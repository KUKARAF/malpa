# malpa — AI-Powered Userscript Manager (Chrome Extension, Manifest V3)

## Overview

**malpa** is a Chrome extension that lets users describe a change they want on any webpage (e.g. _"make the input bar green"_) and have an AI agent generate, store, and auto-inject a userscript — just like Violentmonkey, but AI-authored. Users can also edit existing scripts through the same AI interface.

The extension does **not** fetch page HTML over the network. It reads the live DOM from the content script context and passes it to the AI. This means the AI sees the real, JS-rendered state of the page.

---

## Key References (Manifest V3)

| Topic | URL |
|---|---|
| MV3 overview & migration | https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3 |
| `chrome.scripting` API | https://developer.chrome.com/docs/extensions/reference/api/scripting |
| `chrome.storage` API | https://developer.chrome.com/docs/extensions/reference/api/storage |
| `chrome.tabs` API | https://developer.chrome.com/docs/extensions/reference/api/tabs |
| Content Scripts concepts | https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts |
| Native `userScripts` API | https://developer.chrome.com/docs/extensions/reference/api/userScripts |
| Service Workers (background) | https://developer.chrome.com/docs/extensions/mv3/service_workers/ |
| Content Security Policy | https://developer.chrome.com/docs/extensions/mv3/manifest/content_security_policy/ |

> **Note on Violentmonkey:** It is fine to study Violentmonkey's source for conceptual reference (script storage schema, @match parsing, sandbox model). However, Violentmonkey targets MV2 and its background-page / `eval` patterns are not compatible with MV3's service-worker model and stricter CSP. Prefer the native `chrome.userScripts` API (Chrome 120+) or `chrome.scripting.executeScript` with `world: "MAIN"` over any MV2-era approach.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Popup UI  (popup.html + popup.js)                          │
│  • User types prompt                                        │
│  • Shows spinner / result                                   │
│  • Opens Dashboard                                          │
└────────────────┬────────────────────────────────────────────┘
                 │ chrome.runtime.sendMessage
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Service Worker  (background.js)                            │
│  • Orchestrates AI agent loop                               │
│  • Calls OpenRouter API                                     │
│  • Reads/writes scripts via chrome.storage.local            │
│  • Registers / updates scripts via chrome.userScripts API   │
└────────┬────────────────────────┬───────────────────────────┘
         │ scripting.executeScript │ userScripts.register
         ▼                        ▼
┌─────────────────┐   ┌───────────────────────────────────────┐
│  Content Script │   │  Injected Userscripts (one per rule)  │
│  (content.js)   │   │  run in MAIN world on matching URLs   │
│  • Extracts DOM │   └───────────────────────────────────────┘
│  • Reports back │
└─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Dashboard  (dashboard.html + dashboard.js)                 │
│  • List all scripts (name, match, enabled, last-run)        │
│  • Enable / disable / delete / re-edit via AI               │
│  • Execution log viewer                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Popup (`popup.html` / `popup.js`)

- Text area: user prompt (e.g. _"make the search bar background red"_)
- Button: **Generate Script**
- Status bar: shows agent thinking steps in real-time (streamed via `chrome.runtime.onMessage`)
- Link: **Open Dashboard**
- The popup reads the active tab URL and passes it to the service worker along with the prompt

### 2. Service Worker (`background.js`)

This is the brain. It:

1. Receives `{action: "generate", prompt, tabId}` from the popup
2. Sends `{action: "getDOM"}` to the content script on `tabId` — gets back a lightweight DOM summary (tag names, ids, class names only, no text content) capped at 20 KB. Full outerHTML is **not** sent upfront; the agent fetches details on demand via tools.
3. Runs an **agentic loop** against the OpenRouter API:
   - System prompt includes the lightweight DOM summary and the user's intent
   - The model may call tools: `search_dom(query)`, `read_dom_element(selector)`, `done(script_code, script_name, match_pattern)`
   - Loop continues until `done` is called or max iterations (10) reached
4. On `done`: writes the script to `chrome.storage.local`, registers it with `chrome.userScripts`, and reports success to the popup

#### AI Agent Tool Schema

```jsonc
[
  {
    "name": "search_dom",
    "description": "Search the page DOM for elements whose tag, id, class, name, placeholder, aria-label, or text content contain the query string. Returns a list of matches with their CSS selector path and a short snippet — use this to locate elements before reading their full HTML.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Keyword or phrase to search for in the DOM, e.g. 'search input', 'submit button', 'nav menu'" }
      },
      "required": ["query"]
    }
  },
  {
    "name": "read_dom_element",
    "description": "Return the full outerHTML of elements matching a CSS selector on the current page (up to 20 matches).",
    "parameters": {
      "type": "object",
      "properties": {
        "selector": { "type": "string" }
      },
      "required": ["selector"]
    }
  },
  {
    "name": "done",
    "description": "Emit the final userscript and finish.",
    "parameters": {
      "type": "object",
      "properties": {
        "name":          { "type": "string", "description": "Human-readable script name" },
        "match_pattern": { "type": "string", "description": "URL match pattern, e.g. *://example.com/*" },
        "script_code":   { "type": "string", "description": "Full userscript JS (no ==UserScript== header needed)" }
      },
      "required": ["name", "match_pattern", "script_code"]
    }
  }
]
```

When `read_dom_element` is called the service worker sends another `executeScript` call to the content script to resolve it, then feeds the result back to the model as a tool result.

### 3. Content Script (`content.js`)

Injected via `manifest.json` `content_scripts` on `<all_urls>` at `document_idle`.

Handles three messages from the service worker:

| Message action | Response |
|---|---|
| `getDOM` | `{ summary: "..." }` — a condensed structural summary: every element serialised as `<tag#id.class>` with no text content, capped at 20 KB. Gives the AI a map of the page without flooding the context window. |
| `searchDOM` + `query` | Full-text search across all element attributes (`id`, `class`, `name`, `placeholder`, `aria-label`) and visible text nodes. Returns up to 30 matches, each with a generated unique CSS selector path and a 100-character text snippet. The content script uses `TreeWalker` + `querySelectorAll` to do this entirely in-page — no network call needed. |
| `querySelector` + `selector` | `{ html: el.outerHTML }` for each matching element (up to 20) |

The content script runs in the **ISOLATED** world so it can safely read the DOM without being affected by page JS.

### 4. Userscript Registry

Scripts are stored in `chrome.storage.local` under the key `"scripts"` as an array:

```jsonc
[
  {
    "id": "uuid-v4",
    "name": "Make search bar red",
    "matchPattern": "*://example.com/*",
    "code": "document.querySelector('#search').style.background = 'red';",
    "enabled": true,
    "createdAt": "2026-05-03T12:00:00Z",
    "updatedAt": "2026-05-03T12:00:00Z",
    "runLog": [
      { "tabId": 42, "url": "https://example.com/", "ts": "2026-05-03T12:01:00Z", "ok": true }
    ]
  }
]
```

Scripts are registered/unregistered using the **`chrome.userScripts` API** (Chrome 120+):

```js
await chrome.userScripts.register([{
  id: script.id,
  matches: [script.matchPattern],
  js: [{ code: script.code }],
  world: "MAIN",          // runs in page context so it can manipulate the DOM freely
  runAt: "document_idle"
}]);
```

On extension startup the service worker reads all enabled scripts from storage and re-registers them (the `userScripts` registration is non-persistent across restarts).

> **Requires** `"userScripts"` permission in `manifest.json` and `"scripting"` for DOM reads.  
> Also requires the user to enable **Developer Mode** in `chrome://extensions` for `userScripts` to work.

### 5. Settings Page (`settings.html` / `settings.js`)

Stored in `chrome.storage.sync`:

```jsonc
{
  "openrouterApiKey": "sk-or-...",
  "model": "anthropic/claude-sonnet-4-5",
  "maxIterations": 10,
  "domTruncationBytes": 150000
}
```

Default model: `anthropic/claude-sonnet-4-5` (via OpenRouter).

### 6. Dashboard (`dashboard.html` / `dashboard.js`)

- **Scripts tab**: table of all stored scripts
  - Columns: Name, Match Pattern, Status (enabled toggle), Created, Actions (Edit via AI, Delete, View code)
  - Edit via AI: opens an inline panel with the existing script code pre-loaded, user types a change prompt, AI patches the script
- **Log tab**: execution log pulled from the `runLog` array of each script
  - Columns: Timestamp, Script Name, URL, Result (ok / error message)
  - Filter by script name or URL
- **Settings tab**: inline shortcut to the settings page

---

## `manifest.json` (skeleton)

```jsonc
{
  "manifest_version": 3,
  "name": "malpa",
  "version": "0.1.0",
  "description": "AI-powered userscript generator and manager",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "userScripts",
    "tabs"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "options_page": "settings.html"
}
```

> `"unsafe-eval"` is intentionally **absent** from CSP. All script code is stored as strings and injected via `chrome.userScripts` — never `eval()`'d in the extension context.

---

## AI Agent System Prompt

```
You are a userscript-writing agent. The user wants to modify a webpage.
You have access to tools to inspect the live DOM of the page.

Rules:
- The DOM snapshot below is a condensed structural summary, not full HTML. Use `search_dom` to find relevant elements by keyword, then `read_dom_element` to read their full HTML before writing code.
- Prefer `search_dom` over guessing selectors — the page may be large and the summary incomplete.
- Write vanilla JS. Do not use jQuery or any CDN dependency.
- Scripts must be self-contained and idempotent (safe to run multiple times).
- When confident, call `done` with the final script.
- Use specific CSS selectors derived from the actual DOM you observed.
- Do not use `document.write` or `eval`.
- Maximum {maxIterations} tool calls before you must call `done`.

Current page URL: {url}
Current page DOM summary (structural only — use search_dom / read_dom_element to get full details):
---
{domSnapshot}
---

User request: {userPrompt}
```

---

## OpenRouter Integration

All AI calls go through `https://openrouter.ai/api/v1/chat/completions` using the standard OpenAI-compatible tool-use format.

```js
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${settings.openrouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "chrome-extension://malpa",
    "X-Title": "malpa"
  },
  body: JSON.stringify({
    model: settings.model,   // default: "anthropic/claude-sonnet-4-5"
    messages,
    tools,
    stream: false
  })
});
```

---

## Execution Logging

Each time a userscript runs on a tab, the content script sends a `{action: "log", scriptId, url, ok, error}` message to the service worker. The service worker appends to `script.runLog` (capped at 200 entries per script) and saves back to storage. The dashboard reflects this live via `chrome.storage.onChanged`.

---

## File Structure

```
malpa/
├── manifest.json
├── background.js          # service worker — agent loop, script registry
├── content.js             # DOM extractor + tool executor
├── popup.html / popup.js  # user prompt entry
├── dashboard.html / dashboard.js   # script manager + logs
├── settings.html / settings.js     # API key + model config
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── spec.md                # this file
```

---

## Limitations & Known Constraints

| Constraint | Detail |
|---|---|
| `chrome.userScripts` requires Dev Mode | End-users must enable Developer Mode in `chrome://extensions`. This is a Chrome security requirement for dynamically registered scripts. |
| Service worker lifetime | MV3 service workers terminate after ~30 s of inactivity. Long AI calls must complete within this window or use `chrome.alarms` to wake the worker. OpenRouter calls should target <25 s. |
| DOM size | Very large DOMs are truncated before being sent to the AI. The agent can use `read_dom_element` to drill into specific parts. |
| `eval` / `new Function` | Forbidden in extension context by MV3 CSP. All code execution goes through `chrome.userScripts` or `chrome.scripting.executeScript`. |
| Cross-origin iframes | Content script only has access to the top-level frame DOM unless `all_frames: true` is set. Not enabled by default. |
| Storage quota | `chrome.storage.local` has a 10 MB default quota. Long run logs should be pruned automatically. |

---

## Out of Scope (v1)

- Syncing scripts across devices (storage.sync has a 100 KB limit; too small for scripts)
- Script marketplace / sharing
- `@require` / `@resource` Greasemonkey-style meta-headers
- Sandboxed execution (scripts run in MAIN world by design, same as Violentmonkey default)
- Firefox / Safari support

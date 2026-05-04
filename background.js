// background.js — service worker (MV3)

const DEFAULT_SETTINGS = {
  openrouterApiKey: "",
  model: "anthropic/claude-sonnet-4-5",
  maxTokens: 8192,
  maxIterations: 10,
  domTruncationBytes: 150000,
};

// ── Loki logging ──────────────────────────────────────────────────────────────
// Toggle LOKI_ENABLED to true locally to ship logs to Loki.
// CI/CD refuses to build if this is true — never ship with it enabled.

const LOKI_ENABLED = false;
const LOKI_URL = "http://192.168.1.66:3100";

function lokiLog(labels, payload) {
  if (!LOKI_ENABLED) return;
  const tsNs = String(BigInt(Date.now()) * 1_000_000n);
  const body = {
    streams: [{
      stream: { job: "malpa", ...labels },
      values: [[tsNs, JSON.stringify(payload)]],
    }],
  };
  fetch(`${LOKI_URL}/loki/api/v1/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => console.warn("[malpa] Loki push failed:", e.message));
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_dom",
      description:
        "Search the page DOM for elements whose tag, id, class, name, placeholder, aria-label, or text content contain the query string. Returns a list of matches with their CSS selector path and a short snippet — use this to locate elements before reading their full HTML.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword or phrase to search for in the DOM, e.g. 'search input', 'submit button', 'nav menu'",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_dom_element",
      description:
        "Return the full outerHTML of elements matching a CSS selector on the current page (up to 20 matches).",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Emit the final userscript and finish.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable script name" },
          match_pattern: {
            type: "string",
            description: "URL match pattern, e.g. *://example.com/*",
          },
          script_code: {
            type: "string",
            description: "Full userscript JS (no ==UserScript== header needed)",
          },
        },
        required: ["name", "match_pattern", "script_code"],
      },
    },
  },
];

// ── Storage helpers ──────────────────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function getScripts() {
  const { scripts = [] } = await chrome.storage.local.get("scripts");
  return scripts;
}

async function saveScripts(scripts) {
  await chrome.storage.local.set({ scripts });
}

async function upsertScript(script) {
  const scripts = await getScripts();
  const idx = scripts.findIndex((s) => s.id === script.id);
  if (idx >= 0) {
    scripts[idx] = script;
  } else {
    scripts.push(script);
  }
  await saveScripts(scripts);
}

// ── URL match pattern helpers ─────────────────────────────────────────────────

function patternToRegex(pattern) {
  try {
    if (pattern === "<all_urls>") return /.*/;
    const m = pattern.match(/^([^:]+):\/\/([^/]*)(\/.*)$/);
    if (!m) return null;
    const [, scheme, host, path] = m;
    const schemeRe = scheme === "*" ? "(?:https?|ftp)" : scheme;
    let hostRe;
    if (host === "*") {
      hostRe = "[^/]+";
    } else if (host.startsWith("*.")) {
      hostRe = "(?:[^/]+\\.)?" + host.slice(2).replace(/\./g, "\\.");
    } else {
      hostRe = host.replace(/\./g, "\\.");
    }
    const pathRe = path.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
  } catch {
    return null;
  }
}

function urlMatchesPattern(url, pattern) {
  const re = patternToRegex(pattern);
  return re ? re.test(url) : false;
}

// ── Badge ─────────────────────────────────────────────────────────────────────

async function updateBadgeForTab(tabId, url) {
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    return;
  }
  const scripts = await getScripts();
  const count = scripts.filter((s) => s.enabled && urlMatchesPattern(url, s.matchPattern)).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId }).catch(() => {});
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb", tabId }).catch(() => {});
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (tab?.url) updateBadgeForTab(tabId, tab.url).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    updateBadgeForTab(tabId, tab.url).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.scripts) return;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url) updateBadgeForTab(tab.id, tab.url).catch(() => {});
    }
  });
});

// ── userScripts registry ─────────────────────────────────────────────────────

function wrapCode(code, scriptId) {
  return `(function(){try{${code}
window.postMessage({type:"malpa_log",scriptId:${JSON.stringify(scriptId)},url:location.href,ok:true},'*');
}catch(e){window.postMessage({type:"malpa_log",scriptId:${JSON.stringify(scriptId)},url:location.href,ok:false,error:e.message},'*');}})();`;
}

const USER_SCRIPTS_UNAVAILABLE =
  'chrome.userScripts is unavailable. Open chrome://extensions → malpa → Details ' +
  'and enable "Allow User Scripts", then reload the extension.';

let worldConfigured = false;

async function ensureWorldConfigured() {
  if (worldConfigured) return;
  await chrome.userScripts.configureWorld({
    csp: "script-src 'self' 'unsafe-inline' *",
    messaging: true,
  });
  worldConfigured = true;
}

async function registerScript(script) {
  if (!chrome.userScripts) throw new Error(USER_SCRIPTS_UNAVAILABLE);
  await ensureWorldConfigured();
  await chrome.userScripts.unregister({ ids: [script.id] }).catch(() => {});
  await chrome.userScripts.register([
    {
      id: script.id,
      matches: [script.matchPattern],
      js: [{ code: wrapCode(script.code, script.id) }],
      world: "USER_SCRIPT",
      runAt: "document_idle",
    },
  ]);
  console.log(`[malpa] Registered "${script.name}" for pattern: ${script.matchPattern}`);
}

async function unregisterScript(id) {
  if (!chrome.userScripts) return;
  await chrome.userScripts.unregister({ ids: [id] }).catch(() => {});
}

async function reregisterAllScripts() {
  if (!chrome.userScripts) {
    console.warn("[malpa]", USER_SCRIPTS_UNAVAILABLE);
    return;
  }
  await ensureWorldConfigured();
  const scripts = await getScripts();
  for (const script of scripts) {
    if (script.enabled) await registerScript(script);
  }
}

// ── Default scripts (seeded on first install) ─────────────────────────────────

const DEFAULT_SCRIPTS = [
  {
    name: "Trans.eu Auto-Refresh with Progress Bar",
    matchPattern: "*://platform.trans.eu/freights/sent*",
    code: `(function() {
    'use strict';

    let autoRefreshInterval = null;
    let autoRefreshEnabled = false;
    let refreshMinutes = 15;
    let progressInterval = null;
    let elapsedSeconds = 0;

    function clickAllReloadButtons() {
        const reloadButtons = document.querySelectorAll('a[data-ctx="anchor-resubmit-freight"]');
        console.log(\`Auto-refresh: Found \${reloadButtons.length} reload buttons to click\`);
        reloadButtons.forEach((button, index) => {
            setTimeout(() => {
                console.log(\`Clicking reload button \${index + 1}/\${reloadButtons.length}\`);
                button.click();
            }, index * 1000);
        });
    }

    function startAutoRefresh() {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        if (progressInterval) clearInterval(progressInterval);

        const intervalMs = refreshMinutes * 60 * 1000;
        const totalSeconds = refreshMinutes * 60;
        elapsedSeconds = 0;

        const progressBar = document.getElementById('auto-refresh-progress');

        progressInterval = setInterval(() => {
            elapsedSeconds++;
            const percent = (elapsedSeconds / totalSeconds) * 100;
            if (progressBar) progressBar.style.width = percent + "%";
            if (elapsedSeconds >= totalSeconds) elapsedSeconds = 0;
        }, 1000);

        autoRefreshInterval = setInterval(() => {
            console.log('Auto-refresh triggered');
            clickAllReloadButtons();
            elapsedSeconds = 0;
            if (progressBar) progressBar.style.width = "0%";
        }, intervalMs);
    }

    function stopAutoRefresh() {
        if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
        const progressBar = document.getElementById('auto-refresh-progress');
        if (progressBar) progressBar.style.width = "0%";
    }

    function injectAutoRefreshControls() {
        if (document.getElementById('auto-refresh-controls')) return;
        const toolbar = document.querySelector('._2op11k2_i_a');
        if (!toolbar) return;

        const style = document.createElement('style');
        style.textContent = \`
            #auto-refresh-toggle:checked { background-color: #22c55e; }
            #auto-refresh-toggle::before {
                content: ''; position: absolute;
                width: 16px; height: 16px; border-radius: 50%;
                background-color: white; top: 2px; left: 2px;
                transition: transform 0.3s;
            }
            #auto-refresh-toggle:checked::before { transform: translateX(20px); }
        \`;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.id = 'auto-refresh-controls';
        container.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background-color:#f3f4f6;border-radius:6px;margin-left:12px;border:1px solid #e5e7eb;';

        const toggleLabel = document.createElement('label');
        toggleLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;';
        const toggleText = document.createElement('span');
        toggleText.textContent = 'Auto Refresh:';
        toggleText.style.cssText = 'font-size:13px;font-weight:500;color:#374151;';
        const toggleSwitch = document.createElement('input');
        toggleSwitch.type = 'checkbox';
        toggleSwitch.id = 'auto-refresh-toggle';
        toggleSwitch.style.cssText = 'width:40px;height:20px;cursor:pointer;appearance:none;background-color:#d1d5db;border-radius:10px;position:relative;transition:background-color 0.3s;';
        toggleLabel.appendChild(toggleText);
        toggleLabel.appendChild(toggleSwitch);

        const inputLabel = document.createElement('label');
        inputLabel.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const inputText = document.createElement('span');
        inputText.textContent = 'Interval:';
        inputText.style.cssText = 'font-size:13px;color:#374151;';
        const intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.id = 'auto-refresh-interval';
        intervalInput.value = '15';
        intervalInput.min = '1';
        intervalInput.max = '120';
        intervalInput.style.cssText = 'width:50px;padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;text-align:center;';
        const minutesText = document.createElement('span');
        minutesText.textContent = 'min';
        minutesText.style.cssText = 'font-size:13px;color:#6b7280;';
        inputLabel.appendChild(inputText);
        inputLabel.appendChild(intervalInput);
        inputLabel.appendChild(minutesText);

        const progressContainer = document.createElement('div');
        progressContainer.style.cssText = 'position:relative;width:120px;height:6px;background-color:#e5e7eb;border-radius:999px;overflow:hidden;';
        const progressBar = document.createElement('div');
        progressBar.id = 'auto-refresh-progress';
        progressBar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#22c55e,#4ade80);transition:width 1s linear;';
        progressContainer.appendChild(progressBar);

        container.appendChild(toggleLabel);
        container.appendChild(inputLabel);
        container.appendChild(progressContainer);
        toolbar.appendChild(container);

        toggleSwitch.addEventListener('change', (e) => {
            autoRefreshEnabled = e.target.checked;
            if (autoRefreshEnabled) {
                refreshMinutes = parseInt(intervalInput.value) || 15;
                startAutoRefresh();
            } else {
                stopAutoRefresh();
            }
        });

        intervalInput.addEventListener('change', (e) => {
            const newValue = parseInt(e.target.value);
            if (newValue >= 1 && newValue <= 120) {
                refreshMinutes = newValue;
                if (autoRefreshEnabled) startAutoRefresh();
            } else {
                intervalInput.value = refreshMinutes;
            }
        });
    }

    setTimeout(injectAutoRefreshControls, 1000);

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((m) => { if (m.addedNodes.length) injectAutoRefreshControls(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
})();`,
  },
];

async function seedDefaultScripts() {
  const existing = await getScripts();
  if (existing.length > 0) return;
  const now = new Date().toISOString();
  for (const def of DEFAULT_SCRIPTS) {
    const script = {
      id: crypto.randomUUID(),
      name: def.name,
      matchPattern: def.matchPattern,
      code: def.code,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      runLog: [],
    };
    await upsertScript(script);
    if (chrome.userScripts) await registerScript(script).catch(() => {});
    console.log(`[malpa] Seeded default script: "${script.name}"`);
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") await seedDefaultScripts();
  await reregisterAllScripts();
});
chrome.runtime.onStartup.addListener(reregisterAllScripts);

// ── Status broadcast ─────────────────────────────────────────────────────────

function broadcastStatus(message) {
  chrome.runtime.sendMessage({ action: "status", message }).catch(() => {});
}

function broadcastDone(script) {
  chrome.runtime.sendMessage({ action: "done", script }).catch(() => {});
}

function broadcastError(error) {
  chrome.runtime.sendMessage({ action: "error", error }).catch(() => {});
}

// ── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(settings, messages) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "chrome-extension://malpa",
      "X-Title": "malpa",
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: settings.maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ── DOM tool dispatcher ───────────────────────────────────────────────────────

async function sendToTab(tabId, matchPattern, message) {
  if (!tabId) {
    throw new Error(
      `No tab matching "${matchPattern}" is open. ` +
      `Please open the page in a tab and try again so I don't have to work blind.`
    );
  }
  return chrome.tabs.sendMessage(tabId, message).catch(() => {
    throw new Error(
      `Could not reach the content script on the matching tab. ` +
      `Try reloading the page at "${matchPattern}" and then retry the edit.`
    );
  });
}

async function dispatchDOMTool(toolName, args, tabId, matchPattern) {
  if (toolName === "search_dom") {
    broadcastStatus(`Searching DOM for: "${args.query}"`);
    const result = await sendToTab(tabId, matchPattern, { action: "searchDOM", query: args.query });
    return JSON.stringify(result.matches || []);
  }

  if (toolName === "read_dom_element") {
    broadcastStatus(`Reading DOM element: "${args.selector}"`);
    const result = await sendToTab(tabId, matchPattern, { action: "querySelector", selector: args.selector });
    if (result.error) return `Error: ${result.error}`;
    return JSON.stringify(result.results || []);
  }

  return "Unknown tool";
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(settings, tabUrl, domSnapshot, userPrompt) {
  return `You are a userscript-writing agent. The user wants to modify a webpage.
You have access to tools to inspect the live DOM of the page.

Rules:
- The DOM snapshot below is a condensed structural summary, not full HTML. Use search_dom to find relevant elements by keyword, then read_dom_element to read their full HTML before writing code.
- Prefer search_dom over guessing selectors — the page may be large and the summary incomplete.
- Write vanilla JS. Do not use jQuery or any CDN dependency.
- Scripts must be self-contained and idempotent (safe to run multiple times).
- When confident, call done with the final script.
- Use specific CSS selectors derived from the actual DOM you observed.
- Do not use document.write or eval.
- Maximum ${settings.maxIterations} tool calls before you must call done.

Current page URL: ${tabUrl}
Current page DOM summary (structural only — use search_dom / read_dom_element to get full details):
---
${domSnapshot}
---

User request: ${userPrompt}`;
}

function buildEditSystemPrompt(settings, tabUrl, domSnapshot, existingCode, userPrompt) {
  return `You are a userscript-writing agent. The user wants to modify an existing userscript.
You have access to tools to inspect the live DOM of the page.

Rules:
- Use search_dom and read_dom_element to verify current DOM selectors before modifying.
- Write vanilla JS. Do not use jQuery or any CDN dependency.
- Scripts must be self-contained and idempotent (safe to run multiple times).
- When confident, call done with the updated script.
- Use specific CSS selectors derived from the actual DOM you observed.
- Do not use document.write or eval.
- Maximum ${settings.maxIterations} tool calls before you must call done.

Current page URL: ${tabUrl}
Current page DOM summary (structural only — use search_dom / read_dom_element to get full details):
---
${domSnapshot}
---

Existing script code:
---
${existingCode}
---

User modification request: ${userPrompt}`;
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgentLoop(settings, messages, tabId, matchPattern) {
  let iterations = 0;
  const maxIter = settings.maxIterations || 10;

  while (iterations < maxIter) {
    iterations++;
    broadcastStatus(`Thinking… (step ${iterations})`);

    const data = await callOpenRouter(settings, messages);
    const choice = data.choices?.[0];
    if (!choice) throw new Error("No response from model");

    const msg = choice.message;
    messages.push(msg);

    // Check for tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name;
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        if (toolName === "done") {
          return { name: args.name, matchPattern: args.match_pattern, code: args.script_code };
        }

        const toolResult = await dispatchDOMTool(toolName, args, tabId, matchPattern);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } else {
      // Model responded without tool call — unexpected, treat as error
      throw new Error("Model did not call any tool. Last response: " + (msg.content || ""));
    }

    if (choice.finish_reason === "stop") break;
  }

  throw new Error(`Agent did not call done() within ${maxIter} iterations`);
}

// ── Generate handler ──────────────────────────────────────────────────────────

async function handleGenerate({ prompt, tabId, tabUrl }) {
  const settings = await getSettings();

  if (!settings.openrouterApiKey) {
    throw new Error("OpenRouter API key not set. Please configure it in Settings.");
  }

  broadcastStatus("Reading page DOM…");
  const domResult = await chrome.tabs.sendMessage(tabId, {
    action: "getDOM",
    truncationBytes: settings.domTruncationBytes,
  });
  const domSnapshot = domResult?.summary || "(no DOM available)";

  const systemPrompt = buildSystemPrompt(settings, tabUrl, domSnapshot, prompt);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const result = await runAgentLoop(settings, messages, tabId, tabUrl);

  const now = new Date().toISOString();
  const script = {
    id: crypto.randomUUID(),
    name: result.name,
    matchPattern: result.matchPattern,
    code: result.code,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    runLog: [],
  };

  await upsertScript(script);
  await registerScript(script);
  lokiLog({ event: "script_generated" }, { id: script.id, name: script.name, matchPattern: script.matchPattern });
  broadcastStatus("Script saved and registered!");
  broadcastDone(script);
}

// ── Edit handler ──────────────────────────────────────────────────────────────

async function findTabForScript(script) {
  const allTabs = await chrome.tabs.query({});
  return allTabs.find((t) => t.url && urlMatchesPattern(t.url, script.matchPattern)) || null;
}

async function handleEditScript({ id, prompt }) {
  const settings = await getSettings();

  if (!settings.openrouterApiKey) {
    throw new Error("OpenRouter API key not set. Please configure it in Settings.");
  }

  const scripts = await getScripts();
  const existing = scripts.find((s) => s.id === id);
  if (!existing) throw new Error("Script not found: " + id);

  // Find a real tab matching the script's pattern rather than trusting whatever
  // tab the dashboard happened to send (which is usually the dashboard itself).
  const matchingTab = await findTabForScript(existing);
  const tabId = matchingTab?.id ?? null;
  const tabUrl = matchingTab?.url ?? existing.matchPattern;

  broadcastStatus("Reading page DOM…");
  let domSnapshot = "(no DOM available)";
  if (tabId) {
    const domResult = await chrome.tabs.sendMessage(tabId, {
      action: "getDOM",
      truncationBytes: settings.domTruncationBytes,
    }).catch(() => null);
    domSnapshot = domResult?.summary || "(no DOM available)";
  }

  const systemPrompt = buildEditSystemPrompt(
    settings,
    tabUrl,
    domSnapshot,
    existing.code,
    prompt
  );
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const result = await runAgentLoop(settings, messages, tabId, existing.matchPattern);

  const updated = {
    ...existing,
    // Fall back to existing values if the AI omits them (common for edits)
    name: result.name || existing.name,
    matchPattern: result.matchPattern || existing.matchPattern,
    code: result.code,
    updatedAt: new Date().toISOString(),
  };

  await unregisterScript(existing.id);
  await upsertScript(updated);
  if (updated.enabled) await registerScript(updated);
  lokiLog({ event: "script_edited" }, { id: updated.id, name: updated.name, matchPattern: updated.matchPattern });
  broadcastStatus("Script updated!");
  broadcastDone(updated);
}

// ── Log handler ───────────────────────────────────────────────────────────────

async function handleLog({ scriptId, url, ok, error }) {
  const scripts = await getScripts();
  const script = scripts.find((s) => s.id === scriptId);
  if (!script) return;

  const entry = { tabId: null, url, ts: new Date().toISOString(), ok };
  if (!ok && error) entry.error = error;

  script.runLog = [entry, ...(script.runLog || [])].slice(0, 200);
  await upsertScript(script);

  lokiLog({ event: "script_run" }, {
    scriptId,
    scriptName: script.name,
    url,
    ok,
    ...(error ? { error } : {}),
  });
}

// ── Toggle/Delete handlers ────────────────────────────────────────────────────

async function handleToggleScript({ id, enabled }) {
  const scripts = await getScripts();
  const script = scripts.find((s) => s.id === id);
  if (!script) return;

  script.enabled = enabled;
  script.updatedAt = new Date().toISOString();
  await upsertScript(script);

  if (enabled) {
    await registerScript(script);
  } else {
    await unregisterScript(script.id);
  }
  lokiLog({ event: "script_toggled" }, { id, name: script.name, enabled });
}

async function handleSaveScriptCode({ id, code }) {
  const scripts = await getScripts();
  const script = scripts.find((s) => s.id === id);
  if (!script) return;
  script.code = code;
  script.updatedAt = new Date().toISOString();
  await upsertScript(script);
  if (script.enabled) await registerScript(script);
}

async function handleDeleteScript({ id }) {
  const scripts = await getScripts();
  const script = scripts.find((s) => s.id === id);
  const filtered = scripts.filter((s) => s.id !== id);
  await saveScripts(filtered);
  await unregisterScript(id);
  lokiLog({ event: "script_deleted" }, { id, name: script?.name });
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === "generate") {
    handleGenerate(message)
      .catch((e) => {
        broadcastError(e.message);
        lokiLog({ event: "error" }, { action: "generate", error: e.message });
      });
    sendResponse({ ok: true });
    return false;
  }

  if (action === "editScript") {
    handleEditScript(message)
      .catch((e) => {
        broadcastError(e.message);
        lokiLog({ event: "error" }, { action: "editScript", error: e.message });
      });
    sendResponse({ ok: true });
    return false;
  }

  if (action === "log") {
    handleLog(message).catch(console.error);
    return false;
  }

  if (action === "saveScriptCode") {
    handleSaveScriptCode(message).then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  if (action === "toggleScript") {
    handleToggleScript(message).then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  if (action === "deleteScript") {
    handleDeleteScript(message).then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }
});

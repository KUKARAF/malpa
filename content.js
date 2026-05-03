// content.js — runs in ISOLATED world on all pages

// Listen for postMessage events from MAIN world (injected userscripts)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "malpa_log") return;
  const { scriptId, url, ok, error } = event.data;
  chrome.runtime.sendMessage({ action: "log", scriptId, url, ok, error }).catch(() => {});
});

// Build a condensed structural summary of the DOM
function buildDOMSummary(truncationBytes = 150000) {
  const parts = [];
  let totalLen = 0;

  function walk(node, depth) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (depth > 30) return;

    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : "";
    const cls = node.className && typeof node.className === "string"
      ? "." + node.className.trim().split(/\s+/).join(".")
      : "";
    const line = `${"  ".repeat(depth)}<${tag}${id}${cls}>\n`;

    if (totalLen + line.length > truncationBytes) return;
    parts.push(line);
    totalLen += line.length;

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(document.documentElement, 0);
  return parts.join("");
}

// Generate a unique CSS selector path for an element
function getCSSPath(el) {
  const parts = [];
  let node = el;
  while (node && node !== document.documentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let selector = node.tagName.toLowerCase();
    if (node.className && typeof node.className === "string") {
      const classes = node.className.trim().split(/\s+/).slice(0, 2);
      selector += classes.map(c => `.${CSS.escape(c)}`).join("");
    }
    // Add nth-child if needed for uniqueness
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter(c => c.tagName === node.tagName)
      : [];
    if (siblings.length > 1) {
      const idx = siblings.indexOf(node) + 1;
      selector += `:nth-of-type(${idx})`;
    }
    parts.unshift(selector);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

// Search DOM for elements matching a query string
function searchDOM(query) {
  const q = query.toLowerCase();
  const matches = [];

  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node = walker.nextNode();
  while (node && matches.length < 30) {
    const el = node;
    const tag = el.tagName.toLowerCase();

    const attrs = [
      el.id,
      el.className && typeof el.className === "string" ? el.className : "",
      el.getAttribute("name") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("title") || "",
      el.getAttribute("alt") || "",
      el.getAttribute("type") || "",
      el.getAttribute("value") || "",
    ];

    // Get visible text (direct text children only, to avoid flooding)
    let textSnippet = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        textSnippet += child.textContent;
      }
    }
    textSnippet = textSnippet.trim().slice(0, 100);

    const haystack = [tag, ...attrs, textSnippet].join(" ").toLowerCase();

    if (haystack.includes(q)) {
      matches.push({
        selector: getCSSPath(el),
        tag,
        id: el.id || null,
        className: typeof el.className === "string" ? el.className.trim() || null : null,
        snippet: textSnippet || null,
      });
    }

    node = walker.nextNode();
  }

  return matches;
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getDOM") {
    const summary = buildDOMSummary(message.truncationBytes || 150000);
    sendResponse({ summary });
    return true;
  }

  if (message.action === "searchDOM") {
    try {
      const matches = searchDOM(message.query || "");
      sendResponse({ matches });
    } catch (e) {
      sendResponse({ matches: [], error: e.message });
    }
    return true;
  }

  if (message.action === "querySelector") {
    try {
      const els = Array.from(document.querySelectorAll(message.selector)).slice(0, 20);
      const results = els.map(el => ({ html: el.outerHTML }));
      sendResponse({ results });
    } catch (e) {
      sendResponse({ results: [], error: e.message });
    }
    return true;
  }
});

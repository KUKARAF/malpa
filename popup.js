// popup.js

let activeTabId = null;
let activeTabUrl = null;

const promptEl = document.getElementById("prompt");
const generateBtn = document.getElementById("generate-btn");
const statusEl = document.getElementById("status");
const urlBadge = document.getElementById("url-badge");
const dashboardLink = document.getElementById("dashboard-link");

// Get active tab info on load
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab) {
    activeTabId = tab.id;
    activeTabUrl = tab.url;
    urlBadge.textContent = tab.url || "";
  }
});

// Open dashboard in new tab
dashboardLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// Generate button
generateBtn.addEventListener("click", () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    addStatusLine("Please enter a prompt.", "error");
    return;
  }

  if (!activeTabId) {
    addStatusLine("No active tab found.", "error");
    return;
  }

  setLoading(true);
  clearStatus();
  showStatus();

  chrome.runtime.sendMessage({
    action: "generate",
    prompt,
    tabId: activeTabId,
    tabUrl: activeTabUrl,
  });
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "status") {
    addStatusLine(message.message);
  } else if (message.action === "done") {
    addStatusLine("Script created: " + (message.script?.name || ""), "success");
    setLoading(false);
  } else if (message.action === "error") {
    addStatusLine("Error: " + message.error, "error");
    setLoading(false);
  }
});

function setLoading(loading) {
  generateBtn.disabled = loading;
  generateBtn.textContent = loading ? "Generating…" : "Generate Script";
}

function showStatus() {
  statusEl.classList.add("visible");
}

function clearStatus() {
  statusEl.innerHTML = "";
}

function addStatusLine(text, type = "") {
  showStatus();
  const line = document.createElement("div");
  line.className = "status-line" + (type ? " " + type : "");
  line.textContent = text;
  statusEl.appendChild(line);
  statusEl.scrollTop = statusEl.scrollHeight;
}

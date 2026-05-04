// settings.js

const DEFAULTS = {
  openrouterApiKey: "",
  model: "anthropic/claude-sonnet-4-5",
  maxTokens: 8192,
  maxIterations: 10,
  domTruncationBytes: 150000,
};

const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const maxTokensEl = document.getElementById("maxTokens");
const maxIterEl = document.getElementById("maxIterations");
const domBytesEl = document.getElementById("domTruncationBytes");
const saveBtn = document.getElementById("save-btn");
const saveMsg = document.getElementById("save-msg");

// Load existing settings
chrome.storage.sync.get(DEFAULTS, (settings) => {
  apiKeyEl.value = settings.openrouterApiKey || "";
  modelEl.value = settings.model || DEFAULTS.model;
  maxTokensEl.value = settings.maxTokens ?? DEFAULTS.maxTokens;
  maxIterEl.value = settings.maxIterations ?? DEFAULTS.maxIterations;
  domBytesEl.value = settings.domTruncationBytes ?? DEFAULTS.domTruncationBytes;
});

// Save
saveBtn.addEventListener("click", () => {
  const settings = {
    openrouterApiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim() || DEFAULTS.model,
    maxTokens: parseInt(maxTokensEl.value, 10) || DEFAULTS.maxTokens,
    maxIterations: parseInt(maxIterEl.value, 10) || DEFAULTS.maxIterations,
    domTruncationBytes: parseInt(domBytesEl.value, 10) || DEFAULTS.domTruncationBytes,
  };

  chrome.storage.sync.set(settings, () => {
    saveMsg.classList.add("visible");
    setTimeout(() => saveMsg.classList.remove("visible"), 2000);
  });
});

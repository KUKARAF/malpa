// dashboard.js

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ── Modal ──────────────────────────────────────────────────────────────────

const codeModal = document.getElementById("code-modal");
const modalCode = document.getElementById("modal-code");
const modalTitle = document.getElementById("modal-title");
const modalSaveMsg = document.getElementById("modal-save-msg");
let modalScriptId = null;

function closeCodeModal() {
  codeModal.classList.remove("open");
  modalScriptId = null;
}

document.getElementById("modal-close").addEventListener("click", closeCodeModal);
document.getElementById("modal-cancel-btn").addEventListener("click", closeCodeModal);
codeModal.addEventListener("click", (e) => {
  if (e.target === codeModal) closeCodeModal();
});

document.getElementById("modal-save-btn").addEventListener("click", () => {
  if (!modalScriptId) return;
  chrome.runtime.sendMessage({
    action: "saveScriptCode",
    id: modalScriptId,
    code: modalCode.value,
  }, () => {
    modalSaveMsg.classList.add("visible");
    setTimeout(() => modalSaveMsg.classList.remove("visible"), 2000);
  });
});

function showCodeModal(script) {
  modalScriptId = script.id;
  modalTitle.textContent = script.name;
  modalCode.value = script.code;
  modalSaveMsg.classList.remove("visible");
  codeModal.classList.add("open");
  modalCode.focus();
}

// ── Scripts rendering ──────────────────────────────────────────────────────

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso || "—";
  }
}

function renderScripts(scripts) {
  const tbody = document.getElementById("scripts-body");
  const table = document.getElementById("scripts-table");
  const empty = document.getElementById("scripts-empty");
  const count = document.getElementById("scripts-count");
  const editPanels = document.getElementById("edit-panels");

  tbody.innerHTML = "";
  editPanels.innerHTML = "";

  count.textContent = `${scripts.length} script${scripts.length !== 1 ? "s" : ""}`;

  if (scripts.length === 0) {
    table.style.display = "none";
    empty.style.display = "block";
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  for (const script of scripts) {
    const tr = document.createElement("tr");
    tr.dataset.id = script.id;

    tr.innerHTML = `
      <td class="name-cell">${escHtml(script.name)}</td>
      <td class="match-cell">${escHtml(script.matchPattern)}</td>
      <td>
        <label class="toggle" title="${script.enabled ? "Enabled" : "Disabled"}">
          <input type="checkbox" class="toggle-input" ${script.enabled ? "checked" : ""} data-id="${escHtml(script.id)}">
          <span class="slider"></span>
        </label>
      </td>
      <td class="date-cell">${formatDate(script.createdAt)}</td>
      <td>
        <div class="actions">
          <button class="btn-sm view-code-btn" data-id="${escHtml(script.id)}">Code</button>
          <button class="btn-sm edit-ai-btn" data-id="${escHtml(script.id)}">Edit via AI</button>
          <button class="btn-sm danger delete-btn" data-id="${escHtml(script.id)}">Delete</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);

    // Edit panel (hidden by default, inserted after table)
    const panelDiv = document.createElement("div");
    panelDiv.id = `edit-panel-${script.id}`;
    panelDiv.style.display = "none";
    panelDiv.dataset.id = script.id;
    panelDiv.innerHTML = `
      <div class="edit-panel">
        <h3>Edit "${escHtml(script.name)}" via AI</h3>
        <pre>${escHtml(script.code)}</pre>
        <textarea class="edit-prompt" placeholder="Describe the change you want…"></textarea>
        <div class="edit-panel-actions">
          <button class="btn-primary apply-edit-btn" data-id="${escHtml(script.id)}">Apply</button>
          <button class="btn-cancel cancel-edit-btn" data-id="${escHtml(script.id)}">Cancel</button>
        </div>
        <div class="edit-status" id="edit-status-${escHtml(script.id)}"></div>
      </div>
    `;
    editPanels.appendChild(panelDiv);
  }

  // Wire up events
  tbody.querySelectorAll(".toggle-input").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      chrome.runtime.sendMessage({
        action: "toggleScript",
        id: checkbox.dataset.id,
        enabled: checkbox.checked,
      });
    });
  });

  tbody.querySelectorAll(".view-code-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const script = scripts.find((s) => s.id === btn.dataset.id);
      if (script) showCodeModal(script);
    });
  });

  tbody.querySelectorAll(".edit-ai-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`edit-panel-${btn.dataset.id}`);
      if (!panel) return;
      const isVisible = panel.style.display !== "none";
      // Close all panels first
      document.querySelectorAll("[id^='edit-panel-']").forEach((p) => (p.style.display = "none"));
      if (!isVisible) panel.style.display = "block";
    });
  });

  tbody.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const script = scripts.find((s) => s.id === btn.dataset.id);
      if (!script) return;
      if (!confirm(`Delete "${script.name}"?`)) return;
      chrome.runtime.sendMessage({ action: "deleteScript", id: btn.dataset.id });
    });
  });

  editPanels.querySelectorAll(".cancel-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`edit-panel-${btn.dataset.id}`);
      if (panel) panel.style.display = "none";
    });
  });

  editPanels.querySelectorAll(".apply-edit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const panel = document.getElementById(`edit-panel-${btn.dataset.id}`);
      const textarea = panel.querySelector(".edit-prompt");
      const prompt = textarea.value.trim();
      if (!prompt) return;

      const statusEl = document.getElementById(`edit-status-${btn.dataset.id}`);
      statusEl.className = "edit-status";
      statusEl.textContent = "Thinking…";
      btn.disabled = true;

      chrome.runtime.sendMessage({
        action: "editScript",
        id: btn.dataset.id,
        prompt,
      });

      // Listen for result
      const handler = (message) => {
        if (message.action === "status") {
          statusEl.textContent = message.message;
        } else if (message.action === "done") {
          statusEl.className = "edit-status success";
          statusEl.textContent = "Script updated!";
          btn.disabled = false;
          chrome.runtime.onMessage.removeListener(handler);
          panel.style.display = "none";
        } else if (message.action === "error") {
          statusEl.className = "edit-status error";
          statusEl.textContent = "Error: " + message.error;
          btn.disabled = false;
          chrome.runtime.onMessage.removeListener(handler);
        }
      };
      chrome.runtime.onMessage.addListener(handler);
    });
  });
}

// ── Logs rendering ─────────────────────────────────────────────────────────

function renderLogs(scripts, nameFilter = "", urlFilter = "") {
  const tbody = document.getElementById("logs-body");
  const table = document.getElementById("logs-table");
  const empty = document.getElementById("logs-empty");

  // Build name lookup
  const nameMap = Object.fromEntries(scripts.map((s) => [s.id, s.name]));

  // Flatten all log entries
  let entries = [];
  for (const script of scripts) {
    for (const entry of script.runLog || []) {
      entries.push({ ...entry, scriptName: script.name, scriptId: script.id });
    }
  }

  // Sort newest first
  entries.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  // Apply filters
  const nf = nameFilter.toLowerCase();
  const uf = urlFilter.toLowerCase();
  if (nf) entries = entries.filter((e) => e.scriptName.toLowerCase().includes(nf));
  if (uf) entries = entries.filter((e) => (e.url || "").toLowerCase().includes(uf));

  tbody.innerHTML = "";

  if (entries.length === 0) {
    table.style.display = "none";
    empty.style.display = "block";
    return;
  }

  table.style.display = "table";
  empty.style.display = "none";

  for (const entry of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="date-cell">${formatDate(entry.ts)}</td>
      <td>${escHtml(entry.scriptName)}</td>
      <td style="font-size:12px;color:#666;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(entry.url || "")}">${escHtml(entry.url || "—")}</td>
      <td>${entry.ok
        ? '<span class="result-ok">✓ ok</span>'
        : `<span class="result-err">✗ ${escHtml(entry.error || "error")}</span>`
      }</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Main data load ─────────────────────────────────────────────────────────

let allScripts = [];

function loadAndRender() {
  chrome.storage.local.get("scripts", ({ scripts = [] }) => {
    allScripts = scripts;
    renderScripts(scripts);
    renderLogs(
      scripts,
      document.getElementById("log-filter-name").value,
      document.getElementById("log-filter-url").value
    );
  });
}

loadAndRender();

// Live update when storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scripts) {
    allScripts = changes.scripts.newValue || [];
    renderScripts(allScripts);
    renderLogs(
      allScripts,
      document.getElementById("log-filter-name").value,
      document.getElementById("log-filter-url").value
    );
  }
});

// Log filters
document.getElementById("log-filter-name").addEventListener("input", () => {
  renderLogs(
    allScripts,
    document.getElementById("log-filter-name").value,
    document.getElementById("log-filter-url").value
  );
});
document.getElementById("log-filter-url").addEventListener("input", () => {
  renderLogs(
    allScripts,
    document.getElementById("log-filter-name").value,
    document.getElementById("log-filter-url").value
  );
});

// ── Helpers ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

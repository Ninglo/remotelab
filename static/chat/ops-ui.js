(function () {
  const opsPanelBtn = document.getElementById("opsPanelBtn");
  const opsReportBadge = document.getElementById("opsReportBadge");
  const opsPanel = document.getElementById("opsPanel");
  const opsPanelBackdrop = document.getElementById("opsPanelBackdrop");
  const opsPanelCloseBtn = document.getElementById("opsPanelCloseBtn");
  const opsPanelRefreshBtn = document.getElementById("opsPanelRefreshBtn");
  const opsTabReports = document.getElementById("opsTabReports");
  const opsTabTriggers = document.getElementById("opsTabTriggers");
  const opsReportsView = document.getElementById("opsReportsView");
  const opsTriggersView = document.getElementById("opsTriggersView");

  if (!opsPanelBtn || !opsPanel || !opsPanelBackdrop || !opsReportsView || !opsTriggersView) {
    return;
  }

  let activeView = "reports";
  let pollTimer = null;
  let reportsCache = [];

  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
  }

  async function apiJson(method, path, body) {
    const options = { method };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const res = await fetch(path, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  }

  function formatTime(value) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms)) return "-";
    return new Date(ms).toLocaleString();
  }

  function setReportBadge(reports) {
    const unreadCount = (Array.isArray(reports) ? reports : []).filter((item) => !item?.read).length;
    if (unreadCount <= 0) {
      opsReportBadge.hidden = true;
      opsReportBadge.textContent = "0";
      return;
    }
    opsReportBadge.hidden = false;
    opsReportBadge.textContent = String(unreadCount);
  }

  async function loadReports() {
    const reports = await apiJson("GET", "/api/reports");
    reportsCache = Array.isArray(reports) ? reports : [];
    setReportBadge(reportsCache);
    return reportsCache;
  }

  async function loadTriggers() {
    const data = await apiJson("GET", "/api/triggers");
    return Array.isArray(data?.triggers) ? data.triggers : [];
  }

  function renderReports(reports) {
    if (!Array.isArray(reports) || reports.length === 0) {
      opsReportsView.innerHTML = '<div class="ops-list-empty">No reports yet.</div>';
      return;
    }

    opsReportsView.innerHTML = reports.map((report) => {
      const reportId = report?.id || "";
      return `
        <div class="ops-item${report?.read ? "" : " unread"}" data-report-id="${escapeHtml(reportId)}">
          <div class="ops-item-title">${escapeHtml(report?.title || "Untitled")}</div>
          <div class="ops-item-meta">
            <span>${escapeHtml(report?.source || "unknown")}</span>
            <span>${escapeHtml(formatTime(report?.createdAt))}</span>
            <span>${report?.read ? "read" : "unread"}</span>
          </div>
          <div class="ops-item-actions">
            <button class="ops-item-btn" data-action="open">Open</button>
            <button class="ops-item-btn" data-action="mark-read" ${report?.read ? "disabled" : ""}>Mark Read</button>
            <button class="ops-item-btn" data-action="delete">Delete</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderTriggers(triggers) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
      opsTriggersView.innerHTML = '<div class="ops-list-empty">No triggers configured.</div>';
      return;
    }

    opsTriggersView.innerHTML = triggers.map((trigger) => {
      const text = String(trigger?.text || "").trim();
      return `
        <div class="ops-item" data-trigger-id="${escapeHtml(trigger?.id || "")}">
          <div class="ops-item-title">${escapeHtml(trigger?.title || "Untitled trigger")}</div>
          <div class="ops-item-meta">
            <span>${escapeHtml(trigger?.status || "unknown")}</span>
            <span>${escapeHtml(formatTime(trigger?.scheduledAt))}</span>
            <span>${escapeHtml((trigger?.sessionId || "").slice(0, 8))}</span>
          </div>
          <div class="ops-item-text">${escapeHtml(text.length > 180 ? `${text.slice(0, 179)}...` : text)}</div>
          <div class="ops-item-actions">
            <label class="ops-trigger-enabled">
              <input type="checkbox" data-action="toggle-enabled" ${trigger?.enabled ? "checked" : ""}>
              enabled
            </label>
          </div>
        </div>
      `;
    }).join("");
  }

  async function refreshActiveView() {
    try {
      if (activeView === "reports") {
        renderReports(await loadReports());
        return;
      }
      renderTriggers(await loadTriggers());
    } catch (error) {
      const target = activeView === "reports" ? opsReportsView : opsTriggersView;
      target.innerHTML = `<div class="ops-list-empty">${escapeHtml(error.message || "Failed to load")}</div>`;
    }
  }

  function setOpsPanelOpen(open) {
    opsPanel.hidden = !open;
    opsPanelBackdrop.hidden = !open;
    opsPanel.setAttribute("aria-hidden", open ? "false" : "true");

    if (open) {
      refreshActiveView();
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(refreshActiveView, 15000);
      return;
    }

    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function switchView(nextView) {
    activeView = nextView === "triggers" ? "triggers" : "reports";
    opsTabReports.classList.toggle("active", activeView === "reports");
    opsTabTriggers.classList.toggle("active", activeView === "triggers");
    opsReportsView.hidden = activeView !== "reports";
    opsTriggersView.hidden = activeView !== "triggers";
    if (!opsPanel.hidden) {
      refreshActiveView();
    }
  }

  async function handleReportAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.getAttribute("data-action");
    const card = button.closest("[data-report-id]");
    const reportId = card ? card.getAttribute("data-report-id") : "";
    if (!reportId) return;

    try {
      button.disabled = true;
      if (action === "open") {
        const report = reportsCache.find((item) => item?.id === reportId);
        if (report && !report.read) {
          await apiJson("PATCH", `/api/reports/${encodeURIComponent(reportId)}/read`);
        }
        window.open(`/api/reports/${encodeURIComponent(reportId)}/html`, "_blank", "noopener");
      } else if (action === "mark-read") {
        await apiJson("PATCH", `/api/reports/${encodeURIComponent(reportId)}/read`);
      } else if (action === "delete") {
        await apiJson("DELETE", `/api/reports/${encodeURIComponent(reportId)}`);
      }
      renderReports(await loadReports());
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || "Operation failed");
    }
  }

  async function handleTriggerAction(event) {
    const toggle = event.target.closest('input[data-action="toggle-enabled"]');
    if (!toggle) return;
    const card = toggle.closest("[data-trigger-id]");
    const triggerId = card ? card.getAttribute("data-trigger-id") : "";
    if (!triggerId) return;

    try {
      toggle.disabled = true;
      await apiJson("PATCH", `/api/triggers/${encodeURIComponent(triggerId)}`, {
        enabled: !!toggle.checked,
      });
      renderTriggers(await loadTriggers());
    } catch (error) {
      toggle.disabled = false;
      window.alert(error.message || "Update failed");
    }
  }

  function syncVisibilityForMode() {
    if (typeof visitorMode !== "undefined" && visitorMode) {
      opsPanelBtn.style.display = "none";
      setOpsPanelOpen(false);
      return;
    }
    opsPanelBtn.style.display = "";
  }

  opsPanelBtn.addEventListener("click", () => {
    syncVisibilityForMode();
    if (opsPanelBtn.style.display === "none") return;
    setOpsPanelOpen(opsPanel.hidden);
  });
  if (opsPanelCloseBtn) opsPanelCloseBtn.addEventListener("click", () => setOpsPanelOpen(false));
  if (opsPanelBackdrop) opsPanelBackdrop.addEventListener("click", () => setOpsPanelOpen(false));
  if (opsPanelRefreshBtn) opsPanelRefreshBtn.addEventListener("click", () => refreshActiveView());
  if (opsTabReports) opsTabReports.addEventListener("click", () => switchView("reports"));
  if (opsTabTriggers) opsTabTriggers.addEventListener("click", () => switchView("triggers"));
  opsReportsView.addEventListener("click", handleReportAction);
  opsTriggersView.addEventListener("change", handleTriggerAction);

  syncVisibilityForMode();
  void loadReports().catch(() => {});

  window.RemoteLabOpsPanel = {
    refresh: refreshActiveView,
    close: () => setOpsPanelOpen(false),
    syncVisibilityForMode,
  };
})();

// Ordinary action notices are browser-local. Delivery warnings are a live
// projection of the outbox: keep only read versions locally, never a second
// copy of the delivery record. Both the bell and conversation use this view.
const RemoteLabNotifications = (() => {
  const toggle = document.getElementById("notificationToggle");
  const panel = document.getElementById("notificationPanel");
  const badge = document.getElementById("notificationBadge");
  const list = document.getElementById("notificationList");
  const clear = document.getElementById("notificationClear");
  const close = document.getElementById("notificationClose");
  const showAll = document.getElementById("notificationShowAll");
  const status = document.getElementById("notificationStatus");
  const contextPanel = document.getElementById("deliveryIssues");
  const personId = window.__REMOTELAB_BOOTSTRAP__?.auth?.person?.id;
  const base = document.querySelector("base[href]")?.getAttribute("href") || "/";
  const storageKey = personId ? `remotelab.notifications:${base}:${personId}` : "";
  const readKey = storageKey ? `${storageKey}:delivery-read` : "";
  const limit = 50;
  let notices = [];
  let deliveryIssues = [];
  let readVersions = {};
  let sessionContext = null;
  let scopeSessionId = "";
  let deliveryLoaded = false;
  let refreshError = false;
  let dismissError = false;
  let mutationEpoch = 0;
  let refreshPromise = null;
  let refreshAgain = false;
  const dismissing = new Set();
  try {
    const saved = storageKey ? JSON.parse(localStorage.getItem(storageKey) || "[]") : [];
    if (Array.isArray(saved)) notices = saved.filter(item => item && typeof item.message === "string"
      && Number.isFinite(item.at) && ["info", "warn", "error"].includes(item.level)).slice(0, limit);
  } catch {}
  try {
    const saved = readKey ? JSON.parse(localStorage.getItem(readKey) || "{}") : {};
    if (saved && typeof saved === "object" && !Array.isArray(saved)) readVersions = saved;
  } catch {}

  function translate(key, fallback, vars) {
    return window.remotelabT ? window.remotelabT(key, vars) : fallback;
  }
  function persist() {
    try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(notices)); } catch {}
    try { if (readKey) localStorage.setItem(readKey, JSON.stringify(readVersions)); } catch {}
  }
  function visible(item) {
    return !scopeSessionId || item.sessionId === scopeSessionId;
  }
  function markVisibleRead() {
    notices = notices.map(notice => visible(notice) ? { ...notice, read: true } : notice);
    for (const issue of deliveryIssues.filter(visible)) readVersions[issue.id] = issue.issueVersion;
    persist();
  }
  function renderContext() {
    if (!contextPanel) return;
    const count = sessionContext?.id
      ? (deliveryLoaded ? deliveryIssues.filter(issue => issue.sessionId === sessionContext.id).length
        : sessionContext.deliveryIssueCount || 0) : 0;
    const signature = JSON.stringify([sessionContext?.id, count]);
    if (contextPanel.dataset.signature === signature) return;
    contextPanel.dataset.signature = signature;
    contextPanel.replaceChildren();
    contextPanel.hidden = count === 0;
    if (!count) return;
    const summary = document.createElement("span");
    summary.textContent = translate("delivery.issues", `Delivery issues: ${count}`, { count });
    const open = document.createElement("button");
    open.type = "button";
    open.className = "delivery-issues-open";
    open.textContent = translate("delivery.viewNotifications", "View in notifications");
    open.addEventListener("click", () => setOpen(true, sessionContext.id));
    contextPanel.appendChild(summary);
    contextPanel.appendChild(open);
  }
  function sessionButton(row, sessionId) {
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = translate("notifications.session", "Open session");
    link.addEventListener("click", () => {
      setOpen(false);
      if (typeof attachSession === "function") attachSession(sessionId);
    });
    row.appendChild(link);
  }
  function renderDeliveryIssue(issue) {
    const row = document.createElement("article");
    row.className = "notification-item notification-item--error notification-delivery";
    row.dataset.deliveryId = issue.id;
    const title = document.createElement("h3");
    title.textContent = issue.sessionName || translate("notifications.deliverySession", "Conversation");
    const time = document.createElement("time");
    time.textContent = Number.isFinite(Date.parse(issue.createdAt))
      ? new Date(issue.createdAt).toLocaleString(document.documentElement.lang || undefined) : "";
    const text = document.createElement("p");
    text.textContent = [issue.connector, issue.filename || translate("delivery.message", "Message"),
      translate(`delivery.${issue.state}`, issue.state), issue.lastError].filter(Boolean).join(" · ");
    row.appendChild(title);
    row.appendChild(time);
    row.appendChild(text);
    if (issue.hasSession) sessionButton(row, issue.sessionId);
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "notification-dismiss";
    dismiss.textContent = translate("delivery.dismiss", "Read, dismiss");
    dismiss.disabled = dismissing.has(issue.id);
    dismiss.addEventListener("click", () => dismissIssue(issue));
    row.appendChild(dismiss);
    return row;
  }
  function render() {
    const unread = notices.filter(item => !item.read).length
      + deliveryIssues.filter(issue => readVersions[issue.id] !== issue.issueVersion).length;
    if (badge) { badge.textContent = String(unread); badge.hidden = unread === 0; }
    if (clear) clear.disabled = notices.length === 0;
    if (showAll) showAll.hidden = !scopeSessionId;
    if (status) {
      status.hidden = !deliveryIssues.some(visible);
      status.textContent = translate("notifications.deliveryNote", "Dismiss only hides the warning; delivery status is unchanged.");
    }
    renderContext();
    if (!list) return;
    list.replaceChildren();
    if (refreshError || dismissError) {
      const error = document.createElement("p");
      error.className = "notification-error";
      error.setAttribute("role", "alert");
      error.textContent = dismissError ? translate("delivery.dismissFailed", "Could not dismiss the notice. Refresh and try again.")
        : translate("notifications.loadFailed", "Could not refresh delivery notices. Previous warnings are retained.");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = translate("notifications.retry", "Retry");
      retry.addEventListener("click", () => refreshDeliveryIssues());
      error.appendChild(retry);
      list.appendChild(error);
    }
    const items = [...deliveryIssues.filter(visible).map(issue => ({ issue, at: Date.parse(issue.createdAt) || 0 })),
      ...notices.filter(visible).map(notice => ({ notice, at: notice.at }))].sort((a, b) => b.at - a.at);
    if (!items.length && !refreshError && !dismissError) {
      const empty = document.createElement("p");
      empty.className = "notification-empty";
      empty.textContent = translate("notifications.empty", "No notifications");
      list.appendChild(empty);
    }
    for (const item of items) {
      if (item.issue) { list.appendChild(renderDeliveryIssue(item.issue)); continue; }
      const notice = item.notice;
      const row = document.createElement("article");
      row.className = `notification-item notification-item--${notice.level}`;
      const time = document.createElement("time");
      time.dateTime = new Date(notice.at).toISOString();
      time.textContent = new Date(notice.at).toLocaleString(document.documentElement.lang || undefined);
      const text = document.createElement("p");
      text.textContent = notice.message;
      row.appendChild(time);
      row.appendChild(text);
      if (typeof notice.sessionId === "string" && notice.sessionId) {
        sessionButton(row, notice.sessionId);
      }
      list.appendChild(row);
    }
  }
  function setOpen(open, sessionId = "") {
    if (!panel) return;
    panel.hidden = !open;
    toggle?.setAttribute("aria-expanded", String(open));
    if (open) {
      scopeSessionId = sessionId;
      markVisibleRead();
      render();
      close?.focus();
      refreshDeliveryIssues();
    }
  }
  async function refreshDeliveryIssues() {
    if (!toggle || typeof fetchJsonOrRedirect !== "function"
      || (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode)) return;
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshPromise = (async () => {
      do {
        refreshAgain = false;
        const epoch = mutationEpoch;
        try {
          const data = await fetchJsonOrRedirect("/api/source-delivery-issues", { revalidate: false, cache: "no-store" });
          if (!Array.isArray(data?.issues)) throw new Error("Invalid delivery issue response");
          if (epoch !== mutationEpoch) { refreshAgain = true; continue; }
          deliveryIssues = data.issues.filter(issue => issue && typeof issue.id === "string"
            && typeof issue.issueVersion === "string");
          readVersions = Object.fromEntries(deliveryIssues.filter(issue => readVersions[issue.id] === issue.issueVersion)
            .map(issue => [issue.id, issue.issueVersion]));
          deliveryLoaded = true;
          refreshError = false;
          if (dismissError && !deliveryIssues.some(issue => issue.id === dismissError)) dismissError = false;
          if (panel?.hidden === false) markVisibleRead();
          else persist();
        } catch {
          refreshError = true;
        }
        render();
      } while (refreshAgain);
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function dismissIssue(issue) {
    if (dismissing.has(issue.id)) return;
    dismissing.add(issue.id);
    dismissError = false;
    render();
    try {
      const data = await fetchJsonOrRedirect(`/api/source-deliveries/${encodeURIComponent(issue.id)}/dismiss`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueVersion: issue.issueVersion }),
      });
      if (!data?.delivery) throw new Error("Missing dismissal receipt");
      mutationEpoch += 1;
      deliveryIssues = deliveryIssues.filter(entry => entry.id !== issue.id || entry.issueVersion !== issue.issueVersion);
      delete readVersions[issue.id];
      persist();
      render();
      await Promise.all([
        refreshDeliveryIssues(),
        typeof refreshSidebarSession === "function" ? refreshSidebarSession(issue.sessionId, { forceFresh: true }).catch(() => {}) : null,
      ]);
    } catch {
      dismissError = issue.id;
      await refreshDeliveryIssues();
    } finally {
      dismissing.delete(issue.id);
      render();
    }
  }
  toggle?.addEventListener("click", () => setOpen(panel?.hidden !== false));
  close?.addEventListener("click", () => { setOpen(false); toggle?.focus(); });
  clear?.addEventListener("click", () => { notices = []; persist(); render(); });
  showAll?.addEventListener("click", () => setOpen(true));
  document.addEventListener("click", event => {
    // Rendering a busy/dismissed row can remove the clicked node before this
    // handler runs. The original event path still identifies an inside click.
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (panel && !panel.hidden && !path.includes(panel) && !panel.contains(event.target) && !toggle?.contains(event.target)
      && !contextPanel?.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && panel && !panel.hidden) { setOpen(false); toggle?.focus(); }
  });
  window.addEventListener("remotelab:localechange", () => {
    if (contextPanel) delete contextPanel.dataset.signature;
    render();
  });
  window.addEventListener("storage", event => {
    if (event.key !== readKey && event.key !== storageKey) return;
    try {
      const value = JSON.parse(event.newValue || (event.key === readKey ? "{}" : "[]"));
      if (event.key === readKey && value && typeof value === "object" && !Array.isArray(value)) readVersions = value;
      if (event.key === storageKey && Array.isArray(value)) notices = value.filter(item => item && typeof item.message === "string"
        && Number.isFinite(item.at) && ["info", "warn", "error"].includes(item.level)).slice(0, limit);
      render();
    } catch {}
  });
  render();

  return {
    refreshDeliveryIssues,
    setSessionContext(session) { sessionContext = session; renderContext(); },
    notify(message, level = "info", options = {}) {
      const text = typeof message === "string" ? message.trim() : String(message || "");
      if (!text) return;
      const severity = ["error", "warn"].includes(level) ? level : "info";
      const sessionId = options.sessionId || "";
      notices.unshift({ message: text, level: severity, at: Date.now(), sessionId,
        read: panel?.hidden === false && visible({ sessionId }) });
      notices = notices.slice(0, limit);
      persist();
      render();
      let container = document.getElementById("system-toast-container");
      if (!container) {
        container = document.createElement("div");
        container.id = "system-toast-container";
        document.body.appendChild(container);
      }
      const toast = document.createElement("div");
      toast.className = `system-toast system-toast--${severity}`;
      toast.setAttribute("role", severity === "error" ? "alert" : "status");
      const content = document.createElement("span");
      content.textContent = text;
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "×";
      dismiss.setAttribute("aria-label", translate("action.close", "Close"));
      const timer = setTimeout(() => toast.remove(), severity === "error" ? 8000 : 5000);
      dismiss.addEventListener("click", () => { clearTimeout(timer); toast.remove(); });
      toast.appendChild(content);
      toast.appendChild(dismiss);
      container.appendChild(toast);
      while (container.children.length > 3) container.firstElementChild.remove();
    },
  };
})();

function showSystemToast(message, level = "info", options = {}) {
  RemoteLabNotifications.notify(message, level, options);
}

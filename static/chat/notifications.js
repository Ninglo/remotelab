// In-app notifications need no browser permission. Keep recent notices after
// their toast disappears, scoped to this signed-in Person and product path.
const RemoteLabNotifications = (() => {
  const toggle = document.getElementById("notificationToggle");
  const panel = document.getElementById("notificationPanel");
  const badge = document.getElementById("notificationBadge");
  const list = document.getElementById("notificationList");
  const clear = document.getElementById("notificationClear");
  const close = document.getElementById("notificationClose");
  const personId = window.__REMOTELAB_BOOTSTRAP__?.auth?.person?.id;
  const base = document.querySelector("base[href]")?.getAttribute("href") || "/";
  const storageKey = personId ? `remotelab.notifications:${base}:${personId}` : "";
  const limit = 50;
  let notices = [];
  try {
    const saved = storageKey ? JSON.parse(localStorage.getItem(storageKey) || "[]") : [];
    if (Array.isArray(saved)) notices = saved.filter(item => item && typeof item.message === "string"
      && Number.isFinite(item.at) && ["info", "warn", "error"].includes(item.level)).slice(0, limit);
  } catch {}

  function translate(key, fallback) {
    return window.remotelabT ? window.remotelabT(key) : fallback;
  }
  function persist() {
    try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(notices)); } catch {}
  }
  function render() {
    const unread = notices.filter(item => !item.read).length;
    if (badge) { badge.textContent = String(unread); badge.hidden = unread === 0; }
    if (clear) clear.disabled = notices.length === 0;
    if (!list) return;
    list.replaceChildren();
    if (!notices.length) {
      const empty = document.createElement("p");
      empty.className = "notification-empty";
      empty.textContent = translate("notifications.empty", "No notifications");
      list.appendChild(empty);
    }
    for (const notice of notices) {
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
        const link = document.createElement("button");
        link.type = "button";
        link.textContent = translate("notifications.session", "Open session");
        link.addEventListener("click", () => {
          setOpen(false);
          if (typeof attachSession === "function") attachSession(notice.sessionId);
        });
        row.appendChild(link);
      }
      list.appendChild(row);
    }
  }
  function setOpen(open) {
    if (!panel) return;
    panel.hidden = !open;
    toggle?.setAttribute("aria-expanded", String(open));
    if (open) {
      notices = notices.map(notice => ({ ...notice, read: true }));
      persist();
      render();
      close?.focus();
    }
  }
  toggle?.addEventListener("click", () => setOpen(panel?.hidden !== false));
  close?.addEventListener("click", () => { setOpen(false); toggle?.focus(); });
  clear?.addEventListener("click", () => { notices = []; persist(); render(); });
  document.addEventListener("click", event => {
    if (panel && !panel.hidden && !panel.contains(event.target) && !toggle?.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && panel && !panel.hidden) { setOpen(false); toggle?.focus(); }
  });
  window.addEventListener("remotelab:localechange", render);
  render();

  return {
    notify(message, level = "info", options = {}) {
      const text = typeof message === "string" ? message.trim() : String(message || "");
      if (!text) return;
      const severity = ["error", "warn"].includes(level) ? level : "info";
      notices.unshift({ message: text, level: severity, at: Date.now(), sessionId: options.sessionId || "", read: panel?.hidden === false });
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

"use strict";
(function installUsageCollection(globalScope) {
  if ((typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) || !globalScope.crypto?.randomUUID) return;
  const visitId = crypto.randomUUID(), queue = [], presented = new Set(), observed = new Set();
  let sessionId = "", page = "", lastOpened = "", timer = null, sending = false, retryMs = 1000;
  const entry = new URL(location.href).searchParams.has("session") ? "session_link" : "default";
  function track(event, fields = {}) {
    if (queue.length >= 500) return;
    queue.push({ eventId: crypto.randomUUID(), timestamp: Date.now(), visitId, sessionId, page, event, ...fields });
    if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, 1000);
  }
  async function flush() {
    if (sending || !queue.length || navigator.onLine === false) return;
    sending = true;
    const batch = queue.splice(0, 50);
    try {
      const response = await fetch("/api/usage/events", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: batch }), keepalive: true });
      if (response.status !== 202 || !(await response.json()).recorded) throw new Error("collection unavailable");
      retryMs = 1000;
    } catch { queue.unshift(...batch); queue.splice(500); retryMs = Math.min(60_000, retryMs * 2); }
    finally {
      sending = false;
      if (queue.length && !timer) timer = setTimeout(() => { timer = null; void flush(); }, retryMs);
    }
  }
  function open(entryKind) {
    if (!document.hidden && page === "sessions" && sessionId && lastOpened !== sessionId) {
      lastOpened = sessionId; track("session_open", { entry: entryKind });
    }
  }
  function enter(nextPage) {
    if (page === nextPage) return;
    page = nextPage; lastOpened = "";
    if (!document.hidden) track("page_enter");
    open("navigation");
  }
  function attach(id) {
    if (sessionId !== id) { sessionId = id; lastOpened = ""; }
    open(entry);
  }
  function present(element, metadata) {
    if (document.hidden || page !== "sessions" || !element.isConnected) return;
    const key = `${metadata.sessionId}:${metadata.historySeq}:${metadata.kind}:${metadata.state || ""}`;
    if (presented.has(key)) return;
    presented.add(key); if (presented.size > 10000) presented.delete(presented.values().next().value);
    track("content_presented", metadata);
  }
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const item of entries) if (item.isIntersecting && item.intersectionRect.width > 0 && item.intersectionRect.height > 0
        && !document.hidden && page === "sessions") {
      present(item.target, item.target._usageMetadata); observer.unobserve(item.target); observed.delete(item.target);
    }
  }, { threshold: 0 }) : null;
  function content(element, event) {
    if (!observer || !event?.seq || !sessionId) return;
    element._usageMetadata = { sessionId, historySeq: event.seq, runId: event.runId, requestId: event.requestId,
      kind: event.messageKind === "user_question" ? "question" : event.phase === "final" ? "final" : "reply",
      ...(event.questionState ? { state: event.questionState, questionId: event.questionId } : {}) };
    observed.add(element); observer.observe(element);
  }
  if (observer && typeof MutationObserver === "function") new MutationObserver(() => {
    // Renderers build batches off-document. Prune after insertion/removal, not
    // while the preceding nodes are still in an unfinished DocumentFragment.
    for (const node of observed) if (!node.isConnected) { observer.unobserve(node); observed.delete(node); }
  }).observe(document.body, { childList: true, subtree: true });
  async function objectHash(text) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`usage-v1:${text}`));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
  }
  document.addEventListener("click", event => {
    if (!event.isTrusted) return;
    const target = event.target.closest?.("button, a, img, video, audio");
    if (!target) return;
    const actions = { cancelBtn: "stop", sendBtn: "send", newSessionBtn: "new_session", headerNewSessionBtn: "new_session",
      taskCenterCreateToggle: "create_automation", monitoringOverviewTab: "monitor_overview", monitoringAutomationsTab: "monitor_automations",
      monitoringUsageTab: "monitor_usage" };
    if (actions[target.id]) track("ui_action", { feature: "workbench", action: actions[target.id] });
    let url; try { url = new URL(target.getAttribute("href") || target.getAttribute("src") || "", location.href); } catch { return; }
    const asset = url.pathname.match(/^\/api\/assets\/([a-zA-Z0-9_-]+)\/download$/);
    const publication = url.pathname.match(/^\/public-pages\/([a-zA-Z0-9_-]+)\//);
    const image = url.pathname.match(/^\/images\/([a-zA-Z0-9_-]+\.[a-z0-9]+)$/);
    if (url.origin !== location.origin) return;
    const action = target.hasAttribute("download") || url.searchParams.get("download") === "1" ? "download" : "open";
    if (asset) track("artifact_open", { objectId: asset[1], action });
    else if (publication || image) void objectHash(publication ? `publication:${publication[1]}` : image[1])
      .then(objectId => track("artifact_open", { objectId, action, kind: publication ? "web" : "image" })).catch(() => {});
  });
  document.addEventListener("visibilitychange", () => {
    track("page_visibility", { state: document.hidden ? "background" : "foreground" });
    if (!document.hidden) {
      lastOpened = ""; open("foreground");
      for (const node of observed) { observer?.unobserve(node); observer?.observe(node); }
    }
    void flush();
  });
  globalScope.addEventListener("pagehide", () => {
    track("page_visibility", { state: "leave" });
    if (queue.length) navigator.sendBeacon?.("/api/usage/events", new Blob([JSON.stringify({ events: queue.slice(0, 50) })], { type: "application/json" }));
  });
  globalScope.addEventListener("online", () => void flush());
  globalScope.RemoteLabUsage = { track, attach, enter, content, flush };
  // Initial HTTP bootstrap and reconnect can select a Session without calling
  // the sidebar click helper. Observe the canonical store, including that path.
  if (typeof chatStore !== "undefined" && chatStore?.subscribe) {
    const sync = state => { attach(state.currentSessionId || ""); enter(state.activeTab || "sessions"); };
    chatStore.subscribe(sync); sync(chatStore.getState());
  }
})(window);

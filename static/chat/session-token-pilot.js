"use strict";

// Visual pilot for one Person. Values are recorded per-Session tokens, not quota usage.
(function initSessionTokenPilot() {
  const pilotPersonId = "person_8b536b37317e491d96036fc8";
  if (bootstrapAuthInfo?.person?.id !== pilotPersonId) return;
  const list = document.getElementById("sessionList");
  if (!list) return;

  let bySession = new Map();
  let loadState = "loading";
  let lastReadAt = 0;
  let loading = false;
  let queued = false;

  function compactTokens(value) {
    if (value >= 1e8) return `${Number((value / 1e8).toFixed(1))}亿`;
    if (value >= 1e4) return `${Number((value / 1e4).toFixed(1))}万`;
    return String(value);
  }

  function heatLevel(value) {
    if (value < 1e5) return 1;
    if (value < 1e6) return 2;
    if (value < 1e7) return 3;
    if (value < 1e8) return 4;
    return 5;
  }

  function updateRow(row) {
    const sessionId = row.querySelector(".session-action-btn[data-id]")?.dataset.id;
    if (!sessionId) return;
    const info = row.querySelector(".session-item-info");
    if (!info) return;
    let target = info.querySelector(".session-item-description, .session-item-meta");
    if (!target) {
      target = document.createElement("div");
      target.className = "session-item-description";
      info.append(target);
    }
    let badge = target.querySelector(".session-token-pilot");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "session-token-pilot";
      const bar = document.createElement("span");
      bar.className = "session-token-pilot-bar";
      bar.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "session-token-pilot-label";
      badge.append(bar, label);
      target.append(badge);
    }
    const tokens = bySession.get(sessionId);
    const known = Number.isFinite(tokens);
    const text = known ? `${compactTokens(tokens)} Token` : loadState === "loading" ? "Token · …" : "Token · —";
    const title = known
      ? `已记录 Token：${tokens.toLocaleString("zh-CN")}。包含此 Session 的后台调用；不代表剩余额度。`
      : loadState === "error" ? "用量暂时无法读取" : "暂无可核对的 Token 记录";
    badge.className = `session-token-pilot${known ? ` level-${heatLevel(tokens)}` : " is-unknown"}`;
    badge.title = title;
    const label = badge.querySelector(".session-token-pilot-label");
    if (label.textContent !== text) label.textContent = text;
  }

  function updateRows() {
    observer.disconnect();
    for (const row of list.querySelectorAll(".session-item")) updateRow(row);
    observer.observe(list, { childList: true, subtree: true });
  }

  function queueUpdate() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      updateRows();
    });
  }

  const observer = new MutationObserver(queueUpdate);
  observer.observe(list, { childList: true, subtree: true });
  queueUpdate();

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      // Existing endpoint is adequate for the one-Person trial. A compact endpoint
      // should replace this full response before a wider rollout.
      const response = await fetch("/api/usage/summary?days=3650&top=5000", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("usage unavailable");
      const result = await response.json();
      if (!Array.isArray(result.bySession)) throw new Error("invalid usage summary");
      bySession = new Map(result.bySession
        .filter((entry) => entry?.sessionId && Number.isFinite(entry.totalTokens) && entry.runCount > 0)
        .map((entry) => [entry.sessionId, entry.totalTokens]));
      loadState = "ready";
    } catch {
      loadState = bySession.size ? "ready" : "error";
    } finally {
      lastReadAt = Date.now();
      loading = false;
      queueUpdate();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastReadAt > 10 * 60_000) void refresh();
  });
  window.setInterval(() => {
    if (!document.hidden && Date.now() - lastReadAt > 10 * 60_000) void refresh();
  }, 10 * 60_000);
  void refresh();
})();

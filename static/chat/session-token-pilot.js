"use strict";

// Read-only Session usage trial for the requesting Person on this instance.
(function initSessionTokenPilot() {
  if (bootstrapAuthInfo?.person?.id !== "person_8b536b37317e491d96036fc8") return;
  const list = document.getElementById("sessionList");
  if (!list) return;
  document.documentElement.classList.add("session-token-pilot-enabled");

  let bySession = new Map();
  let refreshing = false;
  let updateQueued = false;
  let lastReadAt = 0;

  function formatTokens(tokens) {
    if (tokens > 0 && tokens < 100) return "<0.1k";
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }

  function updateRow(row) {
    const sessionId = row.querySelector(".session-action-btn[data-id]")?.dataset.id;
    const titleRow = row.querySelector(".session-item-title-row");
    if (!sessionId || !titleRow) return;
    let amount = titleRow.querySelector(".session-token-pilot");
    const tokens = bySession.get(sessionId);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      amount?.remove();
      return;
    }
    if (!amount) {
      amount = document.createElement("span");
      amount.className = "session-token-pilot";
      titleRow.insertBefore(amount, titleRow.querySelector(".session-item-actions"));
    }
    amount.textContent = formatTokens(tokens);
    amount.title = `已记录累计用量：${tokens.toLocaleString("zh-CN")} Token（含此会话的后台调用；不是剩余额度）`;
    amount.setAttribute("aria-label", amount.title);
  }

  function updateRows() {
    observer.disconnect();
    for (const row of list.querySelectorAll(".session-item")) updateRow(row);
    observer.observe(list, { childList: true, subtree: true });
  }

  function queueUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => {
      updateQueued = false;
      updateRows();
    });
  }

  const observer = new MutationObserver(queueUpdate);
  observer.observe(list, { childList: true, subtree: true });
  queueUpdate();

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      // The existing summary is sufficient for this single-Person trial.
      const response = await fetch("/api/usage/summary?days=3650&top=5000", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("usage unavailable");
      const result = await response.json();
      if (!Array.isArray(result.bySession)) throw new Error("invalid usage summary");
      bySession = new Map(result.bySession
        .filter((entry) => entry?.sessionId && Number.isSafeInteger(entry.totalTokens)
          && entry.totalTokens >= 0 && entry.runCount > 0)
        .map((entry) => [entry.sessionId, entry.totalTokens]));
      queueUpdate();
    } catch {
      // No invented zero or placeholder when the recorded usage is unavailable.
    } finally {
      lastReadAt = Date.now();
      refreshing = false;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastReadAt >= 2 * 60_000) void refresh();
  });
  window.setInterval(() => {
    if (!document.hidden && Date.now() - lastReadAt >= 2 * 60_000) void refresh();
  }, 2 * 60_000);
  void refresh();
})();

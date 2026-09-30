"use strict";

// Small, read-only pilot. This Person ID controls visibility, not the Codex account.
(function initPetQuotaPilot() {
  const pilotPersonId = "person_8b536b37317e491d96036fc8";
  if (bootstrapAuthInfo?.person?.id !== pilotPersonId) return;

  const workspace = document.getElementById("sessionWorkspace");
  if (!workspace) return;

  const container = document.createElement("div");
  container.className = "pet-quota-pilot";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pet-quota-pilot-button";
  button.textContent = "本周额度 · 查询中";
  button.setAttribute("aria-expanded", "false");
  const details = document.createElement("div");
  details.className = "pet-quota-pilot-details";
  details.hidden = true;
  container.append(button, details);
  workspace.append(container);

  let requestId = 0;
  const isAmber = () => document.documentElement.getAttribute("data-theme") === "amber";
  const dateText = (value) => {
    const date = new Date(value || "");
    return Number.isFinite(date.getTime())
      ? date.toLocaleString(document.documentElement.lang || undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "未知";
  };
  const validWindow = (value) => value && Number.isFinite(value.remainingPercent)
    && value.remainingPercent >= 0 && value.remainingPercent <= 100
    && (!value.resetsAt || Date.parse(value.resetsAt) > Date.now());
  const windowLabel = (value) => value?.windowDurationMins === 10080 ? "本周"
    : value?.windowDurationMins === 300 ? "5 小时" : "额度";

  async function refresh() {
    if (!isAmber()) return;
    const currentRequest = ++requestId;
    button.textContent = "本周额度 · 查询中";
    try {
      const [statusResponse, usageResponse] = await Promise.all([
        fetch("/api/codex-auth/status", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/codex-auth/rate-limits", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (!statusResponse.ok || !usageResponse.ok) throw new Error("unavailable");
      const [{ codexAuth }, { codexUsage }] = await Promise.all([statusResponse.json(), usageResponse.json()]);
      if (currentRequest !== requestId) return;
      const checkedAt = Date.parse(codexUsage?.checkedAt || "");
      const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < 10 * 60_000 && checkedAt <= Date.now() + 60_000;
      const sameAccount = codexAuth?.loggedIn === true && codexAuth.accountRevision
        && codexAuth.accountRevision === codexUsage?.accountRevision;
      const buckets = codexUsage?.status === "ready" && sameAccount && fresh ? codexUsage.buckets || [] : [];
      const windows = buckets.flatMap((bucket) => [bucket.primary, bucket.secondary].filter(validWindow));
      const weekly = windows.find((window) => window.windowDurationMins === 10080);
      button.textContent = weekly ? `本周剩余 ${Number(weekly.remainingPercent.toFixed(1))}%` : "本周额度 · 暂不可用";
      details.replaceChildren();
      const rows = ["当前实例 Codex 账号", ...windows.map((window) =>
        `${windowLabel(window)}剩余 ${Number(window.remainingPercent.toFixed(1))}% · 重置 ${dateText(window.resetsAt)}`),
        `采样 ${fresh ? dateText(codexUsage.checkedAt) : "暂不可用"}`];
      for (const row of rows) {
        const line = document.createElement("div");
        line.textContent = row;
        details.append(line);
      }
    } catch {
      if (currentRequest !== requestId) return;
      button.textContent = "本周额度 · 暂不可用";
      details.textContent = "当前实例 Codex 账号 · 暂时无法读取";
    }
  }

  button.addEventListener("click", () => {
    details.hidden = !details.hidden;
    button.setAttribute("aria-expanded", String(!details.hidden));
    if (!details.hidden) void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isAmber()) void refresh();
  });
  function syncTheme() {
    if (isAmber()) {
      void refresh();
    } else {
      requestId++;
      details.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  }
  window.addEventListener("remotelab:themechange", syncTheme);
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === "remotelab.theme") syncTheme();
  });
  window.setInterval(() => {
    if (!document.hidden && isAmber()) void refresh();
  }, 5 * 60_000);
  syncTheme();
})();

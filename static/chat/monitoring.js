"use strict";

(function attachMonitoring(globalScope) {
  const overview = document.getElementById("monitoringOverview");
  const automations = document.getElementById("monitoringAutomations");
  const content = document.getElementById("monitoringContent");
  if (!overview || !automations || !content) return;
  const views = ["overview", "usage", "automations"];
  const usage = document.getElementById("monitoringUsage");
  const tabs = [document.getElementById("monitoringOverviewTab"), document.getElementById("monitoringUsageTab"), document.getElementById("monitoringAutomationsTab")];
  const period = document.getElementById("monitoringPeriod");
  const refresh = document.getElementById("monitoringRefresh");
  const create = document.getElementById("taskCenterCreateToggle");
  const requested = new URL(globalScope.location.href).searchParams.get("monitor");
  let view = views.includes(requested) ? requested : "automations";
  let value = null, serial = 0, loading = false;
  const t = (key, vars) => globalScope.remotelabT?.(`monitoring.${key}`, vars) || key;
  const node = (tag, text = "", className = "") => {
    const item = document.createElement(tag); item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const number = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "—";
  const percent = value => Number.isFinite(value) ? `${value.toFixed(1).replace(/\.0$/, "")}%` : "—";
  const bytes = value => Number.isFinite(value) ? `${(value / 1024 ** 3).toFixed(2)} GiB` : "—";
  const time = value => Number.isFinite(Date.parse(value || "")) ? new Date(value).toLocaleString() : "—";
  const status = value => {
    const key = value === "active" ? "enabled" : value === "failed" ? "failedState" : value === "started" ? "running" : value || "unknown";
    const result = t(key); return result === `monitoring.${key}` ? String(value || "—") : result;
  };
  function section(title, parent = content) {
    const root = node("section", "", "monitoring-section"); root.appendChild(node("h3", title)); parent.appendChild(root); return root;
  }
  function table(root, headings, rows) {
    const wrap = node("div", "", "monitoring-table-wrap"), table = node("table");
    const head = node("thead"), headingRow = node("tr");
    headings.forEach(heading => { const th = node("th", heading); th.scope = "col"; headingRow.appendChild(th); });
    head.appendChild(headingRow); table.appendChild(head);
    const body = node("tbody");
    rows.forEach(row => { const tr = node("tr"); row.forEach(cell => {
      const td = node("td"); if (cell?.nodeType) td.appendChild(cell); else td.textContent = String(cell ?? "—"); tr.appendChild(td);
    }); body.appendChild(tr); });
    table.appendChild(body); wrap.appendChild(table); root.appendChild(wrap);
  }
  function executionLink(item) {
    const link = node("a", item.title || item.subject);
    const sessionId = item.sessionId || item.lastExecution?.sessionId;
    link.href = sessionId ? `/?tab=sessions&session=${encodeURIComponent(sessionId)}` : "/?tab=tasks";
    return link;
  }
  function alertDetail(item) {
    if (item.detail) return item.detail;
    if (item.kind === "disk") return t("diskRisk", { free: bytes(item.availableBytes), used: percent(item.usedPercent), inodes: percent(item.inodeUsedPercent) });
    if (item.kind === "quota") return t("quotaRisk", { count: item.availableAccounts });
    if (item.kind === "lowQuota") return t("lowQuotaRisk");
    return t(item.kind === "automation" ? "automationRisk" : "serviceRisk");
  }
  function quotaDuration(window) {
    return window.minutes >= 1440 ? t("days", { count: Math.round(window.minutes / 1440) })
      : window.minutes >= 60 ? t("hours", { count: Math.round(window.minutes / 60) }) : t("minutes", { count: window.minutes });
  }
  function accountCard(account) {
    const card = node("article", "", "monitoring-account"); card.dataset.status = account.status;
    const header = node("header", "", "monitoring-account-header");
    header.appendChild(node("h4", account.label));
    header.appendChild(node("span", status(account.status), "monitoring-account-status")); card.appendChild(header);
    if (account.active) card.appendChild(node("span", t("active"), "monitoring-account-default"));
    const windows = account.windows.slice().sort((a, b) => (account.status === "exhausted" ? a.remainingPercent - b.remainingPercent : 0)
      || (b.minutes === 10080) - (a.minutes === 10080) || b.minutes - a.minutes);
    if (!windows.length) card.appendChild(node("p", t("quotaUnknown"), "monitoring-quota-unknown"));
    windows.forEach((window, index) => {
      const quota = node("div", "", "monitoring-quota");
      quota.dataset.primary = String(index === 0);
      quota.dataset.band = account.status === "unknown" || account.status === "conflicting" ? "unknown"
        : window.remainingPercent <= 10 ? "low" : window.remainingPercent <= 30 ? "limited" : "available";
      const label = node("div", "", "monitoring-quota-label");
      label.appendChild(node("span", t("windowRemaining", { window: quotaDuration(window) })));
      label.appendChild(node("strong", percent(window.remainingPercent))); quota.appendChild(label);
      if (Number.isFinite(window.remainingPercent)) {
        const meter = node("meter"); meter.min = 0; meter.max = 100; meter.value = window.remainingPercent;
        meter.setAttribute("aria-label", `${account.label} · ${quotaDuration(window)} · ${t("remaining")} ${percent(window.remainingPercent)}`);
        quota.appendChild(meter);
      }
      quota.appendChild(node("p", t("windowReset", { time: time(window.resetsAt) }), "monitoring-quota-reset")); card.appendChild(quota);
    });
    card.appendChild(node("p", t("accountObserved", { time: time(account.observedAt) }), "monitoring-account-observed"));
    return card;
  }
  function render() {
    content.replaceChildren();
    if (!value) { content.appendChild(node("p", t(loading ? "loading" : "failed"), "monitoring-note")); return; }
    const snapshot = node("div", "", "monitoring-snapshot"); snapshot.id = "monitoringSnapshot"; content.appendChild(snapshot);
    snapshot.appendChild(node("h2", t("snapshotTitle"), "monitoring-snapshot-heading"));
    snapshot.appendChild(node("p", t("updated", { time: time(value.generatedAt) }), "monitoring-note"));
    const attention = section(t("attention"), snapshot); attention.dataset.section = "attention";
    if (!value.attention.length) attention.appendChild(node("p", t("clear"), "monitoring-note"));
    else value.attention.slice().sort((a, b) => (b.severity === "critical") - (a.severity === "critical")).forEach(item => {
      const row = node("div", "", "monitoring-alert"); row.dataset.severity = item.severity;
      row.appendChild(node("span", t(item.severity === "critical" ? "critical" : "warning"), "monitoring-alert-label"));
      const detail = node("div"); detail.appendChild(item.kind === "automation" ? executionLink(item) : node("strong", item.subject));
      detail.appendChild(node("p", alertDetail(item))); row.appendChild(detail); attention.appendChild(row);
    });
    (value.recovery || []).filter(item => !["healthy", "paused"].includes(item.currentResourceStatus)).slice(-20).forEach(item => {
      const row = node("div", null, "monitoring-alert");
      const detail = node("div"); detail.appendChild(node("strong", `${item.subject} · ${item.label}`));
      detail.appendChild(node("p", item.reason || item.summary || "沿原任务检查点办理"));
      if (item.sessionId) {
        const link = node("a", "查看处理记录"); link.href = `/?session=${encodeURIComponent(item.sessionId)}&tab=sessions`;
        detail.appendChild(link);
      }
      row.appendChild(detail); attention.appendChild(row);
    });
    const accounts = section(t("accounts"), snapshot); accounts.dataset.section = "accounts";
    if (!value.accounts.length) accounts.appendChild(node("p", t("noAccounts"), "monitoring-note"));
    else {
      const summary = node("div", "", "monitoring-account-summary");
      for (const state of ["available", "exhausted", "unknown"]) {
        const count = value.accounts.filter(account => state === "unknown" ? !["available", "exhausted"].includes(account.status) : account.status === state).length;
        const badge = node("span", `${status(state)} ${count}`, "monitoring-account-status"); badge.dataset.status = state; summary.appendChild(badge);
      }
      accounts.appendChild(summary);
      const grid = node("div", "", "monitoring-account-grid");
      value.accounts.slice().sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))
        .forEach(account => grid.appendChild(accountCard(account)));
      accounts.appendChild(grid);
      accounts.appendChild(node("p", t("quotaNote"), "monitoring-note"));
    }
    if (!value.opportunities.length) accounts.appendChild(node("p", t("noCapacity"), "monitoring-note"));
    else value.opportunities.forEach(item => {
      accounts.appendChild(node("p", `${t("capacity", { count: item.accounts.length })} ${t("capacityNote")}`, "monitoring-note"));
    });
    const disks = section(t("disks")); disks.dataset.section = "disks";
    if (value.apiHealth) {
      const api = section("飞书 API");
      table(api, ["对象", "状态与处理", "24h窗口调用／失败", "5分钟调用", "最近调用"], value.apiHealth.providers.map(item =>
        [item.label, item.detail, `${item.calls24h}／${item.failed24h}`, item.calls5m, time(item.lastObservedAt)]));
      api.appendChild(node("p", value.apiHealth.coverage.detail, "monitoring-note"));
      const endpoints = value.apiHealth.providers.flatMap(item => item.endpoints.map(endpoint =>
        [item.label, endpoint.endpoint, endpoint.calls, endpoint.failed]));
      if (endpoints.length) table(api, ["对象", "调用最多的接口", "已观察调用", "失败"], endpoints);
      value.apiHealth.providers.forEach(item => api.appendChild(node("p", `${item.label}：日志初次观测 ${time(item.firstObservedAt)}`, "monitoring-note")));
      api.appendChild(node("p", value.apiHealth.tenantQuota ? `企业额度已用 ${percent(value.apiHealth.tenantQuota.usedPercent)}`
        : "企业真实剩余额度未知，需管理员后台读数；本地调用数不代表计费用量。", "monitoring-note"));
    }
    table(disks, [t("resource"), t("used"), t("free"), t("inodes")], value.disks.map(disk => [disk.label, percent(disk.usedPercent), bytes(disk.availableBytes), percent(disk.inodeUsedPercent)]));
    value.disks.filter(disk => disk.sharedFilesystem).forEach(disk => disks.appendChild(node("p", t("shared", { name: disk.sharedFilesystem }), "monitoring-note")));
    const usage = section(t("usage"));
    if (!value.usage) usage.appendChild(node("p", t("noUsage"), "monitoring-note"));
    else {
      const totals = value.usage.totals, metrics = node("dl", "", "monitoring-metrics");
      for (const [label, text] of [[t("tokens"), number(totals.totalTokens)], [t("background"), `${number(totals.backgroundTokens)} · ${percent(typeof totals.backgroundShare === "number" ? totals.backgroundShare * 100 : NaN)}`],
        [t("cache"), percent(typeof totals.cachedInputShare === "number" ? totals.cachedInputShare * 100 : NaN)],
        [t("actualCost"), totals.exactCostRunCount ? `$${Number(totals.costUsd || 0).toFixed(2)}` : "—"],
        [t("estimatedCost"), `$${Number(totals.estimatedCostUsd || 0).toFixed(2)}`]]) {
        const pair = node("div"); pair.appendChild(node("dt", label)); pair.appendChild(node("dd", text)); metrics.appendChild(pair);
      }
      usage.appendChild(metrics); usage.appendChild(node("p", t("costNote"), "monitoring-note"));
      usage.appendChild(node("p", `${time(value.usage.window.start)} — ${time(value.usage.window.end)}`, "monitoring-note"));
      table(usage, [t("model"), t("tokens")], (value.usage.byModel || []).map(item => [item.model || item.key || "—", number(item.totalTokens)]));
      table(usage, [t("operation"), t("tokens")], (value.usage.byOperationGroup || []).map(item => [
        (item.operationGroup || item.key) === "background" ? t("background") : (item.operationGroup || item.key) === "foreground" ? t("foreground") : item.label || item.operationGroup || item.key || "—", number(item.totalTokens)]));
      const trend = node("div", "", "monitoring-trend"), days = (value.usage.byDay || []).slice().sort((a, b) => String(a.day || a.key).localeCompare(String(b.day || b.key)));
      const maximum = Math.max(1, ...days.map(day => day.totalTokens));
      trend.setAttribute("aria-label", t("trend"));
      days.forEach(day => {
        const row = node("div"); row.appendChild(node("span", day.day || day.key));
        const meter = node("meter"); meter.min = 0; meter.max = maximum; meter.value = day.totalTokens;
        meter.setAttribute("aria-label", `${day.day || day.key}: ${number(day.totalTokens)} Token`);
        row.appendChild(meter); row.appendChild(node("span", number(day.totalTokens))); trend.appendChild(row);
      }); usage.appendChild(trend);
    }
    const operations = section(t("operations")); operations.appendChild(node("p", t("jobs", { count: value.automations.active }), "monitoring-note"));
    table(operations, [t("job"), t("status"), t("lastRun"), t("nextRun")], [
      ...value.services.map(service => [service.label, service.status === "paused" ? `按原指令停用：${service.maintenanceReason}` : status(service.status), time(service.lastRunAt), "—"]),
      ...value.automations.items.filter(task => !["completed", "cancelled"].includes(task.state)).map(task => [executionLink(task),
        `${status(task.state)}${task.lastExecution ? ` · ${status(task.lastExecution.state)}` : ""}`,
        time(task.lastExecution?.completedAt || task.lastExecution?.scheduledAt), time(task.nextRunAt)]),
    ]);
    if (value.automaticRequests.length) {
      const details = node("details"); details.appendChild(node("summary", t("automaticRequests")));
      details.appendChild(node("p", t("requestsNote"), "monitoring-note"));
      table(details, [t("account"), t("status"), t("observed")], value.automaticRequests.map(item => [item.label, status(item.status), time(item.completedAt)]));
      operations.appendChild(details);
    }
    const coverage = section(t("coverage")); coverage.appendChild(node("p", t("scope"), "monitoring-note"));
    if (value.coverage.unknownAccounts) coverage.appendChild(node("p", t("unknownCount", { count: value.coverage.unknownAccounts }), "monitoring-note"));
    if (value.coverage.unverifiedAdmissions) coverage.appendChild(node("p", t("unverifiedAdmissions", { count: value.coverage.unverifiedAdmissions }), "monitoring-note"));
    if (!value.coverage.servicesConfigured) coverage.appendChild(node("p", t("noServices"), "monitoring-note"));
    value.coverage.gaps.forEach(gap => {
      const source = ({ usage: "sourceUsage", fleet: "sourceFleet", accounts: "sourceAccounts", automations: "sourceAutomation", automaticRequests: "sourceRequests" })[gap.source];
      coverage.appendChild(node("p", t("gap", { source: source ? t(source) : gap.source, code: gap.code }), "monitoring-note"));
    });
  }
  async function load({ silent = false } = {}) {
    const request = ++serial; loading = true; refresh.disabled = true;
    if (!silent && !value) render();
    try {
      const next = await fetchJsonOrRedirect(`/api/monitoring/overview?days=${Number(period.value) || 7}`, { revalidate: false });
      if (request === serial) { value = next; render(); }
    } catch {
      if (request === serial) { value = null; loading = false; render(); }
    } finally { if (request === serial) { loading = false; refresh.disabled = false; } }
  }
  function select(next, { sync = true } = {}) {
    view = next; overview.hidden = view !== "overview"; automations.hidden = view !== "automations";
    if (usage) usage.hidden = view !== "usage";
    create.hidden = view !== "automations";
    tabs.forEach((tab, index) => { const selected = index === views.indexOf(view);
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    });
    if (sync) {
      const url = new URL(globalScope.location.href); url.searchParams.set("tab", "tasks");
      if (view !== "automations") url.searchParams.set("monitor", view); else url.searchParams.delete("monitor");
      globalScope.history.replaceState(null, "", url);
      if (view === "overview") void load();
      else if (view === "usage") void globalScope.RemoteLabUsageAnalysis?.load();
      else void globalScope.RemoteLabTaskCenter?.onTabShown();
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(views[index]));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const target = event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : (index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length;
      select(views[target]); tabs[target].focus();
    });
  });
  period.addEventListener("change", () => { value = null; void load(); });
  refresh.addEventListener("click", () => void load());
  globalScope.addEventListener("remotelab:localechange", () => { if (value) render(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && view === "overview" && document.body.dataset.appView === "tasks") void load({ silent: true });
  });
  globalScope.RemoteLabMonitoring = { isOverview: () => view !== "automations", onTabShown: () => view === "usage" ? globalScope.RemoteLabUsageAnalysis?.load() : load({ silent: Boolean(value) }) };
  select(view, { sync: false });
  if (view === "overview" && document.body.dataset.appView === "tasks") void load();
})(window);

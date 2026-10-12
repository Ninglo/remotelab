"use strict";

(function attachMonitoring(globalScope) {
  const overview = document.getElementById("monitoringOverview");
  const automations = document.getElementById("monitoringAutomations");
  const content = document.getElementById("monitoringContent");
  if (!overview || !automations || !content) return;
  const views = ["overview", "usage", "automations", "feedback"];
  const feedback = document.getElementById("monitoringFeedback");
  const usage = document.getElementById("monitoringUsage");
  const tabs = [document.getElementById("monitoringOverviewTab"), document.getElementById("monitoringUsageTab"), document.getElementById("monitoringAutomationsTab"), document.getElementById("monitoringFeedbackTab")];
  const period = document.getElementById("monitoringPeriod");
  const refresh = document.getElementById("monitoringRefresh");
  const create = document.getElementById("taskCenterCreateToggle");
  const requested = new URL(globalScope.location.href).searchParams.get("monitor");
  let view = views.includes(requested) ? requested : "overview";
  let value = null, serial = 0, loading = false, loadedAt = 0, loadedDays = 0;
  const priority = document.getElementById("monitoringResourceAttention");
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
  const apiSummary = document.getElementById("monitoringApiSummary");
  const apiDetails = document.getElementById("monitoringApiDetails");
  function summaryMetrics(parent, entries) {
    const grid = node("div", "", "monitoring-summary-metrics");
    for (const [label, metric, hint] of entries) {
      const card = node("div"); card.append(node("small", label), node("strong", metric));
      if (hint) card.appendChild(node("small", hint)); grid.appendChild(card);
    }
    parent.appendChild(grid);
  }
  function summaryStatus(parent, label, severity, details) {
    const button = node("button", label, "monitoring-action"); button.type = "button";
    button.dataset.severity = severity;
    button.addEventListener("click", () => { const fold = details?.closest("details"); if (fold) fold.open = true; });
    parent.appendChild(button);
  }
  function render() {
    content.replaceChildren();
    if (apiSummary) {
      apiSummary.replaceChildren(node("h2", "API")); apiDetails?.replaceChildren();
      if (!value) apiSummary.appendChild(node("p", loading ? "正在读取 API 观测…" : "API 数据未取得，状态未知。", "monitoring-note"));
      else {
        const health = value.apiHealth, providers = health?.providers || [];
        const calls = providers.reduce((sum, p) => sum + p.calls24h, 0), failed = providers.reduce((sum,p) => sum+p.failed24h,0);
        const alerts = (value.attention || []).filter(a => a.kind === "api");
        summaryMetrics(apiSummary, [["24 小时调用", health ? number(calls) : "—", "本实例已记录的飞书 API"],
          ["24 小时失败率", calls ? percent(failed / calls * 100) : "—", health ? `${number(failed)} 次失败` : "尚未取得"],
          ["近 5 分钟调用", health ? number(providers.reduce((sum,p) => sum+p.calls5m,0)) : "—", "不发起额外探测"]]);
        const unknown = !health || !health.coverage?.complete || !providers.length || providers.some(p => p.status === "unknown");
        summaryStatus(apiSummary, alerts.length ? `${alerts.length} 项 API 异常 · 查看原因` : unknown ? "API 观测不足 · 查看范围" : "已记录 API 未发现异常",
          alerts.some(a => a.severity === "critical") ? "critical" : alerts.length ? "warning" : "neutral", apiDetails);
        apiSummary.appendChild(node("p", `实例级 · ${time(health?.observedAt)} · 仅覆盖已记录调用`, "monitoring-note"));
      }
    }
    if (priority) {
      priority.replaceChildren(node("h2", "基础资源"));
      if (!value) priority.appendChild(node("p", loading ? "正在读取资源观测…" : "资源查询失败，异常数量未知。点击刷新重试。", "monitoring-note"));
      else priority.appendChild(node("p", `当前实例 · ${time(value.generatedAt)} · 磁盘与账户共享，Token 按所选期间统计`, "monitoring-note"));
    }

    if (!value) { content.appendChild(node("p", t(loading ? "loading" : "failed"), "monitoring-note")); return; }
    const snapshot = node("div", "", "monitoring-snapshot"); snapshot.id = "monitoringSnapshot"; content.appendChild(snapshot);
    snapshot.appendChild(node("h2", t("snapshotTitle"), "monitoring-snapshot-heading"));
    const disks = section("磁盘容量", snapshot); disks.dataset.section = "disks";
    if (!value.disks.length) disks.appendChild(node("p", "尚未取得磁盘数据，状态未知。", "monitoring-note"));
    else table(disks, ["磁盘", "状态", "已用", "可用空间", "inode 已用"], value.disks.map(disk => {
      const badge = node("span", status(disk.status), "monitoring-account-status");
      badge.dataset.status = disk.status === "healthy" ? "available" : disk.status === "critical" ? "exhausted" : disk.status;
      const used = node("span", percent(disk.usedPercent));
      if (["critical", "warning"].includes(disk.status)) { used.className = "monitoring-metric-signal"; used.dataset.severity = disk.status; }
      return [disk.label, badge, used, bytes(disk.availableBytes), percent(disk.inodeUsedPercent)];
    }));
    value.disks.filter(disk => disk.sharedFilesystem).forEach(disk => disks.appendChild(node("p", t("shared", { name: disk.sharedFilesystem }), "monitoring-note")));
    const accounts = section("账户额度", snapshot); accounts.dataset.section = "accounts";
    if (!value.accounts.length) accounts.appendChild(node("p", t("noAccounts"), "monitoring-note"));
    else {
      const summary = node("div", "", "monitoring-account-summary");
      for (const state of ["available", "exhausted", "unknown"]) {
        const count = value.accounts.filter(account => state === "unknown" ? !["available", "exhausted"].includes(account.status) : account.status === state).length;
        const badge = node("span", `${status(state)} ${count}`, "monitoring-account-status"); badge.dataset.status = state; summary.appendChild(badge);
      }
      accounts.appendChild(summary);
      const sortedAccounts = value.accounts.slice().sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
      table(accounts, [t("account"), t("status"), "剩余额度", "最近观测"], sortedAccounts.map(account => {
        const label = node("div", account.label);
        if (account.active) label.appendChild(node("small", t("active"), "monitoring-owner"));
        const badge = node("span", status(account.status), "monitoring-account-status"); badge.dataset.status = account.status;
        const quota = node("div", "", "monitoring-quota-cell");
        for (const window of account.windows) {
          const row = node("div"); row.appendChild(node("span", `${quotaDuration(window)} · ${percent(window.remainingPercent)}`));
          if (Number.isFinite(window.remainingPercent)) { const meter = node("meter"); meter.min = 0; meter.max = 100; meter.value = window.remainingPercent; meter.low = 10; meter.high = 30; meter.optimum = 100; meter.setAttribute("aria-label", `${account.label} ${quotaDuration(window)} 剩余 ${percent(window.remainingPercent)}`); row.appendChild(meter); }
          quota.appendChild(row);
        }
        if (!account.windows.length) quota.appendChild(node("span", t("quotaUnknown")));
        return [label, badge, quota, time(account.observedAt)];
      }));
      const quotaDetails = node("details"); quotaDetails.appendChild(node("summary", "查看各账号重置时间与完整额度"));
      const grid = node("div", "", "monitoring-account-grid"); sortedAccounts.forEach(account => grid.appendChild(accountCard(account)));
      quotaDetails.appendChild(grid); accounts.appendChild(quotaDetails);
      accounts.appendChild(node("p", t("quotaNote"), "monitoring-note"));
    }
    if (value.apiHealth) {
      const api = section("飞书 API", apiDetails || content);
      for (const item of (value.attention || []).filter(a => a.kind === "api")) { const line = node("p", `${item.subject}：${alertDetail(item)}`, "monitoring-alert"); line.dataset.severity = item.severity; api.prepend(line); }
      table(api, ["对象", "状态与处理", "24h窗口调用／失败", "5分钟调用", "最近调用"], value.apiHealth.providers.map(item =>
        [item.label, item.detail, `${item.calls24h}／${item.failed24h}`, item.calls5m, time(item.lastObservedAt)]));
      api.appendChild(node("p", value.apiHealth.coverage.detail, "monitoring-note"));
      const endpoints = value.apiHealth.providers.flatMap(item => item.endpoints.map(endpoint =>
        [item.label, endpoint.endpoint, endpoint.calls, endpoint.failed]));
      if (endpoints.length) table(api, ["对象", "调用最多的接口", "已观察调用", "失败"], endpoints);
      const componentName = component => ({ connector: "聊天与评论", workboard: "进展卡片", display: "副屏飞书提醒" }[component] || component);
      const components = value.apiHealth.providers.flatMap(item => (item.components || []).map(component =>
        [item.label, componentName(component.component), component.calls, component.failed]));
      if (components.length) table(api, ["对象", "调用组件", "24h窗口调用", "失败"], components);
      const hours = value.apiHealth.providers.flatMap(item => (item.hours || []).map(hour => [item.label, time(hour.at), hour.calls, hour.failed]));
      if (hours.length) table(api, ["对象", "记录小时（部分小时不作完整日均）", "调用", "失败"], hours);
      const repeats = value.apiHealth.providers.flatMap(item => (item.duplicateReads || []).map(read =>
        [item.label, componentName(read.component), read.endpoint, read.calls]));
      if (repeats.length) table(api, ["对象", "组件", "5分钟内反复返回相同数据的读取", "次数"], repeats);
      api.appendChild(node("p", "相同读取比较仅覆盖升级后的成功请求，同一进程内使用临时密钥摘要；未记录的历史和进程间重复保留未知。", "monitoring-note"));
      value.apiHealth.providers.forEach(item => api.appendChild(node("p", `${item.label}：日志初次观测 ${time(item.firstObservedAt)}`, "monitoring-note")));
      api.appendChild(node("p", value.apiHealth.tenantQuota ? `企业额度已用 ${percent(value.apiHealth.tenantQuota.usedPercent)}`
        : `${value.apiHealth.tenantQuotaLimit ? `已确认月度上限 ${number(value.apiHealth.tenantQuotaLimit)} 次；` : ""}企业真实剩余额度未知，需管理员后台读数；本地调用数不代表计费用量。`, "monitoring-note"));
    }
    const usage = section("Token 消耗", snapshot); usage.dataset.section = "tokens";
    if (!value.usage) usage.appendChild(node("p", t("noUsage"), "monitoring-note"));
    else {
      const totals = value.usage.totals;
      summaryMetrics(usage, [["期间总用量", number(totals.totalTokens), "Token"],
        ["后台用量", number(totals.backgroundTokens), Number.isFinite(totals.backgroundShare) ? `占总量 ${percent(totals.backgroundShare * 100)}` : "占比未知"],
        ["输入缓存占比", percent(Number.isFinite(totals.cachedInputShare) ? totals.cachedInputShare * 100 : NaN), "已记录输入中的缓存份额"]]);
      usage.appendChild(node("p", `${time(value.usage.window.start)} — ${time(value.usage.window.end)}`, "monitoring-note"));
      const breakdown = node("details"); breakdown.appendChild(node("summary", "查看按模型、前后台和日期的用量")); usage.appendChild(breakdown);
      table(breakdown, [t("model"), t("tokens")], (value.usage.byModel || []).map(item => [item.model || item.key || "—", number(item.totalTokens)]));
      table(breakdown, [t("operation"), t("tokens")], (value.usage.byOperationGroup || []).map(item => [
        (item.operationGroup || item.key) === "background" ? t("background") : (item.operationGroup || item.key) === "foreground" ? t("foreground") : item.label || item.operationGroup || item.key || "—", number(item.totalTokens)]));
      const trend = node("div", "", "monitoring-trend"), days = (value.usage.byDay || []).slice().sort((a, b) => String(a.day || a.key).localeCompare(String(b.day || b.key)));
      const maximum = Math.max(1, ...days.map(day => day.totalTokens));
      trend.setAttribute("aria-label", t("trend"));
      days.forEach(day => {
        const row = node("div"); row.appendChild(node("span", day.day || day.key));
        const meter = node("meter"); meter.min = 0; meter.max = maximum; meter.value = day.totalTokens;
        meter.setAttribute("aria-label", `${day.day || day.key}: ${number(day.totalTokens)} Token`);
        row.appendChild(meter); row.appendChild(node("span", number(day.totalTokens))); trend.appendChild(row);
      }); breakdown.appendChild(trend);
    }
    for (const gap of value.coverage?.gaps || []) {
      const target = gap.source === "usage" ? usage : gap.source === "accounts" ? accounts : gap.source === "fleet" ? disks : null;
      if (target) target.appendChild(node("p", `部分数据未取得（${gap.code || "来源不可用"}），不能据此判断全部正常。`, "monitoring-note"));
    }
  }

  async function load({ silent = false, force = false } = {}) {
    const days = Number(period.value) || 1;
    void globalScope.RemoteLabSessionMonitoring?.load(days, force);
    if (loading && days === loadedDays) return;
    if (!force && value && days === loadedDays && Date.now() - loadedAt < 15000) return;
    const request = ++serial; loading = true; loadedDays = days; refresh.disabled = true;
    if (!silent && !value) render();
    try {
      const response = await fetch(`/api/monitoring/overview?days=${days}`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (request === serial) { value = next; loadedAt = Date.now(); render(); }
    } catch {
      if (request === serial) { value = null; loading = false; render(); }
    } finally { if (request === serial) { loading = false; refresh.disabled = false; } }
  }
  function select(next, { sync = true } = {}) {
    view = next; overview.hidden = view !== "overview"; automations.hidden = view !== "automations";
    if (usage) usage.hidden = view !== "usage";
    if (feedback) feedback.hidden = view !== "feedback";
    create.hidden = view !== "automations";
    tabs.forEach((tab, index) => { const selected = index === views.indexOf(view);
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    });
    if (sync) {
      const url = new URL(globalScope.location.href); url.searchParams.set("tab", "tasks");
      url.searchParams.set("monitor", view);
      globalScope.history.replaceState(null, "", url);
      if (view === "overview") void load();
      else if (view === "usage") void globalScope.RemoteLabUsageAnalysis?.load();
      else if (view === "feedback") void globalScope.RemoteLabProjectFeedback?.load();
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
  refresh.addEventListener("click", () => void load({ force: true }));
  globalScope.addEventListener("remotelab:localechange", () => { if (value) render(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && view === "overview" && document.body.dataset.appView === "tasks") void load({ silent: true });
  });
  globalScope.RemoteLabMonitoring = { isOverview: () => view !== "automations", onTabShown: () => view === "feedback" ? globalScope.RemoteLabProjectFeedback?.load() : view === "usage" ? globalScope.RemoteLabUsageAnalysis?.load() : load({ silent: Boolean(value) }) };
  select(view, { sync: false });
  if (view === "overview" && document.body.dataset.appView === "tasks") void load();
})(window);

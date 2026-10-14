"use strict";

(function attachMonitoring(globalScope) {
  const overview = document.getElementById("monitoringOverview");
  const automations = document.getElementById("monitoringAutomations");
  const content = document.getElementById("monitoringContent");
  if (!overview || !automations || !content) return;
  const test = document.getElementById("monitoringTest");
  const views = ["overview", "usage", "automations", "feedback", ...(test ? ["test"] : [])];
  const feedback = document.getElementById("monitoringFeedback");
  const usage = document.getElementById("monitoringUsage");
  const tabs = [document.getElementById("monitoringOverviewTab"), document.getElementById("monitoringUsageTab"), document.getElementById("monitoringAutomationsTab"), document.getElementById("monitoringFeedbackTab"), ...(test ? [document.getElementById("monitoringTestTab")] : [])];
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
  const handlingOpen = new Map();
  function handlingDetails(key, title) {
    const details = node("details", "", "monitoring-handling"); details.dataset.handling = key;
    details.open = handlingOpen.get(key) === true;
    details.appendChild(node("summary", title));
    details.addEventListener("toggle", () => { if (details.isConnected) handlingOpen.set(key, details.open); });
    return details;
  }
  function handlingGuide(parent, kind) {
    const root = handlingDetails(kind, "何时提醒、怎么处理"); parent.appendChild(root);
    const policy = value?.handling, destinations = policy?.destinations;
    if (!policy) { root.appendChild(node("p", "处理规则尚未读取，暂时无法确认。")); return; }
    const strict = policy.noisePolicy?.mode === "risk_only";
    const rules = {
      disk: ["容量或文件数量占用达到92%，连续两次巡检确认后提醒；可用空间不足20 GiB，或占用达到97%，立即提醒。",
        "先检查可安全清理的缓存和重复副本，处理后复测空间。",
        "需要删除唯一数据、迁移或扩容时，先列出对象、影响和恢复办法，等你确认。"],
      service: ["服务连续五次巡检失败才提醒；启动中、计划停用不算故障。",
        "先查退出原因和依赖，在固定处理会话中修复。",
        "重启可能打断任务时先请你确认；缺权限时明确说明需要什么。"],
      api: ["5分钟内至少10次失败、失败比例达到50%，连续三次巡检确认后提醒。新出现额度拒绝且消息发送未恢复时也会提醒；只有调用量高或响应慢不推送。",
        "读取已有调用日志，找出失败接口和调用来源；目前提供诊断，不自动停业务或购买额度。",
        "需要管理员核对额度时说明所需信息；扩容、停业务或换应用先请你确认。"],
      accountContinuity: ["剩余不高于10%，且无可用备用、未开启切换或切换仍未完成，连续三次巡检确认后提醒。正常用完、暂时读不到额度不报耗尽。",
        "剩余20%时准备备用；开启自动切换后，在10%预留线切换后续请求，在途任务继续运行。",
        "没有备用时，需要你登录已获授权的账号或选择等待重置。"],
      automation: ["重要任务连续三次巡检确认失败后提醒；暂停、条件未满足和已经完成不算故障。",
        "回到原执行会话，先查产物和送达回执，只补失败步骤。",
        "需要批准或补充资料时，会写清具体动作；点击查看不等于批准。"],
      coverage: ["数据过期或读取失败会在页面标明，不当作正常，也不单独反复推送。",
        "检查采集时间和送达回执；发送结果不确定时先核对原消息。",
        "确需登录或授权时，会明确说明需要你完成哪一步。"],
      usage: ["用量高、任务运行时间长，本身不会触发预警。",
        "结合任务进度、产物和错误排查，不自动中断任务或更换模型。",
        "需要调整预算或停止业务时，先向你说明影响和可选方案。"],
    };
    const inherited = policy.policies?.find(p => p.kind === kind);
    const rows = rules[kind];
    const warning = strict ? rows[0] : inherited?.warning || "容量或文件数量占用达到85%标为预警、92%标为严重；系统盘可用不足15／8 GiB同样标记。通知按当前实例配置确认。";
    for (const [label, text] of [["什么时候提醒", warning], ["系统怎么处理", rows[1]], ["什么时候需要你", rows[2]]]) {
      const p = node("p"); p.append(node("strong", `${label}：`), document.createTextNode(text)); root.appendChild(p);
    }
    if (["disk", "service", "automation"].includes(kind)) root.appendChild(node("p",
      (kind === "automation" ? policy.automationRecoveryEnabled : policy.recoveryEnabled)
        ? "自动补救已开启；有明确处理方案或资料请求时，会直接提醒你。"
        : "自动补救未开启；以上是处理规则，当前不会自动执行。", "monitoring-note"));
    const place = ["disk", "service"].includes(kind) ? destinations?.resources
      : kind === "api" ? destinations?.api : kind === "accountContinuity" ? destinations?.account : null;
    if (place?.summary) root.appendChild(node("p", `处理结果：${place.summary.label}。补救过程和结果更新同一张卡。`, "monitoring-note"));
    if (place?.sessionId) {
      const link = node("a", "打开处理会话"); link.href = `/?session=${encodeURIComponent(place.sessionId)}`; root.appendChild(link);
    }
    if (kind === "coverage") root.appendChild(node("p", destinations?.alert?.enabled
      ? `告警接收：${destinations.alert.label}。`
      : "当前告警推送暂停；后台检查与已开启的补救继续运行。", "monitoring-note"));
    if (kind === "automation" && destinations?.automations?.length) table(root, ["任务", "处理会话", "结果发到哪里"], destinations.automations.map(task => {
      const entry = task.sessionId ? node("a", "打开原会话") : node("span", "尚无执行会话");
      if (task.sessionId) entry.href = `/?session=${encodeURIComponent(task.sessionId)}`;
      const report = node("div", task.delivery.label);
      report.appendChild(node("small", `补救摘要：${task.summary?.label || "位置待核实"}`, "monitoring-owner"));
      return [task.title, entry, report];
    }));
    const repairs = (value.recovery || []).filter(r => r.kind === kind).sort((a, b) => Number(Boolean(b.currentIssue)) - Number(Boolean(a.currentIssue))
      || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    for (const repair of repairs) {
      const detail = handlingDetails(`record:${kind}:${repair.key || repair.id}`, `${repair.subject} · ${repair.label}`);
      detail.appendChild(node("p", `${time(repair.updatedAt)} · ${repair.reason || repair.summary || repair.label}`, "monitoring-note"));
      if (repair.error && repair.status === "blocked") detail.appendChild(node("p", `执行错误：${repair.error}`, "monitoring-note"));
      if (repair.plan) table(detail, ["处置方案", "内容"], [["执行条件", repair.plan.requiresConfirmation ? "等待你确认" : "低风险自行处理"],
        ["步骤", repair.plan.summary], ["对象", repair.plan.target], ["影响", repair.plan.impact], ["恢复方式", repair.plan.rollback], ["验收", repair.plan.verification]]);
      if (repair.sessionId) { const link = node("a", "查看这次处理记录"); link.href = `/?session=${encodeURIComponent(repair.sessionId)}`; detail.appendChild(link); }
      root.appendChild(detail);
    }
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
  function summaryMetrics(parent, entries) {
    const grid = node("div", "", "monitoring-summary-metrics");
    for (const [label, metric, hint] of entries) {
      const card = node("div"); card.append(node("small", label), node("strong", metric));
      if (hint) card.appendChild(node("small", hint)); grid.appendChild(card);
    }
    parent.appendChild(grid);
  }
  function renderAccounts(parent, data) {
    const accounts = section("账户余额", parent); accounts.dataset.section = "accounts";
    if (!data.accounts.length) accounts.appendChild(node("p", t("noAccounts"), "monitoring-note"));
    else {
      const summary = node("div", "", "monitoring-account-summary");
      for (const state of ["available", "exhausted", "unknown"]) {
        const count = data.accounts.filter(account => state === "unknown" ? !["available", "exhausted"].includes(account.status) : account.status === state).length;
        const badge = node("span", `${status(state)} ${count}`, "monitoring-account-status"); badge.dataset.status = state; summary.appendChild(badge);
      }
      accounts.appendChild(summary);
      const sortedAccounts = data.accounts.slice().sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
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
    return accounts;
  }

  const testState = {};
  let testLoading = false, testLoadedAt = 0;
  async function loadTest({ force = false } = {}) {
    if (!test || testLoading || (!force && Date.now() - testLoadedAt < 15000)) return;
    testLoading = true;
    const button = document.getElementById("monitoringTestRefresh");
    button.disabled = true;
    const dashboard = document.getElementById("monitoringTestDashboard");
    const accounts = document.getElementById("monitoringTestAccounts");
    for (const fold of dashboard.querySelectorAll("[data-agent-fold]")) testState[fold.dataset.agentFold] = fold.open;
    const accountsOpen = accounts.querySelector("details")?.open === true;
    const read = async path => {
      const response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return response.json();
    };
    const results = await Promise.allSettled([
      read("/api/monitoring/sessions?days=7&compact=1&dashboard=1"),
      read("/api/monitoring/overview?days=7"),
    ]);
    try {
      const [sessionsResult, accountsResult] = results;
      if (sessionsResult.status === "fulfilled") globalScope.RemoteLabAgentDashboard.render(dashboard, sessionsResult.value.agentDashboard, { state: testState });
      else dashboard.replaceChildren(node("p", "运行指标读取失败，请刷新重试。", "monitoring-note"));
      accounts.replaceChildren();
      if (accountsResult.status === "fulfilled") {
        const data = accountsResult.value;
        const section = renderAccounts(accounts, data);
        const fold = section.querySelector("details"); if (fold) fold.open = accountsOpen;
        for (const gap of data.coverage?.gaps || []) if (gap.source === "accounts") section.appendChild(node("p", "部分账号额度未取得，不能据此判断全部正常。", "monitoring-note"));
      } else accounts.appendChild(node("p", "账号额度读取失败，请刷新重试。", "monitoring-note"));
      if (results.every(result => result.status === "fulfilled")) testLoadedAt = Date.now();
    } finally { testLoading = false; button.disabled = false; }
  }

  function render() {
    automations.querySelector('[data-handling="automation"]')?.remove();
    if (value) {
      const guide = node("div"); handlingGuide(guide, "automation"); automations.prepend(guide.firstChild);
    }
    content.replaceChildren();
    if (priority) {
      priority.replaceChildren(node("h2", "账户与用量"));
      if (!value) priority.appendChild(node("p", loading ? "正在读取资源观测…" : "资源查询失败，异常数量未知。点击刷新重试。", "monitoring-note"));
      else priority.appendChild(node("p", `当前实例 · ${time(value.generatedAt)} · 账户剩余额度与所选期间 Token 总数`, "monitoring-note"));
    }

    if (!value) { content.appendChild(node("p", t(loading ? "loading" : "failed"), "monitoring-note")); return; }
    const snapshot = node("div", "", "monitoring-snapshot"); snapshot.id = "monitoringSnapshot"; content.appendChild(snapshot);
    const accounts = renderAccounts(snapshot, value);
    const usage = section("Token 总数", snapshot); usage.dataset.section = "tokens";
    if (!value.usage) usage.appendChild(node("p", t("noUsage"), "monitoring-note"));
    else {
      const totals = value.usage.totals;
      summaryMetrics(usage, [["所选期间 Token 总数", number(totals.totalTokens), "Token · 含前台与后台"]]);
      usage.appendChild(node("p", `${time(value.usage.window.start)} — ${time(value.usage.window.end)} · 已记录的模型输入与输出合计。`, "monitoring-note"));
    }
    for (const gap of value.coverage?.gaps || []) {
      const target = gap.source === "usage" ? usage : gap.source === "accounts" ? accounts : null;
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
    if (test) test.hidden = view !== "test";
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
      else if (view === "test") void loadTest();
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
  document.getElementById("monitoringTestRefresh")?.addEventListener("click", () => void loadTest({ force: true }));
  period.addEventListener("change", () => { value = null; void load(); });
  refresh.addEventListener("click", () => void load({ force: true }));
  globalScope.addEventListener("remotelab:localechange", () => { if (value) render(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && view === "test" && document.body.dataset.appView === "tasks") void loadTest();
    if (!document.hidden && view === "overview" && document.body.dataset.appView === "tasks") void load({ silent: true });
  });
  globalScope.RemoteLabMonitoring = { loadHandling: () => load({ silent: Boolean(value) }), isOverview: () => view !== "automations", onTabShown: () => view === "test" ? loadTest() : view === "feedback" ? globalScope.RemoteLabProjectFeedback?.load() : view === "usage" ? globalScope.RemoteLabUsageAnalysis?.load() : load({ silent: Boolean(value) }) };
  select(view, { sync: false });
  if (view === "test" && document.body.dataset.appView === "tasks") void loadTest();
  if (view === "overview" && document.body.dataset.appView === "tasks") void load();
})(window);

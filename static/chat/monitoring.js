"use strict";

(function attachMonitoring(globalScope) {
  const portal = globalScope.__REMOTELAB_BOOTSTRAP__?.monitoringPortal;
  const portalQuery = new URL(globalScope.location.href).searchParams;
  const management = portalQuery.get('monitor') === 'automations' || portalQuery.get('manage') === '1';
  if (portal?.url && !portal.preview && !management) {
    const target = new URL(portal.url);
    const routes = { overview: 'overview', test: 'overview', usage: 'usage', feedback: 'labor', security: 'safety' };
    target.searchParams.set('tab', routes[portalQuery.get('monitor')] || 'overview');
    if (portalQuery.get('monitor') === 'feedback') target.searchParams.set('portfolio', 'claude-tag');
    const panel = document.getElementById('taskCenterPanel');
    panel?.replaceChildren(Object.assign(document.createElement('h2'), {textContent:'监管中心'}),
      Object.assign(document.createElement('a'), {href:target.href,textContent:'打开统一监管中心 →'}));
    const open = () => globalScope.location.assign(target.href);
    globalScope.RemoteLabMonitoring = {onTabShown:open,isOverview:()=>true,loadHandling:()=>{}};
    if (portalQuery.get('tab') === 'tasks') open();
    return;
  }
  if (portal?.url && !portal.preview && management) {
    const panel = document.getElementById('taskCenterPanel');
    const back = Object.assign(document.createElement('a'), {href:portal.url,textContent:'← 返回监管中心'});
    back.className='monitoring-note';panel?.prepend(back);
    // Retain original authenticated action tools, not a second dashboard.
    const nav = panel?.querySelector('.monitoring-tabs');if(nav){nav.hidden=true;nav.style.display='none';}
  }
  const overview = document.getElementById("monitoringOverview");
  const automations = document.getElementById("monitoringAutomations");
  const content = document.getElementById("monitoringContent");
  if (!overview || !automations || !content) return;
  const security = document.getElementById("monitoringSecurity");
  const views = ["overview", "usage", "automations", "feedback", ...(security ? ["security"] : [])];
  const feedback = document.getElementById("monitoringFeedback");
  const usage = document.getElementById("monitoringUsage");
  const tabs = [document.getElementById("monitoringOverviewTab"), document.getElementById("monitoringUsageTab"), document.getElementById("monitoringAutomationsTab"), document.getElementById("monitoringFeedbackTab"), ...(security ? [document.getElementById("monitoringSecurityTab")] : [])];
  const refresh = document.getElementById("monitoringRefresh");
  const create = document.getElementById("taskCenterCreateToggle");
  const requested = new URL(globalScope.location.href).searchParams.get("monitor");
  let view = views.includes(requested) ? requested : "overview";
  let value = null;
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
        label.appendChild(node("small", `更新于 ${time(account.observedAt)}`, "agent-account-observed-mobile"));
        if (account.active) label.appendChild(node("small", t("active"), "monitoring-owner"));
        const badge = node("span", status(account.status), "monitoring-account-status"); badge.dataset.status = account.status;
        const quota = node("div", "", "monitoring-quota-cell");
        for (const window of account.windows) {
          const row = node("div"); row.appendChild(node("span", `${quotaDuration(window)} · ${percent(window.remainingPercent)}`));
          if (Number.isFinite(window.remainingPercent)) { const meter = node("meter"); meter.min = 0; meter.max = 100; meter.value = window.remainingPercent; meter.low = 10; meter.high = 30; meter.optimum = 100; meter.setAttribute("aria-label", `${account.label} ${quotaDuration(window)} 剩余 ${percent(window.remainingPercent)}`); row.appendChild(meter); }
          row.appendChild(node("small", t("windowReset", { time: time(window.resetsAt) }), "monitoring-quota-reset"));
          quota.appendChild(row);
        }
        if (!account.windows.length) quota.appendChild(node("span", t("quotaUnknown")));
        return [label, badge, quota, time(account.observedAt)];
      }));
      accounts.appendChild(node("p", t("quotaNote"), "monitoring-note"));
    }
    return accounts;
  }

  const current = { dashboard: document.getElementById("monitoringSessions"), accounts: node("div"), button: refresh, state: { sources: true }, loadedAt: 0 };
  current.accounts.id = "monitoringSnapshot";
  current.accounts.className = "monitoring-snapshot";
  document.getElementById("monitoringResourcePanel").hidden = true;
  async function load({ force = false } = {}) {
    if (!current.dashboard || current.loading || (!force && Date.now() - current.loadedAt < 15000)) return;
    current.loading = true;
    const { button, dashboard, accounts, state } = current;
    button.disabled = true;
    if (!dashboard.childElementCount) dashboard.appendChild(node("p", "正在读取监控数据…", "monitoring-note"));
    for (const fold of dashboard.querySelectorAll("[data-agent-fold]")) state[fold.dataset.agentFold] = fold.open;
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
      accounts.replaceChildren();
      if (accountsResult.status === "fulfilled") {
        const data = accountsResult.value;
        const section = renderAccounts(accounts, data);
        for (const gap of data.coverage?.gaps || []) if (gap.source === "accounts") section.appendChild(node("p", "部分账号额度未取得，不能据此判断全部正常。", "monitoring-note"));
      } else accounts.appendChild(node("p", "账号额度读取失败，请刷新重试。", "monitoring-note"));
      globalScope.RemoteLabAgentDashboard.render(dashboard,
        sessionsResult.status === "fulfilled" ? sessionsResult.value.agentDashboard : null, { state });
      dashboard.append(accounts);
      if (accountsResult.status === "fulfilled") { value = accountsResult.value; render(); }
      if (results.every(result => result.status === "fulfilled")) current.loadedAt = Date.now();
    } finally { current.loading = false; button.disabled = false; }
  }

  function render() {
    automations.querySelector('[data-handling="automation"]')?.remove();
    if (value) {
      const guide = node("div"); handlingGuide(guide, "automation"); automations.prepend(guide.firstChild);
    }
  }
  let reviewOffset = 0, reviewSeverity = '', reviewState = '', reviewLoading = false, reviewReload = false;
  const reviewFolds = new Map();
  const reviewLabels = { none: '未发现具体风险', low: '低', medium: '中', high: '高', critical: '严重',
    reviewed: '已审', pending: '待审', failed: '失败', running: '批审中', incomplete: '尚未审完',
    completed: '当前快照已审完', not_started: '尚未开始', interrupted: '批审中断', disabled: '未启用' };
  async function loadSecurity() {
    const content = document.getElementById('promptReviewContent');
    if (!content) return;
    if (reviewLoading) { reviewReload = true; return; }
    reviewLoading = true;
    for (const d of content.querySelectorAll('[data-review-fold]')) reviewFolds.set(d.dataset.reviewFold, d.open);
    try {
      const query = new URLSearchParams({ offset: reviewOffset, severity: reviewSeverity, state: reviewState });
      const response = await fetch(`/api/monitoring/prompt-review?${query}`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (query.toString() !== new URLSearchParams({ offset: reviewOffset, severity: reviewSeverity, state: reviewState }).toString()) { reviewReload = true; return; }
      content.replaceChildren();
      const summary = section('Prompt 安全审阅', content), c = data.coverage || {}, u = data.usage || {};
      summary.append(node('p', `${reviewLabels[data.state] || data.state}${data.workerRunning ? ' · 工作进程运行中' : ''} · ${data.model} · ${data.ruleVersion}`));
      summary.append(node('p', '模型提出的风险线索，需结合原会话核对授权与实际后果。审阅不会执行整改。', 'monitoring-note'));
      summary.append(node('p', `原文来源 ${c.sources || 0} 条：完整审完 ${c.fullyReviewed || 0}，部分或待审 ${c.partialOrPending || 0}，无法读取 ${c.unreadable || 0}。`, 'monitoring-note'));
      summary.append(node('p', `去重内容段 ${c.uniqueSegments || 0}：已审 ${c.reviewed || 0}，待审 ${c.pending || 0}，失败 ${c.failed || 0}；复用 ${c.deduplicatedOccurrences || 0} 次。`, 'monitoring-note'));
      summary.append(node('p', `内容段风险：严重 ${data.risks?.critical || 0} · 高 ${data.risks?.high || 0} · 中 ${data.risks?.medium || 0} · 低 ${data.risks?.low || 0}。同一内容段只计一次。`, 'monitoring-note'));
      summary.append(node('p', `实测输入 ${u.inputTokens ?? '—'} token（缓存 ${u.cachedInputTokens ?? '—'}），输出 ${u.outputTokens ?? '—'}；${u.measuredCalls || 0}/${u.calls || 0} 次调用有用量回执；调用累计 ${(Number(u.elapsedMs || 0) / 60000).toFixed(1)} 分钟。`, 'monitoring-note'));
      summary.append(node('p', `扫描 ${time(data.scannedAt)} · 更新 ${time(data.updatedAt)} · 增量任务 ${data.config?.scheduleId || '尚未登记'}。页面读取不会调用模型。`, 'monitoring-note'));
      document.getElementById('promptReviewRun').disabled = !data.config?.enabled || data.workerRunning;
      const scope = node('details'); scope.dataset.reviewFold = 'scope'; scope.open = reviewFolds.get('scope') === true;
      scope.append(node('summary', '覆盖来源、缺口与审阅边界'));
      (data.notes || []).forEach(note => scope.append(node('p', note, 'monitoring-note')));
      (c.bySource || []).forEach(s => scope.append(node('p', `${s.kind}：${s.sources} 条`, 'monitoring-note')));
      if (c.gaps?.length) scope.append(node('pre', c.gaps.map(g => `${g.kind} ${g.runId || ''} ${g.reason}`).join('\n')));
      summary.append(scope);
      const results = section('风险条目与待处理内容', content), controls = node('div', '', 'monitoring-toolbar');
      for (const [label, values, selected, change] of [
        ['风险级别', ['', 'critical', 'high', 'medium', 'low', 'none'], reviewSeverity, value => { reviewSeverity = value; }],
        ['审阅状态', ['', 'reviewed', 'failed', 'pending'], reviewState, value => { reviewState = value; }],
      ]) {
        const l = node('label', `${label} `), select = node('select'); select.setAttribute('aria-label', label);
        for (const value of values) { const option = node('option', value ? reviewLabels[value] : '全部'); option.value = value; select.append(option); }
        select.value = selected; select.addEventListener('change', () => { change(select.value); reviewOffset = 0; void loadSecurity(); });
        l.append(select); controls.append(l);
      }
      results.append(controls);
      for (const row of data.rows || []) {
        const d = node('details', '', 'monitoring-summary-panel'); d.dataset.reviewFold = row.id; d.open = reviewFolds.get(row.id) === true;
        d.append(node('summary', `${reviewLabels[row.state]} · ${row.state === 'reviewed' ? reviewLabels[row.severity] : row.error || '等待批审'} · ${row.source.kind} · 复用 ${row.occurrences} 次`));
        const original = node('a', '查看脱敏原文与指纹'); original.href = `/api/monitoring/prompt-review/source?id=${encodeURIComponent(row.source.id)}`; original.target = '_blank'; original.rel = 'noopener'; d.append(original);
        if (row.source.sessionId) { const a = node('a', ' · 打开原会话'); a.href = `/?session=${encodeURIComponent(row.source.sessionId)}`; d.append(a); }
        d.append(node('p', `${row.source.runId || '后台调用'} · ${row.source.field || row.source.delivery || ''} · 段起始行 ${row.source.startLine} · 尝试 ${row.attempts} 次 · ${time(row.reviewedAt)}`, 'monitoring-note'));
        for (const f of row.findings) {
          d.append(node('p', `${reviewLabels[f.severity]} · ${f.category} · 原文行 ${row.source.startLine + f.startLine - 1}–${row.source.startLine + f.endLine - 1}：${f.reason}`), node('blockquote', f.evidence), node('p', `建议：${f.recommendation}`));
        }
        if (row.state === 'failed') d.append(node('p', '未计为通过；按批次自动退避重试，累计三次失败后保留错误，需排查后重置该条结果。', 'monitoring-note'));
        results.append(d);
      }
      if (!data.rows?.length) results.append(node('p', '当前筛选没有记录。'));
      const paging = node('div', '', 'monitoring-toolbar');
      for (const [label, offset, disabled] of [['上一页', Math.max(0, reviewOffset - 50), reviewOffset === 0], ['下一页', reviewOffset + 50, reviewOffset + 50 >= data.total]]) {
        const button = node('button', label, 'task-center-action'); button.type = 'button'; button.disabled = disabled;
        button.addEventListener('click', () => { reviewOffset = offset; void loadSecurity(); }); paging.append(button);
      }
      paging.append(node('span', `${data.total} 段 · 第 ${Math.floor(reviewOffset / 50) + 1} 页`)); results.append(paging);
    } catch { content.replaceChildren(node('p', '审阅状态读取失败，请刷新重试；不能据此判断安全。', 'monitoring-note')); }
    finally { reviewLoading = false; if (reviewReload) { reviewReload = false; void loadSecurity(); } }
  }
  function select(next, { sync = true } = {}) {
    view = next; overview.hidden = view !== "overview"; automations.hidden = view !== "automations";
    if (security) security.hidden = view !== "security";
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
      else if (view === "security") void loadSecurity();
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
  document.getElementById('promptReviewRefresh')?.addEventListener('click', () => void loadSecurity());
  document.getElementById('promptReviewRun')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const response = await fetch('/api/monitoring/prompt-review/run', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('launch failed');
      await loadSecurity();
    } catch { document.getElementById('promptReviewContent').append(node('p', '补审启动未确认，请先刷新核对进程状态。')); }
  });
  refresh.addEventListener("click", () => void load({ force: true }));
  globalScope.addEventListener("remotelab:localechange", () => { if (view === "overview") void load({ force: true }); else if (value) render(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && view === 'security' && document.body.dataset.appView === 'tasks') void loadSecurity();
    if (!document.hidden && view === "overview" && document.body.dataset.appView === "tasks") void load({ silent: true });
  });
  globalScope.RemoteLabMonitoring = { loadHandling: () => load({ silent: Boolean(value) }), isOverview: () => view !== "automations", onTabShown: () => view === 'security' ? loadSecurity() : view === "feedback" ? globalScope.RemoteLabProjectFeedback?.load() : view === "usage" ? globalScope.RemoteLabUsageAnalysis?.load() : load({ silent: Boolean(value) }) };
  // Preserve old bookmarks without retaining a second dashboard or extra load.
  if (requested === "test") {
    const url = new URL(globalScope.location.href); url.searchParams.set("monitor", "overview");
    globalScope.history.replaceState(null, "", url);
  }
  select(view, { sync: false });
  if (view === 'security' && document.body.dataset.appView === 'tasks') void loadSecurity();
  if (view === "overview" && document.body.dataset.appView === "tasks") void load();
})(window);

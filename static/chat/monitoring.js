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
  function handlingGuide(parent) {
    const root = section("预警与自动补救", parent); root.dataset.section = "handling";
    const policy = value.handling;
    root.appendChild(node("p", !policy ? "处置配置尚未取得，执行状态未知。" : policy.recoveryEnabled
      ? "自动补救已启用。低风险、已有授权且可验证的动作自行执行；中高风险先给出具体方案，等待人在处理会话确认。"
      : "自动补救未启用；以下为预警与补救规则，不代表已经执行。", "monitoring-note"));
    const resourceEntry = node("div");
    if (policy?.coordinatorSessionId) {
      const link = node("a", "打开固定补救会话"); link.href = `/?session=${encodeURIComponent(policy.coordinatorSessionId)}`;
      resourceEntry.append(link, node("small", "磁盘、服务补救沿用此会话，保留每次执行与确认记录。", "monitoring-owner"));
    } else resourceEntry.textContent = "尚未配置固定补救会话";
    const automationEntry = node("div"), link = node("a", "查看自动化执行记录");
    link.href = "/?tab=tasks&monitor=automations"; automationEntry.append(link,
      node("small", policy?.automationRecoveryEnabled ? "已配置任务范围；失败补救回到该任务的执行会话。" : "自动化失败补救未启用。", "monitoring-owner"));
    const guides = [
      ["磁盘", "容量或 inode 达到85%预警、92%严重；系统盘可用不足15 GiB／8 GiB同样触发。受阻后继续恶化会升级。",
        "先核对已有清理和安全候选；只处理符合现行流程的可重建缓存、已核验重复副本，并复测。删除唯一数据、迁移或扩容先给方案待确认。", resourceEntry],
      ["账号连续性", "正常消耗和耗尽只记录；20%检查备用准备。没有可用备用、无法采集或切换持续未完成才提醒。",
        "自动切换开启时，10%切换后续请求到已登录且额度高于10%的本地备用；确已耗尽时可用正余额账号兜底。在途任务保留原账号。",
        "后台切换器直接执行；本页账户额度显示开关、备用数量和最近切换，不另开 AI 会话。"],
      ["自动化失败", "核对真实失败和当前任务状态；已停用或已结束的任务不重新启动。",
        "先检查原产物和回执，只补失败步骤；结果不确定的发送先核实。中高风险动作在原处理会话确认。", automationEntry],
    ];
    const cards = node("div", "", "monitoring-account-grid");
    for (const [title, warning, remedy, destination] of guides) {
      const card = node("article", "", "monitoring-account"); card.appendChild(node("h4", title));
      for (const [label, description] of [["预警说明", warning], ["补救说明", remedy], ["执行与记录", destination]]) {
        const paragraph = node("div"); paragraph.appendChild(node("strong", label));
        paragraph.appendChild(description?.nodeType ? description : node("p", description)); card.appendChild(paragraph);
      }
      cards.appendChild(card);
    }
    root.appendChild(cards);
    root.appendChild(node("p", "待确认方案会列出具体对象、步骤、影响、恢复方式和验收办法。下方记录来自实际补救状态；任务结束不等于风险已经解除。", "monitoring-note"));
    const repairs = (value.recovery || []).slice().sort((a, b) => Number(Boolean(b.currentIssue)) - Number(Boolean(a.currentIssue))
      || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const history = node("details"); history.appendChild(node("summary", `补救记录（${repairs.length}）`));
    if (!repairs.length) history.appendChild(node("p", "尚无已记录的补救。", "monitoring-note"));
    for (const repair of repairs) {
      const detail = node("details"); detail.appendChild(node("summary", `${repair.subject} · ${repair.label}`));
      detail.appendChild(node("p", `最近更新：${time(repair.updatedAt)} · ${repair.reason || repair.label}`, "monitoring-note"));
      if (repair.error && repair.status === "blocked") detail.appendChild(node("p", `执行错误：${repair.error}`, "monitoring-note"));
      if (repair.summary) detail.appendChild(node("p", `已记录检查：${repair.summary}`, "monitoring-note"));
      if (repair.plan) table(detail, ["处置方案", "内容"], [["执行条件", repair.plan.requiresConfirmation ? "等待人确认" : "低风险自行处理"],
        ["步骤", repair.plan.summary], ["对象", repair.plan.target], ["影响", repair.plan.impact], ["恢复方式", repair.plan.rollback], ["验收", repair.plan.verification]]);
      if (repair.sessionId) { const entry = node("a", "查看这次补救的处理会话"); entry.href = `/?session=${encodeURIComponent(repair.sessionId)}`; detail.appendChild(entry); }
      history.appendChild(detail);
    }
    root.appendChild(history);
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
  const svgNode = (tag, attrs = {}) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    return element;
  };
  function capacityRing(value, label, severity) {
    const valid = Number.isFinite(value) && value >= 0 && value <= 100;
    const wrap = node('div', '', 'monitoring-capacity-ring');
    wrap.dataset.severity = severity || 'healthy';
    const svg = svgNode('svg', { viewBox: '0 0 88 88', role: 'img', 'aria-label': `${label} ${valid ? percent(value) : '未知'}` });
    svg.appendChild(svgNode('circle', { cx: 44, cy: 44, r: 35, class: 'monitoring-ring-track' }));
    if (valid) svg.appendChild(svgNode('circle', { cx: 44, cy: 44, r: 35, class: 'monitoring-ring-value',
      pathLength: 100, 'stroke-dasharray': `${value} 100`, transform: 'rotate(-90 44 44)' }));
    wrap.append(svg, node('strong', valid ? percent(value) : '—'));
    return wrap;
  }
  function trendChart(parent, trend, { key, title, unit, description, samples }) {
    const card = node('section', '', 'monitoring-line-card'); card.dataset.metric = key;
    card.appendChild(node('h4', title));
    const days = trend.days || [], valid = days.filter(day => Number.isFinite(day[key]));
    const latest = days.at(-1), headline = node('div', '', 'monitoring-line-headline');
    headline.append(node('strong', number(latest?.[key])), node('small', `今日 · ${unit} · 截至 ${time(trend.end)}`));
    card.appendChild(headline);
    const svg = svgNode('svg', { viewBox: '0 0 400 155', role: 'img', 'aria-label': `${title}，${unit}；${description}。无记录日期留空，逐日数据见下方展开表。` });
    const maximum = Math.max(1, ...valid.map(day => day[key]));
    const x = index => 38 + index * 57, y = value => 113 - value / maximum * 83;
    for (const ratio of [0, .5, 1]) {
      const yy = y(ratio * maximum);
      svg.appendChild(svgNode('line', { x1: 38, y1: yy, x2: 380, y2: yy, class: 'monitoring-chart-grid' }));
      const label = svgNode('text', { x: 32, y: yy + 4, 'text-anchor': 'end' }); label.textContent = number(ratio * maximum); svg.appendChild(label);
    }
    let path = '', connected = false;
    days.forEach((day, i) => {
      const label = svgNode('text', { x: x(i), y: 139, 'text-anchor': 'middle' }); label.textContent = day.day.slice(5); svg.appendChild(label);
      if (!Number.isFinite(day[key])) { connected = false; return; }
      path += `${connected ? 'L' : 'M'}${x(i)},${y(day[key])} `; connected = true;
    });
    svg.appendChild(svgNode('path', { d: path, class: 'monitoring-chart-line' }));
    days.forEach((day, i) => {
      if (!Number.isFinite(day[key])) return;
      const dot = svgNode('circle', { cx: x(i), cy: y(day[key]), r: 4, class: 'monitoring-chart-point' });
      const tooltip = svgNode('title'); tooltip.textContent = `${day.day}：${day[key].toLocaleString()} ${unit}；${samples(day)}`;
      dot.appendChild(tooltip); svg.appendChild(dot);
    });
    card.appendChild(svg);
    card.appendChild(node('p', `${valid.length}/7 天有样本 · ${description}`, 'monitoring-note'));
    const details = node('details'); details.appendChild(node('summary', '查看逐日数值与样本'));
    table(details, ['日期（UTC）', unit, '样本'], days.map(day => [day.day,
      Number.isFinite(day[key]) ? day[key].toLocaleString() : '无样本', samples(day)]));
    card.appendChild(details); parent.appendChild(card);
  }
  function renderSessionTrends() {
    const root = document.getElementById('monitoringSessionTrends'); if (!root) return;
    root.replaceChildren(node('h3', '近 7 天走势'));
    const trend = value?.usage?.dailyTrend;
    if (!trend) { root.appendChild(node('p', loading ? '正在读取历史记录…' : '历史记录未取得，不能判断为零。', 'monitoring-note')); return; }
    root.appendChild(node('p', `${trend.start.slice(0, 10)} — ${trend.end.slice(0, 10)} · UTC 自然日，今天未结束。按运行结束／账本记账日期归集，不等同于当天实际调用分摊；未回传部分不计入。`, 'monitoring-note'));
    const grid = node('div', '', 'monitoring-line-grid'); root.appendChild(grid);
    trendChart(grid, trend, { key: 'sessionCount', title: '有用量记录的 Session', unit: '个',
      description: '当日去重数，含前后台；不是历史 Session 总数', samples: day => `${day.runCount} 次运行记录` });
    trendChart(grid, trend, { key: 'avgContextTokens', title: '平均上下文', unit: 'Token / 运行',
      description: '前台运行最近回传值的均值；不是注入字节数', samples: day => `${day.contextSamples} / ${day.foregroundRuns} 次前台运行有回传` });
  }

  function renderScope() {
    const root = document.getElementById("monitoringScope");
    if (!root) return;
    const wasOpen = root.querySelector("details")?.open || false;
    root.replaceChildren(node("h2", "检查范围与开销"));
    if (!value) { root.appendChild(node("p", "检查配置尚未取得，不能确认后台巡检是否运行。", "monitoring-note")); return; }
    const observation = value.observation || {};
    const cadence = observation.cadenceSeconds === 60 ? "每分钟" : "频率待核实";
    const live = observation.configured && observation.status === "healthy";
    const check = !observation.configured ? "尚未确认后台巡检配置"
      : live ? `后台巡检：${cadence}` : "后台巡检未确认正常运行";
    root.appendChild(node("p", `${check} · 最近完成 ${time(observation.lastObservedAt)}。页面统计在打开或刷新时查询，切回页面时按需更新。`, "monitoring-note"));
    if (live && observation.cadenceSeconds && Number.isFinite(Date.parse(observation.lastObservedAt))
      && Date.now() - Date.parse(observation.lastObservedAt) > observation.cadenceSeconds * 3000) {
      root.appendChild(node("p", "最近巡检记录已超过三个检查周期，请核查后台是否正常完成。", "monitoring-note"));
    }
    const details = node("details"); details.open = wasOpen;
    details.appendChild(node("summary", "查看检查内容、频率和消耗怎么算"));
    const checks = [
      [`服务（${value.services?.length ?? "—"} 项）、磁盘（${value.disks?.length ?? "—"} 项）、自动化任务`, live ? `${cadence}巡检，也可页面查询` : "页面可查询；后台状态待核实", "本机服务状态、磁盘和任务记录；普通检查不调用模型"],
      ["账号额度", "巡检或页面查询时读取已有观测", "额度采集器提供数据；各账号时间不同，以最近观测为准"],
      ["飞书 API", "巡检或页面查询时汇总日志", "读取已记录调用与失败，不为检查额外调用飞书；不等于企业账单"],
      ["Session 与 Token 用量", "打开、刷新或切回页面时按需查询", "执行记录及用量账本；页面展示不启动模型"],
      ["异常提醒与补救", "发现符合条件的新故障时触发", observation.recoveryEnabled ? "提醒可能调用飞书，自动补救可能调用模型；有去重和重试限制" : "提醒可能调用飞书；当前未开启自动补救"],
    ];
    const checksList = node("div", "", "monitoring-scope-checks");
    for (const [title, frequency, source] of checks) {
      const item = node("section");
      item.append(node("h3", title), node("p", frequency), node("p", source, "monitoring-note"));
      checksList.appendChild(item);
    }
    details.appendChild(checksList);
    if (value.services?.length) {
      const scope = node("details"); scope.appendChild(node("summary", "查看纳入巡检的服务"));
      table(scope, ["服务", "当前状态"], value.services.map(service => [service.label, status(service.status)]));
      details.appendChild(scope);
    }
    details.appendChild(node("p", "Token 总量累计所选期间内有记录的模型输入与输出，包含前台和后台；输入可能重复使用历史上下文，不等于新增注入量。后台 Token 也不全是监管消耗。", "monitoring-note"));
    details.appendChild(node("p", "本机巡检的 CPU、内存和磁盘读取尚无持续开销统计，不能从 Token 数推算；页面也不把一次测试结果当作实时用量。", "monitoring-note"));
    details.appendChild(node("p", `页面数据生成于 ${time(value.generatedAt)}。最近巡检完成时间来自后台记录，二者分别显示；旧时间不代表刚刚检查过。`, "monitoring-note"));
    root.appendChild(details);
  }

  function render() {
    renderScope();
    renderSessionTrends();
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
    handlingGuide(snapshot);
    const disks = section("磁盘容量", snapshot); disks.dataset.section = "disks";
    if (!value.disks.length) disks.appendChild(node("p", "尚未取得磁盘数据，状态未知。", "monitoring-note"));
    else table(disks, ["磁盘", "状态", "已用", "可用空间", "inode 已用"], value.disks.map(disk => {
      const badge = node("span", status(disk.status), "monitoring-account-status");
      badge.dataset.status = disk.status === "healthy" ? "available" : disk.status === "critical" ? "exhausted" : disk.status;
      const used = node("span", percent(disk.usedPercent));
      if (["critical", "warning"].includes(disk.status)) { used.className = "monitoring-metric-signal"; used.dataset.severity = disk.status; }
      return [disk.label, badge, used, bytes(disk.availableBytes), percent(disk.inodeUsedPercent)];
    }));
    const diskVisuals = node("div", "", "monitoring-disk-visuals");
    for (const disk of value.disks) {
      const card = node("div", "", "monitoring-disk-visual");
      card.appendChild(capacityRing(disk.usedPercent, `${disk.label} 已用`, disk.status));
      const caption = node("div"); caption.append(node("strong", disk.label), node("span", "容量已用"), node("small", `可用 ${bytes(disk.availableBytes)}`));
      card.appendChild(caption); diskVisuals.appendChild(card);
    }
    disks.insertBefore(diskVisuals, disks.children[1] || null);
    value.disks.filter(disk => disk.sharedFilesystem).forEach(disk => disks.appendChild(node("p", t("shared", { name: disk.sharedFilesystem }), "monitoring-note")));
    for (const repair of (value.recovery || []).filter(r => r.kind === "disk" && r.currentIssue)) {
      const details = node("details"); details.appendChild(node("summary", `${repair.subject}处置：${repair.label}`));
      details.appendChild(node("p", repair.reason || repair.summary || "正在核对安全处置方案", "monitoring-note"));
      if (repair.error && repair.status === "blocked") details.appendChild(node("p", `执行错误：${repair.error}`, "monitoring-note"));
      if (repair.plan) table(details, ["方案", "内容"], [["执行条件", repair.plan.requiresConfirmation ? "经人确认后执行" : "低风险自行处理"],
        ["步骤", repair.plan.summary], ["对象", repair.plan.target], ["影响", repair.plan.impact], ["恢复方式", repair.plan.rollback], ["验收", repair.plan.verification]]);
      if (repair.sessionId) { const link = node("a", "查看原处理会话"); link.href = `/?session=${encodeURIComponent(repair.sessionId)}`; details.appendChild(link); }
      disks.appendChild(details);
    }
    const accounts = section("账户额度", snapshot); accounts.dataset.section = "accounts";
    const continuity = value.accountContinuity;
    if (continuity) accounts.appendChild(node("p", `本实例自动切换${continuity.autoSwitch ? "已开启" : "未开启"}；已登录且额度高于10%的备用 ${continuity.backupCount} 个。20%进入备用准备区，10%切换后续请求；在途任务保留原账号。其他机器账号不算本实例备用。`, "monitoring-note"));
    if (continuity?.lastSwitch) {
      const change = continuity.lastSwitch;
      accounts.appendChild(node("p", `最近自动切换：${time(change.at)} · ${({ reserve: "提前保留余额", confirmed_exhaustion: "原账号已耗尽", remaining_balance_fallback: "使用仍有余额的本地账号兜底" })[change.reason] || "后台切换已记录"}。`, "monitoring-note"));
    }
    for (const item of (value.attention || []).filter(a => a.kind === "accountContinuity")) {
      const line = node("p", alertDetail(item), "monitoring-alert"); line.dataset.severity = item.severity; accounts.appendChild(line);
    }
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
      summaryMetrics(usage, [["期间总用量", number(totals.totalTokens), "Token · 含前台与后台"],
        ["后台用量", number(totals.backgroundTokens), Number.isFinite(totals.backgroundShare) ? `占总量 ${percent(totals.backgroundShare * 100)}` : "占比未知"],
        ["输入缓存占比", percent(Number.isFinite(totals.cachedInputShare) ? totals.cachedInputShare * 100 : NaN), "已记录输入中的缓存份额"]]);
      usage.appendChild(node("p", `${time(value.usage.window.start)} — ${time(value.usage.window.end)} · 累计模型输入与输出，不是当前上下文大小，也不是仅监管的消耗。`, "monitoring-note"));
      if (value.usage.dailyTrend) trendChart(usage, value.usage.dailyTrend, {
        key: 'totalTokens', title: '近 7 天 Token 用量', unit: 'Token',
        description: 'UTC 自然日，今天未结束；含前后台，按运行结束／记账日期归集', samples: day => `${day.runCount} 次运行记录`,
      });
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

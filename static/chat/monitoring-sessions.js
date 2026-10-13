'use strict';
(function (g) {
  const root = document.getElementById('monitoringSessions');
  if (!root) return;
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
  const fmt = v => Number.isFinite(v) ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v) : '—';
  const duration = v => !Number.isFinite(v) ? '—' : v < 60000 ? `${(v / 1000).toFixed(1)} 秒` : `${(v / 60000).toFixed(1)} 分钟`;
  const names = { firstContentMs: '首次正文送达（飞书）', firstReplyMs: '首次答复／提问送达（飞书）', prepareMs: '受理→准备（含排队）', launchMs: '准备→启动', runMs: '执行（含等待）', deliveryMs: '结果→送达', requestMs: '受理→结果', inputTokens: '每 Run 累计输入', contextTokens: '每 Run 最新上下文', injectionBytes: 'RemoteLab 注入量' };
  const size = v => Number.isFinite(v) ? `${(v / 1024).toFixed(1)} KiB` : '—';
  const val = (k, v) => k.endsWith('Ms') ? duration(v) : k === 'injectionBytes' ? size(v) : fmt(v);
  let data = null, error = '', pending = null, serial = 0, days = 1, loadedAt = 0;
  let mode = 'group', scope = '', filter = 'all', search = '', limit = 50, allGroups = false, expanded = false, selectedSession = '';
  let contextExpanded = false;
  const rowOpen = new Map(), diagnosisOpen = new Map();
  const diagnosisFor = s => (data?.diagnostics?.incidents || []).filter(i => !i.test && i.sessionIds.includes(s.sessionId)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const diagnosisLabel = i => i.status === 'resolved' ? '已恢复' : '已排查 · 待复核';
  function diagnosisDetails(s) {
    const list = diagnosisFor(s), fold = el('details', '', 'monitoring-session-diagnosis');
    fold.open = diagnosisOpen.get(s.sessionId) === true;
    fold.append(el('summary', list.length ? `巡检：${diagnosisLabel(list[0])}` : '指标变化与巡检规则'));
    fold.addEventListener('toggle', () => { if (fold.isConnected) diagnosisOpen.set(s.sessionId, fold.open); });
    if (s.signals.length) fold.append(signalList(s));
    fold.append(el('p', '准备或启动持续变慢才触发巡检；执行时长、输入量上涨先作为变化记录。页面标记不等于故障。', 'monitoring-note'));
    if (!list.length) fold.append(el('p', data?.diagnostics?.unavailable ? '巡检记录暂时无法读取。' : '尚无自动巡检记录。', 'monitoring-note'));
    for (const i of list.slice(0,3)) {
      fold.append(el('p', `${diagnosisLabel(i)}：${i.summary}`), el('p', i.nextStep, 'monitoring-note'));
      for (const e of i.evidence || []) fold.append(el('p', e, 'monitoring-note'));
      if (i.limitations) fold.append(el('p', i.limitations, 'monitoring-note'));
      for (const r of i.relatedRecovery || []) if (r.sessionId) { const a=el('a', `相关${r.kind === 'disk' ? '磁盘' : '服务'}处理记录`); a.href=`/?tab=sessions&session=${encodeURIComponent(r.sessionId)}`; fold.append(a); }
      fold.append(el('small', `${new Date(i.checkedAt).toLocaleString()} · ${i.deliveryStatus === 'delivered' ? '已私信通知' : ['uncertain','sending'].includes(i.deliveryStatus) ? '私信送达待核实' : '未发送通知'}`, 'monitoring-note'));
    }
    return fold;
  }
  const running = s => s.activity?.run?.state === 'running';
  const waiting = s => s.activity?.run?.waiting || (s.activity?.queue?.count || 0) > 0;
  const state = s => s.archived ? '已归档' : s.activity?.run?.waiting ? '运行中 · 等待' : running(s) ? '运行中' : waiting(s) ? '排队' : s.activity?.run?.state === 'idle' ? '空闲' : '状态未知';
  const title = s => s.name || s.sessionId;
  const button = (text, action) => { const b = el('button', text, 'monitoring-action'); b.type = 'button'; b.addEventListener('click', action); return b; };
  const table = (headings, rows) => { const wrap = el('div', '', 'monitoring-table-wrap'), t = el('table'), h = el('thead'), tr = el('tr'); for (const htext of headings) { const th = el('th', htext); th.scope = 'col'; tr.append(th); } h.append(tr); t.append(h); const body = el('tbody'); for (const cells of rows) { const r = el('tr'); for (const c of cells) { const d = el('td'); d.append(c?.nodeType ? c : document.createTextNode(String(c ?? '—'))); r.append(d); } body.append(r); } t.append(body); wrap.append(t); return wrap; };
  const metricName = k => names[k] || k;
  const signalText = x => `${metricName(x.metric)}突增 ${x.ratio.toFixed(1)} 倍 · 近期 ${val(x.metric, x.current)} / 基线 ${val(x.metric, x.baseline)}`;
  function signalList(s, visual = false) {
    const list = el('span', '', 'monitoring-session-anomalies');
    for (const x of s.signals) {
      const line = el('span', '', 'monitoring-metric-signal'); line.dataset.severity = 'neutral';
      if (!visual) line.textContent = signalText(x);
      else {
        const heading = el('span', '', 'monitoring-signal-heading');
        heading.append(el('span', metricName(x.metric)), el('strong', `${x.ratio.toFixed(1)} 倍`, 'monitoring-signal-ratio')); line.append(heading);
        const max = Math.max(x.current, x.baseline);
        for (const [label, value, kind] of [['近期', x.current, 'recent'], ['基线', x.baseline, 'baseline']]) {
          const row = el('span', '', 'monitoring-comparison-row'), track = el('span', '', 'monitoring-comparison-track'), fill = el('span');
          track.setAttribute('aria-hidden', 'true'); fill.style.width = `${max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : 0}%`; track.dataset.kind = kind; track.append(fill);
          row.append(el('small', label), track, el('span', val(x.metric, value))); line.append(row);
        }
      }
      list.append(line);
    }
    return list;
  }
  function metricValue(s, key, value) {
    const x = s.signals.find(signal => signal.metric === key);
    if (!x) return val(key, value);
    const node = el('span', val(key, value), 'monitoring-metric-signal'); node.dataset.severity = 'neutral';
    node.title = signalText(x); node.append(el('small', '变化待核', 'monitoring-metric-caption')); return node;
  }
  function focusSession(s) { selectedSession = s.sessionId; scope = ''; search = ''; filter = 'all'; expanded = true; render(); root.querySelector('[data-testid="session-selection"]')?.scrollIntoView({ block: 'nearest' }); }
  const queryViews = new Map();
  function queryPanel(session, host) {
    const key = `${session.sessionId}:${days}`, view = queryViews.get(key);
    host.replaceChildren();
    if (!view) { host.append(button('查看按需背景查询记录', () => loadQueries(session, host))); return; }
    if (view.pending) { host.append(el('p', '正在读取查询记录…', 'monitoring-note')); return; }
    if (view.error) { host.append(el('p', `查询记录暂不可用：${view.error}`, 'monitoring-note'), button('重试查询记录', () => loadQueries(session, host))); return; }
    const q = view.data, c = q.summary;
    host.append(el('h4', '按需背景查询'), el('p', `${c.attempts} 次查询 · 成功 ${c.succeeded} · 部分返回 ${c.partial} · 失败 ${c.failed} · 未见结束 ${c.unfinished}`, 'monitoring-note'));
    host.append(el('p', `同类同关键词重复查询 ${c.repeated} 次（包含首次，不等于无效重复）。采集起点：${q.collectionStartedAt ? new Date(q.collectionStartedAt).toLocaleString() : '未知'}。`, 'monitoring-note'));
    if (!c.attempts) host.append(el('p', '所选期间未观测到已接入的查询；可能不需要查询、使用了其他读取方式，或发生在采集前。', 'monitoring-note'));
    const states = { started: '未见结束', succeeded: '成功返回', partial: '部分返回', failed: '失败' };
    const kinds = { work: '相关工作与背景', memory: '记忆与背景', people: '人员资料' };
    if (q.records.length) host.append(table(['时间／类型', '结果', '返回量／耗时', '查询标识'], q.records.map(r => [
      `${new Date(r.timestamp).toLocaleString()} · ${kinds[r.kind] || r.kind} · ${{ agent: 'Agent', human: '人工入口', system: '服务入口' }[r.actorKind] || '来源未知'}`,
      `${states[r.state] || r.state}${Number.isInteger(r.resultCount) ? ` · ${r.resultCount} 条工作候选` : ''}${r.errorCode ? ` · ${r.errorCode}` : ''}`,
      `${size(r.sizeBytes)} / ${duration(r.durationMs)}`,
      `${(r.queryHash || '').slice(0, 10)}${r.runId ? ' · ' + r.runId : ''}`,
    ])));
    if (q.coverage.incomplete || q.hasMore) host.append(el('p', '记录不完整或已达展示上限，以上只是部分记录。', 'monitoring-note'));
    host.append(el('p', '仅记录 work context、work people、memory context。返回不代表已读或采纳；直接读文件、其他工具不在覆盖范围。关键词以标识去重，原查询内容在 Session 的工具记录中查看。', 'monitoring-note'));
    if (q.rules) {
      const r = q.rules, s = r.summary;
      const labels = { accepted: '输入接收回执', compacted: '原生压缩完成', started: '恢复开始', prepared: '恢复内容已生成', skipped: '未找到可恢复快照', failed: '恢复失败' };
      host.append(el('h4', '规则与压缩'), el('p', `规则输入 ${s.accepted} · 压缩 ${s.compacted} · 恢复内容已生成 ${s.prepared} · 恢复失败 ${s.failed} · 未见结束 ${s.unfinished}`, 'monitoring-note'));
      host.append(el('p', `采集起点：${r.collectionStartedAt ? new Date(r.collectionStartedAt).toLocaleString() : '尚未观测到事件'}。`, 'monitoring-note'));
      if (r.records.length) host.append(table(['时间', '证据', '规则版本／Run'], r.records.map(x => [
        new Date(x.timestamp).toLocaleString(), `${labels[x.state] || x.state}${x.kind === 'reference' ? '（沿用版本）' : x.kind === 'full' ? '（完整规则）' : ''}${x.errorCode ? ' · ' + x.errorCode : ''}`,
        `${(x.fingerprint || '').slice(0, 12)}${x.runId ? ' · ' + x.runId : ''}`,
      ])));
      if (!r.records.length) host.append(el('p', '未观测到规则事件；不能据此判断规则仍在或已经丢失。已有执行可能尚未加载新埋点。', 'monitoring-note'));
      if (r.hasMore) host.append(el('p', '仅展示最近 100 条规则记录。', 'monitoring-note'));
      host.append(el('p', '覆盖 RemoteLab 投射的七类规则。压缩与恢复观测目前接入 Codex；“恢复内容已生成”不等于原生已应用，更不证明模型理解或遵守。原生系统规则、AGENTS.md、Skill 和直接读文件不在此快照覆盖范围。', 'monitoring-note'));
    }
    host.append(button('刷新查询记录', () => loadQueries(session, host)));
  }
  async function loadQueries(session, host) {
    const requestedDays = days, key = `${session.sessionId}:${requestedDays}`;
    if (queryViews.get(key)?.pending) return;
    queryViews.set(key, { pending: true }); queryPanel(session, host);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/monitoring/context-queries?sessionId=${encodeURIComponent(session.sessionId)}&days=${requestedDays}`, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (!value.summary || !Array.isArray(value.records)) throw Error('返回格式不正确');
      queryViews.set(key, { data: value });
    } catch (e) { queryViews.set(key, { error: e.name === 'AbortError' ? '超过 15 秒' : e.message }); }
    finally { clearTimeout(timer); if (days === requestedDays) queryPanel(session, host); }
  }
  let responseExpanded = false;
  function render() {
    responseExpanded = root.querySelector('[data-testid="response-timing-days"]')?.open ?? responseExpanded;
    contextExpanded = root.querySelector('[data-testid="session-context-guide"]')?.open ?? contextExpanded;
    root.replaceChildren(); root.append(el('h2', 'Session 监管'));
    if (data?.contextExperiment) {
      const experiment = data.contextExperiment, note = el('div', '', 'monitoring-alert');
      note.dataset.testid = 'context-experiment'; note.dataset.severity = 'neutral';
      const states = { running: '正在打点实验', paused: '已暂停新会话分流', stopped: '已停止实验注入', unavailable: '实验状态暂不可用' };
      const content = el('div'); note.append(content);
      content.append(el('strong', `上下文注入对照 · ${states[experiment.state] || states.unavailable}`));
      if (experiment.state !== 'unavailable') {
        content.append(el('p', experiment.mode === 'aa' ? 'A/A 校验：两组均按需读取。' : 'A 组：自动注入背景；B 组：按需读取。', 'monitoring-note'));
        content.append(el('p', `范围：${experiment.people.join('、')}自 ${new Date(experiment.since).toLocaleString()} 起新开的会话；自动化另行接入。50/50 随机分流，同一会话固定分组；独立留样 ${Math.round(experiment.sampleRate * 100)}%，观察 ${experiment.observationHours} 小时。`, 'monitoring-note'));
        content.append(el('p', `夜间评阅${experiment.reviewEnabled ? '已启用' : '已暂停'}。此处标记实验配置，不代表每个会话已入组、注入已被采用或机制优劣已有结论。`, 'monitoring-note'));
      } else content.append(el('p', '暂时无法读取实验配置，不能据此判断实验已停止。', 'monitoring-note'));
      root.append(note);
    }
    const context = el('details', '', 'monitoring-fold'); context.open = contextExpanded; context.dataset.testid = 'session-context-guide';
    context.append(el('summary', '上下文如何注入'));
    context.append(el('p', '通用规则，实际内容随入口和配置变化；这里不逐条读取 Session。', 'monitoring-note'));
    const contextRules = el('ul', '', 'monitoring-note');
    for (const text of [
      '启动：Harness 自身规则、工作区约定与 Skill 目录，加上 RemoteLab 的能力和记忆入口。',
      '每轮：当前消息、来源身份、适用的个人／Session 规则与任务状态；人员和项目资料通常先给目录指针。',
      '飞书：所选话题及绑定群的聊天背景，过长内容提供分页原文；新话题读取群公告，同项目讨论群与干活群共用讨论群公告，已有话题保留首次版本。',
      '续聊：沿用原生历史，确认已送入的来源内容去重。支持恢复的 Codex 可复用未变规则的快照引用，压缩后恢复；规则或身份变化时重发。',
      '按需：Agent 再读取资料正文、记忆、Skill 和工具结果，不在每轮预先全量塞入。',
    ]) contextRules.append(el('li', text));
    context.append(contextRules, el('p', '下方“平均注入”只计 RemoteLab 保存的附加上下文字节，不含用户正文、Harness 原生规则与历史、工具输出，也不是 Token 数。', 'monitoring-note'));
    root.append(context);
    if (pending) root.append(el('p', data ? '正在更新，以下保留上次数据…' : '正在读取 Session 统计…', 'monitoring-note'));
    if (error) { const warning = el('div', '', 'monitoring-alert'); warning.dataset.severity = 'critical'; warning.setAttribute('role', 'alert'); warning.append(el('strong', `Session 查询失败：${error}`), button('重试', () => load(days, true))); root.append(warning); }
    if (!data) { if (!pending) root.append(el('p', '数据尚未取得，无法判断异常数量。资源板块独立加载。', 'monitoring-note')); return; }
    root.append(el('p', `${error ? '上次成功记录 · ' : ''}${new Date(data.generatedAt).toLocaleString()} · 最近 ${days === 1 ? '24 小时' : days + ' 天'} · ${data.sessions.length} 个 Session`, 'monitoring-note'));
    const rows = data.sessions, flagged = rows.filter(s => s.signals.length), overview = data.summary || {};
    const stats = el('div', '', 'monitoring-summary-metrics');
    stats.dataset.testid = 'session-summary';
    for (const [label, count, hint] of [
      ['当前 Session', fmt(overview.currentSessions), `未归档 · ${rows.filter(running).length} 个运行中`],
      ['平均 Session 用量', fmt(overview.meanUsageTokens), `Token / Session · 期间有用量记录的 ${overview.usageSessions ?? '—'} 个`],
      ['平均上下文注入', size(overview.meanInjectionBytes), `每次运行 · ${overview.injectionCount ?? '—'} 个注入样本`],
    ]) { const card = el('div'); card.append(el('small', label), el('strong', count), el('small', hint)); stats.append(card); }
    root.append(stats);
    const statusBar = el('div', '', 'monitoring-summary-status');
    const statusText = flagged.length ? `${flagged.length} 个 Session 指标变化` : '已测样本未发现突增';
    const badge = button(statusText, () => { expanded = true; filter = flagged.length ? 'attention' : 'all'; scope = ''; search = ''; selectedSession = ''; render(); });
    badge.dataset.severity = 'neutral';
    statusBar.append(badge);
    const c = data.coverage;
    const partial = c.truncated || c.readErrors || c.missingRuns || c.missingRequests || c.missingInjections;
    statusBar.append(el('span', partial ? '部分数据缺失 · 不能据此判断全部正常' : '仅比较样本充足的指标', 'monitoring-note'));
    root.append(statusBar);
    if (data.diagnostics?.checkedAt) root.append(el('small', `巡检最近检查：${new Date(data.diagnostics.checkedAt).toLocaleString()} · 结果见各会话的折叠说明`, 'monitoring-note'));

    if (data.responseTiming) {
      const r = data.responseTiming, panel = el('section', '', 'monitoring-response-timing'); panel.dataset.testid = 'response-timing';
      panel.append(el('h3', '飞书响应速度 · 当前统计范围'));
      panel.append(table(['从受理到送达', '中位数', 'P95', '有回执／可统计'], [
        ['首次正文（含开场、进展）', duration(r.firstContent.median), duration(r.firstContent.p95), `${r.firstContent.count} / ${r.eligible}`],
        ['首次答复／提问（不含开场、进展）', duration(r.firstReply.median), duration(r.firstReply.p95), `${r.firstReply.count} / ${r.eligible}`],
      ]));
      panel.append(el('p', `按 UTC 自然日：${r.start.slice(0,10)} 至 ${r.end.slice(0,10)}（今日未结束）。起点为 RemoteLab 受理，终点为飞书成功回执；不含进入 RemoteLab 之前的等待，也不证明已读或回复有用。仅已落账运行的首条人工请求，追加消息及未结束任务未纳入。排除自动受理通知，缺少回执不算零秒。`, 'monitoring-note'));
      const daily = el('details'); daily.dataset.testid = 'response-timing-days'; daily.open = responseExpanded; daily.addEventListener('toggle', () => { if (daily.isConnected) responseExpanded = daily.open; }); daily.append(el('summary', '查看逐日响应速度与样本'));
      daily.append(table(['日期（UTC）', '首正文中位数／P95', '首答复中位数／P95', '正文／答复／可统计'], r.days.map(d => [
        d.day, `${duration(d.firstContent.median)} / ${duration(d.firstContent.p95)}`, `${duration(d.firstReply.median)} / ${duration(d.firstReply.p95)}`,
        `${d.firstContent.count} / ${d.firstReply.count} / ${d.eligible}`,
      ])));
      daily.append(el('p', '按请求受理日归集，仅覆盖当前窗口已落账运行的首条人工飞书请求；运行中追加消息、尚未落账的慢任务、Web 和其他渠道不在此统计内。历史缺失不补猜。任务种类和模型不同，趋势不能直接归因于优化。此汇总不随下方群或发起人筛选变化。', 'monitoring-note'));
      panel.append(daily); root.append(panel);
    }
    const body = el('div'); root.append(body);
    if (flagged.length) {
      const box = el('div', '', 'monitoring-session-signals'); box.dataset.testid = 'session-anomaly-preview';
      for (const s of flagged.slice(0, 3)) {
        const b = button('', () => focusSession(s));
        b.dataset.severity = 'neutral';
        b.append(el('strong', title(s), 'monitoring-signal-title'), el('small', diagnosisFor(s).length ? diagnosisLabel(diagnosisFor(s)[0]) : `${s.signals.length} 项指标变化 · 尚未确认故障`)); box.append(b);
      }
      body.append(box);
      if (flagged.length > 3) body.append(button(`查看全部 ${flagged.length} 个指标突增的 Session`, () => { expanded = true; selectedSession = ''; scope = ''; search = ''; filter = 'attention'; render(); }));
    }
    const bar = el('div', '', 'monitoring-session-controls');
    const groupLabel = el('label', '汇总 '), select = el('select'); select.setAttribute('aria-label', 'Session 汇总方式'); for (const [value, label] of [['group', '按群'], ['person', '按发起人']]) { const option = el('option', label); option.value = value; select.append(option); } select.value = mode; select.onchange = () => { mode = select.value; scope = ''; selectedSession = ''; search = ''; filter = 'all'; allGroups = false; limit = 50; render(); }; groupLabel.append(select); bar.append(groupLabel);
    const input = el('input'); input.type = 'search'; input.placeholder = '搜索标题、群或发起人'; input.setAttribute('aria-label', input.placeholder); input.value = search; input.oninput = () => { search = input.value; selectedSession = ''; expanded = true; limit = 50; render(); const next = root.querySelector('input'); next.focus(); }; bar.append(input);
    const filterSelect = el('select'); filterSelect.setAttribute('aria-label', 'Session 状态筛选'); for (const [value, label] of [['all', '全部状态'], ['attention', '仅指标变化'], ['running', '运行中'], ['waiting', '等待／排队']]) { const option = el('option', label); option.value = value; filterSelect.append(option); } filterSelect.value = filter; filterSelect.onchange = () => { filter = filterSelect.value; selectedSession = ''; expanded = true; limit = 50; render(); }; bar.append(filterSelect); body.append(bar);
    const field = mode === 'person' ? 'personId' : 'groupId', dictionary = mode === 'person' ? data.people : data.groups;
    const buckets = new Map();
    for (const s of rows) { const k = s[field]; if (!buckets.has(k)) buckets.set(k, { id: k, total: 0, running: 0, waiting: 0, attention: 0, tokens: 0 }); const b = buckets.get(k); b.total++; b.running += Number(running(s)); b.waiting += Number(waiting(s)); b.attention += Number(s.signals.length > 0); b.tokens += s.totalTokens || 0; }
    const groups = [...buckets.values()].sort((a, b) => b.attention - a.attention || b.running - a.running || b.tokens - a.tokens);
    if (!scope && !search && !selectedSession) { const gt = table([mode === 'person' ? '发起人' : '群／入口', '总数', '运行／等待', '指标变化'], groups.slice(0, allGroups ? undefined : 3).map(b => [button(dictionary[b.id] || '未知', () => { scope = b.id; selectedSession = ''; expanded = true; limit = 50; render(); }), b.total, `${b.running} / ${b.waiting}`, b.attention])); gt.dataset.testid = 'monitor-groups'; gt.classList.add('monitoring-owner-summary'); body.append(gt); if (groups.length > 3) body.append(button(allGroups ? '收起' : `查看全部 ${groups.length} 项归属`, () => { allGroups = !allGroups; render(); })); }
    if (!expanded && !flagged.length) {
      const preview = el('div', '', 'monitoring-session-preview'); preview.dataset.testid = 'session-running-preview';
      const active = rows.filter(s => running(s) || waiting(s)).slice(0, 3);
      if (active.length) { preview.append(el('small', '当前运行 / 等待')); for (const s of active) preview.append(button(`${title(s)} · ${state(s)}`, () => focusSession(s))); body.append(preview); }
    }
    const fold = el('details', '', 'monitoring-fold'); fold.open = expanded; fold.dataset.testid = 'session-details';
    fold.append(el('summary', expanded ? '收起 Session 指标明细' : '展开 Session 列表与指标明细'));
    fold.addEventListener('toggle', () => { if (expanded !== fold.open) { expanded = fold.open; render(); } });
    root.append(fold);
    if (!expanded) return;
    const detailBody = el('div'); fold.append(detailBody);
    const selected = el('div', '', 'monitoring-session-controls'); selected.dataset.testid = 'session-selection';
    const focused = rows.find(s => s.sessionId === selectedSession);
    selected.append(el('h3', focused ? title(focused) : scope ? dictionary[scope] || '未知' : mode === 'person' ? 'Session 列表 · 按发起人查看' : 'Session 列表 · 按群查看'));
    if (scope || selectedSession) selected.append(button('返回全部 Session', () => { scope = ''; selectedSession = ''; render(); }));
    detailBody.append(selected);
    const needle = search.toLowerCase();
    const matches = rows.filter(s => (!selectedSession || s.sessionId === selectedSession) && (!scope || s[field] === scope) && (!needle || [s.sessionId, title(s), data.groups[s.groupId], data.people[s.personId]].join(' ').toLowerCase().includes(needle)) && (filter === 'all' || filter === 'attention' && s.signals.length || filter === 'running' && running(s) || filter === 'waiting' && waiting(s))).sort((a, b) => Number(b.signals.length > 0) - Number(a.signals.length > 0) || Number(running(b)) - Number(running(a)) || (b.totalTokens || 0) - (a.totalTokens || 0));
    const sessionTable = table(['标题／归属', '状态', '期间用量 Token', '平均准备', '平均执行', '平均上下文', '平均注入'], matches.slice(0, limit).map(s => {
      const cell = el('div'), details = el('details'), summary = el('summary', title(s)); details.append(summary);
      details.open = rowOpen.get(s.sessionId) === true;
      details.addEventListener('toggle', () => { if (details.isConnected) rowOpen.set(s.sessionId, details.open); });
      const link = el('a', '打开 Session'); link.href = `/?tab=sessions&session=${encodeURIComponent(s.sessionId)}`; details.append(link);
      const queries = el('div', '', 'monitoring-context-queries'); queries.dataset.testid = 'context-query-records'; queryPanel(s, queries); details.append(queries);
      details.append(table(['阶段／指标', '均值', '中位数', 'P95', '样本'], Object.entries(s.metrics).map(([k, v]) => [metricName(k), metricValue(s, k, v.mean), val(k, v.median), val(k, v.p95), v.count])));
      for (const x of s.signals) details.append(el('p', `${metricName(x.metric)}：最近 ${x.recentCount} 个 / 此前 ${x.baselineCount} 个样本 · ${x.model}`, 'monitoring-note'));
      const group = `群：${data.groups[s.groupId] || '未知'}`, person = `发起人：${data.people[s.personId] || '未知'}`;
      cell.append(details, el('small', mode === 'person' ? `${person} · ${group}` : `${group} · ${person}`, 'monitoring-owner'));
      if (s.signals.length || diagnosisFor(s).length) cell.append(diagnosisDetails(s));
      const flag = el('span', state(s), 'monitoring-account-status');
      return [cell, flag, fmt(s.totalTokens), metricValue(s, 'prepareMs', s.metrics.prepareMs?.mean), metricValue(s, 'runMs', s.metrics.runMs?.mean), metricValue(s, 'contextTokens', s.metrics.contextTokens?.mean), metricValue(s, 'injectionBytes', s.metrics.injectionBytes?.mean)];
    })); sessionTable.dataset.testid = 'monitor-sessions'; detailBody.append(sessionTable);
    if (!matches.length) detailBody.append(el('p', '没有符合当前筛选的 Session。', 'monitoring-note'));
    if (matches.length > limit) detailBody.append(button(`再显示 50 个（当前 ${limit} / ${matches.length}）`, () => { limit += 50; render(); }));
    const coverage = el('details', '', 'monitoring-session-coverage'); coverage.append(el('summary', '数据范围与统计口径'));
    coverage.append(el('p', `阶段统计 ${c.sampledRuns} / ${c.eligibleRuns} 个已落账 Run${c.truncated ? '，达到读取上限，属于部分统计' : ''}；缺失 Run ${c.missingRuns}、Request ${c.missingRequests}，读取错误 ${c.readErrors}。统计缓存 60 秒；当前状态另行读取。`, 'monitoring-note'));
    coverage.append(el('p', '按实际群绑定和发起身份汇总；未知归属单列。运行和等待可能重叠。上下文为各 Run 最新回传值的均值，不是每次模型调用均值。阶段缺少配对时间戳时显示“—”。', 'monitoring-note'));
    coverage.append(el('p', '突增比较同 Session、模型、Harness：最近 3 个样本对比此前至少 10 个、最多 20 个；达到 2 倍且超过最小绝对增量时显示变化；这是统计线索，不等于故障。巡检单独核对新鲜样本与绝对耗时。API 当前只统计实例总量。', 'monitoring-note')); detailBody.append(coverage);
    coverage.append(el('p', '平均 Session 用量＝所选期间已记录用量之和 ÷ 有用量记录的 Session 数；包含期间有记录的已归档 Session，不把未记录用量当零。平均注入按有效前台 Run 样本加权，统计 RemoteLab 保存的 modelContext UTF-8 字节数，不含 Harness 历史、工具输出和用户正文，不能视为 Token。缺失注入 ' + (c.missingInjections || 0) + ' 个样本。', 'monitoring-note'));
  }
  async function load(nextDays = 1, force = false) {
    if (pending && days === nextDays) return pending.promise;
    if (!force && data && days === nextDays && Date.now() - loadedAt < 15000) return;
    if (pending) pending.controller.abort();
    if (days !== nextDays) { data = null; scope = ''; selectedSession = ''; }
    days = nextDays; error = ''; const id = ++serial, controller = new AbortController();
    const task = { controller }; pending = task; render();
    const timeout = setTimeout(() => controller.abort(), 15000);
    task.promise = (async () => {
      try {
        const r = await fetch(`/api/monitoring/sessions?days=${days}&compact=1`, { credentials: 'same-origin', signal: controller.signal });
        if (r.status === 401 || r.status === 403) { data = null; throw Error('登录已失效，请重新登录'); }
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        const value = await r.json(); if (!Array.isArray(value.sessions) || !value.groups) throw Error('返回格式不正确');
        if (id === serial) { data = value; loadedAt = Date.now(); }
      } catch (e) { if (id === serial) error = e.name === 'AbortError' ? '超过 15 秒，点击重试' : e.message; }
      finally { clearTimeout(timeout); if (id === serial) { pending = null; render(); } }
    })();
    return task.promise;
  }
  g.RemoteLabSessionMonitoring = { load };
})(window);

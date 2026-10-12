'use strict';
(function (g) {
  const root = document.getElementById('monitoringSessions');
  if (!root) return;
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
  const fmt = v => Number.isFinite(v) ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v) : '—';
  const duration = v => !Number.isFinite(v) ? '—' : v < 60000 ? `${(v / 1000).toFixed(1)} 秒` : `${(v / 60000).toFixed(1)} 分钟`;
  const names = { prepareMs: '受理→准备（含排队）', launchMs: '准备→启动', runMs: '执行（含等待）', deliveryMs: '结果→送达', requestMs: '受理→结果', inputTokens: '每 Run 累计输入', contextTokens: '每 Run 最新上下文' };
  const val = (k, v) => k.endsWith('Ms') ? duration(v) : fmt(v);
  let data = null, error = '', pending = null, serial = 0, days = 1, loadedAt = 0;
  let mode = 'group', scope = '', filter = 'all', search = '', limit = 50, allGroups = false;
  const running = s => s.activity?.run?.state === 'running';
  const waiting = s => s.activity?.run?.waiting || (s.activity?.queue?.count || 0) > 0;
  const state = s => s.archived ? '已归档' : s.activity?.run?.waiting ? '运行中 · 等待' : running(s) ? '运行中' : waiting(s) ? '排队' : s.activity?.run?.state === 'idle' ? '空闲' : '状态未知';
  const title = s => s.name || s.sessionId;
  const button = (text, action) => { const b = el('button', text, 'monitoring-action'); b.type = 'button'; b.addEventListener('click', action); return b; };
  const table = (headings, rows) => { const wrap = el('div', '', 'monitoring-table-wrap'), t = el('table'), h = el('thead'), tr = el('tr'); for (const htext of headings) { const th = el('th', htext); th.scope = 'col'; tr.append(th); } h.append(tr); t.append(h); const body = el('tbody'); for (const cells of rows) { const r = el('tr'); for (const c of cells) { const d = el('td'); d.append(c?.nodeType ? c : document.createTextNode(String(c ?? '—'))); r.append(d); } body.append(r); } t.append(body); wrap.append(t); return wrap; };
  function render() {
    root.replaceChildren(); root.append(el('h2', 'Session 监管'));
    if (pending) root.append(el('p', data ? '正在更新，以下保留上次数据…' : '正在读取 Session 统计…', 'monitoring-note'));
    if (error) { const warning = el('div', '', 'monitoring-alert'); warning.dataset.severity = 'critical'; warning.setAttribute('role', 'alert'); warning.append(el('strong', `Session 查询失败：${error}`), button('重试', () => load(days, true))); root.append(warning); }
    if (!data) { if (!pending) root.append(el('p', '数据尚未取得，无法判断异常数量。资源板块独立加载。', 'monitoring-note')); return; }
    root.append(el('p', `${error ? '上次成功记录 · ' : ''}${new Date(data.generatedAt).toLocaleString()} · 最近 ${days === 1 ? '24 小时' : days + ' 天'} · ${data.sessions.length} 个 Session`, 'monitoring-note'));
    const rows = data.sessions, flagged = rows.filter(s => s.signals.length), stats = el('div', '', 'monitoring-session-stats');
    for (const [label, count, f] of [['需关注', flagged.length, 'attention'], ['运行中', rows.filter(running).length, 'running'], ['等待／排队', rows.filter(waiting).length, 'waiting'], ['窗口 Token', fmt(data.totals?.totalTokens), 'all']]) {
      const b = button('', () => { filter = f; scope = ''; limit = 50; render(); }); b.append(el('small', label), el('strong', String(count))); b.dataset.selected = String(filter === f); stats.append(b);
    }
    root.append(stats);
    if (flagged.length) {
      const box = el('div', '', 'monitoring-session-signals');
      for (const s of flagged.slice(0, 5)) { const signal = s.signals[0], b = button('', () => { scope = ''; search = s.sessionId; filter = 'all'; render(); }); b.dataset.severity = signal.severity; b.append(el('strong', title(s)), el('span', `${names[signal.metric]} ${signal.ratio.toFixed(1)} 倍 · 当前 ${val(signal.metric, signal.current)} / 基线 ${val(signal.metric, signal.baseline)}`)); box.append(b); }
      root.append(box);
    } else root.append(el('p', '已取得的样本未命中突增规则；样本不足不作正常判断。', 'monitoring-note'));
    const bar = el('div', '', 'monitoring-session-controls');
    const groupLabel = el('label', '汇总 '), select = el('select'); select.setAttribute('aria-label', 'Session 汇总方式'); for (const [value, label] of [['group', '按群'], ['person', '按发起人']]) { const option = el('option', label); option.value = value; select.append(option); } select.value = mode; select.onchange = () => { mode = select.value; scope = ''; allGroups = false; render(); }; groupLabel.append(select); bar.append(groupLabel);
    const input = el('input'); input.type = 'search'; input.placeholder = '搜索标题、群或发起人'; input.setAttribute('aria-label', input.placeholder); input.value = search; input.oninput = () => { search = input.value; limit = 50; render(); const next = root.querySelector('input'); next.focus(); }; bar.append(input);
    const filterSelect = el('select'); filterSelect.setAttribute('aria-label', 'Session 状态筛选'); for (const [value, label] of [['all', '全部状态'], ['attention', '仅需关注'], ['running', '运行中'], ['waiting', '等待／排队']]) { const option = el('option', label); option.value = value; filterSelect.append(option); } filterSelect.value = filter; filterSelect.onchange = () => { filter = filterSelect.value; limit = 50; render(); }; bar.append(filterSelect); root.append(bar);
    const field = mode === 'person' ? 'personId' : 'groupId', dictionary = mode === 'person' ? data.people : data.groups;
    const buckets = new Map();
    for (const s of rows) { const k = s[field]; if (!buckets.has(k)) buckets.set(k, { id: k, total: 0, running: 0, waiting: 0, attention: 0, tokens: 0 }); const b = buckets.get(k); b.total++; b.running += Number(running(s)); b.waiting += Number(waiting(s)); b.attention += Number(s.signals.length > 0); b.tokens += s.totalTokens || 0; }
    const groups = [...buckets.values()].sort((a, b) => b.attention - a.attention || b.running - a.running || b.tokens - a.tokens);
    if (!scope && !search) { const gt = table([mode === 'person' ? '发起人' : '群／入口', '运行／等待', 'Session', '需关注', '窗口 Token'], groups.slice(0, allGroups ? undefined : 8).map(b => [button(dictionary[b.id] || '未知', () => { scope = b.id; limit = 50; render(); }), `${b.running} / ${b.waiting}`, b.total, b.attention, fmt(b.tokens)])); gt.dataset.testid = 'monitor-groups'; root.append(gt); if (groups.length > 8) root.append(button(allGroups ? '收起' : `查看全部 ${groups.length} 项归属`, () => { allGroups = !allGroups; render(); })); }
    const selected = el('div', '', 'monitoring-session-controls'); selected.append(el('h3', scope ? dictionary[scope] || '未知' : 'Session 列表')); if (scope) selected.append(button('返回全部归属', () => { scope = ''; render(); })); root.append(selected);
    const needle = search.toLowerCase();
    const matches = rows.filter(s => (!scope || s[field] === scope) && (!needle || [s.sessionId, title(s), data.groups[s.groupId], data.people[s.personId]].join(' ').toLowerCase().includes(needle)) && (filter === 'all' || filter === 'attention' && s.signals.length || filter === 'running' && running(s) || filter === 'waiting' && waiting(s))).sort((a, b) => Number(b.signals.length > 0) - Number(a.signals.length > 0) || Number(running(b)) - Number(running(a)) || (b.totalTokens || 0) - (a.totalTokens || 0));
    const sessionTable = table(['标题／归属', '状态', '窗口 Token', '平均准备', '平均执行', '平均上下文'], matches.slice(0, limit).map(s => {
      const cell = el('div'), details = el('details'), summary = el('summary', title(s)); details.append(summary);
      const link = el('a', '打开 Session'); link.href = `/?tab=sessions&session=${encodeURIComponent(s.sessionId)}`; details.append(link);
      details.append(table(['阶段／指标', '均值', 'P95', '样本'], Object.entries(s.metrics).map(([k, v]) => [names[k], val(k, v.mean), val(k, v.p95), v.count])));
      for (const x of s.signals) details.append(el('p', `${names[x.metric]} ${x.ratio.toFixed(1)} 倍；最近 ${x.recentCount} 个 / 此前 ${x.baselineCount} 个 · ${x.model}`, 'monitoring-note'));
      cell.append(details, el('small', `${data.groups[s.groupId] || '群未知'} · ${data.people[s.personId] || '发起人未知'}`, 'monitoring-owner'));
      const flag = el('span', state(s), 'monitoring-account-status'); if (s.signals.length) { flag.dataset.status = 'exhausted'; flag.textContent += ' · 需关注'; }
      return [cell, flag, fmt(s.totalTokens), duration(s.metrics.prepareMs?.mean), duration(s.metrics.runMs?.mean), fmt(s.metrics.contextTokens?.mean)];
    })); sessionTable.dataset.testid = 'monitor-sessions'; root.append(sessionTable);
    if (!matches.length) root.append(el('p', '没有符合当前筛选的 Session。', 'monitoring-note'));
    if (matches.length > limit) root.append(button(`再显示 50 个（当前 ${limit} / ${matches.length}）`, () => { limit += 50; render(); }));
    const coverage = el('details', '', 'monitoring-session-coverage'); coverage.append(el('summary', '数据范围与统计口径'));
    const c = data.coverage;
    coverage.append(el('p', `阶段统计 ${c.sampledRuns} / ${c.eligibleRuns} 个已落账 Run${c.truncated ? '，达到读取上限，属于部分统计' : ''}；缺失 Run ${c.missingRuns}、Request ${c.missingRequests}，读取错误 ${c.readErrors}。统计缓存 60 秒；当前状态另行读取。`, 'monitoring-note'));
    coverage.append(el('p', '按实际群绑定和发起身份汇总；未知归属单列。运行和等待可能重叠。上下文为各 Run 最新回传值的均值，不是每次模型调用均值。阶段缺少配对时间戳时显示“—”。', 'monitoring-note'));
    coverage.append(el('p', '突增比较同 Session、模型、Harness：最近 3 个样本对比此前至少 10 个、最多 20 个；2 倍黄色、3 倍红色，并要求最小绝对增量。仅页面提示。API 当前只统计实例总量。', 'monitoring-note')); root.append(coverage);
    if (c.truncated || c.readErrors || c.missingRuns || c.missingRequests) root.prepend(el('p', '统计存在缺口，请展开“数据范围与统计口径”。', 'monitoring-alert'));
  }
  async function load(nextDays = 1, force = false) {
    if (pending && days === nextDays) return pending.promise;
    if (!force && data && days === nextDays && Date.now() - loadedAt < 15000) return;
    if (pending) pending.controller.abort();
    if (days !== nextDays) { data = null; scope = ''; }
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

'use strict';
(function (g) {
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
  const number = value => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
  const duration = value => !Number.isFinite(value) ? '—' : value < 60000 ? `${(value / 1000).toFixed(1)} 秒` : `${(value / 60000).toFixed(1)} 分钟`;
  const svgNode = (name, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const disclosure = (label, key, state) => { const d = el('details'); d.dataset.agentFold = key; d.open = state?.[key] === true; d.append(el('summary', label)); d.addEventListener('toggle', () => { if (d.isConnected && state) state[key] = d.open; }); return d; };
  const table = (head, rows) => {
    const wrap = el('div', '', 'agent-table'), t = el('table'), h = el('tr');
    head.forEach(v => { const th = el('th', v); th.scope = 'col'; h.append(th); }); const th = el('thead'); th.append(h); t.append(th);
    const body = el('tbody'); rows.forEach(row => { const tr = el('tr'); row.forEach(v => { const td = el('td'); td.append(v?.nodeType ? v : document.createTextNode(String(v ?? '—'))); tr.append(td); }); body.append(tr); }); t.append(body); wrap.append(t); return wrap;
  };
  function chart(d, key, title, unit, sample, explanation, state) {
    const card = el('section', '', 'agent-metric'); card.dataset.metric = key;
    const value = d.today[key], format = unit === '耗时' ? duration : number;
    card.append(el('h4', title), el('strong', format(value), 'agent-value'), el('p', `${unit === '耗时' ? '越短越快' : unit} · 样本 ${sample(d.today)} 次`, 'agent-note'));
    card.append(el('p', explanation, 'agent-note'));
    const svg = svgNode('svg', { viewBox: '0 0 400 155', role: 'img', 'aria-label': `${title}，近七日；精确值见下方表格` });
    const max = Math.max(1, ...d.days.map(v => Number.isFinite(v[key]) ? v[key] : 0));
    const x = i => 50 + i * 55, y = v => 112 - v / max * 82;
    for (const ratio of [0, .5, 1]) {
      svg.append(svgNode('line', { x1: 50, x2: 380, y1: y(ratio * max), y2: y(ratio * max), class: 'agent-gridline' }));
      const label = svgNode('text', { x: 44, y: y(ratio * max) + 4, 'text-anchor': 'end' }); label.textContent = format(ratio * max); svg.append(label);
    }
    let path = '', connected = false;
    d.days.forEach((row, i) => {
      const label = svgNode('text', { x: x(i), y: 140, 'text-anchor': 'middle' }); label.textContent = row.day.slice(5); svg.append(label);
      if (!Number.isFinite(row[key])) { connected = false; return; }
      path += `${connected ? 'L' : 'M'}${x(i)},${y(row[key])} `; connected = true;
    });
    svg.append(svgNode('path', { d: path, class: 'agent-line' }));
    d.days.forEach((row, i) => {
      if (!Number.isFinite(row[key])) return;
      const dot = svgNode('circle', { cx: x(i), cy: y(row[key]), r: 4, class: 'agent-dot', tabindex: 0 });
      const text = `${row.day}：${format(row[key])}，统计 ${sample(row)} 次`; dot.setAttribute('aria-label', text);
      const tooltip = svgNode('title'); tooltip.textContent = text; dot.append(tooltip); svg.append(dot);
    }); card.append(svg);
    const fold = disclosure('每日明细', key, state);
    fold.append(table(['日期', unit, '样本数'], d.days.map(row => [row.day, Number.isFinite(row[key]) ? (unit === '耗时' ? duration(row[key]) : row[key].toLocaleString('zh-CN', { maximumFractionDigits: 2 })) : '暂无数据', sample(row)])));
    card.append(fold); return card;
  }
  function durationChart(d, key, title, first, state) {
    const choices = [
      ['total', '完整交付', '从系统收到消息，到最终结果全部送达。'],
      ['wait', '排队与启动', '系统收到消息后，排队、准备并启动执行的时间。'],
      ['run', '执行过程', '从开始执行到执行结束，包括思考和工具操作。'],
      ['send', '结果发送', '执行结束后，把最终结果送达的时间。'],
    ];
    const stateKey = `${key}Stage`, stage = choices.some(c => c[0] === state[stateKey]) ? state[stateKey] : 'total';
    const stats = row => stage === 'total' ? row[first ? 'firstDelivery' : 'delivery']
      : row[first ? 'firstDeliveryStages' : 'deliveryStages']?.[stage];
    const project = row => ({ ...row, [key]: stats(row)?.mean ?? null });
    const explanation = choices.find(c => c[0] === stage)[2] + (stage === 'total' ? '按今日有效样本取平均。' : '只统计时间记录完整的消息。');
    const card = chart({ ...d, today: project(d.today), days: d.days.map(project) }, key, title, '耗时', row => stats(row)?.count ?? 0, explanation, state);
    const label = el('label', '耗时阶段 ', 'agent-stage-control'), select = el('select');
    select.setAttribute('aria-label', `${title}：阶段`);
    for (const [value, text] of choices) { const option = el('option', text); option.value = value; select.append(option); }
    select.value = stage; label.append(select); card.insertBefore(label, card.children[1]);
    select.addEventListener('change', () => {
      state[stateKey] = select.value;
      state[key] = card.querySelector('details').open;
      const next = durationChart(d, key, title, first, state); card.replaceWith(next); next.querySelector('select').focus();
    });
    return card;
  }
  function render(root, d, { state = {}, sourceBase = '', sessionBase = '' } = {}) {
    root.replaceChildren(); root.classList.add('agent-dashboard'); root.setAttribute('translate', 'no'); root.dataset.testid = 'agent-dashboard';
    if (!d) { root.append(el('p', '统计暂不可用，请稍后刷新。')); return; }
    const heading = el('div', '', 'agent-heading');
    heading.append(el('p', `${d.today.day} 05:00 — 次日 05:00 · 北京时间 · 今日尚未结束 · 下方为近七日趋势`, 'agent-note'));
    root.append(heading);
    const counts = el('div', '', 'agent-counts');
    for (const [name, value, note] of [['运行中会话', d.currentRunning, d.unknownStates ? `${d.unknownStates} 个会话状态暂未取得` : '当前正在执行任务的会话'], ['今日活跃会话', d.todayActiveSessions ?? d.today.sessions, '今天处理过任务的会话，同一会话只计一次']]) {
      const item = el('div'); item.append(el('small', name), el('strong', number(value)), el('small', note)); counts.append(item);
    } root.append(counts);
    const grid = el('div', '', 'agent-metrics');
    for (const args of [
      ['meanTokens', '平均 token 用量', 'token / 次', r => r.usageRuns, '今日 token 总量除以有用量记录的执行次数，包含对话和后台任务。'],
      ['totalTokens', '今日 token 总量', 'token', r => r.usageRuns, '今天记录到的模型输入与输出总量，包含对话和后台任务。'],
      ['meanInjectionChars', '平均上下文注入量', '字符 / 次', r => r.injection.count, '每次对话执行前，RemoteLab 自动注入的上下文字符数取平均。'],
      ['firstInjectionChars', '新会话首轮平均注入量', '字符 / 首轮', r => r.firstInjection.count, '仅统计新会话首轮自动注入的上下文，按字符数取平均。'],
    ]) grid.append(chart(d, ...args, state));
    const response = chart(d, 'meanFirstResponseMs', '平均首次响应时间', '耗时', r => r.firstResponse?.count ?? 0, '从消息发出到首条文字回复送达。开场和进展计入，表情和自动受理通知不计入。', state);
    response.classList.add('agent-first-response'); grid.append(response);
    grid.append(durationChart(d, 'meanDeliveryMs', '平均交付用时', false, state),
      durationChart(d, 'firstDeliveryMs', '新会话首轮平均交付用时', true, state));
    root.append(grid);
    const journey = el('section', '', 'agent-journey'); journey.dataset.testid = 'journey-timing';
    journey.append(el('h3', '今日各环节用时'));
    const stages = d.today.journeyStages || {};
    journey.append(el('p', `统计 ${stages.total?.count ?? 0} 条时间记录完整的飞书消息，各环节使用同一批样本。`, 'agent-note'));
    journey.append(table(['环节', '计时范围', '平均用时', '样本数'], [
      ['receive', '消息接收', '发出消息 → 系统收到'],
      ['prepare', '排队与准备', '系统收到 → 准备完成'],
      ['launch', '启动执行', '准备完成 → 开始执行'],
      ['run', '执行过程', '开始执行 → 执行结束'],
      ['send', '结果发送', '执行结束 → 最终结果送达'],
      ['total', '合计', '发出消息 → 最终结果送达'],
    ].map(([key, name, range]) => [name, range, duration(stages[key]?.mean), stages[key]?.count ?? 0])));
    journey.append(el('p', '首次响应可能发生在执行过程中，因此单独统计，不重复计入总耗时。', 'agent-note'));
    root.append(journey);
    const sources = disclosure('上下文注入来源', 'sources', state);
    if (d.documents?.length) {
      sources.append(el('h4', '常用文档'));
      sources.append(table(['文档名称', '文档字符数', '使用时机'], d.documents.map(row => {
        const a = el('a', row.name); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.chars === null ? row.name : a, row.chars === null ? '未取得' : row.chars.toLocaleString(), row.when];
      })));
      sources.append(el('p', '文档长度不代表实际注入量。下方示例列出一次新会话首轮实际注入的内容。', 'agent-note'));
    }
    if (d.sources) {
      sources.append(el('p', `最近一条有完整记录的新会话首轮 · ${new Date(d.sources.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 共 ${d.sources.chars.toLocaleString()} 字符`, 'agent-note'));
      sources.append(table(['文档／内容来源', '实际注入字符数', '查看来源'], d.sources.entries.map(row => {
        const a = el('a', row.sourcePath?.endsWith('.md') ? '查看规则文档' : '查看组装来源'); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.name, row.chars.toLocaleString(), row.sourcePath ? a : '查看原会话'];
      })));
      const a = el('a', '打开这条记录所在的会话'); a.href = `${sessionBase}/?tab=sessions&session=${encodeURIComponent(d.sources.sessionId)}`; sources.append(a);
    } else sources.append(el('p', '暂无可核对的新会话首轮记录。'));
    sources.append(el('p', '字符数包含标题和分隔符。注入内容因用户和群聊而异，链接指向当前规则文档或实现。这里只统计 RemoteLab 自动注入的上下文，不含 Harness 自行加载的规则、AGENTS.md、Skill 或工具读取的内容。', 'agent-note')); root.append(sources);
    const coverage = d.coverage || {};
    root.append(el('p', `更新于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}${coverage.truncated ? ' · 当前只统计了部分执行记录' : ''}。缺少数据时显示“—”。`, 'agent-note'));
    const scope = disclosure('统计口径', 'scope', state);
    scope.append(el('p', `已读取 ${coverage.sampledRuns ?? 0} 条执行记录，共有 ${coverage.eligibleRuns ?? 0} 条可供统计。未取得的记录：执行信息 ${coverage.missingRuns || 0} 条、消息信息 ${coverage.missingRequests || 0} 条、上下文注入 ${coverage.missingInjections || 0} 条。`, 'agent-note'));
    Object.values(d.semantics || {}).forEach(text => scope.append(el('p', text, 'agent-note')));
    scope.append(el('p', `今天有 ${d.today.unknownFirstRuns} 条记录无法确认是不是会话首轮，未计入首轮指标。每项平均值只使用该项有数据的记录。token 用量包含后台任务，上下文注入量和耗时只统计对话。`, 'agent-note')); root.append(scope);
  }
  function renderCompact(root, d, { state = {}, accounts, accountData, refresh } = {}) {
    const wasOpen = root.querySelector('dialog')?.open === true;
    const focused = root.querySelector('dialog')?.contains(document.activeElement);
    const originalAccountPanel = accounts.closest('.monitoring-summary-panel');
    if (originalAccountPanel && !originalAccountPanel.contains(root)) accounts.remove();
    if (originalAccountPanel && !originalAccountPanel.contains(root)) originalAccountPanel.remove();
    root.replaceChildren(); root.className = 'agent-dashboard agent-compact'; root.setAttribute('translate', 'no');
    root.parentElement.classList.add('agent-compact-host');
    root.previousElementSibling?.remove();
    const full = el('div'); render(full, d, { state });
    const card = el('article', '', 'agent-compact-card'); card.dataset.testid = 'agent-summary';
    const intro = el('div', '', 'agent-compact-intro');
    intro.append(el('span', 'MONITOR', 'agent-compact-kicker'), el('h2', 'Agent'), el('p', '查看会话与用量，了解响应速度和账户额度。', 'agent-note'));
    const header = el('header'); header.append(el('h3', '运行概览'), el('span', '今日 · 05:00 起', 'agent-note')); card.append(header);
    const list = accountData?.accounts || [];
    const available = list.filter(a => a.status === 'available').length;
    const exhausted = list.filter(a => a.status === 'exhausted').length;
    const unknown = list.length - available - exhausted;
    const quota = !accountData || !list.length ? '额度未取得' : `${available} 个可用` + (exhausted ? ` · ${exhausted} 个耗尽` : '') + (unknown ? ` · ${unknown} 个待核` : '');
    const summary = el('div', '', 'agent-compact-stats');
    for (const [title, value, hint] of [
      ['运行中会话', number(d?.currentRunning), `今日活跃 ${number(d?.todayActiveSessions ?? d?.today.sessions)} 个`],
      ['今日 token', number(d?.today.totalTokens), `平均每次 ${number(d?.today.meanTokens)} token`],
      ['平均首次响应', duration(d?.today.meanFirstResponseMs), `平均交付 ${duration(d?.today.meanDeliveryMs)}`],
      ['账户额度', quota, '查看各账户剩余额度与重置时间'],
    ]) {
      const item = el('div'), metric = el('strong', value);
      if (title === '账户额度' && accountData && list.length) {
        metric.textContent = ''; metric.classList.add('agent-compact-quota'); metric.setAttribute('aria-label', quota);
        for (const [count, label, status] of [[available, '可用', available ? 'available' : 'unknown'], [exhausted, '耗尽', 'exhausted'], [unknown, '待核', 'unknown']]) {
          if (!count && label !== '可用') continue;
          const badge = el('span', `${count} ${label}`, 'agent-compact-quota-badge'); badge.dataset.status = status; metric.append(badge);
        }
      }
      item.append(el('small', title), metric, el('small', hint)); summary.append(item);
    }
    card.append(summary);
    if (accountData?.coverage?.gaps?.some(gap => gap.source === 'accounts')) card.append(el('p', '部分账户额度未取得', 'agent-note'));
    const open = el('button', '查看详情', 'agent-compact-open'); open.type = 'button'; open.setAttribute('aria-haspopup', 'dialog'); header.append(open);
    const dialog = el('dialog', '', 'agent-compact-dialog'); dialog.setAttribute('aria-labelledby', 'agent-compact-title');
    const top = el('header', '', 'agent-compact-top'), title = el('h2', 'Agent 监控'); title.id = 'agent-compact-title';
    const close = el('button', '关闭'); close.type = 'button'; close.autofocus = true;
    const reload = el('button', '刷新'); reload.type = 'button'; reload.addEventListener('click', () => { reload.disabled = true; refresh(); });
    top.append(title, reload, close); dialog.append(top);
    const body = el('div', '', 'agent-compact-body'); dialog.append(body);
    if (d) body.append(full.querySelector('.agent-heading'), full.querySelector('.agent-counts'));
    else body.append(el('p', '运行指标暂未取得，可刷新重试；账户额度单独显示。', 'agent-note'));
    const tabs = el('div', '', 'agent-compact-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '监控详情'); body.append(tabs);
    const groups = [
      ['usage', '用量', ['totalTokens', 'meanTokens']],
      ['response', '响应与交付', ['meanFirstResponseMs', 'meanDeliveryMs', 'firstDeliveryMs']],
      ['context', '上下文注入', ['meanInjectionChars', 'firstInjectionChars']],
      ['accounts', '账户', []],
    ];
    const panels = new Map(), buttons = new Map();
    for (const [key, label, metrics] of groups) {
      const tab = el('button', label); tab.type = 'button'; tab.id = `agent-tab-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `agent-panel-${key}`); tabs.append(tab); buttons.set(key, tab);
      const panel = el('section', '', 'agent-compact-panel'); panel.id = `agent-panel-${key}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0; body.append(panel); panels.set(key, panel);
      const choices = el('div', '', 'agent-compact-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', `${label}趋势指标`);
      const cards = metrics.map(metric => full.querySelector(`[data-metric="${metric}"]`)).filter(Boolean);
      if (cards.length) {
        panel.append(choices);
        for (const metricCard of cards) {
          const metric = metricCard.dataset.metric, pick = el('button'); pick.type = 'button'; pick.dataset.pick = metric;
          pick.append(el('small', metricCard.querySelector('h4').textContent), el('strong', metricCard.querySelector('.agent-value').textContent));
          pick.addEventListener('click', () => selectMetric(metric)); choices.append(pick); panel.append(metricCard);
        }
        function selectMetric(metric) {
          state[`compactMetric-${key}`] = metric;
          panel.querySelectorAll('[data-metric]').forEach(item => { item.hidden = item.dataset.metric !== metric; });
          choices.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.pick === metric)));
        }
        selectMetric(metrics.includes(state[`compactMetric-${key}`]) ? state[`compactMetric-${key}`] : metrics[0]);
      }
      if (key === 'response' && d) panel.append(full.querySelector('.agent-journey'));
      if (key === 'context' && d) panel.append(full.querySelector('[data-agent-fold="sources"]'));
      if (key === 'accounts') {
        accounts.querySelectorAll('.monitoring-table-wrap tbody tr').forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length === 4) cells[0].append(el('small', `更新于 ${cells[3].textContent}`, 'agent-account-observed-mobile'));
        });
        panel.append(accounts);
      }
    }
    const scope = full.querySelector('[data-agent-fold="scope"]'); if (scope) body.append(scope);
    function selectTab(key, focus = false) {
      state.compactTab = key;
      panels.forEach((panel, id) => { panel.hidden = id !== key; });
      buttons.forEach((button, id) => { button.setAttribute('aria-selected', String(id === key)); button.tabIndex = id === key ? 0 : -1; });
      if (focus) buttons.get(key).focus();
    }
    buttons.forEach((button, key) => button.addEventListener('click', () => selectTab(key)));
    tabs.addEventListener('keydown', event => {
      const keys = [...buttons.keys()], i = keys.indexOf(state.compactTab);
      const next = event.key === 'ArrowRight' ? (i + 1) % keys.length : event.key === 'ArrowLeft' ? (i + keys.length - 1) % keys.length : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); selectTab(keys[next], true); }
    });
    selectTab(panels.has(state.compactTab) ? state.compactTab : 'usage');
    open.addEventListener('click', () => dialog.showModal()); close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => open.focus());
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
    root.append(intro, card, dialog);
    if (wasOpen) { dialog.showModal(); if (focused) close.focus(); }
  }
  g.RemoteLabAgentDashboard = { render, renderCompact };
})(window);

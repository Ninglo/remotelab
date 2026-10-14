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
    card.append(el('h4', title), el('strong', format(value), 'agent-value'), el('p', `${unit === '耗时' ? '越短越快' : unit} · 今日统计 ${sample(d.today)} 次`, 'agent-note'));
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
    const fold = disclosure('查看每天的数据', key, state);
    fold.append(table(['日期', unit, '统计次数'], d.days.map(row => [row.day, Number.isFinite(row[key]) ? (unit === '耗时' ? duration(row[key]) : row[key].toLocaleString('zh-CN', { maximumFractionDigits: 2 })) : '暂无数据', sample(row)])));
    card.append(fold); return card;
  }
  function durationChart(d, key, title, first, state) {
    const choices = [
      ['total', '收到 → 最终送达', '从系统收到消息，到最终结果全部送达。'],
      ['wait', '收到 → 开始运行', '系统收到消息后，排队、准备并启动执行的时间。'],
      ['run', '运行阶段', '从开始执行到执行结束，包括思考和工具操作。'],
      ['send', '运行结束 → 最终送达', '执行结束后，把最终结果送达的时间。'],
    ];
    const stateKey = `${key}Stage`, stage = choices.some(c => c[0] === state[stateKey]) ? state[stateKey] : 'total';
    const stats = row => stage === 'total' ? row[first ? 'firstDelivery' : 'delivery']
      : row[first ? 'firstDeliveryStages' : 'deliveryStages']?.[stage];
    const project = row => ({ ...row, [key]: stats(row)?.mean ?? null });
    const explanation = choices.find(c => c[0] === stage)[2] + (stage === 'total' ? '显示今日平均用时。' : '只统计时间记录完整的消息。');
    const card = chart({ ...d, today: project(d.today), days: d.days.map(project) }, key, title, '耗时', row => stats(row)?.count ?? 0, explanation, state);
    const label = el('label', '查看阶段 ', 'agent-stage-control'), select = el('select');
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
    root.replaceChildren(); root.classList.add('agent-dashboard'); root.dataset.testid = 'agent-dashboard';
    if (!d) { root.append(el('p', '统计暂不可用，请稍后刷新。')); return; }
    const heading = el('div', '', 'agent-heading');
    heading.append(el('p', `${d.today.day} 05:00 — 次日 05:00 · 北京时间 · 今日尚未结束 · 下方为近七日趋势`, 'agent-note'));
    root.append(heading);
    const counts = el('div', '', 'agent-counts');
    for (const [name, value, note] of [['正在执行的会话', d.currentRunning, d.unknownStates ? `${d.unknownStates} 个会话状态暂未取得` : '此刻正在处理任务'], ['今日活跃会话', d.todayActiveSessions ?? d.today.sessions, '今天处理过任务的会话，同一会话只计一次']]) {
      const item = el('div'); item.append(el('small', name), el('strong', number(value)), el('small', note)); counts.append(item);
    } root.append(counts);
    const grid = el('div', '', 'agent-metrics');
    for (const args of [
      ['meanTokens', '每次执行的平均 Token 用量', 'Token / 次执行', r => r.usageRuns, '今日 Token 总数除以记录到用量的执行次数，包含对话和后台任务。'],
      ['totalTokens', '今日 Token 总数', 'Token', r => r.usageRuns, '今天记录到的模型输入与输出总量，包含对话和后台任务。'],
      ['meanInjectionChars', '每次执行的平均背景字数', '字符 / 次执行', r => r.injection.count, '每次处理对话时，RemoteLab 提供给模型的背景文字平均有多少字。'],
      ['firstInjectionChars', '新会话首轮的平均背景字数', '字符 / 首次执行', r => r.firstInjection.count, '只统计新会话第一次执行时提供的背景文字。'],
    ]) grid.append(chart(d, ...args, state));
    const response = chart(d, 'meanFirstResponseMs', '首次回复平均等待时间', '耗时', r => r.firstResponse?.count ?? 0, '从你发出消息，到第一条文字回复送达，包括开场或进展；不含表情和自动受理通知。', state);
    response.classList.add('agent-first-response'); grid.append(response);
    grid.append(durationChart(d, 'meanDeliveryMs', '平均交付用时', false, state),
      durationChart(d, 'firstDeliveryMs', '新会话首轮的平均交付用时', true, state));
    root.append(grid);
    const journey = el('section', '', 'agent-journey'); journey.dataset.testid = 'journey-timing';
    journey.append(el('h3', '今日各环节用时'));
    const stages = d.today.journeyStages || {};
    journey.append(el('p', `按 ${stages.total?.count ?? 0} 条时间记录完整的飞书消息统计。五个环节的平均用时相加，等于合计。`, 'agent-note'));
    journey.append(table(['环节', '计时范围', '平均用时', '统计次数'], [
      ['receive', '消息接收', '发出消息 → 系统收到'],
      ['prepare', '排队与准备', '系统收到 → 准备完成'],
      ['launch', '启动执行', '准备完成 → 开始执行'],
      ['run', '执行过程', '开始执行 → 执行结束'],
      ['send', '结果发送', '执行结束 → 最终结果送达'],
      ['total', '合计', '发出消息 → 最终结果送达'],
    ].map(([key, name, range]) => [name, range, duration(stages[key]?.mean), stages[key]?.count ?? 0])));
    journey.append(el('p', '首次回复是你第一次收到文字反馈的时间，可能发生在执行过程中，不计入上面的环节加总。', 'agent-note'));
    root.append(journey);
    const sources = disclosure('查看背景文字的来源', 'sources', state);
    if (d.documents?.length) {
      sources.append(el('h4', '常用文档'));
      sources.append(table(['文档名称', '文档字数', '使用时机'], d.documents.map(row => {
        const a = el('a', row.name); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.chars === null ? row.name : a, row.chars === null ? '未取得' : row.chars.toLocaleString(), row.when];
      })));
      sources.append(el('p', '文档字数不等于每次实际提供给模型的字数。下面是一条真实会话首轮的记录。', 'agent-note'));
    }
    if (d.sources) {
      sources.append(el('p', `最近一条有完整记录的新会话首轮 · ${new Date(d.sources.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 共 ${d.sources.chars.toLocaleString()} 字符`, 'agent-note'));
      sources.append(table(['文档／内容来源', '实际提供字数', '查看来源'], d.sources.entries.map(row => {
        const a = el('a', row.sourcePath?.endsWith('.md') ? '查看规则文档' : '查看组装来源'); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.name, row.chars.toLocaleString(), row.sourcePath ? a : '来源见 Session'];
      })));
      const a = el('a', '打开这条记录所在的会话'); a.href = `${sessionBase}/?tab=sessions&session=${encodeURIComponent(d.sources.sessionId)}`; sources.append(a);
    } else sources.append(el('p', '暂无可核对的新会话首轮记录。'));
    sources.append(el('p', '展示该样本实际注入的内容块，含标题与分隔符；链接指向当前规则文档或组装代码。人员、群背景随入口变化，不是一份全体会话固定照抄的清单。Harness 原生规则、AGENTS.md、Skill 与后续工具读取不在此计量内。', 'agent-note')); root.append(sources);
    const coverage = d.coverage || {};
    root.append(el('p', `更新于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}${coverage.truncated ? ' · 当前只统计了部分执行记录' : ''}。缺少数据时显示“—”。`, 'agent-note'));
    const scope = disclosure('这些数字怎么算', 'scope', state);
    scope.append(el('p', `已读取 ${coverage.sampledRuns ?? 0} 条执行记录，共有 ${coverage.eligibleRuns ?? 0} 条可供统计。未取得的记录：执行信息 ${coverage.missingRuns || 0} 条、消息信息 ${coverage.missingRequests || 0} 条、背景文字 ${coverage.missingInjections || 0} 条。`, 'agent-note'));
    Object.values(d.semantics || {}).forEach(text => scope.append(el('p', text, 'agent-note')));
    scope.append(el('p', `今天有 ${d.today.unknownFirstRuns} 条记录无法确认是不是会话首轮，未计入首轮指标。每项平均值只使用该项有数据的记录。Token 包含后台任务，背景字数和耗时只统计对话。`, 'agent-note')); root.append(scope);
  }
  g.RemoteLabAgentDashboard = { render };
})(window);

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
    card.append(el('h4', title), el('strong', format(value), 'agent-value'), el('p', `${unit === '耗时' ? '越短越快' : unit} · 今日 ${sample(d.today)} 个样本`, 'agent-note'));
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
      const text = `${row.day}：${format(row[key])}，${sample(row)} 个样本`; dot.setAttribute('aria-label', text);
      const tooltip = svgNode('title'); tooltip.textContent = text; dot.append(tooltip); svg.append(dot);
    }); card.append(svg);
    const fold = disclosure('逐日数值与样本', key, state);
    fold.append(table(['统计日', unit, '样本'], d.days.map(row => [row.day, Number.isFinite(row[key]) ? (unit === '耗时' ? duration(row[key]) : row[key].toLocaleString('zh-CN', { maximumFractionDigits: 2 })) : '无样本', sample(row)])));
    card.append(fold); return card;
  }
  function durationChart(d, key, title, first, state) {
    const choices = [
      ['total', '收到 → 最终送达', '从收到请求到最终正文全部送达。'],
      ['wait', '收到 → 开始运行', '收到请求后，等待准备和启动运行的时间。'],
      ['run', '运行阶段', '从开始运行到运行结束，含模型思考与工具执行。'],
      ['send', '运行结束 → 最终送达', '运行结束后，到最终正文全部送达的时间。'],
    ];
    const stateKey = `${key}Stage`, stage = choices.some(c => c[0] === state[stateKey]) ? state[stateKey] : 'total';
    const stats = row => stage === 'total' ? row[first ? 'firstDelivery' : 'delivery']
      : row[first ? 'firstDeliveryStages' : 'deliveryStages']?.[stage];
    const project = row => ({ ...row, [key]: stats(row)?.mean ?? null });
    const explanation = choices.find(c => c[0] === stage)[2] + (stage === 'total' ? '按有效飞书执行记录取平均。' : '仅统计阶段时间齐全的飞书执行记录。');
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
    for (const [name, value, note] of [['当前运行 Session', d.currentRunning, d.unknownStates ? `${d.unknownStates} 个状态未取得` : '当前状态快照'], ['今日累计 Session', d.todayActiveSessions ?? d.today.sessions, '今日有运行记录，按 Session 去重']]) {
      const item = el('div'); item.append(el('small', name), el('strong', number(value)), el('small', note)); counts.append(item);
    } root.append(counts);
    const grid = el('div', '', 'agent-metrics');
    for (const args of [
      ['meanTokens', '今日每次执行平均用量', 'Token / 次执行', r => r.usageRuns, '今日总 Token ÷ 有用量记录的执行次数，含前台与后台。'],
      ['totalTokens', '今日累计用量', 'Token', r => r.usageRuns, '今日已记录的输入与输出 Token 合计，含前台与后台。'],
      ['meanInjectionChars', '今日每次执行平均注入', '字符 / 次执行', r => r.injection.count, '前台对话中，有注入记录的各次执行取平均。'],
      ['firstInjectionChars', '新 Session 首次执行平均注入', '字符 / 首次执行', r => r.firstInjection.count, '只取新 Session 的第一次执行，再对有效记录取平均。'],
    ]) grid.append(chart(d, ...args, state));
    grid.append(durationChart(d, 'meanDeliveryMs', '今日每次执行平均交付耗时', false, state),
      durationChart(d, 'firstDeliveryMs', '新 Session 首次执行平均交付耗时', true, state));
    root.append(grid);
    const sources = disclosure('常规对话注入来源 · 名称、字符数与原文入口', 'sources', state);
    if (d.documents?.length) {
      sources.append(el('h4', '常规文档与加载方式'));
      sources.append(table(['文档名称', '当前原文字数', '何时使用'], d.documents.map(row => {
        const a = el('a', row.name); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.chars === null ? row.name : a, row.chars === null ? '未取得' : row.chars.toLocaleString(), row.when];
      })));
      sources.append(el('p', '以上是当前原文的字符数，不表示每轮都把整份文档注入。下面按真实首轮快照显示实际注入量。', 'agent-note'));
    }
    if (d.sources) {
      sources.append(el('p', `最近一个可核对的首轮样本 · ${new Date(d.sources.observedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 共 ${d.sources.chars.toLocaleString()} 字符`, 'agent-note'));
      sources.append(table(['文档／内容来源', '实际注入字符', '查看来源'], d.sources.entries.map(row => {
        const a = el('a', row.sourcePath?.endsWith('.md') ? '查看规则文档' : '查看组装来源'); a.href = `${sourceBase}/api/monitoring/context-source?id=${encodeURIComponent(row.id)}`; a.target = '_blank'; a.rel = 'noopener';
        return [row.name, row.chars.toLocaleString(), row.sourcePath ? a : '来源见 Session'];
      })));
      const a = el('a', '打开该首轮所在 Session'); a.href = `${sessionBase}/?tab=sessions&session=${encodeURIComponent(d.sources.sessionId)}`; sources.append(a);
    } else sources.append(el('p', '尚未取得可确认的首轮注入样本。'));
    sources.append(el('p', '展示该样本实际注入的内容块，含标题与分隔符；链接指向当前规则文档或组装代码。人员、群背景随入口变化，不是一份全体会话固定照抄的清单。Harness 原生规则、AGENTS.md、Skill 与后续工具读取不在此计量内。', 'agent-note')); root.append(sources);
    const coverage = d.coverage || {};
    root.append(el('p', `已读取 ${coverage.sampledRuns ?? 0} / ${coverage.eligibleRuns ?? 0} 次执行记录${coverage.truncated ? ' · 部分覆盖' : ''}；缺失运行 ${coverage.missingRuns || 0}、请求 ${coverage.missingRequests || 0}、注入 ${coverage.missingInjections || 0}。无样本保留空缺。更新于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`, 'agent-note'));
    const scope = disclosure('统计口径与覆盖范围', 'scope', state);
    Object.values(d.semantics || {}).forEach(text => scope.append(el('p', text, 'agent-note')));
    scope.append(el('p', `首轮归属暂无法确认：今日 ${d.today.unknownFirstRuns} 个样本；各指标只除以各自有效样本数。用量含前后台，注入与交付只统计前台运行；图表不能单独证明任务质量变化。`, 'agent-note')); root.append(scope);
  }
  g.RemoteLabAgentDashboard = { render };
})(window);

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
  function chart(d, key, title, unit, sample, state) {
    const card = el('section', '', 'agent-metric'); card.dataset.metric = key;
    const value = d.today[key], format = unit === '耗时' ? duration : number;
    card.append(el('h4', title), el('strong', format(value), 'agent-value'), el('p', `${unit === '耗时' ? '越短越快' : unit} · 今日 ${sample(d.today)} 个样本`, 'agent-note'));
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
  function render(root, d, { state = {}, sourceBase = '', sessionBase = '' } = {}) {
    root.replaceChildren(); root.classList.add('agent-dashboard'); root.dataset.testid = 'agent-dashboard';
    if (!d) { root.append(el('p', '统计暂不可用，请稍后刷新。')); return; }
    const heading = el('div', '', 'agent-heading'); heading.append(el('h3', 'Agent 运行概览'), el('span', 'TODAY / 7 DAYS'));
    root.append(heading, el('p', `${d.today.day} 05:00 — 次日 05:00 · 北京时间 · 今日尚未结束`, 'agent-note'));
    const counts = el('div', '', 'agent-counts');
    for (const [name, value, note] of [['当前运行 Session', d.currentRunning, d.unknownStates ? `${d.unknownStates} 个状态未取得` : '当前状态快照'], ['今日累计 Session', d.todayActiveSessions ?? d.today.sessions, '今日有运行记录，按 Session 去重']]) {
      const item = el('div'); item.append(el('small', name), el('strong', number(value)), el('small', note)); counts.append(item);
    } root.append(counts);
    const grid = el('div', '', 'agent-metrics');
    for (const args of [
      ['meanTokens', '今日平均用量', 'Token / 次执行', r => r.usageRuns],
      ['totalTokens', '今日总用量', 'Token', r => r.usageRuns],
      ['meanInjectionChars', '今日平均上下文注入', '字符 / 次执行', r => r.injection.count],
      ['firstInjectionChars', '首轮上下文注入', '字符 / 新 Session 首轮', r => r.firstInjection.count],
      ['meanDeliveryMs', '今日平均交付耗时', '耗时', r => r.delivery.count],
      ['firstDeliveryMs', '首轮交付耗时', '耗时', r => r.firstDelivery.count],
    ]) grid.append(chart(d, ...args, state)); root.append(grid);
    const sources = disclosure('常规对话注入来源 · 名称、字符数与原文入口', 'sources', state);
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

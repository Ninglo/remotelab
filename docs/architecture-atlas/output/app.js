import { meta, references, nodes, overviewGraphs, actors, sequences, feedbackGraph, feedbackDetails,
  questionLevels, states, simulations, openings, rollout, contracts, invariants } from './guide-data.js?v=20261003c';

const el = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const github = (path, pilot = true) => `https://github.com/Ninglo/remotelab/blob/${pilot ? meta.pilotCommit : meta.mainCommit}/${path}`;
const sourceLinks = key => (references[key] || []).map(path => `<a href="${github(path, !['background'].includes(key))}" target="_blank" rel="noopener noreferrer">${escape(path)} ↗</a>`).join('');
const state = { overview: 'target', sequence: 'long', simulation: 'long', frame: 0 };

function controls(rootId, entries, selected, onChange) {
  const root = el(rootId);
  root.replaceChildren();
  for (const [key, value] of Object.entries(entries)) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = value.label;
    button.dataset.choice = key; button.setAttribute('aria-pressed', String(key === selected));
    button.addEventListener('click', () => onChange(key));
    root.append(button);
  }
}

// Wrap labels by visible character width, keeping CJK text readable in SVG.
function lines(text, budget = 16) {
  const out = []; let current = '', width = 0;
  for (const c of text) {
    const next = /[\x00-\x7f]/.test(c) ? .55 : 1;
    if (current && width + next > budget) { out.push(current); current = ''; width = 0; }
    current += c; width += next;
  }
  if (current) out.push(current);
  return out;
}

function svgText(text, x, y, className, budget, lineHeight = 17, anchor = 'start') {
  return `<text class="${className}" x="${x}" y="${y}" text-anchor="${anchor}">${lines(text, budget).map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escape(line)}</tspan>`).join('')}</text>`;
}

function drawGraph(rootId, graph, resolveNode, onSelect) {
  const marker = `${rootId}-arrow`;
  let svg = `<svg viewBox="0 0 1120 ${graph.height}" role="group" aria-label="${escape(el(rootId).getAttribute('aria-label'))}"><defs><marker id="${marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#969da6" stroke-width="1.2"/></marker></defs>`;
  for (const lane of graph.lanes || []) svg += `<rect class="lane-bg" x="${lane.x}" y="55" width="${lane.w}" height="${graph.height - 77}" rx="10"/><text class="lane-label" x="${lane.x + lane.w/2}" y="83" text-anchor="middle">${escape(lane.label)}</text>`;
  for (const edge of graph.edges) {
    svg += `<polyline class="flow-edge${edge.async ? ' async' : ''}" points="${edge.points.map(p=>p.join(',')).join(' ')}" marker-end="url(#${marker})"/>`;
    if (edge.label) svg += `<text class="edge-label" x="${edge.at[0]}" y="${edge.at[1]}" text-anchor="middle">${escape(edge.label)}</text>`;
  }
  for (const node of graph.nodes) {
    const id = node.ref || node.id;
    const data = resolveNode(id);
    svg += `<g class="graph-node ${data.role || node.tone || ''}" role="button" tabindex="0" aria-pressed="false" aria-label="${escape(data.title)}：查看职责" data-node="${escape(id)}"><rect class="node-box" x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="9"/>`;
    if (data.owner) {
      svg += svgText(data.owner,node.x+14,node.y+21,'node-owner',24,12);
      svg += svgText(data.title,node.x+14,node.y+51,'node-title',Math.floor((node.w-28)/15),18);
      svg += `<text class="node-status" x="${node.x+14}" y="${node.y+node.h-15}">${escape(data.status)}</text>`;
    } else {
      svg += svgText(data.title,node.x+14,node.y+29,'node-title',Math.floor((node.w-28)/15),20);
      svg += svgText(data.sub || '',node.x+14,node.y+58,'node-sub',Math.floor((node.w-28)/11),15);
    }
    svg += '</g>';
  }
  el(rootId).innerHTML = svg + '</svg>';
  const select = id => {
    el(rootId).querySelectorAll('[data-node]').forEach(item => {
      const active = item.dataset.node === id;
      item.classList.toggle('is-selected', active); item.setAttribute('aria-pressed', String(active));
    });
    onSelect(id);
  };
  el(rootId).querySelectorAll('[data-node]').forEach(item => {
    item.addEventListener('click', () => select(item.dataset.node));
    item.addEventListener('keydown', e => {
      if (['Enter',' '].includes(e.key)) { e.preventDefault(); select(item.dataset.node); }
    });
  });
  select(graph.defaultNode || graph.nodes[0].ref || graph.nodes[0].id);
}

function showNode(id) {
  const data = nodes[id];
  el('overview-detail').innerHTML = `<div><span class="badge ${state.overview === 'target' ? 'proposed' : ''}">${escape(data.status)}</span><h3>${escape(data.title)}</h3><p class="detail-summary">${escape(data.summary)}</p><p class="detail-proof">${escape(data.evidence)}</p><div class="source-links">${sourceLinks(data.refs)}</div></div><dl class="detail-facts">${[['owner','谁承担'],['stored','保存在哪里'],['input','接收什么'],['async','异步与恢复'],['output','交给谁 / 输出什么']].map(([key,label])=>`<div><dt>${label}</dt><dd>${escape(data[key])}</dd></div>`).join('')}</dl>`;
}

function renderOverview(key = state.overview) {
  state.overview = key;
  controls('overview-controls', overviewGraphs, key, renderOverview);
  el('overview-intro').textContent = overviewGraphs[key].intro;
  drawGraph('overview-graph',overviewGraphs[key],id=>nodes[id],showNode);
}

function renderSequence(key = state.sequence) {
  state.sequence = key;
  controls('sequence-controls',sequences,key,renderSequence);
  const sequence = sequences[key];
  el('sequence-intro').textContent = sequence.lead;
  const height = 132 + sequence.steps.length * 75;
  const xs = [90,320,545,770,1000];
  const index = Object.fromEntries(actors.map((actor,i)=>[actor.id,i]));
  let svg = `<svg viewBox="0 0 1120 ${height}" role="group" aria-label="${escape(sequence.label)}异步时序"><defs><marker id="sequence-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#8b94a1" stroke-width="1.2"/></marker></defs>`;
  actors.forEach((actor,i)=>{
    svg += `<rect x="${xs[i]-86}" y="18" width="172" height="59" rx="7" fill="${actor.id==='harness'?'#f5f1fa':'#f7f8fa'}"/><text class="actor-label" x="${xs[i]}" y="43" text-anchor="middle">${escape(actor.label)}</text><text class="actor-owner" x="${xs[i]}" y="61" text-anchor="middle">${escape(actor.owner)}</text><line class="life-line" x1="${xs[i]}" y1="83" x2="${xs[i]}" y2="${height-20}"/>`;
  });
  sequence.steps.forEach(([from,to,title,detail],i)=>{
    const x1=xs[index[from]],x2=xs[index[to]],y=137+i*75;
    const labelLines=lines(title, Math.max(12,Math.floor(Math.abs(x2-x1)/12)-3));
    svg += `<g class="sequence-step" role="button" tabindex="0" data-step="${i}" aria-pressed="false" aria-label="步骤 ${i+1}：${escape(title)}"><rect class="sequence-row" x="15" y="${y-48}" width="1090" height="68" opacity=".92"/><text class="sequence-number" x="29" y="${y}">${String(i+1).padStart(2,'0')}</text><line class="sequence-arrow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-end="url(#sequence-arrow)"/><text class="sequence-label" x="${(x1+x2)/2}" y="${y-12-(labelLines.length-1)*16}" text-anchor="middle">${labelLines.map((line,j)=>`<tspan x="${(x1+x2)/2}" dy="${j?16:0}">${escape(line)}</tspan>`).join('')}</text><title>${escape(detail)}</title></g>`;
  });
  el('sequence-graph').innerHTML=svg+'</svg>';
  const select = i => {
    const [from,to,title,detail] = sequence.steps[i];
    el('sequence-graph').querySelectorAll('[data-step]').forEach(item=>{
      const active=Number(item.dataset.step)===i;
      item.classList.toggle('is-selected',active);item.setAttribute('aria-pressed',String(active));
    });
    el('sequence-detail').innerHTML=`<strong>${String(i+1).padStart(2,'0')} · ${escape(actors[index[from]].label)} → ${escape(actors[index[to]].label)}：${escape(title)}</strong><p>${escape(detail)}</p>`;
  };
  el('sequence-graph').querySelectorAll('[data-step]').forEach(item=>{
    item.addEventListener('click',()=>select(Number(item.dataset.step)));
    item.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(Number(item.dataset.step));}});
  });
  select(0);
}

function renderFeedback() {
  drawGraph('feedback-graph',feedbackGraph,id=>feedbackGraph.nodes.find(node=>node.id===id),id=>{
    const data=feedbackGraph.nodes.find(node=>node.id===id);
    el('feedback-detail').innerHTML=`<strong>${escape(data.title)}</strong><p>${escape(feedbackDetails[id])}</p>`;
  });
  el('question-levels').innerHTML=questionLevels.map(level=>`<article class="question-level ${level.tone}"><span class="example-label">${escape(level.example)}</span><h4>${escape(level.label)}</h4><p>${escape(level.behavior)}</p><div class="silence ${level.tone}">无回复：${escape(level.silence)}</div></article>`).join('');
}

function renderSimulation(key = state.simulation, frame = 0) {
  state.simulation=key;state.frame=frame;
  controls('simulation-controls',simulations,key,newKey=>renderSimulation(newKey,0));
  const scenario=simulations[key],current=scenario.frames[frame];
  el('frame-list').innerHTML=scenario.frames.map((item,i)=>`<li><button type="button" data-frame="${i}" ${i===frame?'aria-current="step"':''}><span class="frame-index">${String(i+1).padStart(2,'0')}</span>${escape(item.label)}</button></li>`).join('');
  el('frame-list').querySelectorAll('[data-frame]').forEach(button=>button.addEventListener('click',()=>renderSimulation(key,Number(button.dataset.frame))));
  el('previous-frame').disabled=frame===0;
  el('next-frame').disabled=frame===scenario.frames.length-1;
  el('frame-note').textContent=current.note||'按可核对事件更新状态，不按计时器刷进度。';
  el('run-indicator').textContent=`执行：${current.run}`;
  const opening=scenario.frames.slice(0,frame+1).find(item=>item.opening)?.opening;
  const title='统一消息接入、进度与交互';
  let html='<div class="conversation-body"><div class="user-bubble">把消息接入、进度和用户反馈规划成一套清楚的架构。</div>';
  if(current.reaction)html+=`<div class="reaction">✓ ${escape(current.reaction)}</div>`;
  if(opening)html+=`<div class="message opening-message"><div class="message-kind">主 Harness · 开场与工作话题入口</div><p>${escape(opening)}</p></div>`;
  if(current.card){
    const marks={done:'✓',running:'◉',pending:'○',cancelled:'–'};
    html+=`<article class="work-card" data-task-id="demo-task"><div class="card-goal">${title}</div><div class="card-meta"><span class="task-state">${escape(current.status)}</span>${current.delivery?`<span>${escape(current.delivery)}</span>`:''}</div><h4>交付项 · 按实际验收更新</h4><ul class="deliverables">${current.items.map(item=>`<li class="${item.status}"><span class="mark">${marks[item.status]}</span><span>${escape(item.title)}${item.status==='cancelled'?'（已取消）':''}</span></li>`).join('')}</ul><div class="progress-area"><h4>实际进度</h4><p>${escape(current.progress)}</p></div><div class="card-foot">同一任务卡 · 事件版本 ${frame+1}${current.result?' · 正式结果见下方':''}</div></article>`;
  }
  if(current.question)html+=`<article class="question-card"><div class="question-head">单独交互卡 · ${escape(current.question.level)}</div><p>${escape(current.question.text)}</p><small>${escape(current.question.silence)}</small></article>`;
  if(current.reply)html+=`<div class="message"><div class="message-kind">回答用户主动插问 · 原任务继续</div><p>${escape(current.reply)}</p></div>`;
  if(current.result)html+=`<div class="message result-message"><div class="message-kind">正式结果 · ${escape(current.delivery||current.status)}</div><p>${escape(current.result)}</p></div>`;
  if(!current.card&&!opening&&!current.result)html+=`<div class="placeholder">${escape(current.status)}。当前无需另发一条固定开场。</div>`;
  el('conversation-body').innerHTML=html+'</div>';
}

el('previous-frame').addEventListener('click',()=>renderSimulation(state.simulation,Math.max(0,state.frame-1)));
el('next-frame').addEventListener('click',()=>renderSimulation(state.simulation,Math.min(simulations[state.simulation].frames.length-1,state.frame+1)));

function renderReference() {
  el('version').textContent=meta.version;
  el('architecture-status').textContent=meta.status;
  el('audit-boundary').textContent=meta.boundary;
  el('weak-opening').textContent=openings.weak;
  el('useful-opening').textContent=openings.useful;
  el('opening-rule').textContent=openings.rule;
  el('main-commit').textContent=meta.mainCommit.slice(0,8);
  el('pilot-commit').textContent=meta.pilotCommit.slice(0,8);
  el('state-lanes').innerHTML=states.map(lane=>`<article class="state-lane"><h3>${escape(lane.label)}</h3><div class="state-owner">维护者：${escape(lane.owner)}</div><ol class="state-track">${lane.states.map(status=>`<li>${escape(status)}</li>`).join('')}</ol><p>${escape(lane.meaning)}</p></article>`).join('');
  el('rollout-list').innerHTML=rollout.map((item,i)=>`<article class="rollout-item"><div><span class="eyebrow">${String(i+1).padStart(2,'0')} / ${escape(item.status||'待实施')}</span><h3>${escape(item.title)}</h3><div class="owner">承接：${escape(item.owner)}</div></div><dl><div><dt>已核对现状</dt><dd>${escape(item.now)}</dd></div><div><dt>目标改动</dt><dd>${escape(item.change)}</dd></div><div class="acceptance"><dt>真实入口验收</dt><dd>${escape(item.acceptance)}</dd></div></dl></article>`).join('');
  el('contract-rows').innerHTML=contracts.map(item=>`<tr><td>${escape(item.name)}<div class="caption">${escape(item.status)}</div></td><td>${escape(item.writer)}</td><td>${escape(item.fact)}</td><td>${escape(item.consumer)}</td></tr>`).join('');
  el('invariants').innerHTML=invariants.map(text=>`<li>${escape(text)}</li>`).join('');
  const labels={ingress:'入口与群话题',admission:'接纳与会话',runtime:'原生输入与停止',execution:'脱离网页的执行',projection:'表面输出选择',workboard:'稳定任务卡',questions:'普通提问 Broker',delivery:'结果投递与回执',jev:'现有 Jev 分支',background:'后置独立整理'};
  el('source-list').innerHTML=Object.keys(references).map(key=>`<div class="source-group"><strong>${escape(labels[key])}</strong><div class="source-links">${sourceLinks(key)}</div></div>`).join('');
}

renderReference(); renderOverview(); renderSequence(); renderFeedback(); renderSimulation();

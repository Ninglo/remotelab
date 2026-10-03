import { sourceCommit, statusNames, domains, nodes, paths, findings } from './atlas-data.js?v=20260929h';
import { experiences, feishuRules, resourceSnapshot, missingDimensions } from './experience-data.js?v=20260929h';
import { journeyRoutes, journeyStages } from './journey-data.js?v=20260929h';
import { stateLayers, situationGroups, situations } from './situation-data.js?v=20260929h';

const byId = new Map(nodes.map((node) => [node.id, node]));
const elements = {
  domainNav: document.querySelector('#domain-nav'),
  domainCount: document.querySelector('#domain-count'),
  nodeCount: document.querySelector('#node-count'),
  mapLayout: document.querySelector('#map-layout'),
  mapSearch: document.querySelector('#map-search'),
  resetMap: document.querySelector('#reset-map'),
  pathTabs: document.querySelector('#path-tabs'),
  pathContent: document.querySelector('#path-content'),
  findingList: document.querySelector('#finding-list'),
  detail: document.querySelector('#detail-panel'),
  main: document.querySelector('.main-content'),
  experienceList: document.querySelector('#experience-list'),
  feishuRules: document.querySelector('#feishu-rules'),
  journeyRouteTabs: document.querySelector('#journey-route-tabs'),
  journeyLead: document.querySelector('#journey-lead'),
  journeyStages: document.querySelector('#journey-stages'),
  loopPreview: document.querySelector('#loop-preview'),
  journeyMatrix: document.querySelector('#journey-matrix'),
  groupOverview: document.querySelector('#group-overview'),
  stateLayers: document.querySelector('#state-layers'),
  situationList: document.querySelector('#situation-list'),
  situationMatrix: document.querySelector('#situation-matrix'),
  resourceSummary: document.querySelector('#resource-summary'),
  missingDimensions: document.querySelector('#missing-dimensions'),
};

const state = { view: 'experience', domain: null, query: '', node: null, path: paths[0].id, route: journeyRoutes[0].id };
let renderedRoute = null;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const label = (id) => byId.get(id)?.title ?? id;
const stateLabel = (id) => stateLayers.find((layer) => layer.id === id)?.title ?? id;
const badge = (status) => `<span class="badge" data-tone="${escapeHtml(status)}">${escapeHtml(statusNames[status] ?? status)}</span>`;

function renderDomainNav() {
  elements.domainCount.textContent = String(domains.length);
  elements.domainNav.innerHTML = `
    <button class="domain-button ${state.domain === null ? 'is-active' : ''}" type="button" data-domain="all">
      <span class="domain-number">◎</span><span>全部区域</span><span class="domain-total">${nodes.length}</span>
    </button>
    ${domains.map((domain) => `<button class="domain-button ${state.domain === domain.id ? 'is-active' : ''}" type="button" data-domain="${escapeHtml(domain.id)}">
      <span class="domain-number">${domain.number}</span><span>${escapeHtml(domain.title)}</span><span class="domain-total">${nodes.filter((node) => node.domain === domain.id).length}</span>
    </button>`).join('')}`;
}

function matches(node, query) {
  if (!query) return true;
  const haystack = [node.title, node.summary, node.owner, node.contract, node.reads, node.writes, node.open,
    ...node.sources.map((source) => `${source.path} ${source.note}`)].join(' ').toLocaleLowerCase();
  return haystack.includes(query);
}

function renderMap() {
  const query = state.query.trim().toLocaleLowerCase();
  const visible = nodes.filter((node) => (!state.domain || node.domain === state.domain) && matches(node, query));
  elements.nodeCount.textContent = String(visible.length);
  elements.mapLayout.innerHTML = domains.filter((domain) => !state.domain || domain.id === state.domain).map((domain) => {
    const members = visible.filter((node) => node.domain === domain.id);
    if (!members.length) return '';
    return `<section class="domain-card" id="domain-${escapeHtml(domain.id)}">
      <div class="domain-head"><div><div class="domain-kicker">${domain.number} / ${escapeHtml(domain.id.toUpperCase())}</div><h3>${escapeHtml(domain.title)}</h3><p>${escapeHtml(domain.description)}</p></div><span class="domain-count">${members.length} 个机制</span></div>
      <div class="node-grid">${members.map((node) => `<button class="node-card ${state.node === node.id ? 'is-selected' : ''}" type="button" data-node="${escapeHtml(node.id)}" aria-label="查看${escapeHtml(node.title)}详情"><span><strong>${escapeHtml(node.title)}</strong><small>${escapeHtml(node.summary)}</small></span><span class="node-arrow" aria-hidden="true">↗</span></button>`).join('')}</div>
    </section>`;
  }).join('') || '<div class="empty-results">没有匹配的机制。试试其他关键词，或点击“显示全部”。</div>';
  renderDomainNav();
}

function renderPaths() {
  elements.pathTabs.innerHTML = paths.map((path) => `<button class="path-tab ${state.path === path.id ? 'is-active' : ''}" type="button" role="tab" aria-selected="${state.path === path.id}" data-path="${escapeHtml(path.id)}">${escapeHtml(path.title)}</button>`).join('');
  const path = paths.find((item) => item.id === state.path) ?? paths[0];
  elements.pathContent.innerHTML = `<div class="path-lead"><span class="path-label">CROSS-CUTTING PATH</span><h3>${escapeHtml(path.title)}</h3><p>${escapeHtml(path.lead)}</p></div>
    <div class="path-steps">${path.steps.map((step, index) => `<div class="path-step"><div class="step-track"><span class="step-number">${index + 1}</span></div><div class="step-body"><h4>${escapeHtml(step.title)}</h4><p>${escapeHtml(step.text)}</p><div>${step.nodes.map((id) => `<button class="step-node" type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div></div></div>`).join('')}</div>
    <div class="path-gap"><strong>待补证据：</strong>${escapeHtml(path.gap)}</div>`;
}

function renderFindings() {
  elements.findingList.innerHTML = findings.map((finding) => `<article class="finding-card"><div class="finding-top"><h3>${escapeHtml(finding.title)}</h3>${badge(finding.status)}</div><p>${escapeHtml(finding.text)}</p><div class="finding-nodes">${finding.nodes.map((id) => `<button type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div></article>`).join('');
}

function renderJourney() {
  const route = journeyRoutes.find((item) => item.id === state.route) ?? journeyRoutes[0];
  elements.journeyRouteTabs.innerHTML = journeyRoutes.map((item) => `<button type="button" role="tab" aria-selected="${item.id === route.id}" class="journey-route-tab ${item.id === route.id ? 'is-active' : ''}" data-route="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join('');
  elements.journeyLead.innerHTML = `<span class="journey-route-kind">${escapeHtml(route.kind)}</span><p>${escapeHtml(route.intro)}</p>`;
  const factLabels = [
    ['action', '谁处理、谁判断'], ['stored', '写入哪里'],
    ['resources', '模型与资源'], ['protocol', '接口与协议'],
  ];
  elements.journeyStages.innerHTML = journeyStages.map((stage, index) => {
    const step = route.stages[stage.id];
    return `<article id="journey-stage-${escapeHtml(stage.id)}" class="journey-stage ${step.skipped ? 'is-skipped' : ''} ${stage.id === 'decide' ? 'is-decision' : ''}">
      <div class="journey-timeline-mark"><span>${stage.id === 'decide' ? '◇' : String(index + 1).padStart(2, '0')}</span></div>
      <div class="journey-stage-body"><div class="journey-stage-head"><span class="journey-question">${escapeHtml(stage.question)}</span><h3>${escapeHtml(stage.title)}</h3><p>${escapeHtml(step.summary)}</p>${step.skipped ? '<span class="journey-skip-tag">本路径跳过工作 Run</span>' : ''}</div>
      <p class="journey-visible"><strong>用户看到</strong>${escapeHtml(step.visible)}</p>
      <details class="journey-code"><summary>展开处理、存储、消耗、接口与源码 <span aria-hidden="true">⌄</span></summary><div class="journey-code-body"><div class="journey-stage-marks"><span>计算：${escapeHtml(route.marks[index][0])}</span><span>主要状态：${escapeHtml(route.marks[index][1])}</span></div><div class="journey-facts">${factLabels.map(([key, title]) => `<div class="journey-fact"><strong>${title}</strong><p>${escapeHtml(step[key])}</p></div>`).join('')}</div><div class="experience-node-links">${stage.nodes.map((id) => `<button type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div><div class="experience-source-list">${step.sources.map(sourceMarkup).join('')}</div></div></details></div>
    </article>`;
  }).join('');
  renderedRoute = route.id;
}

function renderLoopPreview() {
  elements.loopPreview.innerHTML = paths.map((path, index) => `<article class="loop-item"><span class="loop-number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(path.title)}</h3><p>${escapeHtml(path.lead)}</p><button type="button" data-path="${escapeHtml(path.id)}">查看触发、读写与代码 ↗</button></div></article>`).join('');
}

function renderSituationOverview() {
  elements.groupOverview.innerHTML = situationGroups.map((group, index) => `<button type="button" class="group-overview-item" data-case-group="${escapeHtml(group.id)}"><span>${String(index + 1).padStart(2, '0')} / ${situations.filter((item) => item.group === group.id).length} 种情形</span><strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(group.lead)}</small></button>`).join('');
}

function renderStateLayers() {
  elements.stateLayers.innerHTML = stateLayers.map((layer, index) => `<details id="state-layer-${escapeHtml(layer.id)}" class="state-layer"><summary><span class="state-layer-index">${String(index + 1).padStart(2, '0')}</span><span class="state-layer-main"><strong>${escapeHtml(layer.title)}</strong><small>${escapeHtml(layer.meaning)}</small></span><span class="state-layer-scope">${escapeHtml(layer.scope)}</span><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="state-layer-body"><dl><div><dt>实际位置</dt><dd>${escapeHtml(layer.location)}</dd></div><div><dt>何时写入</dt><dd>${escapeHtml(layer.writeWhen)}</dd></div><div><dt>未来读取</dt><dd>${escapeHtml(layer.reuse)}</dd></div></dl><div class="state-layer-links"><button type="button" data-node="${escapeHtml(layer.node)}">查看机制 ↗</button></div>${sourceMarkup(layer.source)}</div></details>`).join('');
}

function situationLayerLinks(ids, verb) {
  return ids.length
    ? ids.map((id) => `<button type="button" data-layer="${escapeHtml(id)}">${escapeHtml(verb)} ${escapeHtml(stateLabel(id))} ↗</button>`).join('')
    : '<span class="no-layer-write">没有确认的自动写入</span>';
}

function renderSituations() {
  let index = 0;
  elements.situationList.innerHTML = situationGroups.map((group) => `<section id="situation-group-${escapeHtml(group.id)}" class="situation-group"><header><span>${escapeHtml(group.id.toUpperCase())}</span><h3>${escapeHtml(group.title)}</h3><p>${escapeHtml(group.lead)}</p></header><div>${situations.filter((item) => item.group === group.id).map((item) => {
    index += 1;
    return `<details id="case-${escapeHtml(item.id)}" class="situation-case"><summary><span class="situation-index">${String(index).padStart(2, '0')}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.preview)}</small></span><span class="expand-mark" aria-hidden="true">⌄</span></summary><div class="situation-case-body"><dl><div><dt>用户看到</dt><dd>${escapeHtml(item.visible)}</dd></div><div><dt>谁决定、怎么执行</dt><dd>${escapeHtml(item.decision)}</dd></div><div><dt>计算与接口成本</dt><dd>${escapeHtml(item.compute)}</dd></div><div><dt>下一次怎么用</dt><dd>${escapeHtml(item.next)}</dd></div></dl><div class="situation-state-links"><div><b>读取</b>${situationLayerLinks(item.reads, '读')}</div><div><b>写入</b>${situationLayerLinks(item.writes, '写')}</div></div><p class="situation-boundary"><strong>判断边界</strong>${escapeHtml(item.boundary)}</p><div class="experience-node-links">${item.nodes.map((id) => `<button type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div><div class="experience-source-list">${item.sources.map(sourceMarkup).join('')}</div></div></details>`;
  }).join('')}</div></section>`).join('');
}

function renderSituationMatrix() {
  elements.situationMatrix.innerHTML = `<p>写入与读取是两种不同关系。同一情形可能同时读写一层；格子只标示代码路径上的关系，展开情形看具体条件。</p><div class="situation-matrix-scroll"><table><thead><tr><th scope="col">情形</th>${stateLayers.map((layer) => `<th scope="col">${escapeHtml(layer.title)}</th>`).join('')}</tr></thead><tbody>${situations.map((item) => `<tr><th scope="row"><button type="button" data-case="${escapeHtml(item.id)}">${escapeHtml(item.title)} ↗</button></th>${stateLayers.map((layer) => { const reads = item.reads.includes(layer.id); const writes = item.writes.includes(layer.id); return `<td class="${writes ? 'has-write' : reads ? 'has-read' : ''}">${reads && writes ? '读写' : writes ? '写' : reads ? '读' : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderJourneyMatrix() {
  elements.journeyMatrix.innerHTML = `<p>每格标出该阶段的执行方式和主要持久状态；点击可回到主线展开用户体验、资源、协议与源码。<b>跳过 Run</b> 的路径仍可能有模型判断或飞书接口成本。</p><div class="journey-matrix-scroll"><table><thead><tr><th scope="col">输入路径</th>${journeyStages.map((stage, index) => `<th scope="col"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(stage.title)}</th>`).join('')}</tr></thead><tbody>${journeyRoutes.map((route) => `<tr><th scope="row">${escapeHtml(route.label)}</th>${journeyStages.map((stage, index) => { const step = route.stages[stage.id]; const [compute, state] = route.marks[index]; return `<td><button type="button" data-route="${escapeHtml(route.id)}" data-stage="${escapeHtml(stage.id)}" class="${step.skipped ? 'is-skipped' : ''}"><span class="matrix-cell-title">${escapeHtml(step.summary)}</span><span class="matrix-cell-mark">${escapeHtml(compute)} · ${escapeHtml(state)}</span></button></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderFeishuRules() {
  elements.feishuRules.innerHTML = `<div class="policy-heading"><div><div class="eyebrow">FEISHU POLICY SPLIT</div><h3>飞书的两套规则</h3><p>先看同一条群消息在两种规则下的用户体验、模型调用和存储位置。</p></div><span class="policy-snapshot">${escapeHtml(feishuRules.checkedAt)}</span></div>
    <div class="policy-grid">${feishuRules.modes.map((mode) => `<article class="policy-card"><div class="policy-card-head"><h4>${escapeHtml(mode.name)}</h4><span>${escapeHtml(mode.scope)}</span></div>
      <dl><div><dt>用户看到</dt><dd>${escapeHtml(mode.visible)}</dd></div><div><dt>谁决定</dt><dd>${escapeHtml(mode.decision)}</dd></div><div><dt>模型与接口</dt><dd>${escapeHtml(mode.model)}</dd></div><div><dt>写入哪里</dt><dd>${escapeHtml(mode.writes)}</dd></div></dl></article>`).join('')}</div>
    <details class="policy-deep-dive"><summary><span><strong>Jev 判断“不回复”后，消息在 Session 哪里？</strong><small>展开事件顺序、磁盘位置和代码入口</small></span><span class="expand-mark" aria-hidden="true">⌄</span></summary>
      <div class="policy-deep-body"><ol class="policy-timeline">${feishuRules.observation.map(([title, explanation]) => `<li><strong>${escapeHtml(title)}</strong><p>${escapeHtml(explanation)}</p></li>`).join('')}</ol>
        <div class="policy-event-pair"><code>chat-history/{sessionId}/events/… · user / message / feishu_observation</code><code>chat-history/{sessionId}/events/… · system / reaction_decision / silent</code><code>session-observations/… · 去重键 + 决策</code></div>
        <div class="policy-boundaries"><h4>需要继续核对的边界</h4><ul>${feishuRules.boundaries.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul></div>
        <div class="experience-source-list">${feishuRules.sources.map(sourceMarkup).join('')}</div>
      </div></details>`;
}

function renderExperiences() {
  const readingOrder = ['feishu-task', 'feishu-reaction', 'feishu-command', 'web-turn', 'daily-review', 'memory-skill'];
  const ordered = readingOrder.map((id) => experiences.find((item) => item.id === id)).filter(Boolean);
  elements.experienceList.innerHTML = ordered.map((item, index) => `<details class="experience-card">
    <summary><span class="experience-index">${String(index + 1).padStart(2, '0')}</span><span class="experience-intro"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.visible)}</small><span class="experience-chips">${item.tags.map((tag) => `<i>${escapeHtml(tag)}</i>`).join('')}</span></span><span class="expand-mark" aria-hidden="true">⌄</span></summary>
    <div class="experience-body"><div class="experience-facts"><div><b>模型调用</b><p>${escapeHtml(item.model)}</p></div><div><b>主要存储</b><p>${escapeHtml(item.storage)}</p></div></div>
      <h4>这条路径实际经过</h4><ol class="stage-list">${item.stages.map(([kind, description]) => `<li><span>${escapeHtml(kind)}</span><p>${escapeHtml(description)}</p></li>`).join('')}</ol>
      <div class="experience-extra"><div><h4>协议接口</h4><p>${escapeHtml(item.protocol)}</p></div><div><h4>怎样计量</h4><p>${escapeHtml(item.measurement)}</p></div></div>
      <div class="experience-caveat"><b>判断边界</b> ${escapeHtml(item.caveat)}</div>
      <div class="experience-references"><div class="experience-node-links">${item.nodes.map((id) => `<button type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div><div class="experience-source-list">${item.sources.map(sourceMarkup).join('')}</div></div>
    </div>
  </details>`).join('');

  const maxBytes = Math.max(...resourceSnapshot.stores.map((store) => store.bytes));
  const formatBytes = (bytes) => bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  elements.resourceSummary.innerHTML = `<div class="resource-ledger"><div class="ledger-stat"><strong>${resourceSnapshot.ledger.runs.toLocaleString('zh-CN')}</strong><span>7 日已记账 Run</span></div><div class="ledger-stat"><strong>${(resourceSnapshot.ledger.tokens / 1e8).toFixed(1)} 亿</strong><span>模型 tokens，含缓存</span></div><div class="ledger-stat"><strong>${Math.round(resourceSnapshot.ledger.cachedInputShare * 100)}%</strong><span>输入 tokens 为缓存读取</span></div><div class="ledger-stat"><strong>${Math.round(resourceSnapshot.ledger.backgroundShare * 100)}%</strong><span>tokens 属后台操作</span></div><p>${escapeHtml(resourceSnapshot.ledger.window)}。${escapeHtml(resourceSnapshot.ledger.note)} <button class="inline-link" type="button" data-node="usage-ledger">查看账本机制 ↗</button></p></div>
    <div class="storage-card"><div class="storage-top"><h4>持久化目录占用</h4><span>${escapeHtml(resourceSnapshot.measuredAt)}</span></div><p class="storage-method">${escapeHtml(resourceSnapshot.method)}</p>
    <div class="storage-list">${resourceSnapshot.stores.map((store) => `<button class="storage-row" type="button" data-node="${escapeHtml(store.node)}"><span class="storage-name"><strong>${escapeHtml(store.label)}</strong><small>${escapeHtml(store.key)} · ${escapeHtml(store.volume)}</small></span><span class="storage-track"><i style="width:${Math.max(2, Math.round(store.bytes / maxBytes * 100))}%"></i></span><span class="storage-value">${formatBytes(store.bytes)}</span></button>`).join('')}</div>
    <p class="storage-foot">工作区、Harness 自有目录、外部飞书文件和云端账单不在此表内。历史与 Run 目录目前实际位于数据盘；其余列项在系统盘。</p></div>`;
  elements.missingDimensions.innerHTML = missingDimensions.map(([title, explanation]) => `<div class="dimension-card"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(explanation)}</p></div>`).join('');
}

function sourceMarkup(source) {
  const reference = `${source.path}${source.line ? `:${source.line}` : ''}`;
  const url = source.instance ? null : `https://github.com/Ninglo/remotelab/blob/${sourceCommit}/${source.path}${source.line ? `#L${source.line}` : ''}`;
  return `<div class="source-item"><code>${escapeHtml(reference)}</code><span>${escapeHtml(source.note)}${source.instance ? ' · 本实例，未公开源码链接' : ''}</span><div class="source-actions"><button type="button" data-copy="${escapeHtml(reference)}">复制路径</button>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看源码 ↗</a>` : ''}</div></div>`;
}

function renderDetail() {
  const node = byId.get(state.node);
  if (!node) {
    elements.detail.innerHTML = '<div class="detail-empty"><div class="empty-glyph">◎</div><h2>选择一个机制</h2><p>点击系统全景中的节点，查看责任、状态、相邻机制和源码入口。</p></div>';
    elements.detail.classList.remove('is-open');
    return;
  }
  const domain = domains.find((item) => item.id === node.domain);
  elements.detail.innerHTML = `<div class="detail-top"><span class="detail-id">${escapeHtml(domain?.number ?? '')} / ${escapeHtml(domain?.title ?? '')}</span><button class="detail-close" type="button" data-close-detail aria-label="关闭详情">×</button></div>
    <h2 class="detail-title">${escapeHtml(node.title)}</h2><p class="detail-summary">${escapeHtml(node.summary)}</p>
    <div class="badges">${node.status.map(badge).join('')}</div>
    <div class="detail-section"><h3>责任方</h3><p>${escapeHtml(node.owner)}</p></div>
    <div class="detail-section"><h3>机制与边界</h3><p>${escapeHtml(node.contract)}</p></div>
    <div class="detail-section"><h3>读取</h3><p>${escapeHtml(node.reads)}</p></div>
    <div class="detail-section"><h3>产生或修改</h3><p>${escapeHtml(node.writes)}</p></div>
    <div class="detail-section"><h3>相邻机制</h3><div class="detail-links">${node.related.map((id) => `<button class="related-button" type="button" data-node="${escapeHtml(id)}">${escapeHtml(label(id))} ↗</button>`).join('')}</div></div>
    <div class="detail-section"><h3>代码与资料入口</h3>${node.sources.map(sourceMarkup).join('')}</div>
    <div class="detail-section"><h3>下一步核验</h3><p>${escapeHtml(node.open)}</p></div>`;
  elements.detail.classList.add('is-open');
  elements.detail.scrollTop = 0;
}

function renderViews() {
  document.body.dataset.currentView = state.view;
  document.querySelectorAll('.view').forEach((element) => element.classList.toggle('is-active', element.id === `${state.view}-view`));
  document.querySelectorAll('[data-view]').forEach((element) => element.classList.toggle('is-active', element.dataset.view === state.view));
}

function navigate(view, options = {}) {
  state.view = view;
  if (options.domain !== undefined) state.domain = options.domain;
  if (options.path !== undefined) state.path = options.path;
  if (options.node !== undefined) state.node = options.node;
  if (options.route !== undefined) state.route = options.route;
  renderViews();
  if (renderedRoute !== state.route) renderJourney();
  renderMap();
  renderPaths();
  renderDetail();
  if (options.scroll) elements.main.scrollTop = 0;
  const hash = state.node ? `#node/${encodeURIComponent(state.node)}` : view === 'paths' ? `#paths/${encodeURIComponent(state.path)}` : view === 'experience' ? `#route/${encodeURIComponent(state.route)}` : `#${view}`;
  if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  const [kind, value] = decodeURIComponent(window.location.hash.slice(1)).split('/');
  if (kind === 'node' && byId.has(value)) navigate('map', { node: value });
  else if (kind === 'route') navigate('experience', { node: null, route: journeyRoutes.some((route) => route.id === value) ? value : journeyRoutes[0].id });
  else if (kind === 'paths') navigate('paths', { node: null, path: paths.some((path) => path.id === value) ? value : paths[0].id });
  else if (kind && document.getElementById(kind)) {
    const fragment = window.location.hash;
    const anchor = document.getElementById(kind);
    const view = anchor.closest('.view')?.id.replace(/-view$/, '') || 'experience';
    navigate(view, { node: null });
    // A section link is a reading position, not a request to replace the route.
    history.replaceState(null, '', fragment);
    anchor.scrollIntoView({ block: 'start' });
  }
  else if (kind === 'evidence') navigate('evidence', { node: null });
  else if (kind === 'map') navigate('map', { node: null });
  else navigate('experience', { node: null });
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.route) {
    navigate('experience', { route: button.dataset.route, node: null });
    if (button.dataset.stage) document.getElementById(`journey-stage-${button.dataset.stage}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else document.getElementById('journey-route-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (button.dataset.case) {
    if (state.view !== 'experience') navigate('experience', { node: null });
    const item = document.getElementById(`case-${button.dataset.case}`);
    if (item) { item.open = true; item.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  else if (button.dataset.caseGroup) {
    if (state.view !== 'experience') navigate('experience', { node: null });
    document.getElementById(`situation-group-${button.dataset.caseGroup}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (button.dataset.layer) {
    if (state.view !== 'experience') navigate('experience', { node: null });
    const layer = document.getElementById(`state-layer-${button.dataset.layer}`);
    if (layer) { layer.open = true; layer.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  else if (button.dataset.stage) document.getElementById(`journey-stage-${button.dataset.stage}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (button.dataset.view) navigate(button.dataset.view, { node: null, scroll: true });
  else if (button.dataset.scroll) document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (button.dataset.domain) navigate('map', { domain: button.dataset.domain === 'all' ? null : button.dataset.domain, node: null, scroll: true });
  else if (button.dataset.path) navigate('paths', { path: button.dataset.path, node: null, scroll: true });
  else if (button.dataset.node) navigate(state.view, { node: button.dataset.node });
  else if (button.hasAttribute('data-close-detail')) navigate(state.view, { node: null });
  else if (button.dataset.copy) {
    try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = '已复制'; }
    catch { button.textContent = '复制失败'; }
  }
});

elements.mapSearch.addEventListener('input', (event) => { state.query = event.target.value; renderMap(); });
elements.resetMap.addEventListener('click', () => {
  state.query = ''; state.domain = null; elements.mapSearch.value = '';
  navigate('map', { node: null, scroll: true });
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.node) navigate(state.view, { node: null }); });
window.addEventListener('hashchange', readHash);

renderFindings();
renderFeishuRules();
renderExperiences();
renderJourneyMatrix();
renderLoopPreview();
renderSituationOverview();
renderStateLayers();
renderSituations();
renderSituationMatrix();
readHash();

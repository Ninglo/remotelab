import { sourceCommit, statusNames, domains, nodes, paths, findings } from './atlas-data.js';

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
};

const state = { view: 'map', domain: null, query: '', node: null, path: paths[0].id };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const label = (id) => byId.get(id)?.title ?? id;
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
  document.querySelectorAll('.view').forEach((element) => element.classList.toggle('is-active', element.id === `${state.view}-view`));
  document.querySelectorAll('[data-view]').forEach((element) => element.classList.toggle('is-active', element.dataset.view === state.view));
}

function navigate(view, options = {}) {
  state.view = view;
  if (options.domain !== undefined) state.domain = options.domain;
  if (options.path !== undefined) state.path = options.path;
  if (options.node !== undefined) state.node = options.node;
  renderViews();
  renderMap();
  renderPaths();
  renderDetail();
  if (options.scroll) elements.main.scrollTop = 0;
  const hash = state.node ? `#node/${encodeURIComponent(state.node)}` : view === 'paths' ? `#paths/${encodeURIComponent(state.path)}` : `#${view}`;
  if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  const [kind, value] = decodeURIComponent(window.location.hash.slice(1)).split('/');
  if (kind === 'node' && byId.has(value)) navigate('map', { node: value });
  else if (kind === 'paths') navigate('paths', { node: null, path: paths.some((path) => path.id === value) ? value : paths[0].id });
  else if (kind === 'evidence') navigate('evidence', { node: null });
  else navigate('map', { node: null });
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) navigate(button.dataset.view, { node: null, scroll: true });
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
readHash();

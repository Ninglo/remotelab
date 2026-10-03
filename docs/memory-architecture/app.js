import { guide, calculateTokenScenario } from './guide-data.js?v=2.7';

const el = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const repo = 'https://github.com/Ninglo/remotelab/blob/';
const referenceUrl = ref => repo + (ref.revision || (/^(chat|lib|connectors|scripts)\//.test(ref.path) ? guide.mainBaseline : 'main')) + '/' + ref.path;
const refs = Object.fromEntries(guide.references.map(r => [r.id, r]));
const badge = (text, proposed = false) => '<span class="badge' + (proposed ? ' proposed' : '') + '">' + escape(text) + '</span>';
const paths = values => values?.length ? '<div class="path-list">' + values.map(p => '<code>' + escape(p) + '</code>').join('') + '</div>' : '';

el('goal').textContent = guide.goal;
el('version').textContent = 'v' + guide.version + ' · 核对于 ' + guide.verifiedAt;
el('findings').innerHTML = guide.findings.map(([title, text]) => '<div><h3>' + escape(title) + '</h3><p>' + escape(text) + '</p></div>').join('');

function renderControls(id, options, selected, onChange) {
  const root = el(id);
  root.replaceChildren();
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.dataset.value = value;
    button.setAttribute('aria-pressed', String(value === selected));
    button.addEventListener('click', () => {
      root.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      onChange(value);
    });
    root.append(button);
  }
}

function edgeGeometry(from, to) {
  const w = 208, h = 92;
  if (from.x === to.x) {
    const down = to.y > from.y;
    const x = from.x + w / 2;
    const start = from.y + (down ? h : 0), end = to.y + (down ? 0 : h);
    return { path: 'M' + x + ' ' + start + ' L' + x + ' ' + end, x:x+10, y:(start+end)/2 };
  }
  if (to.x < from.x) {
    const sx = from.x + w / 2, tx = to.x + w / 2;
    return {path:'M' + sx + ' ' + (from.y+h) + ' V488 H' + tx + ' V' + (to.y+h),x:(sx+tx)/2,y:486};
  }
  const sx = from.x + w, sy = from.y + h/2, tx = to.x, ty = to.y + h/2;
  const middle = (sx + tx) / 2;
  return {path:'M' + sx + ' ' + sy + ' C' + middle + ' ' + sy + ', ' + middle + ' ' + ty + ', ' + tx + ' ' + ty,x:middle,y:(sy+ty)/2-9};
}

function drawGraph(rootId, detailId, graph, options = {}) {
  const root = el(rootId), proposed = options.proposed === true;
  const active = new Set(options.active || graph.nodes.map(n => n.id));
  const index = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  const marker = rootId + '-arrow';
  let svg = '<svg class="graph-svg" viewBox="0 0 1000 ' + graph.height + '" aria-hidden="true"><defs><marker id="' + marker + '" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#9b9ba2" stroke-width="1.2"/></marker></defs>';
  for (const [a, b, label] of graph.edges) {
    const g = graph.routes?.[a+':'+b] || edgeGeometry(index[a], index[b]), muted = !active.has(a) || !active.has(b);
    svg += '<path class="graph-line' + (label ? ' conditional' : '') + (muted ? ' inactive' : '') + '" d="' + g.path + '" marker-end="url(#' + marker + ')"/>';
    if (label && !muted) svg += '<text class="graph-line-label" x="' + g.x + '" y="' + g.y + '" text-anchor="middle">' + escape(label) + '</text>';
  }
  root.innerHTML = svg + '</svg>';
  for (const node of graph.nodes) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'graph-node' + (active.has(node.id) ? '' : ' inactive') + (proposed ? ' proposed' : '');
    button.style.left = node.x/10 + '%'; button.style.top = node.y/graph.height*100 + '%';
    button.dataset.node = node.id; button.setAttribute('aria-pressed','false');
    button.setAttribute('aria-controls',detailId);
    button.innerHTML = '<span class="node-tag">' + escape(active.has(node.id) ? node.tag : '此场景未自动提供') + '</span><strong>' + escape(node.title) + '</strong><span class="subtitle">' + escape(node.subtitle) + '</span>';
    button.addEventListener('click', () => selectNode(node));
    root.append(button);
  }
  const relations=document.createElement('details');relations.className='graph-relations';
  relations.innerHTML='<summary>查看图中连接关系</summary><ul>'+graph.edges.filter(([a,b])=>active.has(a)&&active.has(b)).map(([a,b,label])=>'<li>'+escape(index[a].title)+' <span aria-label="指向">→</span> '+escape(index[b].title)+(label?' <small>（'+escape(label)+'）</small>':'')+'</li>').join('')+'</ul>';
  root.append(relations);
  function selectNode(node) {
    root.querySelectorAll('.graph-node').forEach(b => {
      const selected = b.dataset.node === node.id;
      b.classList.toggle('selected', selected); b.setAttribute('aria-pressed',String(selected));
    });
    const links = (node.refs || []).map(id => refs[id]).filter(Boolean).map(r => '<a href="' + referenceUrl(r) + '" target="_blank" rel="noopener">' + escape(r.title) + ' ↗</a>').join('');
    el(detailId).innerHTML = '<div><h3>' + escape(node.title) + '</h3><div class="detail-state">' + escape(!active.has(node.id) ? '此场景未自动提供；点击仍可了解机制。' : proposed ? '治理架构；实际启用边界见当前状态。' : node.tag) + '</div></div><div><p>' + escape(node.text) + '</p>' + paths(node.paths) + (links ? '<div class="source-links">依据：' + links + '</div>' : '') + '</div>';
  }
  selectNode(index[options.defaultNode] || graph.nodes[0]);
}

drawGraph('architecture-graph','architecture-detail',guide.architectureGraph,{proposed:true,defaultNode:'memory'});
function definition(id, rows) { el(id).innerHTML = rows.map(([title,text])=>'<div><h4>'+escape(title)+'</h4><p>'+escape(text)+'</p></div>').join(''); }
for (const [id, rows] of [
  ['principles',guide.principles],['scope-rules',guide.scopeRules],['registry-fields',guide.registryFields],['pointer-rules',guide.pointerRules],
  ['write-rules',guide.writeRules],['migration',guide.migration],['acceptance-cases',guide.acceptanceCases],['prerequisites',guide.prerequisites]
]) definition(id,rows);

function renderStorage(key) {
  const item=guide.storageCases.find(item=>item.id===key);
  el('storage-question').textContent=item.question;
  el('storage-detail').innerHTML=['current','target'].map(mode=>{
    const s=item[mode];
    return '<article data-storage-mode="'+mode+'"><h4>'+ (mode==='current'?'目前实际存储':'本次治理方案') +'</h4>'+badge(mode==='current'?'现状已核对':'拟议位置与规则',mode==='target')+paths(s.paths)+'<p>'+escape(s.body)+'</p><dl class="compact-dl"><dt>何时读</dt><dd>'+escape(s.read)+'</dd><dt>怎样写</dt><dd>'+escape(s.write)+'</dd></dl></article>';
  }).join('');
}
renderControls('storage-controls',guide.storageCases.map(c=>[c.id,c.label]),'session',renderStorage);
renderStorage('session');

function renderRoute(key) {
  const c=guide.routeExamples.find(c=>c.id===key);
  el('route-detail').innerHTML='<p class="example-text">'+escape(c.input)+'</p><dl class="walkthrough-dl">'+[['归属',c.route],['依据',c.basis],['写入',c.store],['开工读取',c.read]].map(([t,v])=>'<dt>'+escape(t)+'</dt><dd>'+escape(v)+'</dd>').join('')+'</dl>';
}
renderControls('route-controls',guide.routeExamples.map(c=>[c.id,c.label]),'group-topic',renderRoute);renderRoute('group-topic');

function renderReading(key) {
  const c=guide.readingCases.find(c=>c.id===key);
  el('reading-detail').innerHTML='<ol class="read-steps">'+c.steps.map(([title,body])=>'<li><h4>'+escape(title)+'</h4><p>'+escape(body)+'</p></li>').join('')+'</ol><p class="reading-skip"><strong>通常无需读：</strong>'+escape(c.skip)+'</p>';
}
renderControls('reading-controls',guide.readingCases.map(c=>[c.id,c.label]),'new-group',renderReading);renderReading('new-group');

function renderClassification(key) {
  const c=guide.classificationCases.find(c=>c.id===key);
  el('classification-detail').innerHTML='<div class="classification-example"><div class="eyebrow">'+escape(c.type)+'</div><blockquote>'+escape(c.example)+'</blockquote></div><div><h3>存到：'+escape(c.target)+'</h3>'+paths(c.paths)+'<p>'+escape(c.rule)+'</p><p class="caption">'+escape(c.other)+'</p></div>';
}
renderControls('classification-controls',guide.classificationCases.map(c=>[c.id,c.label]),'project-state',renderClassification);renderClassification('project-state');
el('feedback-story').innerHTML=guide.feedbackStory.map(([title,body])=>'<li><h4>'+escape(title)+'</h4><p>'+escape(body)+'</p></li>').join('');

function selectScenario(key) {
  const scenario = guide.scenarios[key];
  el('scenario-summary').textContent = scenario.summary;
  drawGraph('start-graph','start-detail',guide.startGraph,scenario);
}
renderControls('scenario-controls',Object.entries(guide.scenarios).map(([k,v])=>[k,v.label]),'fresh',selectScenario);
selectScenario('fresh');
function selectCollect(key) {
  const graph = guide.collectGraphs[key];
  el('collect-summary').textContent = graph.intro;
  drawGraph('collect-graph','collect-detail',graph,{proposed:key==='target'});
}
renderControls('collect-controls',Object.entries(guide.collectGraphs).map(([k,v])=>[k,v.label]),'target',selectCollect);
selectCollect('target');

let layerGroup = 'all';
function renderLayers() {
  const query = el('layer-search').value.trim().toLowerCase();
  const selected = guide.layers.filter(l => (layerGroup === 'all' || l.group === layerGroup) && JSON.stringify(l).toLowerCase().includes(query));
  el('layer-list').innerHTML = selected.length ? selected.map(l => '<article class="layer-row" data-layer="' + l.id + '"><div><h3>' + escape(l.title) + '</h3><p>作用范围：' + escape(l.scope) + '</p>' + badge(l.status,l.status.includes('拟建设')) + '</div><div class="paths">' + l.paths.map(p=>'<code>'+escape(p)+'</code>').join('') + '</div><div><p><strong>何时读：</strong>' + escape(l.read) + '</p><p><strong>怎样写：</strong>' + escape(l.write) + '</p></div><details><summary>治理要点</summary><p>' + escape(l.rule) + '</p></details></article>').join('') : '<p class="empty">没有匹配的记忆入口。请换一个关键词或筛选范围。</p>';
}
renderControls('layer-controls',[['all','全部'],['session','会话'],['knowledge','长期知识'],['project','项目与人'],['methods','经验方法']],'all',key => {layerGroup=key;renderLayers();});
el('layer-search').addEventListener('input',renderLayers); renderLayers();
definition('record-fields',guide.recordFields); definition('gap-list',guide.gaps); definition('metrics',guide.metrics);
el('roles').innerHTML = guide.roles.map(([role,text])=>'<dt>'+escape(role)+'</dt><dd>'+escape(text)+'</dd>').join('');
el('isolation').textContent = guide.isolation;
el('phases').innerHTML = guide.phases.map(p=>'<li><h4>'+escape(p.label)+'</h4><p>'+escape(p.enabled)+'</p><p>'+escape(p.disabled)+'</p><p><strong>验收：</strong>'+escape(p.accept)+'</p></li>').join('');

let view = 'organization';
function renderView() {
  const filter = el('view-selector').value;
  const records = guide.demoRecords.filter(r => view === 'organization' || (view === 'project' ? r.project === filter : r.people.includes(filter)));
  el('view-summary').textContent = (view==='organization' ? '组织全局' : filter) + ' · ' + records.length + ' 条认识 · ' + records.filter(r=>r.verification.includes('待')).length + ' 条仍待验证或验收。进度以明确里程碑和验收状态呈现，本例不生成任意百分比。';
  el('view-records').innerHTML = records.map(r=>'<article class="record" data-record="'+escape(r.id)+'"><div class="record-id">'+escape(r.id)+'<p>'+escape(r.project)+'</p></div><div><strong>'+escape(r.title)+'</strong><p>'+escape(r.people.join(' · '))+' · '+escape(r.kind)+'</p><p>来源：'+escape(r.source)+'</p></div><div class="record-status">'+escape(r.execution)+'<p>证据：'+escape(r.verification)+'</p></div></article>').join('');
}
function selectView(key) {
  view = key; el('view-selector-label').hidden = key === 'organization';
  el('view-selector-name').textContent = key==='project'?'项目':'个人';
  const options = [...new Set(guide.demoRecords.flatMap(r=>key==='project'?[r.project]:r.people))];
  el('view-selector').replaceChildren(...options.map(value=>{const o=document.createElement('option');o.value=value;o.textContent=value;return o;}));
  renderView();
}
renderControls('view-controls',[['organization','组织视图'],['project','项目视图'],['person','个人视图']],'organization',selectView);
el('view-selector').addEventListener('change',renderView); selectView('organization');
function renderConfirmation() {
  const changed = el('confirmation-version').value==='2';
  el('confirmation-result').innerHTML = '<p>' + (changed?'交付范围由首版脚本扩展为完整转换流程。':'相关个人承诺交付首版脚本。') + '</p><div class="confirmation-status">' + (changed?'v1 的范围与责任确认仍是历史证据。v2 需要项目负责人和相关个人核对新范围；验收仍待真实结果。':'项目负责人：已确认 v1 范围。<br>相关个人：已确认 v1 承诺。<br>验收人：待结果证据。') + '</div>';
}
el('confirmation-version').addEventListener('change',renderConfirmation);renderConfirmation();

el('load-instance').addEventListener('click',async()=>{
  const button=el('load-instance');button.disabled=true;el('login-link').hidden=true;el('instance-result').textContent='正在核对当前实例…';
  try {
    const response=await fetch('/api/people',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.status===401||response.status===403||response.redirected){el('instance-result').textContent='需先登录当前 RemoteLab 实例，才能读取人员登记。';el('login-link').hidden=false;return;}
    if(!response.ok)throw new Error('HTTP '+response.status);
    const data=await response.json();
    if(!Array.isArray(data.people))throw new Error('当前接口未返回人员登记。');
    el('instance-result').textContent='当前登记 '+data.people.length+' 个 Person。\n核对时间：'+new Date().toLocaleString('zh-CN')+'\n逐人协作偏好完整性：本页未核验。';
  }catch(error){el('instance-result').textContent='未能读取当前实例：'+(error.name==='TimeoutError'?'读取超时，可重试。':error.name==='SyntaxError'?'返回内容不是人员数据，请先登录。':error.message);}
  finally{button.disabled=false;}
});

el('audit-boundary').textContent = '说明 v'+guide.version+'，核对于 '+guide.verifiedAt+'。当前运行源码 '+guide.auditedCommit+'，本次文档主线基线 '+guide.mainBaseline+'；核对的 10 个核心路径、读取与写回文件一致，代码链接定位到主线基线。'+guide.boundary+'本次没有逐条复审全部历史业务事实。各项启用与验收范围依原阅读页中的分项证据。';
el('reference-list').innerHTML = guide.references.map(r=>'<div><a href="'+referenceUrl(r)+'" target="_blank" rel="noopener">'+escape(r.title)+' ↗</a><p>'+escape(r.use)+'</p><code>'+escape(r.path)+'</code></div>').join('');
el('external-list').innerHTML = guide.external.map(r=>'<div><a href="'+escape(r.url)+'" target="_blank" rel="noopener">'+escape(r.title)+' ↗</a><p>'+escape(r.use)+'</p></div>').join('');
el('maintenance').innerHTML = guide.maintenance.map(t=>'<li>'+escape(t)+'</li>').join('');

el('comparison-conclusion').textContent = guide.comparison.conclusion;
el('comparison-evidence').textContent = guide.comparison.evidence;
el('comparison-table').innerHTML = '<thead><tr><th scope="col">比较什么</th><th scope="col">现有机制</th><th scope="col">拟实施方案</th></tr></thead><tbody>' + guide.comparison.rows.map(([name,current,proposed])=>'<tr><th scope="row">'+escape(name)+'</th><td>'+escape(current)+'</td><td>'+escape(proposed)+'</td></tr>').join('') + '</tbody>';
function renderProduct(key) {
  const p=guide.comparison.products.find(item=>item.id===key);
  el('product-detail').innerHTML='<h3>'+escape(p.label)+'</h3><p>'+escape(p.position)+'</p><dl class="product-dl">'+p.rows.map(([title,text])=>'<dt>'+escape(title)+'</dt><dd>'+escape(text)+'</dd>').join('')+'</dl><div class="source-links">'+p.sources.map(([title,url])=>'<a href="'+escape(url)+'" target="_blank" rel="noopener">'+escape(title)+' ↗</a>').join('')+'</div>';
}
renderControls('product-controls',guide.comparison.products.map(p=>[p.id,p.label]),'claude-tag',renderProduct);
renderProduct('claude-tag');
for(const [id,rows] of [['comparison-lessons',guide.comparison.lessons],['cost-rules',guide.costRules],['evaluation',guide.evaluation],['measurement-fields',guide.measurementFields],['release-gates',guide.releaseGates],['failure-rules',guide.failureRules]])definition(id,rows);
drawGraph('cost-graph','cost-detail',guide.costGraph,{proposed:true,defaultNode:'work'});
el('token-boundary').textContent=guide.tokenExample.boundary;
el('token-formula').textContent=guide.tokenExample.formula;
el('token-fields').innerHTML=guide.tokenExample.fields.map(f=>'<label for="token-'+f.id+'">'+escape(f.label)+'<input id="token-'+f.id+'" name="'+f.id+'" type="number" min="0" max="'+f.max+'" step="1" required value="'+f.value+'"></label>').join('');
const formatToken = n => n.toLocaleString('zh-CN');
function renderTokenEstimate() {
  const inputs=[...el('token-fields').querySelectorAll('input')];
  if(!inputs.every(input=>input.checkValidity())){
    el('token-result').textContent='请填写范围内的非负整数；空白或无效输入无法计算。'; return;
  }
  const result=calculateTokenScenario(Object.fromEntries(inputs.map(input=>[input.name,Number(input.value)])));
  const direction=result.delta>0?'增加':result.delta<0?'减少':'相同';
  const ratio=result.change===null?'（当前为 0，比例不适用）':result.delta===0?'':'（'+(Math.abs(result.change)*100).toFixed(1)+'%）';
  el('token-result').innerHTML='<div><span>当前总量／日</span><strong>'+formatToken(result.current)+'</strong></div><div><span>治理后总量／日</span><strong>'+formatToken(result.proposed)+'</strong></div><div><span>净新增后台／日</span><strong>'+formatToken(result.extraBackground)+'</strong></div><p class="token-verdict">按上述假设，总 token '+direction+(result.delta===0?'':' '+formatToken(Math.abs(result.delta)))+' '+ratio+'。'+(result.cheaperFrom===null?'每次前台量没有减少，增加复用次数也不会让本式总量更低。':'维持其余假设不变，每天至少 '+formatToken(result.cheaperFrom)+' 次前台使用，总量才比当前低。')+'</p>';
}
el('token-fields').addEventListener('input',renderTokenEstimate);
renderControls('token-presets',guide.tokenExample.presets.map(p=>[p.id,p.label]),'',key=>{
  const preset=guide.tokenExample.presets.find(p=>p.id===key);
  for(const [id,value] of Object.entries(preset.values))el('token-'+id).value=String(value);
  renderTokenEstimate();
});
renderTokenEstimate();
for(const [id,rows] of [['preparation-risks',guide.preoperation.risks],['preparation-controls',guide.preoperation.controls],['preparation-next',guide.preoperation.next]])definition(id,rows);
for(const key of ['finding','current','tool','boundary'])el('preparation-'+key).textContent=guide.preoperation[key];

// Rendering expands the page after the browser's initial fragment positioning.
// Resolve the existing anchor once the guide is populated so shared links land on it.
if(location.hash){
  let anchor;
  try{anchor=document.getElementById(decodeURIComponent(location.hash.slice(1)));}catch{}
  if(anchor)anchor.scrollIntoView({behavior:'instant',block:'start'});
}

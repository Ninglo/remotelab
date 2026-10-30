const $ = id => document.getElementById(id);
const kinds = { static: '静态网站', preview: '动态网站', asset: '下载与资源', external: '外部网站', missing: '入口已移除' };
const accessNames = { public: '公开访问', employee: '飞书员工登录', basic: '原站账号密码', external: '沿用原站权限', unknown: '待确认' };
const states = { unreviewed: '待整理', active: '在用', planned: '筹备中', archived: '已归档' };
let data, selected, page = 1; const pageSize = 20;
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function link(url, text) { const node = element('a', text, 'title'); try { const u = new URL(url); if (['https:', 'http:'].includes(u.protocol)) { node.href = u.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } } catch {} return node; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (response.status === 401) { location.assign('/site-login?returnTo=%2Fsites'); throw Error('请重新登录'); }
  const value = await response.json(); if (!response.ok) throw Error(value.error || '请求未完成'); return value;
}
async function load() {
  $('refresh').disabled = true;
  try {
    data = await api('/api/sites');
    $('total').textContent = data.totals.all; $('managed').textContent = data.totals.static + data.totals.preview;
    $('external').textContent = data.totals.external; $('pending').textContent = data.totals.needsReview;
    $('viewer').textContent = data.viewer.name; $('scope').textContent = data.scope;
    const value = $('project').value;
    $('project').replaceChildren(new Option('全部项目', ''), new Option('待归类', '__unassigned'));
    for (const project of [...new Set(data.entries.map(e => e.project).filter(Boolean))].sort()) $('project').add(new Option(project, project));
    $('project').value = value; if ($('project').selectedIndex < 0) $('project').value = '';
    render();
  } catch (error) { $('message').textContent = error.message; } finally { $('refresh').disabled = false; }
}
function render() {
  if (!data) return;
  const search = $('search').value.toLowerCase().trim(), project = $('project').value, kind = $('kind').value;
  const entries = data.entries.filter(e => (!search || [e.title,e.project,e.contact,e.ownerName,e.description,e.url,e.slug].join(' ').toLowerCase().includes(search))
    && (!project || (project === '__unassigned' ? !e.project : e.project === project)) && (!kind || e.kind === kind)
    && (!$('incomplete').checked || e.gaps.length || e.status === 'unreviewed'));
  const pages = Math.max(1, Math.ceil(entries.length / pageSize)); page = Math.min(page, pages);
  $('rows').replaceChildren();
  for (const entry of entries.slice((page-1)*pageSize, page*pageSize)) {
    const tr = element('tr'), title = element('td');
    title.append(link(entry.url, entry.title));
    title.append(element('span', entry.description || entry.url || (entry.missing ? '登记仍保留，原托管入口已移除' : '发布目录存在，入口文件待确认'), 'sub')); tr.append(title);
    const owner = element('td', entry.project || '待归类'); owner.append(element('span', entry.ownerName ? `创建人：${entry.ownerName}` : '创建人：待确认', 'sub'));
    if(entry.contact)owner.append(element('span', `维护：${entry.contact}`, 'sub')); tr.append(owner);
    const type = element('td', kinds[entry.kind]); type.append(element('span',accessNames[entry.access] || '待确认','sub')); tr.append(type);
    const status = element('td');status.append(element('span',states[entry.status] || '待整理','tag'));
    if(entry.gaps.length)status.append(element('span','缺：'+entry.gaps.join('、'),'gap'));tr.append(status);
    const controls=element('td'),button=element('button','登记','edit');button.addEventListener('click',()=>edit(entry));controls.append(button);tr.append(controls);$('rows').append(tr);
  }
  $('message').textContent = data.errors.length ? data.errors.join('；') : entries.length ? '' : '没有匹配记录，可调整筛选或登记外部网站。';
  $('count').textContent = `显示 ${entries.length ? (page-1)*pageSize+1 : 0}–${Math.min(page*pageSize,entries.length)} / ${entries.length} 项`;
  $('page').textContent = `${page} / ${pages}`; $('previous').disabled=page===1;$('next').disabled=page===pages;
}
function fact(label,value){if(!value)return;const dt=element('dt',label),dd=element('dd',String(value));$('facts').append(dt,dd);}
function edit(entry) {
  selected=entry || null;const form=$('form');form.reset();$('save-message').textContent='';
  $('dialog-title').textContent = entry ? '补充网站登记' : '登记外部网站';$('record-kind').textContent=entry?kinds[entry.kind]:'其他实例或外部部署';
  for(const name of ['title','url','project','contact','description','sourceLocation','repository','notes','status'])form.elements[name].value=entry?.[name] || (name==='status'?'unreviewed':'');
  form.elements.url.readOnly=!!entry && entry.kind!=='external'; form.elements.url.required=!form.elements.url.readOnly;
  $('owner-note').textContent=entry?.ownerName?`原发布创建人：${entry.ownerName}。补充维护联系人不会更改创建人。`:entry?'旧发布缺少创建人记录，可先补充维护联系人。':'登记创建人会记录为当前登录员工。';
  $('facts').replaceChildren();$('deployment').hidden=!entry;
  if(entry){fact('登记标识',entry.id);fact('访问方式',accessNames[entry.access]);fact('发布目录',entry.deployment?.directory);fact('服务端口',entry.deployment?.loopbackPort);fact('源码位置',entry.origin?.sourcePath);fact('运行工作目录',entry.origin?.runtimeDirectory);fact('发布工作目录',entry.origin?.workingDirectory);fact('原发布链接',entry.originalUrl);fact('发布时间',entry.publishedAt);fact('最近登记',entry.updatedAt);fact('登记人',entry.updatedBy);fact('文件 / 字节',entry.files===undefined?'':`${entry.files ?? '未知'} / ${entry.bytes ?? '未知'}`);}
  $('editor').showModal();
}
$('form').addEventListener('submit',async event=>{
  event.preventDefault();$('save').disabled=true;$('save-message').textContent='';
  try{const values=Object.fromEntries(new FormData($('form')));if(selected && selected.kind!=='external')delete values.url;
    await api('/api/sites/entries',{method:selected?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:selected?.id,revision:selected?.revision || 0,values})});
    $('editor').close();await load();
  }catch(error){$('save-message').textContent=error.message;}finally{$('save').disabled=false;}
});
for(const id of ['close','cancel'])$(id).addEventListener('click',()=>$('editor').close());
$('register').addEventListener('click',()=>edit());$('refresh').addEventListener('click',load);
for(const id of ['search','project','kind','incomplete'])$(id).addEventListener(id==='search'?'input':'change',()=>{page=1;render();});
$('previous').addEventListener('click',()=>{page--;render();});$('next').addEventListener('click',()=>{page++;render();});load();

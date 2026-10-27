import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import { constants } from 'node:fs';
import { readFile, open, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { evidenceConfig, fileId, fileEvidence } from './monitoring-file-evidence.mjs';
import { loadHistory } from './history.mjs';
import { requests } from './requests.mjs';
import { readPersonalProfile } from './memory-learning.mjs';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=(label,q)=>`<a href="/api/monitoring-evidence?${esc(new URLSearchParams(q))}">${esc(label)}</a>`;
const date=x=>new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const kind=x=>({content:'内容修改',added:'新增观测',removed:'删除',permissions:'权限变化',target:'路径变化',update:'修改',add:'新增',delete:'删除'})[x]||x;
function page(title,body,returnUrl='/?tab=settings'){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · 监管文件</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;color:#171918;font:15px/1.7 "Segoe UI","PingFang SC",sans-serif;background:#f6f7f5;background-image:linear-gradient(#dfe3dd 1px,transparent 1px),linear-gradient(90deg,#dfe3dd 1px,transparent 1px);background-size:24px 24px}header,main{max-width:1200px;margin:auto;border:1px solid #171918}header{background:#171918;color:white;padding:16px 26px}header a{color:white}main{background:white;padding:26px;min-height:80vh}h1{font-size:26px}h2{font-size:19px;border-left:4px solid #1878dd;padding-left:12px;margin-top:28px}a{color:#126bc1}p,td,pre{overflow-wrap:anywhere}.muted{color:#626763}pre{white-space:pre-wrap;background:#f6f7f5;padding:16px;border:1px solid #d9ddd9;font:13px/1.7 monospace}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #d9ddd9}th{background:#f1f4eb}summary{cursor:pointer}nav{display:flex;gap:20px;flex-wrap:wrap}@media(max-width:540px){body{padding:8px}main{padding:16px}header{padding:14px}h1{font-size:22px}thead{display:none}tr{display:block;border-bottom:1px solid #d9ddd9;padding:10px 0}td{display:block;border:0;padding:4px 0}td:before{content:attr(data-label)"：";color:#626763;white-space:nowrap;display:inline-block}td:first-child{font-weight:600}}
</style><header><nav><a href="${esc(returnUrl)}">← 返回监管中心</a><a href="/?tab=settings&monitorReturn=1">RemoteLab 设置</a></nav></header><main><h1>${esc(title)}</h1>${body}</main></html>`}
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<td data-label="${esc(heads[i])}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
export async function readTrackedFile(path,entry){
 if(!['.md','.json','.txt','.yaml','.yml','.toml'].includes(extname(path).toLowerCase()))throw Object.assign(Error('该格式暂不提供正文预览'),{status:415});
 if(await realpath(path)!==entry.target)throw Object.assign(Error('文件路径已变化，请等待重新采样'),{status:409});
 const handle=await open(entry.target,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>2097152)throw Object.assign(Error('文件不可预览或超过 2 MiB'),{status:413});
 const body=await handle.readFile('utf8');if(body.includes('\0'))throw Object.assign(Error('二进制文件不提供文本预览'),{status:415});return body;
 }finally{await handle.close()}
}
export async function handleMonitoringEvidence({req,res,pathname,authSession,configOverride,historyReader=loadHistory,requestReader=(s,r)=>requests.byRequest(s,r)}){
 if(pathname!=='/api/monitoring-evidence')return false;
 res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 const fragment=new URL(req.url,'http://local').searchParams.get('fragment')==='1';
 let returnUrl='/?tab=settings';
 const send=(status,title,body)=>{res.writeHead(status,{'Content-Type':fragment?'application/json; charset=utf-8':'text/html; charset=utf-8'});res.end(fragment?JSON.stringify({title,html:body}):page(title,body,returnUrl))};
 if(!authSession){send(401,'请登录 RemoteLab','<a href="/">打开登录页</a>');return true}
 if(req.method!=='GET'){send(405,'仅支持查看','');return true}
 try{
 const employeeQuery=new URL(req.url,'http://local').searchParams;
 const employee=employeeQuery.get('employee');
 if(employee){
  const conf=configOverride||await evidenceConfig();
  if(!conf?.employeeHelper||!/^[-a-z0-9_]{1,40}$/.test(employee)){send(404,'未登记员工记忆入口','');return true}
  const id=employeeQuery.get('file');if(id&&!/^[a-f0-9]{16}$/.test(id)){send(404,'文件不在登记范围','');return true}
  const result=await exec('sudo',['-n','python3',conf.employeeHelper,employee,...(id?[id]:[])],{timeout:10000,maxBuffer:4*1024*1024});
  const value=JSON.parse(result.stdout);
  const body=id?'<p class="file-path">'+esc(value.name)+' · '+esc(value.mode)+'</p><pre>'+esc(value.body)+'</pre>':table(['文件'],value.files.map(f=>[link(f.name,{employee,file:f.id})]));
  send(200,id?value.name:employee+' · 核心与详细记忆',body);return true;
 }
 const config=configOverride||await evidenceConfig();if(!config){send(404,'未配置文件证据入口','');return true}
 if(/^https?:\/\//.test(config.returnUrl||''))returnUrl=config.returnUrl;
 const state=JSON.parse(await readFile(config.statePath,'utf8')),registry=JSON.parse(await readFile(config.registryPath,'utf8'));
 const q=new URL(req.url,'http://local').searchParams,ids=(q.get('groups')||'').split(',');
 const groups=registry.groups.filter(g=>g.collectVersions&&ids.includes(g.id));
 if(!groups.length){send(404,'未找到登记对象','');return true}
 const files=groups.flatMap(g=>Object.entries(state.groups[g.id]?.files||{}).map(([path,entry])=>({group:g,path,entry,id:fileId(path)})));
 const selected=q.get('file'),file=selected?files.find(f=>f.id===selected):null;
 if(selected&&!file){send(404,'文件不在当前登记范围','');return true}
 const base={groups:groups.map(g=>g.id).join(',')};
 let body=`<p class="muted">登记范围内 ${files.length} 个文件 · ${esc(date(state.at))}</p>`;
 if(!file){
 body+=table(['文件','区域'],files.map(f=>[link(f.path.split('/').at(-1),{...base,file:f.id})+'<small class="file-path">'+esc(f.path)+'</small>',esc(f.group.name)]));
 send(200,['navigation','policy','candidates'].every(id=>ids.includes(id))?'核心记忆区':groups.map(g=>g.name).join(' / '),body);return true;
 }
 body=(fragment?'':link('← 返回文件清单',base))+`<p class="file-path">${esc(file.path)}</p>`;
 if(q.get('read')==='1'){
  const tracked=await readTrackedFile(file.path,file.entry);
  if(fragment&&q.get('profile')==='1'&&/\/reference\/people\/person_[a-zA-Z0-9_-]+\.md$/.test(file.path)){
   const document=await readPersonalProfile(file.path);
   const profile={prefix:document.prefix,suffix:document.suffix,entries:document.entries.map(e=>({id:e.id,version:e.version,status:e.status,
    ...(e.status==='withdrawn'?{}:{content:e.content,conditions:e.conditions,exceptions:e.exceptions})}))};
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({title:'个人档案',profile}));return true;
  }
  body+='<h2>当前文件正文</h2><p class="muted">只读预览；查看时间 '+esc(date(Date.now()))+'。</p><pre>'+esc(tracked)+'</pre>';
  if(fragment){send(200,'当前文件正文',body);return true}
 }else body+=`<p>${link('读取当前文件正文',{...base,file:file.id,read:'1'})}</p>`;
 const native=await fileEvidence(config,file.path);
 const valid=[];
 for(const n of native.slice(-200).reverse()){
  if(!/^[a-f0-9]{32}$/.test(n.sessionId)||!Number.isInteger(n.seq))continue;
  const [e]=await historyReader(n.sessionId,{fromSeq:n.seq,toSeq:n.seq,includeBodies:false});
  if(e?.type!=='file_change'||e.changeState!=='completed'||e.filePath!==n.path)continue;
  const record=e.requestId?await requestReader(n.sessionId,e.requestId):null;
  if(!record?.acceptedAt||record.sessionId!==n.sessionId||record.requestId!==e.requestId)continue;
  const text=record.text||'';
  // Display the accepted instruction as evidence, never invent a motive from timing.
  const cleaned=text.replace(/<(private|hide)>[\s\S]*?<\/\1>/g,'').split('Current user message:').at(-1).trim();
  valid.push({n,e,record,purpose:cleaned||'该轮原交办未取得；修改目的待核'});
 }
 body+='<h2>原生修改记录</h2><p class="muted">目的依据为当轮原交办；缺少来源的保留待关联。</p>';
 body+=valid.length?table(['时间 / 修改','来自对话','目的依据','原文'],valid.map(({n,e,purpose})=>[
 esc(date(e.timestamp))+'<br>'+esc(kind(e.changeType)),`<a href="/?session=${esc(n.sessionId)}&tab=sessions">对话 ${esc(n.sessionId.slice(0,8))}</a><br>事件 #${n.seq}`,esc(purpose.slice(0,500))+(purpose.length>500?'…':''),link('本轮原文与修改证据',{...base,file:file.id,source:n.sessionId+':'+n.seq})
 ])):'<p>尚无可关联的原生修改记录，来源与目的待关联。</p>';
 const source=q.get('source'),detail=source&&valid.find(x=>x.n.sessionId+':'+x.n.seq===source);
 if(source&&!detail){send(404,'未找到该文件的来源记录','');return true}
 if(detail){const {n,e,purpose}=detail;const [full]=await historyReader(n.sessionId,{fromSeq:n.seq,toSeq:n.seq,includeBodies:true});
 if(fragment)body='';
 body+='<h2>该轮原文与修改证据</h2><p>轮次 '+esc(e.requestId||'未记录')+'</p><h3>原交办（已隐藏运行附带配置）</h3><pre>'+esc(purpose)+'</pre><h3>原生修改差异</h3><pre>'+esc(full?.diff||'该原生事件没有保存差异正文')+'</pre>';
 if(fragment){send(200,'原文与修改差异',body);return true}
 }
 const changes=(state.events||[]).filter(e=>e.group===file.group.id&&e.object===file.id).reverse();
 body+='<h2>文件版本观测</h2><p class="muted">采样变化尚未逐项关联修改来源。</p>';
 body+=changes.length?table(['发现时间','变化','版本摘要','来源'],changes.map(e=>[esc(date(e.at)),esc(kind(e.kind)),esc((e.before||'—')+' → '+(e.after||'—')),'待关联'])):'<p>基线后暂无已保存的版本变化。</p>';
 send(200,file.path.split('/').at(-1),body);
 }catch(e){send(e.status||503,'暂时无法读取文件证据',`<p>${esc(e.status?e.message:'来源暂不可用，请稍后重试；没有用空记录代替。')}</p>`)}
 return true;
}

// Read-only detail for the Monitor's private work projection. Access is checked
// against every contributing Session before any source text is returned.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evidenceConfig} from './monitoring-file-evidence.mjs';
import {canAccessSession} from './session-access.mjs';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function handleOrganizationWork({req,res,pathname,authSession,configOverride,canRead=canAccessSession}){
 if(pathname!=='/api/monitoring/organization-work')return false;
 const send=(code,text)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});res.end(text);return true};
 if(req.method!=='GET')return send(405,'仅支持读取');
 if(!authSession)return send(401,'请先登录 RemoteLab');
 const id=new URL(req.url,'http://local').searchParams.get('id');if(!/^work_[a-f0-9]{20,24}$/.test(id||''))return send(404,'该工作不存在或当前不可见。');
 const config=configOverride||await evidenceConfig();if(!config?.organizationRecordsDir)return send(503,'工作记录尚未接入。');
 let w;try{w=JSON.parse(await readFile(join(config.organizationRecordsDir,id+'.json'),'utf8'))}catch(error){return send(error.code==='ENOENT'?404:503,error.code==='ENOENT'?'该工作不存在或当前不可见。':'工作记录暂不可用，请稍后重试。')}
 const ids=[...new Set([...(w?.sessions||[]).map(s=>s.id),...(w?.sourceRefs||[]).map(r=>r.sessionId)].filter(Boolean))];
 if(!w||!ids.length||!(await Promise.all(ids.map(s=>canRead(authSession,s)))).every(Boolean))return send(404,'该工作不存在或当前不可见。');
 const section=(title,body)=>`<section><h2>${esc(title)}</h2>${body}</section>`,p=t=>`<p>${esc(t||'尚未取得')}</p>`;
 const sources=(w.sourceRefs||[]).map(r=>`<li><a href="/?session=${esc(r.sessionId)}&amp;tab=sessions">原会话${r.seq?' · 事件 '+r.seq:''}</a>${r.seq?` · <a href="/api/sessions/${esc(r.sessionId)}/events?filter=all&amp;afterSeq=${r.seq-1}&amp;limit=1">原事件</a>`:''}</li>`).join('');
 const body=section('原目标与范围变更',p(w.goal)+p((w.scopeChanges||[]).map(x=>x.text||x).join('\n')))+section('预期验收',p(w.acceptance))+section('关键过程时间线',`<ul>${(w.activityEvents||[]).slice().sort((a,b)=>a.at.localeCompare(b.at)).map(e=>`<li>${esc(e.at)} · ${esc(({human:'人工交互',execution:'执行',delivery:'结果报告',system:'系统维护'})[e.kind]||e.kind)}</li>`).join('')}</ul>`)+section('产物与送达 / 采用证据',(w.results||[]).map(r=>p(r.result)).join('')||p(w.publicDetails?.result))+section('四项评审与人工纠正',p(w.publicDetails?.assessment?Object.entries(w.publicDetails.assessment).map(([k,v])=>k+'：'+v).join('\n'):null)+(w.feedbackRefs||[]).map(f=>p(f.comment)).join('')+p('Agent 初评与已核结果分开；此页只读，评价沿原案例入口。'))+section('机器 / 作业关联',(w.jobs||[]).map(j=>p(j.id+' · '+j.state+' · 观测 '+j.observedAt+(j.stale?'（已过期）':'')+' · '+(j.pools||[]).join('、'))).join('')||p('尚未完成工作级关联'))+section('耗时与成本',p((w.deliveredAt?'已核交付 '+w.deliveredAt+'；交办至交付 '+((Date.parse(w.deliveredAt)-Date.parse(w.startedAt))/3600000).toFixed(1)+' 小时（含等待）。\n':'')+(w.cost?.relatedTokens!=null?'已关联 '+w.cost.linkedRuns+' 个 Run，窗口内 '+w.cost.relatedTokens+' Token；共享 Run '+w.cost.sharedRuns+' 个未摊分。\n':'')+(w.cost?.note||'尚未完成工作级独占归因')))+section('原始证据',`<ul>${sources}</ul>`);
 return send(200,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作证据 · Index 使用与效果</title><style>*{box-sizing:border-box}body{margin:24px;background:#f6f7f5;color:#171918;font:15px/1.7 "Segoe UI","PingFang SC",sans-serif}header,main{max-width:1440px;margin:auto;border:1px solid #171918}header{padding:18px 38px;background:#171918;color:white}header a{color:white}main{padding:30px 38px;background:white}h1{font-size:26px}h2{font-size:19px;border-left:4px solid #338368;padding-left:12px}p,li{white-space:pre-wrap;overflow-wrap:anywhere}section{margin-bottom:28px}a{color:#247bb5}@media(max-width:540px){body{margin:0}main,header{padding:16px}}</style><header><a href="/monitoring-preview/?tab=organization&amp;orgWork=${esc(w.workId)}">← 返回 Index 使用与效果</a></header><main><h1>${esc(w.title)}</h1><p>来源截至 ${esc(w.lastActivityAt||w.startedAt||'待核')} · 原记录权限保持</p>${body}</main></html>`);
}

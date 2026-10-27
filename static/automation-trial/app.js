const $ = s => document.querySelector(s), form = $('#create');
const base = new URL('.', location.href).pathname.replace(/\/$/,'');
const labels = { active:'已启用',paused:'已暂停',ended:'已到期',queued:'等待执行',running:'执行中',repairing:'Agent 修复中',needs_human:'需要你处理',completed:'已完成',delivery_failed:'结果发送失败',stopped:'已停止',admitting:'正在启动' };
let tasks = [], editing = null, latestRender = '', busy = false;
const node = (tag, text, cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e; };
const stamp = d => d ? new Date(d).toLocaleString('zh-CN',{hour12:false}) : '未设置';
async function api(path='', body) {
  let suffix='/api/automation-trial';if(path){const [,id,action]=path.split('/');suffix+='/action';body={...body,id,action};}
  const r=await fetch(base+suffix,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  if(r.status===401)throw new Error('试用登录已失效，请刷新页面重新登录');
  const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data;
}
function error(e){$('#error').textContent=e.message;$('#error').hidden=false;}
function fields(){const kind=form.elements.scheduleKind.value;$('#agent-field').hidden=form.elements.recipientKind.value!=='agent';for(const k of ['once','daily','cron'])$('#'+k+'-field').hidden=kind!==k;}
form.addEventListener('change',fields);
function payload(){const v=Object.fromEntries(new FormData(form));let schedule={kind:v.scheduleKind,timezone:'Asia/Shanghai'};
  if(v.scheduleKind==='daily'){const [h,m]=v.dailyTime.split(':');schedule={kind:'cron',cron:`${Number(m)} ${Number(h)} * * *`,timezone:'Asia/Shanghai'};}
  if(v.scheduleKind==='cron')schedule.cron=v.cron;if(v.scheduleKind==='once')schedule.at=new Date(v.at).toISOString();
  return {...v,recipient:{kind:v.recipientKind,sessionId:v.agentSessionId},schedule,monitoring:{warning:v.warning,noProgressMinutes:Number(v.noProgressMinutes||0)},startsAt:v.startsAt?new Date(v.startsAt).toISOString():'',endsAt:v.endsAt?new Date(v.endsAt).toISOString():''};}
form.onsubmit=async e=>{e.preventDefault();$('#save').disabled=true;$('#error').hidden=true;try{const d=payload();await api(editing?`/${editing.id}/edit`:'',editing?{definition:d,revision:editing.revision}:d);reset();await refresh();}catch(e){error(e);}finally{$('#save').disabled=false;}};
function reset(){editing=null;form.reset();$('#form-title').textContent='新建任务';$('#save').textContent='创建任务';$('#cancel-edit').hidden=true;fields();}
$('#cancel-edit').onclick=reset;
$('#example').onclick=()=>{form.elements.purpose.value='整理一份简短的工作记录';form.elements.input.value='今天完成：接口联调；仍待处理：补一份使用说明。';form.elements.output.value='将输入整理为“已完成”和“下一步”两部分，保存为工作目录中的 result.md，并把正文返回。';form.elements.sop.value='只使用给定输入，不读取其他项目。写完后读回 result.md 核对内容。';form.elements.cost.value='一次短文本整理，预计约 1–3 分钟；实际模型用量以执行记录为准。';};
function button(label,fn,disabled=false){const b=node('button',label,'secondary');b.type='button';b.disabled=disabled;b.onclick=fn;return b;}
async function action(t,a,body={}){try{$('#error').hidden=true;await api(`/${t.id}/${a}`,body);await refresh();}catch(e){error(e);}}
function edit(t){editing=t;const d=t.definition;for(const k of ['title','purpose','input','output','cost','owner','scope','sop'])form.elements[k].value=d[k]||'';
  form.elements.recipientKind.value=d.recipient.kind;form.elements.agentSessionId.value=d.recipient.sessionId||'';
  form.elements.scheduleKind.value=d.schedule.kind;form.elements.cron.value=d.schedule.cron||'';
  const local=d=>d?new Date(Date.parse(d)-new Date(d).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  form.elements.at.value=local(d.schedule.at);form.elements.startsAt.value=local(d.startsAt);form.elements.endsAt.value=local(d.endsAt);
  form.elements.warning.value=d.monitoring.warning;form.elements.noProgressMinutes.value=d.monitoring.noProgressMinutes||'';
  $('#form-title').textContent='编辑任务 · 下轮生效';$('#save').textContent='保存定义';$('#cancel-edit').hidden=false;fields();form.scrollIntoView({behavior:'smooth'});}
function render(){const list=$('#tasks');list.replaceChildren();if(!tasks.length){list.append(node('div','还没有试用任务。可以填写自己的任务，或载入一个简单示例。','empty'));return;}
 for(const t of tasks){const d=t.definition,c=t.cycles.at(-1),card=node('article',undefined,'task');card.dataset.id=t.id;
  const head=node('div',undefined,'task-head');head.append(node('h3',d.title),node('span',labels[c?.status]||labels[t.state]||t.state,'status'));card.append(head);
  card.append(node('p',`${d.owner} · ${d.recipient.kind==='agent'?'交给 Agent':'给我 · 本页与任务会话'} · ${labels[t.state]}`,'meta'));
  if(t.nextAt)card.append(node('p',`下次执行：${stamp(t.nextAt)}`,'meta'));
  if(c?.observationError)card.append(node('p','监管暂不可用，当前执行状态尚未更新：'+c.observationError,'warning'));
  if(c?.error&&c.status!=='completed')card.append(node('p',c.error,'warning'));
  if(c?.result)card.append(node('div',c.result.output||c.result.summary,'result'));
  const delivery=c?.deliveries?.result||c?.deliveries?.human||c?.deliveries?.stall;if(delivery)card.append(node('p',delivery.state==='delivered'?delivery.detail:`通知状态：${delivery.state}${delivery.error?' · '+delivery.error:''}`,'meta'));
  const actions=node('div',undefined,'actions'),unresolved=t.cycles.some(x=>!['completed','stopped'].includes(x.status));
  actions.append(button('运行一次',()=>action(t,'run'),t.state!=='active'||unresolved),button(t.state==='active'?'暂停':'恢复',()=>action(t,t.state==='active'?'pause':'resume')),button('编辑',()=>edit(t)));
  if(c?.sessionId){const a=node('a','打开执行会话');a.href='/?tab=sessions&session='+encodeURIComponent(c.sessionId);a.target='_blank';a.rel='noopener';actions.append(a);}
  if(c?.status==='delivery_failed'||c?.deliveries?.human?.state==='failed')actions.append(button('重发通知',()=>action(t,'deliver')));
  card.append(actions);
  if(c?.status==='needs_human'){const input=node('textarea');input.placeholder='补充必要信息，或说明你已经完成的操作';input.rows=2;card.append(input,button('补充并继续',()=>action(t,'continue',{answer:input.value})));}
  const detail=node('details'),summary=node('summary','任务定义与记录');detail.append(summary);const dl=node('dl');
  for(const [key,value]of [['目的',d.purpose],['输入',d.input],['输出',d.output],['预计成本',d.cost],['生效范围',d.scope],['生效日期',`${stamp(d.startsAt)} → ${d.endsAt?stamp(d.endsAt):'未指定结束日期'}`],['执行 SOP',d.sop],['监管预警',d.monitoring.warning]])dl.append(node('dt',key),node('dd',value));detail.append(dl);
  const ul=node('ul',undefined,'timeline');for(const e of [...t.events].reverse()){const li=node('li',e.text);li.prepend(node('time',stamp(e.at)));ul.append(li);}detail.append(ul);
  for(const old of [...t.cycles].reverse().slice(1)){const sub=node('details');sub.append(node('summary',`${stamp(old.createdAt)} · ${labels[old.status]}`),node('p',old.result?.output||old.error||'暂无结果','result'));detail.append(sub);}
  card.append(detail);list.append(card);}}
async function refresh(){if(busy)return;busy=true;try{const d=await api();tasks=d.tasks;$('#connection').textContent='已同步 '+new Date().toLocaleTimeString('zh-CN');const serialized=JSON.stringify(tasks);
  // Preserve expanded details and human input while unchanged or being edited.
  if(serialized!==latestRender&&!($('#tasks').contains(document.activeElement) && document.activeElement.matches('textarea,input,select'))){const open=new Set([...document.querySelectorAll('.task>details[open]')].map(x=>x.parentElement.dataset.id));render();for(const el of document.querySelectorAll('.task>details'))if(open.has(el.parentElement.dataset.id))el.open=true;latestRender=serialized;}
  if(!form.elements.owner.value&&d.actor.personName)form.elements.owner.value=d.actor.personName;
 }catch(e){$('#connection').textContent='未同步';error(e);}finally{busy=false;}}
fields();refresh();setInterval(()=>{if(!document.hidden)refresh();},2000);

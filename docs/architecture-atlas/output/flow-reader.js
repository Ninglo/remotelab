import { audit, actors, sources, scenarios, feedback, testCases } from './flow-data.js?v=20261003c';
const byId=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={sync:'等待本次交接回执',async:'异步独立推进',conditional:'按条件发生'};
const actorLabels=Object.fromEntries(actors.map(a=>[a.id,a.label]));
const sourceLinks=keys=>`<div class="source-links">${[...new Set(keys.flatMap(k=>sources[k]||[]))].map(p=>`<a href="https://github.com/Ninglo/remotelab/blob/${audit.commit}/${esc(p)}" target="_blank" rel="noopener noreferrer">${esc(p)} ↗</a>`).join('')}</div>`;
let selected='pilot',cursor=0;

function diagram(){
 const config=scenarios[selected], steps=config.steps, xs=actors.map((_,i)=>110+i*190),height=150+steps.length*64;
 let svg=`<svg viewBox="0 0 1360 ${height}" role="group" aria-label="${esc(scenarios[selected].label)}：时间向下的交接时序"><defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#7393b3" stroke-width="1.4"/></marker></defs>`;
 const zoneY=75+config.parallelStart*64;
 svg+=`<rect x="10" y="${zoneY}" width="1340" height="${height-zoneY-14}" rx="5" fill="#edf2f7" stroke="#c7d4e0" stroke-dasharray="4 4"/><text x="32" y="${zoneY+22}" class="flow-zone">接纳后并行区 · 编号供阅读，各支路无全局到达顺序保证</text>`;
 actors.forEach((a,i)=>{svg+=`<text x="${xs[i]}" y="30" class="flow-actor" text-anchor="middle">${esc(a.label)}</text><text x="${xs[i]}" y="51" class="flow-owner" text-anchor="middle">${esc(a.owner)}</text><line class="flow-life" x1="${xs[i]}" x2="${xs[i]}" y1="65" y2="${height-20}"/>`;});
 steps.forEach((s,i)=>{const y=99+i*64+(i>=config.parallelStart?40:0),from=xs[actors.findIndex(a=>a.id===s.from)],to=xs[actors.findIndex(a=>a.id===s.to)],mid=(from+to)/2;
  svg+=`<g class="flow-step" data-step="${i}" tabindex="0" role="button" aria-label="第 ${i+1} 步：${esc(s.title)}；${labels[s.kind]}"><rect class="flow-row" x="12" y="${y-24}" width="1336" height="59" rx="3"/><text x="25" y="${y+4}" class="flow-number">${String(i+1).padStart(2,'0')}</text><line class="flow-arrow ${s.kind}" x1="${from}" y1="${y+8}" x2="${to}" y2="${y+8}" marker-end="url(#flow-arrow)"/><text class="flow-label" x="${mid}" y="${y-4}" text-anchor="middle">${esc(s.title)}</text><text class="flow-kind" x="${mid}" y="${y+29}" text-anchor="middle">${labels[s.kind]}</text></g>`;});
 byId('flow-sequence').innerHTML=svg+'</svg>';
 byId('flow-sequence').querySelectorAll('[data-step]').forEach(g=>{const select=()=>showStep(Number(g.dataset.step));g.addEventListener('click',select);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}});});
}
function showStep(i,scroll=false){
 const steps=scenarios[selected].steps;cursor=Math.max(0,Math.min(i,steps.length-1));const s=steps[cursor];
 byId('step-list').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.step)===cursor)));
 byId('flow-sequence').querySelectorAll('[data-step]').forEach(g=>{g.classList.toggle('active',Number(g.dataset.step)===cursor);g.setAttribute('aria-pressed',String(Number(g.dataset.step)===cursor));});
 byId('step-detail').innerHTML=`<span class="tag ${selected==='goal'?'goal':''}">${labels[s.kind]}${selected==='goal'?' · 目标方案':''}</span><h3>${cursor+1}. ${esc(s.title)}</h3><p class="step-owner">${esc(s.owner)}<br>${esc(actorLabels[s.from])} → ${esc(actorLabels[s.to])}</p><p class="action">${esc(s.action)}</p>${cursor>=scenarios[selected].parallelStart?'<p class="small muted">本步在接纳后的并行区。按各支路的依赖推进；阅读编号不保证表情、开场、卡片或后置整理的全局先后。</p>':''}<div class="step-facts"><p><strong>交了什么</strong>${esc(s.handoff)}</p><p><strong>等什么，什么时候能继续</strong>${esc(s.wait)}</p><p><strong>用户看到什么 / 能证明什么</strong>${esc(s.visible)}</p></div><details data-technical><summary>本步骤的源码依据</summary><div class="detail-body">${sourceLinks([s.ref])}</div></details>`;
 byId('step-count').textContent=`${cursor+1} / ${steps.length}`;byId('step-prev').disabled=cursor===0;byId('step-next').disabled=cursor===steps.length-1;
 if(byId('expand-details').getAttribute('aria-expanded')==='true')byId('step-detail').querySelector('details').open=true;
 if(scroll){const box=document.querySelector('.diagram-scroll');box.scrollTop=Math.max(0,(75+cursor*64+(cursor>=scenarios[selected].parallelStart?40:0))*box.clientWidth/1360-90);const button=byId('step-list').querySelector(`[data-step="${cursor}"]`);button?.scrollIntoView({block:'nearest',inline:'nearest'});}
}
function scene(key){selected=key;cursor=0;const s=scenarios[key];byId('scene-tabs').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scene===key)));
 byId('scene-status').textContent=s.status;byId('scene-status').classList.toggle('goal',key==='goal');byId('scene-intro').textContent=s.intro;
 byId('step-list').innerHTML=s.steps.map((t,i)=>`<button type="button" data-step="${i}"><span>${String(i+1).padStart(2,'0')}</span>${esc(t.title)}</button>`).join('');
 byId('step-list').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>showStep(Number(b.dataset.step),true)));
 diagram();document.querySelector('.diagram-scroll').scrollTop=0;showStep(0);
}
byId('scene-tabs').innerHTML=Object.entries(scenarios).map(([k,s])=>`<button type="button" data-scene="${k}" aria-pressed="false">${esc(s.label)}</button>`).join('');
byId('scene-tabs').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>scene(b.dataset.scene)));
byId('step-prev').addEventListener('click',()=>showStep(cursor-1,true));byId('step-next').addEventListener('click',()=>showStep(cursor+1,true));
byId('reader-version').textContent=audit.version;byId('reader-commit').textContent=audit.commit;byId('reader-scope').textContent=audit.scope;
byId('feedback-rows').innerHTML=feedback.map(([kind,current,goal,ref])=>`<tr><td>${esc(kind)}</td><td>${esc(current)}${sourceLinks([ref])}</td><td>${esc(goal)}</td></tr>`).join('');
byId('test-rows').innerHTML=testCases.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
document.querySelectorAll('[data-sources]').forEach(e=>e.innerHTML=sourceLinks(e.dataset.sources.split(' ')));
const sourceNames={inbox:'接入与耐久 inbox',observation:'第一次 Session 交接：观察历史',jev:'群 Jev 判断',handoff:'路由与第二次 Session 交接',admission:'可执行 Request 接纳',auto:'条件 Auto 路由',native:'追加输入与原生控制',run:'脱离前台的执行',opening:'开场与会话入口',card:'任务快照、原卡进度与卡片范围',delivery:'文本、表情与结果投递',question:'待答题、自动绑定与超时',after:'后置整理'};
byId('all-sources').innerHTML=Object.entries(sources).map(([key])=>`<div class="source-group"><strong>${sourceNames[key]}</strong>${sourceLinks([key])}</div>`).join('');
byId('expand-details').addEventListener('click',()=>{const b=byId('expand-details'),open=b.getAttribute('aria-expanded')!=='true';document.querySelectorAll('details[data-technical]').forEach(d=>d.open=open);b.setAttribute('aria-expanded',String(open));b.textContent=open?'收起技术细节':'展开技术细节';});
if('IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){document.querySelectorAll('.contents nav a').forEach(a=>a.classList.toggle('active',a.hash==='#'+e.target.id));}},{rootMargin:'-10% 0px -70% 0px'});document.querySelectorAll('main>section,header').forEach(s=>observer.observe(s));}
scene('pilot');

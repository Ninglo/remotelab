import { guide } from '../../memory-architecture/guide-data.js?v=2.8';
import { memoryAudit, memorySteps, executionRows, timeRules, timelineExample, backgroundCases, memoryPurposes, memorySupport, memoryFileMap, filingIncident, filingRisks } from '../../memory-architecture/reader-data.js?v=20261003i';
const el=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows=list=>list.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
function tabs(id, list, render) {
  el(id).innerHTML=list.map(item=>`<button type="button" data-memory-choice="${esc(item.id)}" aria-pressed="false">${esc(item.label)}</button>`).join('');
  const choose=value=>{el(id).querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.memoryChoice===value)));render(list.find(item=>item.id===value));};
  el(id).addEventListener('click',event=>{const button=event.target.closest('[data-memory-choice]');if(button)choose(button.dataset.memoryChoice);});
  choose(list[0].id);
}
function step(index){const item=memorySteps[index];el('memory-flow').querySelectorAll('button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));el('memory-step').innerHTML=`<p class="step-owner">${esc(item.owner)}</p><h3>${esc(item.title)}</h3><p>${esc(item.action)}</p><div class="step-facts"><p><strong>读哪些</strong>${esc(item.read)}</p><p><strong>存在哪里</strong>${esc(item.write)}</p><p><strong>下一步与边界</strong>${esc(item.next)}</p></div>`;}
el('memory-flow').innerHTML=memorySteps.map((item,index)=>`<button type="button" data-memory-step="${index}" aria-pressed="false"><small>0${index+1}${index<4?' →':''}</small>${esc(item.title)}</button>`).join('');
el('memory-flow').addEventListener('click',event=>{const button=event.target.closest('[data-memory-step]');if(button)step(Number(button.dataset.memoryStep));});step(0);
tabs('memory-purpose-tabs',memoryPurposes,item=>{el('memory-purpose-detail').innerHTML=`<h3>${esc(item.question)}</h3><p>${esc(item.content)}</p><div class="step-facts"><p><strong>正文位置</strong><code>${esc(item.path)}</code></p><p><strong>何时读取</strong>${esc(item.read)}</p><p><strong>具体例子</strong>${esc(item.example)}</p></div>`;});
el('memory-support-rows').innerHTML=rows(memorySupport);
function revealMemoryAnchor(){let target;try{target=document.getElementById(decodeURIComponent(location.hash.slice(1)));}catch{return;}if(!target||!target.closest('#memory-storage'))return;let parent=target.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}requestAnimationFrame(()=>target.scrollIntoView());}
window.addEventListener('hashchange',revealMemoryAnchor);revealMemoryAnchor();
tabs('memory-store-tabs',guide.storageCases,item=>{el('memory-store-detail').innerHTML=`<h3>${esc(item.question)}</h3><p>${esc(item.current.body)}</p><p class="small muted">当前落点：${item.current.paths.map(path=>`<code>${esc(path)}</code>`).join(' · ')}</p><div class="step-facts"><p><strong>如何读取</strong>${esc(item.current.read)}</p><p><strong>谁更新</strong>${esc(item.current.write)}</p></div><details data-technical><summary>展开治理做法与仍需补齐的部分</summary><div class="detail-body"><p>${esc(item.target.body)}</p><p>${esc(item.target.read)}</p><p>${esc(item.target.write)}</p></div></details>`;});
tabs('memory-class-tabs',guide.classificationCases,item=>{el('memory-class-detail').innerHTML=`<h3>${esc(item.label)}</h3><p>例子：${esc(item.example)}</p><p><strong>归入：${esc(item.target)}</strong> · ${esc(item.type)}</p><p>${esc(item.rule)}</p><p class="small muted">${item.paths.map(path=>esc(path)).join(' · ')}。${esc(item.other)}</p>`;});
tabs('memory-read-tabs',guide.readingCases,item=>{el('memory-read-detail').innerHTML=`<ol>${item.steps.map(([title,text])=>`<li><strong>${esc(title)}</strong>：${esc(text)}</li>`).join('')}</ol><p class="small muted">通常不读：${esc(item.skip)}</p>`;});
el('memory-execution-rows').innerHTML=rows(executionRows);el('memory-time-rows').innerHTML=rows(timeRules);el('memory-background-rows').innerHTML=rows(backgroundCases);
el('memory-filing-cause').textContent=filingIncident.cause;el('memory-filing-correction').textContent=filingIncident.correction;el('memory-filing-recurrence').textContent=filingIncident.recurrence;el('memory-filing-risks').innerHTML=rows(filingRisks);
const fileKinds=['全部',...new Set(memoryFileMap.map(row=>row[0]))];
el('memory-file-kind').innerHTML=fileKinds.map(kind=>`<option>${esc(kind)}</option>`).join('');
function showFileMap(){const kind=el('memory-file-kind').value,query=el('memory-file-query').value.trim().toLowerCase();const list=memoryFileMap.filter(row=>(kind==='全部'||row[0]===kind)&&(!query||row.join(' ').toLowerCase().includes(query)));el('memory-file-rows').innerHTML=rows(list);el('memory-file-count').textContent=`${list.length}组文件位置（查阅清单，不是记忆层级）；占位符表示具体人员、Session、Run或日期。实际已存在的文件与完整路径在14登录读回。`;}
el('memory-file-kind').addEventListener('change',showFileMap);el('memory-file-query').addEventListener('input',showFileMap);showFileMap();
el('memory-timeline-example').innerHTML=timelineExample.map(([date,status,text])=>`<article><time>${esc(date)}</time><h3>${esc(status)}</h3><p>${esc(text)}</p></article>`).join('');
el('memory-audit').textContent=`${memoryAudit.version}；底座${memoryAudit.commit}。${memoryAudit.scope}`;
el('memory-sources').innerHTML=memoryAudit.sources.map(path=>`<a href="https://github.com/Ninglo/remotelab/blob/main/${esc(path)}" target="_blank" rel="noopener">${esc(path)}</a>`).join('');
const names={available:'已记录', 'not-recorded':'尚未登记',unavailable:'暂不可读取','too-large-or-not-file':'文件过大或格式不适用','select-person':'先选择实际Person',invalid:'视图格式不适用'};
let snapshot;
const clearPrivate=()=>{snapshot=undefined;el('memory-private').hidden=true;for(const id of ['memory-project-select','memory-person-select','memory-actual-timeline'])el(id).replaceChildren();for(const id of ['memory-project-index','memory-project-ledger','memory-person-body','memory-company-body','memory-actual-files'])el(id).textContent='';};
function textDocument(id,doc){
 const root=el(id);root.replaceChildren();
 if(doc?.status!=='available'){root.textContent=`${names[doc?.status]||'尚未读取'}。未登记表示尚未整理，不代表没有相关信息。`;return;}
 if(id==='memory-project-index'||id==='memory-project-ledger'){root.textContent=`位置：${doc.path||'当前服务器未提供位置'}\n文件更新时间${doc.modifiedAt} · 内容版本 ${doc.hash}\n\n${doc.text}`;return;}
 const metadata=document.createElement('p');metadata.className='small muted';metadata.textContent=`位置：${doc.path||'当前服务器未提供位置'} · 文件更新时间${doc.modifiedAt} · 内容版本${doc.hash}`;root.append(metadata);
 const inline=(node,text)=>{
  const pattern=/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;let offset=0;
  for(const match of text.matchAll(pattern)){node.append(document.createTextNode(text.slice(offset,match.index)));const a=document.createElement('a');a.textContent=match[1];a.href=match[2];a.target='_blank';a.rel='noopener noreferrer';node.append(a);offset=match.index+match[0].length;}
  node.append(document.createTextNode(text.slice(offset)));
 };
 for(const block of doc.text.split(/\n\s*\n/)){
  const lines=block.split('\n');
  if(/^#{1,4} /.test(block)&&lines.length===1){const heading=document.createElement('h3');heading.className='subhead';heading.textContent=block.replace(/^#{1,4} /,'');root.append(heading);}
  else if(lines.length>2&&lines[0].startsWith('|')&&/^\|[- :|]+\|$/.test(lines[1])){const container=document.createElement('div');container.className='table-scroll';const table=document.createElement('table');for(const [i,line]of lines.entries()){if(i===1)continue;const tr=document.createElement('tr');for(const value of line.split('|').slice(1,-1)){const cell=document.createElement(i===0?'th':'td');inline(cell,value.trim());tr.append(cell);}table.append(tr);}container.append(table);root.append(container);}
  else if(lines.every(line=>line.startsWith('- '))){const list=document.createElement('ul');for(const line of lines){const item=document.createElement('li');inline(item,line.slice(2));list.append(item);}root.append(list);}
  else{const paragraph=document.createElement('p');inline(paragraph,block);root.append(paragraph);}
 }
}
function showTimeline(){
 const project=el('memory-project-select').value,person=el('memory-person-select').value;
 const chronology=snapshot?.chronology;
 if(chronology?.status!=='available'){el('memory-chronology-status').textContent=`时间线：${names[chronology?.status]||'尚未整理'}；可从原主账按事件日期追溯，不能只因字段缺失停止判断。`;return;}
 const data=chronology.data,events=data.events.filter(event=>(!project||event.projectIds.includes(project))&&(!person||event.actors.some(actor=>actor.personId===person)));
 el('memory-chronology-status').textContent=`生成：${data.generatedAt}；本次范围${data.events.length}条关键记录，当前筛选${events.length}条。${chronology.stale?'原主账已变化，视图待刷新；下面只作历史依据。':'内容版本与原主账一致；不表示穷尽全部历史。'} 项目创建日期仍依独立立项证据，最早记录仅证明当时已存在。`;
 el('memory-actual-timeline').innerHTML=events.length?events.map(event=>`<article><time>${esc(event.time.value||'事件时间未知')} · ${esc(event.time.kind)}</time><h3>${esc(event.title)}</h3><p>${esc(event.summary)}</p><p><strong>当时状态：</strong>${esc(event.status)} · <strong>事项：</strong>${esc(event.itemId)}</p><p>${event.actors.map(actor=>`${esc(actor.name)}（${esc(actor.role)}）`).join('；')||'人员职责未在此条核清'}</p><details><summary>出处、时间与前后关系</summary><div class="detail-body"><p>原记录时间：${esc(event.recordedAt||'未核到，不用本次整理时间代替')}。原审阅快照标注：${esc(event.sourceSnapshotAt||'未核到')}。关联前一事件：${esc(event.previousEventId||'此范围未建立前序关联')}。</p><p>来源：${esc(event.source.path)}:${esc(event.source.line)} · ${esc(event.source.basis)}</p><p>${esc(event.source.excerpt)}</p></div></details></article>`).join(''):'<p class="memory-empty">本视图尚无同时满足项目与人员的明确事件。未取得人员关联不等于没有推进；可切回“全部人员”查看项目来源。</p>';
 const row=snapshot.runtime.projects?.find(item=>item.id===project),creation=data.projectCreation?.find(item=>item.projectId===project);
 el('memory-project-state').textContent=row?`${row.sourceGroups}个已绑定来源群，${row.declaredSessions}个明确登记Session；未登记个人工作仍需事项依据。${creation?` 此范围最早存在依据：${creation.earliestKnownInThisView}；创建日期：${creation.createdAt||'未知'}。`:''}`:'全部登记节点；不是全部活跃项目。';
}
async function load(personId=null){
 const button=el('memory-load'),project=el('memory-project-select').value;button.disabled=true;el('memory-person-select').disabled=true;clearPrivate();el('memory-instance-status').textContent='正在读回本实例记录…';
 try{
  const response=await fetch(`/api/memory-context-view${personId!==null?'?personId='+encodeURIComponent(personId):''}`,{credentials:'same-origin',cache:'no-store',redirect:'error'});
  if(response.status===401||response.status===403){el('memory-instance-status').textContent='需先在本实例登录；公开页未读取私人资料。';return;}
  if(!response.ok)throw new Error('实例读取失败');
  const data=await response.json();if(!Array.isArray(data.people)||!data.runtime)throw new Error('实例返回格式不适用');snapshot=data;
  el('memory-instance-status').textContent=`实际读取：${data.generatedAt}；${data.people.length}个Person身份，不等于已整理同等数量的偏好档案。`;
  const rt=data.runtime;el('memory-runtime-status').textContent=rt.status==='available'?`项目记忆${rt.release}：${rt.enabled?'开启':'关闭'}；开工指针${rt.contextEnabled?'开启':'关闭'}；日报增强${rt.reviewEnabled?'开启':'关闭'}；${rt.projects.length}个登记节点，${rt.sourceGroups}个绑定来源群，配置版本${rt.hash}。`:'项目增强配置暂不可读取；旧记忆入口仍需核对。';
  const labels=new Map((data.projectIndex?.text||'').split('\n').filter(line=>line.startsWith('|')).map(line=>line.split('|').slice(1).map(cell=>cell.trim())).map(cells=>[cells[0],cells[1]]));
  el('memory-project-select').innerHTML='<option value="">全部项目节点</option>'+(rt.projects||[]).map(item=>`<option value="${esc(item.id)}">${esc(labels.get(item.id)||item.id)}</option>`).join('');
  if((rt.projects||[]).some(item=>item.id===project))el('memory-project-select').value=project;
  el('memory-person-select').innerHTML='<option value="">全部人员事件／未选个人档案</option>'+data.people.map(person=>`<option value="${esc(person.id)}">${esc(person.name||person.id)}</option>`).join('');el('memory-person-select').value=data.personId||'';
  textDocument('memory-project-index',data.projectIndex);textDocument('memory-project-ledger',data.projectLedger);textDocument('memory-person-body',data.personal);textDocument('memory-company-body',data.company);
  const catalogue=data.fileCatalog;
  el('memory-actual-files').innerHTML=catalogue?`<p>以下是本次实际枚举的文件名及固定位置，只列元数据。归档正文、日志、隐藏目录、符号链接扫描和Harness原生文件未遍历；路径模板不表示已枚举全部历史。${catalogue.truncated?'扫描达到上限，下面不是完整清单。':''}</p><div class="table-scroll"><table><thead><tr><th>文件名</th><th>完整位置</th><th>用途区域</th><th>边界</th></tr></thead><tbody>${rows(catalogue.files.map(file=>[file.name,file.path,file.region,[names[file.status]||'已枚举',file.resolvedPath?`链接到 ${file.resolvedPath}`:'',file.note].filter(Boolean).join('；')]))}</tbody></table></div><h3 class="subhead">实际目录下的变动文件名</h3><div class="table-scroll"><table><thead><tr><th>路径模板</th><th>用途</th></tr></thead><tbody>${rows(catalogue.patterns.map(item=>[item.path,item.note]))}</tbody></table></div><h3 class="subhead">当前自动写回真正允许的目标</h3><div class="table-scroll"><table><thead><tr><th>目标</th><th>实际文件</th><th>范围</th><th>允许类别</th></tr></thead><tbody>${rows((catalogue.writeback||[]).map(item=>[item.id,item.path,item.layer,(item.categories||[]).join('、')]))}</tbody></table></div><p class="small muted">文件存在不表示已核事实或默认规则。${catalogue.issues.length?`有${catalogue.issues.length}项目录或写回读取缺口。`:''}</p>`:'服务器尚未提供文件清单；不能用静态位置冒充实际读回。';
  el('memory-private').hidden=false;showTimeline();
 }catch{clearPrivate();el('memory-instance-status').textContent='未能读取实例记录，未用静态示例冒充最新数据；请登录后重试。';}finally{button.disabled=false;el('memory-person-select').disabled=false;}
}
el('memory-load').addEventListener('click',()=>load());el('memory-project-select').addEventListener('change',showTimeline);el('memory-person-select').addEventListener('change',()=>load(el('memory-person-select').value));

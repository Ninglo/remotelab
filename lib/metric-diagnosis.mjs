import { diagnosisKey } from './session-diagnosis.mjs';
const DAY=86400000;
const finite=n=>Number.isFinite(n)&&n>=0;
export const median=values=>{const a=values.filter(finite).sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;};
export const metricLabels={injectionChars:'上下文注入',firstResponseMs:'首次响应',finalDeliveryMs:'交付用时'};
const floors={injectionChars:1000,firstResponseMs:5000,finalDeliveryMs:30000};
const day=at=>Math.floor((at+3*3600000)/DAY);
const unique=rows=>new Set(rows.map(s=>s.sessionId)).size;
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
function bySession(rows,metric) {
 const groups=new Map();for(const s of rows){if(!groups.has(s.sessionId))groups.set(s.sessionId,[]);groups.get(s.sessionId).push(s.metrics[metric]);}
 return [...groups.values()].map(median);
}
export function metricCohort(s) {
 return JSON.stringify([s.model,s.effort||'unknown',s.tool,s.surface||'unknown',s.firstSessionRun===true?'first':s.firstSessionRun===false?'follow':'unknown',s.experiment||'unmarked']);
}
const format=(metric,v)=>metric==='injectionChars'?`${Math.round(v).toLocaleString('en-US')} 字符`:`${(v/1000).toFixed(1)} 秒`;
export function metricComparisons(samples,now=Date.now()) {
 const groups=new Map(),seen=new Set();
 for(const s of samples){
  if(!s.runId||seen.has(s.runId)||s.background||s.state!=='completed'||!finite(s.responseAt)||s.responseAt>now||now-s.responseAt>14*DAY)continue;
  seen.add(s.runId);const key=metricCohort(s);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(s);
 }
 const comparisons=[];
 for(const [cohort,rows] of groups)for(const metric of Object.keys(metricLabels)){
  const valid=rows.filter(s=>finite(s.metrics[metric]));
  const recent=valid.filter(s=>s.responseAt>=now-DAY),history=valid.filter(s=>s.responseAt<now-DAY);
  const selectedDays=[...new Set(history.map(s=>day(s.responseAt)))].sort((a,b)=>b-a).slice(0,3);
  const baseline=history.filter(s=>selectedDays.includes(day(s.responseAt)));
  if(!recent.length)continue;
  const baseDays=new Set(baseline.map(s=>day(s.responseAt))).size;
  const sessions=bySession(recent,metric),normalSessions=bySession(baseline,metric);
  const current=median(sessions),normal=median(normalSessions);
  const dispersion=normal===null?null:median(normalSessions.map(n=>Math.abs(n-normal)));
  const ratio=normal>0?current/normal:null;
  const supported=baseline.length>=20&&unique(baseline)>=5&&baseDays>=3&&normal>0;
  const enough=recent.length>=10&&unique(recent)>=3;
  // A small population can be suspicious without being represented as a trend.
  const small=recent.length>=3&&unique(recent)>=2;
  const large=supported&&ratio>=1.3&&current-normal>=floors[metric];
  const broad=large&&sessions.filter(v=>v>=normal*1.3).length>=Math.ceil(sessions.length*.6);
  const noisy=normal>0&&dispersion/normal>.3;
  const alarm=broad&&(enough||(small&&ratio>=1.5));
  comparisons.push({cohort,metric,current,baseline:normal,ratio,dispersion,
   currentCount:recent.length,currentSessions:unique(recent),baselineCount:baseline.length,baselineSessions:unique(baseline),baselineDays:baseDays,
   rawMean:mean(recent.map(s=>s.metrics[metric])),baselineRawMean:mean(baseline.map(s=>s.metrics[metric])),
   confidence:!supported?'baseline_insufficient':!enough?'small_sample':noisy?'high_variation':'supported',
   alarm,requiresHumanReview:alarm,rows:recent,baselineRows:baseline,
   reason:!supported?'历史样本不足，不能宣称正常或确认趋势':!enough?'当前样本偏少，只能作为待核实异常':noisy?'历史本身波动较大，需要人工结合任务内容判断':'同类请求的多数会话持续上浮'});
 }
 return comparisons;
}
export function metricCandidate(c,now=Date.now()) {
 const names=JSON.parse(c.cohort),[model,effort,tool,surface,turn,experiment]=names;
 const evidence=[`最近24小时 ${c.currentCount} 次独立执行、${c.currentSessions} 个会话；此前3个有样本日 ${c.baselineCount} 次、${c.baselineSessions} 个会话、${c.baselineDays} 个有样本日。`,
  `按会话等权的中位数：${format(c.metric,c.baseline)} → ${format(c.metric,c.current)}，增加 ${((c.ratio-1)*100).toFixed(1)}%；普通逐次均值为 ${format(c.metric,c.rawMean)}。`,
  `比较范围：${model} / ${effort} / ${tool} / ${surface} / ${turn==='first'?'首次执行':turn==='follow'?'后续执行':'首轮身份未知'} / ${experiment==='unmarked'?'未标记实验':experiment}。`];
 const findings=[];
 if(c.metric==='injectionChars'){
  const ids=new Set(c.rows.flatMap(s=>(s.sources||[]).map(x=>x.id)));
  for(const id of ids){
   const size=rows=>median(rows.map(s=>s.sources?.find(x=>x.id===id)?.chars||0));
   const current=size(c.rows),baseline=size(c.baselineRows),delta=current-baseline;
   if(delta>0)findings.push({id,name:c.rows.flatMap(s=>s.sources||[]).find(x=>x.id===id)?.name||id,delta});
  }
  findings.sort((a,b)=>b.delta-a.delta);
  if(findings.length)evidence.push('注入构成增长线索：'+findings.slice(0,3).map(x=>`${x.name}约增加${Math.round(x.delta)}字符`).join('；')+'。各项为独立中位数，不能相加当作精确归因。');
 } else {
  const stages=c.metric==='firstResponseMs'?['prepareMs','launchMs']:['prepareMs','launchMs','runMs','deliveryMs'];
  for(const stage of stages){const a=median(c.rows.map(s=>s.metrics[stage])),b=median(c.baselineRows.map(s=>s.metrics[stage]));if(a!==null&&b!==null&&a>b)findings.push({id:stage,name:({prepareMs:'准备及排队',launchMs:'启动',runMs:'执行',deliveryMs:'结果发送'})[stage],delta:a-b});}
  findings.sort((a,b)=>b.delta-a.delta);
  if(findings.length)evidence.push('耗时增长线索：'+findings.slice(0,3).map(x=>`${x.name}约增加${(x.delta/1000).toFixed(1)}秒`).join('；')+'。');
 }
 return {key:diagnosisKey(['metric',c.metric,c.cohort]),kind:'metric',metric:c.metric,model,tool,cohort:c.cohort,
  fingerprint:diagnosisKey(c.rows.map(s=>[s.runId,s.metrics[c.metric]]).sort()),members:[...new Set(c.rows.map(s=>s.sessionId))].slice(0,100).map(sessionId=>({sessionId})),
  lastAnomalyAt:Math.max(...c.rows.map(s=>s.responseAt)),baseline:c.baseline,ratio:c.ratio,confidence:c.confidence,
  summary:`${metricLabels[c.metric]}上浮 ${((c.ratio-1)*100).toFixed(1)}%，${c.reason}。`,evidence,
  status:'review_required',trigger:'同类单次指标上浮达到30%，并满足跨会话及样本条件。',
  action:'已自动去重、拆分实验与模型、比较会话中位数，并核对构成与阶段；尚未修改上下文或业务流程。',
  verification:'统计异常已核对；业务根因及调整收益尚未验证。',
  nextStep:'请复核这段时间的实验或任务变化。优先检查上述增长项；有明确原因后再执行可恢复的修正，不因统计变动直接删上下文或重跑任务。',
  limitations:'这是异常线索，不是因果结论。未标记实验可能仍混入；任务复杂度未完全配对。只统计已完成且有相应回执的请求，失败与未完成需另查。',
  diagnosedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
}
export function metricRecovered(item,samples,now=Date.now()) {
 const rows=samples.filter(s=>!s.background&&s.state==='completed'&&(item.comparisonType==='population'?s.firstSessionRun===item.firstSessionRun:metricCohort(s)===item.cohort)&&s.responseAt<=now&&s.responseAt>item.lastAnomalyAt&&s.responseAt>=now-DAY&&finite(s.metrics[item.metric]));
 const seen=new Set();const distinct=rows.filter(s=>!seen.has(s.runId)&&seen.add(s.runId));
 return distinct.length>=10&&unique(distinct)>=3&&(item.comparisonType==='population'?mean(distinct.map(s=>s.metrics[item.metric])):median(bySession(distinct,item.metric)))<=item.baseline*1.15;
}
export function metricCoverage(comparisons,coverage) {
 return {source:coverage,comparisons:comparisons.map(({rows,baselineRows,...value})=>value),
  semantics:'30%为人工核查线，不是已证实故障；同模型/档位/入口/首轮及实验分组，最近24小时对此前3个有样本日（最多回看14天），会话等权，不比较日总量。'};
}

// Also expose a sustained rise in the population's per-request cost. A changed
// task/experiment mix is an explanation to review, not a reason to hide the rise.
export function populationTrendCandidates(samples,now=Date.now()) {
 const result=[],seen=new Set();
 const rows=samples.filter(s=>s.runId&&!seen.has(s.runId)&&seen.add(s.runId)&&!s.background&&s.state==='completed'
  &&finite(s.responseAt)&&s.responseAt<=now&&s.responseAt>=now-14*DAY);
 for(const first of [true,false])for(const metric of Object.keys(metricLabels)){
  const selected=rows.filter(s=>s.firstSessionRun===first&&finite(s.metrics[metric]));
  const dates=[...new Set(selected.map(s=>day(s.responseAt)))].sort((a,b)=>b-a).slice(0,4).reverse();
  if(dates.length<4 || dates.at(-1)!==day(now))continue;
  const points=dates.map(date=>{const rs=selected.filter(s=>day(s.responseAt)===date);return {day:new Date(date*DAY).toISOString().slice(0,10),count:rs.length,sessions:unique(rs),
   mean:mean(rs.map(s=>s.metrics[metric])),median:median(bySession(rs,metric)),experimentCount:rs.filter(s=>s.experiment&&s.experiment!=='unmarked').length,rows:rs};});
  if(points.some(p=>p.count<10||p.sessions<5))continue;
  if(!points.every((p,i)=>i===0||p.mean>points[i-1].mean)||points.at(-1).mean<points[0].mean*1.3
    ||points.at(-1).mean-points[0].mean<floors[metric]||points.at(-1).median<points[0].median*1.15)continue;
  const current=points.at(-1),baseline=points[0],ratio=current.mean/baseline.mean;
  const mixed=current.experimentCount/current.count-baseline.experimentCount/baseline.count;
  const sourceGrowth=metric==='injectionChars' ? [...new Set(current.rows.flatMap(s=>(s.sources||[]).map(x=>x.id)))].map(id=>{
   const avg=rs=>mean(rs.map(s=>s.sources?.find(x=>x.id===id)?.chars||0));
   return {name:current.rows.flatMap(s=>s.sources||[]).find(x=>x.id===id)?.name||id,delta:avg(current.rows)-avg(baseline.rows)};
  }).filter(x=>x.delta>0).sort((a,b)=>b.delta-a.delta).slice(0,3) : [];
  const key=diagnosisKey(['population-trend',metric,first]);
  result.push({key,kind:'metric',metric,cohort:null,firstSessionRun:first,comparisonType:'population',model:'mixed',tool:'mixed',confidence:'composition_review',
   fingerprint:diagnosisKey(current.rows.map(s=>[s.runId,s.metrics[metric]]).sort()),members:[...new Set(current.rows.map(s=>s.sessionId))].slice(0,100).map(sessionId=>({sessionId})),
   baseline:baseline.mean,ratio,lastAnomalyAt:Math.max(...current.rows.map(s=>s.responseAt)),status:'review_required',
   trigger:`${first?'首次执行':'后续执行'}的单次${metricLabels[metric]}连续4个有样本日上升，累计超过30%。`,
   summary:`${format(metric,baseline.mean)} → ${format(metric,current.mean)}，上升${((ratio-1)*100).toFixed(1)}%；今天尚未结束。`,
   action:'已核对逐次均值、会话中位数、各日样本数和实验构成；这不是日总用量增加。',
   verification:`实验标记样本占比变化${(mixed*100).toFixed(1)}个百分点。${Math.abs(mixed)>.1?'组成变化明显，不能把全部增长归因于同类任务退化。':'仍需核对模型与任务构成。'}`,
   evidence:[...points.map(p=>`${p.day}：${format(metric,p.mean)}；${p.count}次、${p.sessions}个会话，实验标记${p.experimentCount}次。`),...(sourceGrowth.length?['构成增长线索：'+sourceGrowth.map(x=>`${x.name}平均增加${Math.round(x.delta)}字符`).join('；')+'。样本组成不同，不能据此证明某项规则自身变长。']:[])],
   nextStep:'需要复核增长是否符合实验预算和任务变化；对照同模型、同档位、同实验组的分析后决定可执行修正。',
   limitations:'样本构成趋势与同类任务退化分别报告；实验标记不覆盖所有人工试验，短期相关不代表原因。',diagnosedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()});
 }
 return result;
}

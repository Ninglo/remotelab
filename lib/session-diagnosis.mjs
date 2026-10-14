import { createHash } from 'node:crypto';

const median = values => { const a = values.slice().sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : null; };
const finite = n => Number.isFinite(n) && n >= 0;
export const diagnosisKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export const diagnosisStages = { prepareMs: '准备（含排队）', launchMs: '启动' };

// A statistical clue is not a request for human intervention. Resource repairs
// already own their delivery route. Private alerts concern current continuity
// failures only; routine actions remain inspectable in the local ledger.
export function privateDiagnosisDecision(item) {
  if(item.riskType !== 'exhausted_bindings') return {eligible:false,reason:item.metric==='recovery'?'resource_route':'observation_only'};
  const reason=item.notificationReason;
  if(item.status==='resolved')return {eligible:false,reason:'resolved'};
  return {eligible:['switch_disabled','no_available_backup'].includes(reason) && !!item.humanAction?.summary,
    reason:reason || 'insufficient_evidence'};
}

export function privateDiagnosisNotification(item,{fresh=false,baseline=false}={}) {
  const decision=privateDiagnosisDecision(item);
  const semantic=diagnosisKey([decision.reason,item.status==='resolved',decision.eligible?item.humanAction:null]);
  const previous=item.notification || {};
  const next={...previous,policy:'risk_only',reason:decision.reason,semantic};
  if(baseline)next.baselineSemantic=semantic;
  if(!fresh || !decision.eligible)next.confirmations=0;
  else if(previous.semantic!==semantic)next.confirmations=1;
  else if(previous.evidenceKey!==item.notificationEvidenceKey)next.confirmations=(previous.confirmations||0)+1;
  next.evidenceKey=item.notificationEvidenceKey;
  const closure=previous.sentSemantic && (decision.reason==='resolved' || fresh && decision.reason==='automatic_continuation');
  next.ready=!!((decision.eligible && next.confirmations>=3 || closure)
    && semantic!==next.baselineSemantic && semantic!==previous.sentSemantic);
  return next;
}

// Numeric projections only. No prompt, conversation text or tool output is collected.
export function diagnosisMeasurements(samples, now = Date.now()) {
  const groups = new Map(), seen = new Set(), result = [];
  for (const s of samples) {
    if (!s.runId || seen.has(s.runId) || s.background || !finite(s.at) || s.at > now + 5000) continue;
    seen.add(s.runId);
    const key = JSON.stringify([s.model, s.tool]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const cohort of groups.values()) {
    cohort.sort((a,b) => b.at-a.at);
    for (const metric of Object.keys(diagnosisStages)) {
      // Keep the three newest runs disjoint from the baseline, even if fields are missing.
      const recent = cohort.slice(0,3).filter(s => finite(s.metrics[metric]));
      const baseline = cohort.slice(3,23).filter(s => finite(s.metrics[metric]) && now-s.at <= 7*86400000);
      if (baseline.length < 10 || !recent.length) continue;
      const normal = median(baseline.map(s => s.metrics[metric]));
      const threshold = Math.max(15000, normal*3);
      result.push({ metric, model:cohort[0].model, tool:cohort[0].tool, baseline:normal, baselineCount:baseline.length, threshold,
        recent:recent.map(s => ({ runId:s.runId, at:s.at, value:s.metrics[metric], state:s.state || 'unknown' })) });
    }
  }
  return result;
}

export function sessionDiagnosisCandidates(rows, now = Date.now()) {
  const groups = new Map();
  for (const row of rows) {
    if (row.archived) continue;
    for (const m of row.diagnosisMeasurements || []) {
      const fresh = m.recent.filter(s => now-s.at <= 30*60000 && s.at <= now+5000);
      const sustained = fresh.length === 3 && fresh.every(s => s.value >= m.threshold);
      const latest = fresh[0];
      if (!sustained && !(latest && now-latest.at <= 10*60000 && latest.value >= m.threshold)) continue;
      const key = diagnosisKey([m.metric,m.model,m.tool]);
      if (!groups.has(key)) groups.set(key,{key,metric:m.metric,model:m.model,tool:m.tool,members:[]});
      groups.get(key).members.push({sessionId:row.sessionId,sustained,...m});
    }
  }
  return [...groups.values()].filter(g => g.members.some(m => m.sustained) || g.members.length >= 3)
    .map(g => ({...g, fingerprint:diagnosisKey(g.members.map(m => [m.sessionId,m.recent.map(r => r.runId)]).sort()),
      shared:g.members.length >= 3, members:g.members.slice(0,20)}));
}

export function diagnoseSessionCandidate(candidate, snapshot = {}) {
  const suspects = [], evidence = [];
  const failed = (snapshot.services || []).filter(s => s.status === 'failed');
  const disks = (snapshot.disks || []).filter(s => s.status === 'critical');
  if (failed.length) suspects.push('同时观测到受监管服务失败，需核对它与该阶段的依赖关系');
  if (disks.length) suspects.push('同时观测到磁盘空间紧张，可能影响准备或启动');
  if ((snapshot.attention || []).some(s => s.kind === 'accountContinuity')) suspects.push('账号连续性存在风险，需核对启动时是否等待可用账号');
  evidence.push(`${candidate.members.length} 个会话的${diagnosisStages[candidate.metric]}耗时达到巡检门槛`);
  const recent = candidate.members.flatMap(m => m.recent);
  evidence.push(`最近样本中位数 ${(median(recent.map(r => r.value))/1000).toFixed(1)} 秒；已按独立执行去重`);
  return { status:'observing', summary:suspects[0] || `已定位到${diagnosisStages[candidate.metric]}阶段变慢，现有记录不足以确认根因`,
    evidence, suspects, nextStep:'无需你操作；等待新的执行样本复核。尚未自动修改服务或任务。',
    limitations:'排队与准备内部步骤尚无完整分段；资源同时异常只是线索，不是因果结论。',
    relatedRecovery:(snapshot.recovery || []).filter(r => ['service','disk'].includes(r.kind) && !['resolved','cancelled'].includes(r.status))
      .slice(0,5).map(r => ({kind:r.kind,status:r.status,sessionId:r.sessionId})) };
}

export function diagnosisRecovered(incident, rows, now = Date.now()) {
  return incident.members.every(member => {
    const row = rows.find(s => s.sessionId === member.sessionId);
    const m = row?.diagnosisMeasurements?.find(x => x.metric === incident.metric && x.model === incident.model && x.tool === incident.tool);
    // No samples, missing fields or idle traffic cannot establish recovery.
    return m?.recent.length === 3 && m.recent.every(r => r.at > incident.lastAnomalyAt && now-r.at <= 30*60000
      && r.state === 'completed' && r.value < member.threshold*0.8);
  });
}

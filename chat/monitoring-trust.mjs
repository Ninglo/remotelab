import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { readSessionAccount } from '../lib/codex-session-routing.mjs';
import { subscriptionAvailability } from '../lib/codex-accounts.mjs';
import { diagnosisKey } from '../lib/session-diagnosis.mjs';
const DAY=86400000;
export async function readTrustAccounts(samples,configDir=CONFIG_DIR,now=Date.now(),trackedSessions=[]) {
 const runtime=await readRecord(join(configDir,'codex-accounts','accounts.json'));
 if(!runtime)return {runtime:null,bindings:[]};
 const ids=[...new Set([...trackedSessions,...samples.filter(s=>!s.background&&s.responseAt>=now-DAY).map(s=>s.sessionId)])].slice(0,1000);
 const bindings=[];
 for(let i=0;i<ids.length;i+=16)bindings.push(...await Promise.all(ids.slice(i,i+16).map(id=>readSessionAccount(join(configDir,'codex-accounts'),id))));
 return {runtime,bindings:bindings.filter(Boolean)};
}
export function trustCandidates({runtime,bindings=[]},snapshot={},samples=[],now=Date.now()) {
 const results=[],accounts=runtime?.accounts||[],label=id=>accounts.find(a=>a.id===id)?.label || '已登录账号';
 const atRisk=bindings.filter(b=>{const a=accounts.find(a=>a.id===b.accountId);return a&&(a.blockedUntil>now||subscriptionAvailability(a.usage,'',now)==='exhausted');});
 const events=runtime?.switchEvents?.length?runtime.switchEvents:runtime?.lastSwitch?[{...runtime.lastSwitch,kind:'default'}]:[];
 for(const event of events.filter(e=>Date.parse(e.at)>=now-DAY && Date.parse(e.at)<=now)) {
  const target=accounts.find(a=>a.id===event.to);
  const bound=event.sessionId?bindings.find(b=>b.sessionId===event.sessionId)?.accountId===event.to:runtime.activeId===event.to;
  const used=samples.some(s=>s.accountId===event.to&&(!event.sessionId||s.sessionId===event.sessionId)&&s.responseAt>=Date.parse(event.at)&&s.state==='completed');
  const id=diagnosisKey(['account-switch',event]);
  results.push({key:id,kind:'lifecycle',metric:'account',members:event.sessionId?[{sessionId:event.sessionId}]:[],fingerprint:diagnosisKey([id,bound,used,atRisk.length]),
   status:bound?'action_verified':'observing',summary:`${label(event.from)} → ${label(event.to)}；${bound?'切换记录与当前选择一致':'当前选择已变化，不能据旧记录确认仍使用此账号'}。`,
   trigger:`${event.reason==='reserve'||event.remainingPercent>0?'低额度预警':'额度耗尽预警'}已触发，原账号剩余${event.remainingPercent ?? '未知'}%。`,
   action:`已执行${event.sessionId?'会话账号迁移':'默认账号切换'}。`,
   verification:`${used?'已观测到目标账号随后成功完成执行。':'尚无目标账号后续成功执行样本，不把切换记录当作任务成功。'} 最近使用的会话中仍有${atRisk.length}个绑定耗尽账号。`,
   evidence:[`触发时间：${event.at}`,`切换范围：${event.sessionId?'单个会话':'未绑定执行的默认账号；不代表全部会话迁移'}`],
   nextStep:atRisk.length?'继续核查旧绑定；启用自动切换时在下一轮启动前迁移，有在途执行时等待其结束。':'无需额外操作；保留本次预警与处置回执。'});
 }
 if(atRisk.length){
  const key=diagnosisKey(['exhausted-bindings']);
  results.push({key,kind:'lifecycle',metric:'account',riskType:'exhausted_bindings',status:'review_required',members:atRisk.slice(0,100).map(b=>({sessionId:b.sessionId})),
   fingerprint:diagnosisKey(atRisk.map(b=>b.sessionId).sort()),summary:`最近使用的${atRisk.length}个会话仍绑定额度耗尽账号。`,
   trigger:'按会话实际绑定核对后发现额度耗尽，不再只检查默认账号。',
   action:'已核对本实例绑定与额度；没有重放旧请求或打断正在执行的任务。',
   verification:'部分会话可能已空闲；绑定耗尽不等于每个会话都发生执行失败。',
   evidence:[],nextStep:runtime.autoSwitch?'后续请求在无在途执行且有新鲜可用备用时自动迁移；无备用则明确提示。':'自动切换未启用，需决定是否使用本实例已登录备用账号。'});
 }
 const latestRecovery=new Map();
 for(const r of snapshot.recovery||[]) {
  const resource=r.kind+':'+(r.id||r.key),previous=latestRecovery.get(resource);
  if(!previous || String(r.createdAt||r.updatedAt)>String(previous.createdAt||previous.updatedAt))latestRecovery.set(resource,r);
 }
 for(const r of latestRecovery.values()){
  if(!r.evidence?.length||!['resolved','blocked','awaiting_confirmation'].includes(r.status)||Date.parse(r.updatedAt)<now-DAY)continue;
  const key=diagnosisKey(['recovery-result',r.key||r.id,r.originRunId||r.sessionId]);
  const observedOnly=r.status==='resolved' && !(Array.isArray(r.attempts)?r.attempts.length:r.attempts);
  if(observedOnly)continue; // Passive health recovery is not an executed repair receipt.
  results.push({key,kind:'lifecycle',metric:'recovery',members:r.sessionId?[{sessionId:r.sessionId}]:[],
   fingerprint:diagnosisKey([r.status,r.summary,r.evidence]),status:r.status==='resolved'?'action_verified':'review_required',
   summary:r.summary||r.reason,trigger:`${r.subject||r.kind}预警已触发。`,action:r.status==='resolved'?'补救记录已验收，实际执行内容见摘要及回执。':'已完成当前可做的排查，仍有未解决条件。',
   verification:r.status==='resolved'?'补救台账已有验收证据；具体业务范围以回执为准。':'尚未验证恢复。',
   evidence:r.evidence.slice(0,3),nextStep:r.humanAction?.summary||r.reason||'无需操作；保留处理结果。'});
 }
 return results;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { diagnosisKey, diagnosisStages, sessionDiagnosisCandidates, diagnoseSessionCandidate, diagnosisRecovered } from '../lib/session-diagnosis.mjs';
import { acquireProviderRuntimeLease } from './provider-runtime-queue.mjs';
import { createSessionMonitoringReader } from './monitoring-sessions.mjs';
import { metricComparisons, metricCandidate, metricRecovered, metricCoverage, metricLabels, populationTrendCandidates } from '../lib/metric-diagnosis.mjs';
import { subscriptionAvailability } from '../lib/codex-accounts.mjs';
import { readTrustAccounts, trustCandidates } from './monitoring-trust.mjs';
import { monitoringIm } from './monitoring-alert-message.mjs';

export const SESSION_DIAGNOSIS_FILE = join(CONFIG_DIR, 'session-diagnostics.json');
const reader = createSessionMonitoringReader({includeInjection:false,maxReadBytes:64*1024*1024,getPeople:async()=>[]});
const metricReaderOptions={includeSamples:true,maxRuns:10000,maxReadBytes:128*1024*1024,getPeople:async()=>[]};
const metricReader=createSessionMonitoringReader({...metricReaderOptions,projectionFile:join(CONFIG_DIR,'metric-projections-v2.json')});
const dryMetricReader=createSessionMonitoringReader(metricReaderOptions);
const cooldown = 30*60000;
const recipientKey = c => diagnosisKey([c.profile,c.configDir,c.feishuAppId,c.openId]);
export function validDiagnosisRecipient(c) {
  return c?.enabled === true && /^ou_[\w]+$/.test(c.openId || '') && /^[\w.-]+$/.test(c.profile || '')
    && /^cli_[\w]+$/.test(c.feishuAppId || '') && !c.chatId;
}
export function sessionDiagnosisCard(item, config) {
  const resolved = item.status === 'resolved';
  const name=metricLabels[item.metric] || diagnosisStages[item.metric] || (item.metric==='account'?'账号连续性':'预警处置');
  const content = `${item.test ? '链路测试，使用模拟样本，不代表真实故障。\n' : ''}${name}：${item.members.length} 个会话\n`
    + [item.trigger && `触发：${item.trigger}`,item.summary,item.action && `行动：${item.action}`,
      item.verification && `验证：${item.verification}`,...(item.evidence||[]).slice(0,4),item.limitations,item.nextStep].filter(Boolean).join('\n');
  let url;
  try { const u = new URL(config.overviewUrl); if (u.protocol === 'https:' || u.protocol === 'http:') url=u.href; } catch {}
  return { config:{wide_screen_mode:true,update_multi:true}, header:{title:{tag:'plain_text',content:`会话巡检${item.test?'测试':''} · ${resolved?'已恢复':item.status==='action_verified'?'已执行，已核对':item.status==='review_required'?'需要复核':'已排查，待复核'}`},template:resolved?'green':'blue'},
    elements:[{tag:'div',text:{tag:'plain_text',content}},
      ...(url ? [{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'打开监控器'},url,type:'default'}]}] : [])] };
}

// Private-only transport. Never inherit the general monitoring group recipient.
export async function deliverSessionDiagnosis(item, config, execute = promisify(execFile), api = monitoringIm) {
  if (!validDiagnosisRecipient(config)) throw new Error('PRIVATE_RECIPIENT_REQUIRED');
  if (item.delivery?.recipientKey && item.delivery.recipientKey !== recipientKey(config)) throw new Error('RECIPIENT_CHANGED');
  const card = sessionDiagnosisCard(item, config);
  if (item.delivery?.messageId) {
    const route = {...config,chatId:item.delivery.chatId};
    const path = `/open-apis/im/v1/messages/${item.delivery.messageId}`;
    const value = await api(route,'GET',path);
    const message = value.items?.find(m => m.message_id === item.delivery.messageId);
    if (!message || message.deleted || message.chat_id !== route.chatId || message.sender?.id !== config.feishuAppId
      || message.msg_type !== 'interactive') throw new Error('ORIGINAL_PRIVATE_MESSAGE_UNAVAILABLE');
    await api(route,'PATCH',path,{content:JSON.stringify(card)});
    return item.delivery;
  }
  const {stdout} = await execute('lark-cli',['--profile',config.profile,'im','+messages-send','--as','bot',
    '--user-id',config.openId,'--msg-type','interactive','--content',JSON.stringify(card),'--idempotency-key',item.id],
  {timeout:25000,maxBuffer:300000,env:{...process.env,...(config.configDir?{LARKSUITE_CLI_CONFIG_DIR:config.configDir}:{}),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}});
  const response=JSON.parse(stdout), data=response.data || response;
  if(response.ok === false || !/^om_[\w]+$/.test(data.message_id || '') || !/^oc_[\w]+$/.test(data.chat_id || '')) throw new Error('PRIVATE_SEND_UNCONFIRMED');
  return {messageId:data.message_id,chatId:data.chat_id,recipientKey:recipientKey(config)};
}

export async function readSessionDiagnostics(file = SESSION_DIAGNOSIS_FILE) {
  const state = await readRecord(file);
  return {checkedAt:state?.checkedAt || null, coverage:state?.coverage || null, metricCoverage:state?.metricCoverage || null,
    incidents:Object.values(state?.incidents || {}).map(i => ({id:i.id,metric:i.metric,status:i.status,summary:i.summary,
      nextStep:i.nextStep,trigger:i.trigger,action:i.action,verification:i.verification,evidence:i.evidence,suspects:i.suspects,limitations:i.limitations,relatedRecovery:i.relatedRecovery,
      sessionIds:i.members.map(m => m.sessionId),checkedAt:i.diagnosedAt,updatedAt:i.updatedAt,
      deliveryStatus:i.delivery?.status || 'disabled',test:i.test === true}))};
}

export async function processSessionDiagnostics({config = {},snapshot = {},dryRun = false,baseline = false,
  now = Date.now(),test = false,stateFile = SESSION_DIAGNOSIS_FILE,readSessions = reader,readMetrics = options => (options.dryRun ? dryMetricReader : metricReader)({days:14}), readAccounts = readTrustAccounts, deliver = deliverSessionDiagnosis} = {}) {
  if(config.enabled !== true || baseline) return {enabled:config.enabled === true,skipped:baseline?'baseline':'disabled'};
  const lease = dryRun ? null : await acquireProviderRuntimeLease({queueKey:'session-diagnostics',rootDir:join(dirname(stateFile),'diagnosis-locks'),wait:false});
  if(!dryRun && !lease) return {enabled:true,skipped:'busy'};
  try {
    const state = await readRecord(stateFile) || {incidents:{}};
    // Reuse the minute observer; detailed sample scans run at most every five minutes.
    if(!dryRun && now-Date.parse(state.checkedAt || '') < 5*60000) return {enabled:true,skipped:'interval'};
    const data = await readSessions({days:7});
    const candidates = sessionDiagnosisCandidates(data.sessions,now);
    const metrics=config.metricPolicy?.enabled === true ? await readMetrics({dryRun}) : {samples:[],coverage:{}};
    const comparisons=metricComparisons(metrics.samples || [],now);
    const complete=metrics.coverage?.truncated!==true && !(metrics.coverage?.limitedFiles>0) && !(metrics.coverage?.readErrors>0);
    const extras=complete ? [...populationTrendCandidates(metrics.samples || [],now),...comparisons.filter(c=>c.alarm).map(c=>metricCandidate(c,now))] : [];
    const tracked=Object.values(state.incidents).filter(i=>i.riskType==='exhausted_bindings'&&i.status!=='resolved').flatMap(i=>i.members.map(m=>m.sessionId));
    const accounts=config.reportActions === true ? await readAccounts(metrics.samples || [],undefined,now,tracked) : null;
    if(accounts) {
      const actions=trustCandidates(accounts,snapshot,metrics.samples || [],now);
      extras.unshift(...actions.filter(c=>c.metric==='account'));
      extras.push(...actions.filter(c=>c.metric!=='account'));
    }
    if(dryRun) return {enabled:true,dryRun:true,candidates:candidates.map(c => ({...c,...diagnoseSessionCandidate(c,snapshot)})),coverage:data.coverage,metrics:metricCoverage(comparisons,metrics.coverage),extraCandidates:extras};
    state.checkedAt = new Date(now).toISOString(); state.coverage = data.coverage;
    state.metricCoverage=metricCoverage(comparisons,metrics.coverage);
    let diagnosed=0, sent=0;
    for(const [id,item] of Object.entries(state.incidents))if(item.delivery?.status==='delivered' && ['resolved','action_verified'].includes(item.status) && now-Date.parse(item.updatedAt)>7*86400000)delete state.incidents[id];
    for(const c of candidates) {
      let item = Object.values(state.incidents).find(i => i.key === c.key && i.status !== 'resolved');
      const lastAnomalyAt = Math.max(...c.members.flatMap(m => m.recent.filter(r => r.value >= m.threshold).map(r => r.at)));
      if(item) {
        item.lastAnomalyAt=Math.max(item.lastAnomalyAt,lastAnomalyAt);
        if(item.fingerprint === c.fingerprint || now-Date.parse(item.diagnosedAt) < cooldown) continue;
      }
      if(diagnosed >= 1) continue;
      if(!item) {
        // A fixed bound protects disk and reader costs; never drop an unresolved incident to admit another.
        if(Object.keys(state.incidents).length >= 100) {
          const closed=Object.values(state.incidents).filter(i => i.status === 'resolved').sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
          if(!closed) break;
          delete state.incidents[closed.id];
        }
        item={id:diagnosisKey([c.key,c.fingerprint,now]),createdAt:state.checkedAt,test};
        state.incidents[item.id]=item;
      }
      Object.assign(item,c,diagnoseSessionCandidate(c,snapshot),{lastAnomalyAt,diagnosedAt:state.checkedAt,updatedAt:state.checkedAt});
      diagnosed++;
    }
    for(const candidate of extras) {
      let item=Object.values(state.incidents).find(i=>i.key===candidate.key && i.status!=='resolved');
      if(item?.fingerprint===candidate.fingerprint)continue;
      if(item && candidate.kind==='metric' && now-Date.parse(item.diagnosedAt)<cooldown)continue;
      if(!item) {
        if(Object.keys(state.incidents).length>=100)continue;
        item={id:diagnosisKey([candidate.key,now]),createdAt:state.checkedAt,test};state.incidents[item.id]=item;
      }
      const frozenBaseline=item.baseline;
      Object.assign(item,candidate,{diagnosedAt:state.checkedAt,updatedAt:state.checkedAt});
      if(frozenBaseline!=null)item.baseline=frozenBaseline;
      diagnosed++;
    }
    for(const item of Object.values(state.incidents)) {
      if(item.kind==='metric') {
        if(complete && item.status!=='resolved' && metricRecovered(item,metrics.samples || [],now))Object.assign(item,{status:'resolved',summary:'至少10次新执行、3个会话的指标已回到原基线15%以内。',verification:'新样本验证指标恢复；不能据此声称已证明根因或自动修复。',nextStep:'保留原预警及分析记录。',updatedAt:state.checkedAt});
        continue;
      }
      if(item.kind==='lifecycle') {
        if(item.riskType==='exhausted_bindings' && item.status!=='resolved' && accounts && item.members.length && item.members.every(m=>{
          const binding=accounts.bindings.find(b=>b.sessionId===m.sessionId),account=accounts.runtime?.accounts?.find(a=>a.id===binding?.accountId);
          return account && !(account.blockedUntil>now) && subscriptionAvailability(account.usage,'',now)==='available';
        }))Object.assign(item,{status:'resolved',summary:'原预警涉及的会话已逐一核对，绑定账号当前额度可用。',verification:'依据当前绑定和新鲜额度读数，不把账号可用当作业务任务完成。',updatedAt:state.checkedAt});
        continue;
      }
      if(item.status !== 'resolved' && diagnosisRecovered(item,data.sessions,now)) Object.assign(item,{
        status:'resolved',summary:'后续连续三次执行已成功，耗时回到门槛以下。',nextStep:'无需操作；没有把自然恢复记为补救成功。',updatedAt:state.checkedAt});
    }
    await writeDurableJson(stateFile,state);
    for(const item of Object.values(state.incidents)) {
      if(!validDiagnosisRecipient(config.notification) || sent >= (config.metricPolicy?.enabled || config.reportActions ? 3 : 1)) break;
      const version=diagnosisKey(sessionDiagnosisCard(item,config.notification));
      if(item.delivery?.version === version || ['sending','uncertain'].includes(item.delivery?.status)) continue;
      // Save intent before I/O. Uncertain sends/edits require readback, never a second card.
      item.delivery={...item.delivery,status:'sending',recipientKey:item.delivery?.recipientKey || recipientKey(config.notification)};
      await writeDurableJson(stateFile,state);
      try { item.delivery={...await deliver(item,config.notification),version,status:'delivered'}; }
      catch { item.delivery.status='uncertain'; }
      sent++;
      await writeDurableJson(stateFile,state);
    }
    return {enabled:true,diagnosed,notificationAttempts:sent,incidents:Object.keys(state.incidents).length,checkedAt:state.checkedAt};
  } finally { await lease?.release(); }
}

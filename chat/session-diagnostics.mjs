import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { diagnosisKey, diagnosisStages, sessionDiagnosisCandidates, diagnoseSessionCandidate, diagnosisRecovered } from '../lib/session-diagnosis.mjs';
import { acquireProviderRuntimeLease } from './provider-runtime-queue.mjs';
import { createSessionMonitoringReader } from './monitoring-sessions.mjs';
import { monitoringIm } from './monitoring-alert-message.mjs';

export const SESSION_DIAGNOSIS_FILE = join(CONFIG_DIR, 'session-diagnostics.json');
const reader = createSessionMonitoringReader({includeInjection:false,maxReadBytes:64*1024*1024,getPeople:async()=>[]});
const cooldown = 30*60000;
const recipientKey = c => diagnosisKey([c.profile,c.configDir,c.feishuAppId,c.openId]);
export function validDiagnosisRecipient(c) {
  return c?.enabled === true && /^ou_[\w]+$/.test(c.openId || '') && /^[\w.-]+$/.test(c.profile || '')
    && /^cli_[\w]+$/.test(c.feishuAppId || '') && !c.chatId;
}
export function sessionDiagnosisCard(item, config) {
  const resolved = item.status === 'resolved';
  const content = `${item.test ? '链路测试，使用模拟样本，不代表真实故障。\n' : ''}${diagnosisStages[item.metric]}：${item.members.length} 个会话\n`
    + `${item.summary}\n${item.nextStep}`;
  let url;
  try { const u = new URL(config.overviewUrl); if (u.protocol === 'https:' || u.protocol === 'http:') url=u.href; } catch {}
  return { config:{wide_screen_mode:true,update_multi:true}, header:{title:{tag:'plain_text',content:`会话巡检${item.test?'测试':''} · ${resolved?'已恢复':'已排查，待复核'}`},template:resolved?'green':'blue'},
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
  return {checkedAt:state?.checkedAt || null, coverage:state?.coverage || null,
    incidents:Object.values(state?.incidents || {}).map(i => ({id:i.id,metric:i.metric,status:i.status,summary:i.summary,
      nextStep:i.nextStep,evidence:i.evidence,suspects:i.suspects,limitations:i.limitations,relatedRecovery:i.relatedRecovery,
      sessionIds:i.members.map(m => m.sessionId),checkedAt:i.diagnosedAt,updatedAt:i.updatedAt,
      deliveryStatus:i.delivery?.status || 'disabled',test:i.test === true}))};
}

export async function processSessionDiagnostics({config = {},snapshot = {},dryRun = false,baseline = false,
  now = Date.now(),test = false,stateFile = SESSION_DIAGNOSIS_FILE,readSessions = reader,deliver = deliverSessionDiagnosis} = {}) {
  if(config.enabled !== true || baseline) return {enabled:config.enabled === true,skipped:baseline?'baseline':'disabled'};
  const lease = dryRun ? null : await acquireProviderRuntimeLease({queueKey:'session-diagnostics',rootDir:join(dirname(stateFile),'diagnosis-locks'),wait:false});
  if(!dryRun && !lease) return {enabled:true,skipped:'busy'};
  try {
    const state = await readRecord(stateFile) || {incidents:{}};
    // Reuse the minute observer; detailed sample scans run at most every five minutes.
    if(!dryRun && now-Date.parse(state.checkedAt || '') < 5*60000) return {enabled:true,skipped:'interval'};
    const data = await readSessions({days:7});
    const candidates = sessionDiagnosisCandidates(data.sessions,now);
    if(dryRun) return {enabled:true,dryRun:true,candidates:candidates.map(c => ({...c,...diagnoseSessionCandidate(c,snapshot)})),coverage:data.coverage};
    state.checkedAt = new Date(now).toISOString(); state.coverage = data.coverage;
    let diagnosed=0, sent=0;
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
    for(const item of Object.values(state.incidents)) {
      if(item.status !== 'resolved' && diagnosisRecovered(item,data.sessions,now)) Object.assign(item,{
        status:'resolved',summary:'后续连续三次执行已成功，耗时回到门槛以下。',nextStep:'无需操作；没有把自然恢复记为补救成功。',updatedAt:state.checkedAt});
    }
    await writeDurableJson(stateFile,state);
    for(const item of Object.values(state.incidents)) {
      if(!validDiagnosisRecipient(config.notification) || sent >= 1) break;
      const version=diagnosisKey([item.status,item.summary,item.nextStep]);
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

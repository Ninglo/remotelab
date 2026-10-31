import { metricAlertBundles, metricBundleCard } from '../lib/metric-alert-bundle.mjs';
import { ALERT_MERGE_MS, observePersistentAlert } from '../lib/alert-notification-policy.mjs';
import { buildAgentDashboard } from './monitoring-dashboard.mjs';
import { prepareAlertEvidenceImage } from '../lib/alert-evidence-image.mjs';
import { alertTime, appendAlertHistory, alertHistoryPanel, alertEvidenceImage, alertSessionUrl, resolutionAttribution } from '../lib/alert-card-history.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { diagnosisKey, diagnosisStages, sessionDiagnosisCandidates, diagnoseSessionCandidate, diagnosisRecovered, privateDiagnosisDecision, privateDiagnosisNotification } from '../lib/session-diagnosis.mjs';
import { acquireProviderRuntimeLease } from './provider-runtime-queue.mjs';
import { createSessionMonitoringReader } from './monitoring-sessions.mjs';
import { metricComparisons, metricCandidate, metricRecovered, metricCoverage, metricLabels, populationTrendCandidates } from '../lib/metric-diagnosis.mjs';
import { metricReferencePolicy } from '../lib/metric-reference.mjs';
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
  if(item.kind==='metric-bundle') return metricBundleCard(item,config);
  const resolved = item.status === 'resolved';
  const name = metricLabels[item.metric] || diagnosisStages[item.metric] || (item.metric === 'account' ? '账号无法自动接续' : '预警处置');
  const automatic = item.notificationReason === 'automatic_continuation';
  const accountRisk = config.noisePolicy?.mode === 'risk_only' && item.riskType === 'exhausted_bindings';
  const risk = item.notificationReason === 'switch_disabled' ? '有执行需求的会话绑定不可用账号，自动切换尚未开启。' : '有执行需求的会话绑定不可用账号，尚无已核实可用备用。';
  const trigger = accountRisk ? (item.originalAccountRisk || risk) : item.originalTrigger || item.trigger || item.evidence?.join('；') || `${item.members?.length || 0}个会话出现${name}异常`;
  const next = resolved ? '无需操作；指标恢复不代表原业务已完成。' : automatic ? '已有备用可自动接续，暂不需要操作。'
    : item.humanAction?.summary || item.nextStep || '暂不需要操作。';
  const content = `${item.test ? '链路测试，使用模拟样本，不代表真实故障。\n' : ''}`
    + `当前状态：${resolved ? '当前问题已解决' : item.status === 'action_verified' ? '已执行并核对，整体恢复待验证' : '已初步分析'}\n`
    + `上次预警：${alertTime(item.createdAt)}（北京时间）\n预警原因：${trigger}\n`
    + (!resolved && item.persistentWarningAt ? '持续告警：连续10分钟未见改善。\n' : '')
    + (resolved ? `处理方式：${resolutionAttribution(item)}\n处理结果：${item.summary || '指标已复查恢复'}\n确认时间：${alertTime(item.updatedAt)}\n`
      : `分析与处理：${accountRisk ? '已核对当前绑定、额度读数和执行需求；未重放任务。' : item.summary || '已核对记录，具体原因尚未确认'}${!accountRisk && item.action ? `；${item.action}` : ''}\n`)
    + (config.noisePolicy?.mode !== 'risk_only' ? `涉及会话：${item.members?.length || 0}个\n` : '')
    + (!accountRisk && item.verification ? `验证：${item.verification}\n` : '')
    + (item.kind==='metric' ? (item.evidence || []).filter(line=>line.includes('增长线索')).join('\n')+'\n' : '') + `需要你：${next}`;
  const sessionId = item.processingSessionId || item.relatedRecovery?.sessionId || item.sessionId;
  const url = alertSessionUrl(sessionId, config.overviewUrl);
  const sourceUrl = item.members?.length === 1 ? alertSessionUrl(item.members[0].sessionId, config.overviewUrl) : '';
  return { config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: `${name}${resolved ? ' · 已解决' : '异常'}${item.test ? ' · 测试' : ''}` },
      template: resolved || automatic ? 'green' : item.severity === 'critical' ? 'red' : 'orange' },
    elements: [...alertEvidenceImage(item), { tag: 'div', text: { tag: 'plain_text', content } },
      ...alertHistoryPanel(item.history || []),
      ...(url || sourceUrl ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text',
        content: url ? '查看原始处理对话' : '查看原始异常会话' }, url: url || sourceUrl, type: 'default' }] }] :
        config.overviewUrl ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看监管记录' }, url: config.overviewUrl, type: 'default' }] }] : [])] };
}

// Private-only transport. Never inherit the general monitoring group recipient.
export async function deliverSessionDiagnosis(item, config, execute = promisify(execFile), api = monitoringIm) {
  if (!validDiagnosisRecipient(config)) throw new Error('PRIVATE_RECIPIENT_REQUIRED');
  if (item.delivery?.recipientKey && item.delivery.recipientKey !== recipientKey(config)) throw new Error('RECIPIENT_CHANGED');
  await prepareAlertEvidenceImage(item, config);
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
    incidents:Object.values(state?.incidents || {}).map(i => ({id:i.id,metric:i.metric,status:i.status,summary:i.summary,resolutionType:i.resolutionType,comparisonType:i.comparisonType,
      nextStep:i.nextStep,trigger:i.trigger,action:i.action,verification:i.verification,evidence:i.evidence,suspects:i.suspects,limitations:i.limitations,relatedRecovery:i.relatedRecovery,
      sessionIds:i.members.map(m => m.sessionId),checkedAt:i.diagnosedAt,updatedAt:i.updatedAt,
      deliveryStatus:Object.values(state?.metricNotifications || {}).find(g=>g.memberIds?.includes(i.id))?.delivery?.status || i.delivery?.status || 'disabled',notificationReason:i.notification?.reason,test:i.test === true}))};
}

export async function processSessionDiagnostics({config = {},snapshot = {},dryRun = false,baseline = false,
  now = Date.now(),test = false,stateFile = SESSION_DIAGNOSIS_FILE,readSessions = reader,readMetrics = options => (options.dryRun ? dryMetricReader : metricReader)({days:14}), readAccounts = readTrustAccounts, deliver = deliverSessionDiagnosis} = {}) {
  if(config.enabled !== true || baseline) return {enabled:config.enabled === true,skipped:baseline?'baseline':'disabled'};
  const lease = dryRun ? null : await acquireProviderRuntimeLease({queueKey:'session-diagnostics',rootDir:join(dirname(stateFile),'diagnosis-locks'),wait:false});
  if(!dryRun && !lease) return {enabled:true,skipped:'busy'};
  try {
    const state = await readRecord(stateFile) || {incidents:{}};
    const riskOnly=config.notification?.noisePolicy?.mode==='risk_only';
    const metricAlerts=config.metricPolicy?.enabled===true && config.metricPolicy?.notifyOnRegression===true;
    const baselineIds=new Set(riskOnly && state.privateNotificationPolicy!==1?Object.keys(state.incidents):[]);
    // Reuse the minute observer; detailed sample scans run at most every five minutes.
    if(!dryRun && now-Date.parse(state.checkedAt || '') < 5*60000) return {enabled:true,skipped:'interval'};
    const data = await readSessions({days:7});
    const candidates = sessionDiagnosisCandidates(data.sessions,now);
    const metrics=config.metricPolicy?.enabled === true ? await readMetrics({dryRun}) : {samples:[],coverage:{}};
    const metricPolicy=config.metricPolicy || {},baselinePolicyKey=diagnosisKey(metricReferencePolicy(metricPolicy));
    const comparisons=metricComparisons(metrics.samples || [],now,metricPolicy);
    const complete=metrics.coverage?.truncated!==true && !(metrics.coverage?.limitedFiles>0) && !(metrics.coverage?.readErrors>0);
    const populations=complete?populationTrendCandidates(metrics.samples || [],now,{...metricPolicy,includeObservations:true}):[];
    const extras=complete ? [...populations.filter(c=>c.alarm),...comparisons.filter(c=>c.alarm).map(c=>metricCandidate(c,now))] : [];
    const tracked=Object.values(state.incidents).filter(i=>i.riskType==='exhausted_bindings'&&i.status!=='resolved').flatMap(i=>i.members.map(m=>m.sessionId));
    const accounts=config.reportActions === true ? await readAccounts(metrics.samples || [],undefined,now,tracked) : null;
    if(accounts) {
      const actions=trustCandidates(accounts,snapshot,metrics.samples || [],now,{riskOnly});
      extras.unshift(...actions.filter(c=>c.metric==='account'));
      extras.push(...actions.filter(c=>c.metric!=='account'));
    }
    if(riskOnly && !metricAlerts)for(const item of extras)if(item.kind==='metric') {
      item.status='observing';
      item.nextStep='先核对任务构成、增长来源及真实执行影响；当前只保留诊断线索，无需你操作。';
    }
    if(riskOnly && !complete)for(const item of extras)if(item.riskType==='exhausted_bindings') {
      item.notificationReason='collection_incomplete';item.humanAction=null;item.status='observing';
      item.nextStep='当前采集有缺口，不能据此判断没有执行需求；先补齐证据，不要求你处理旧绑定。';
      item.fingerprint=diagnosisKey([item.fingerprint,'collection_incomplete']);
    }
    if(dryRun) return {enabled:true,dryRun:true,candidates:candidates.map(c => ({...c,...diagnoseSessionCandidate(c,snapshot)})),coverage:data.coverage,metrics:metricCoverage(comparisons,metrics.coverage),extraCandidates:extras,
      ...(riskOnly?{notificationPreview:extras.map(item=>({key:item.key,...privateDiagnosisDecision(item,{metricAlerts}),requiresDistinctObservations:metricAlerts && item.kind==='metric'?1:3})),note:'仅展示候选资格；实际通知还受持续证据、历史基线、既有回执和暂停开关限制。'}:{})};
    state.checkedAt = new Date(now).toISOString(); state.coverage = data.coverage;
    state.metricCoverage=metricCoverage(comparisons,metrics.coverage);
    let diagnosed=0, sent=0;
    // A changed reference definition invalidates the old statistical comparison,
    // not the original evidence. Recheck on complete, supported observations;
    // never describe a baseline correction as a performance recovery.
    if(complete)for(const item of Object.values(state.incidents)) {
      if(item.kind!=='metric' || item.status==='resolved'&&item.resolutionType!=='baseline_recalibrated' || item.baselinePolicyKey===baselinePolicyKey)continue;
      const excludedLow=item.comparisonType==='rebound'&&metricReferencePolicy(metricPolicy).excludedDates.includes(item.referenceDate);
      const c=item.comparisonType==='population'?populations.find(c=>c.key===item.key):comparisons.find(c=>c.metric===item.metric&&c.cohort===item.cohort
        &&(excludedLow?!c.comparisonType:c.comparisonType===item.comparisonType&&c.referenceDate===item.referenceDate));
      if(!c || c.confidence==='baseline_insufficient' || !c.currentCount)continue;
      const revision={at:state.checkedAt,baseline:item.baseline,ratio:item.ratio,summary:item.summary,evidence:item.evidence,baselinePolicyKey:item.baselinePolicyKey || 'legacy'};
      (item.baselineRevisions ||= []).push(revision);
      if(!excludedLow)Object.assign(item,item.comparisonType==='population'?c:metricCandidate(c,now));
      Object.assign(item,{baselinePolicyKey,recoveryBaseline:c.baseline,diagnosedAt:state.checkedAt,updatedAt:state.checkedAt});
      delete item.resolutionType;
      if(excludedLow || !c.alarm)Object.assign(item,{status:'resolved',resolutionType:'baseline_recalibrated',
        summary:`原比较基准已更正；新参考 ${c.baseline.toFixed(1)} → 当前 ${c.current.toFixed(1)}，变化 ${((c.ratio-1)*100).toFixed(1)}%，未满足预警条件。`,
        verification:'按完整日期、样本支持与已确认休息日重新核查；这是预警依据更正，不代表性能恢复。',nextStep:'保留原始预警与更正记录。'});
      if(excludedLow)item.summary='原低位来自已排除的休息日；原反弹比较依据撤回，不能据此认定优化失效。';
    }
    for(const [id,item] of Object.entries(state.incidents))if(item.delivery?.status==='delivered' && ['resolved','action_verified'].includes(item.status) && now-Date.parse(item.updatedAt)>7*86400000)delete state.incidents[id];
    for(const c of candidates) {
      let item = Object.values(state.incidents).find(i => i.key === c.key
        && (i.status !== 'resolved' || now - Date.parse(i.createdAt) < ALERT_MERGE_MS));
      const lastAnomalyAt = Math.max(...c.members.flatMap(m => m.recent.filter(r => r.value >= m.threshold).map(r => r.at)));
      if(item) {
        item.lastAnomalyAt=Math.max(item.lastAnomalyAt,lastAnomalyAt);
        if(item.status !== 'resolved' && (item.fingerprint === c.fingerprint || now-Date.parse(item.diagnosedAt) < cooldown)) continue;
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
      let item=Object.values(state.incidents).find(i=>i.key===candidate.key
        && (i.status!=='resolved' || now-Date.parse(i.createdAt)<ALERT_MERGE_MS));
      if (item?.status === 'resolved') {
        item.persistence = { since: state.checkedAt }; delete item.persistentWarningAt;
        appendAlertHistory(item, { at: state.checkedAt, label: '三小时内再次预警', summary: candidate.summary });
      }
      if(item && riskOnly && candidate.kind==='metric')Object.assign(item,{status:candidate.status,nextStep:candidate.nextStep});
      // Fresh evidence must advance even when the human-readable conclusion is
      // unchanged. Repeated reads of one quota sample never confirm an alert.
      if(item && riskOnly && candidate.riskType==='exhausted_bindings')item.notificationEvidenceKey=candidate.notificationEvidenceKey;
      if(item?.fingerprint===candidate.fingerprint && item.status!=='resolved')continue;
      if(item && item.status!=='resolved' && candidate.kind==='metric' && item.baselinePolicyKey===candidate.baselinePolicyKey && now-Date.parse(item.diagnosedAt)<cooldown)continue;
      if(!item) {
        if(Object.keys(state.incidents).length>=100)continue;
        item={id:diagnosisKey([candidate.key,now]),createdAt:state.checkedAt,test};state.incidents[item.id]=item;
      }
      const recoveryBaseline=item.recoveryBaseline ?? item.baseline;
      Object.assign(item,candidate,{diagnosedAt:state.checkedAt,updatedAt:state.checkedAt});
      if(recoveryBaseline!=null)item.recoveryBaseline=recoveryBaseline;
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
    for (const item of Object.values(state.incidents)) {
      item.originalTrigger ||= item.trigger || item.evidence?.join('；') || `${item.members?.length || 0}个会话出现指标异常`;
      if (!item.history?.length) appendAlertHistory(item, { at: item.createdAt, label: '触发预警', summary: item.originalTrigger });
      appendAlertHistory(item, { at: item.updatedAt, label: item.resolutionType==='baseline_recalibrated'?'更正比较基准':item.status === 'resolved' ? '复查确认恢复' : '分析与处理',
        summary: [item.summary, item.action, item.verification, item.limitations].filter(Boolean).join('；'), status: item.status });
    }
    if(riskOnly) {
      const freshKeys=new Set(complete?extras.map(i=>i.key):[]);
      for(const item of Object.values(state.incidents))item.notification=privateDiagnosisNotification(item,{fresh:freshKeys.has(item.key),metricAlerts,baseline:((!metricAlerts || item.kind!=='metric') && baselineIds.has(item.id))||!validDiagnosisRecipient(config.notification)});
      state.privateNotificationPolicy=1;
    }
    if(!riskOnly && metricAlerts) {
      const freshKeys=new Set(complete?extras.map(i=>i.key):[]);
      for(const item of Object.values(state.incidents).filter(i=>i.kind==='metric')) item.notification=privateDiagnosisNotification(item,{fresh:freshKeys.has(item.key),metricAlerts,baseline:!validDiagnosisRecipient(config.notification)});
    }
    for (const item of Object.values(state.incidents)) {
      const delivered = item.delivery?.messageId || Object.values(state.metricNotifications || {})
        .find(group => group.memberIds.includes(item.id))?.delivery?.messageId;
      if (!delivered) continue;
      const before = item.persistentWarningAt;
      const notifiedAt = item.firstNotifiedAt || item.delivery?.sentAt || item.createdAt;
      const signal = extras.find(c => c.key === item.key) || item;
      const newMetricSample = signal.lastAnomalyAt > Date.parse(notifiedAt) && signal.lastAnomalyAt <= now;
      const fresh = complete && (item.status === 'resolved' || (item.kind === 'metric'
        ? newMetricSample && extras.some(c => c.key === item.key && c.alarm !== false)
        : [...candidates, ...extras].some(c => c.key === item.key)));
      observePersistentAlert(item, { ...signal, recovered: item.status === 'resolved' },
        { now, since: notifiedAt, fresh });
      if (item.persistentWarningAt !== before && item.notification) item.notification.ready = true;
    }
    await writeDurableJson(stateFile,state);
    const bundles = metricAlerts && validDiagnosisRecipient(config.notification) ? metricAlertBundles(state,config.notification,now) : [];
    const deliveries = [...bundles,...Object.values(state.incidents).filter(i=>!metricAlerts || i.kind!=='metric')];
    for(const item of deliveries) {
      if(!validDiagnosisRecipient(config.notification) || sent >= (config.metricPolicy?.enabled || config.reportActions ? 3 : 1)) break;
      if(riskOnly && item.kind!=='metric-bundle' && !item.notification?.ready)continue;
      const version=diagnosisKey(sessionDiagnosisCard({...item,evidenceImage:null},config.notification));
      if(item.delivery?.version === version || ['sending','uncertain'].includes(item.delivery?.status)) continue;
      if(item.kind==='metric-bundle' && complete) {
        const dashboard=buildAgentDashboard({},metrics.samples || [],now,metrics.coverage || {});
        item.metricChart={generatedAt:dashboard.generatedAt,days:dashboard.days,today:dashboard.today};
      }
      // Save intent before I/O. Uncertain sends/edits require readback, never a second card.
      item.delivery={...item.delivery,status:'sending',recipientKey:item.delivery?.recipientKey || recipientKey(config.notification)};
      await writeDurableJson(stateFile,state);
      try {
        item.delivery={...await deliver(item,config.notification),sentAt:item.delivery?.sentAt || state.checkedAt,version,status:'delivered'};
        item.firstNotifiedAt ||= state.checkedAt;
        if(item.kind==='metric-bundle') {
          item.migration=false;
          for(const id of item.memberIds) {
            const member=state.incidents[id];
            if(member?.notification?.ready) {
              member.firstNotifiedAt ||= state.checkedAt;
              member.notification={...member.notification,sentSemantic:member.notification.semantic,sentRatio:member.ratio,sentLevel:member.notification.level,ready:false};
            }
          }
        }
        else if(riskOnly)item.notification={...item.notification,sentSemantic:item.notification.semantic,...(item.kind==='metric'?{sentRatio:item.ratio,sentLevel:item.notification.level}:{}),ready:false};
      }
      catch { item.delivery.status='uncertain'; }
      sent++;
      await writeDurableJson(stateFile,state);
    }
    return {enabled:true,diagnosed,notificationAttempts:sent,incidents:Object.keys(state.incidents).length,checkedAt:state.checkedAt};
  } finally { await lease?.release(); }
}

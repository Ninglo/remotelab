import { businessStart, BUSINESS_OFFSET, DAY, injectionSources, buildAgentDashboard, readContextDocuments } from './monitoring-dashboard.mjs';
import { projectResponseTiming, timingStats, summarizeResponseTiming } from './response-timing.mjs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR, CHAT_RUNS_DIR, CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import { listPeopleForClient } from '../lib/auth.mjs';
import { queryUsageLedger } from './usage-ledger.mjs';
import { currentExperiment } from './feature-experiment-store.mjs';
import { diagnosisMeasurements } from '../lib/session-diagnosis.mjs';

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value);
const key = (a, b) => createHash('sha256').update(JSON.stringify([a, b])).digest('hex').slice(0, 24);
const time = value => value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
const span = (a, b) => Number.isFinite(time(a)) && Number.isFinite(time(b)) && time(b) >= time(a) ? time(b) - time(a) : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const label = value => typeof value === 'string' ? value.slice(0, 180) : '';

export function sessionOwnership(session, people) {
  const person = people.find(p => p.identities?.some(i => i.id === session.initiatedByIdentityId));
  const source = session.sourceContext || {}, conversation = session.conversation || {};
  // Canonical delivery binding wins. Never use per-person sidebar grouping as a chat.
  const target = conversation.target || {}, chatId = target.chatId || source.chatId;
  const tenant = target.tenantKey || source.tenantKey || conversation.sourceRouteId || source.sourceRouteId || 'unknown';
  const connector = conversation.connector || source.connector;
  const chatType = target.chatType || source.chatType;
  const isGroup = connector === 'feishu' && chatId && ['group', 'topic'].includes(chatType);
  const groupId = isGroup ? key(tenant, chatId) : connector === 'feishu' && chatType === 'p2p' ? 'direct' : chatId ? 'unknown' : 'non-group';
  return { groupId, groupName: isGroup ? (source.chatId === chatId && label(source.chatName) || `群 ${String(chatId).slice(-8)}`) : groupId === 'direct' ? '飞书私聊' : groupId === 'non-group' ? 'Web / 自动任务等非群入口' : '群归属未知',
    personId: person?.id || 'unknown', personName: label(person?.name || person?.handle) || '发起人未知',
    basis: 'Session 群绑定与发起人身份；不是每一轮参与者或资源所有者' };
}

function messageSentAt(request) {
  const source = request.options?.sourceContext;
  if (source?.connector !== 'feishu' || !/^\d{13}$/.test(String(source.createTime ?? ''))) return null;
  const sent = Number(source.createTime), accepted = time(request.acceptedAt);
  return sent > 0 && Number.isFinite(accepted) && sent <= accepted ? sent : null;
}
export function projectRequest(r) {
  if (!r) return null;
  return { requestId: r.requestId, sessionId: r.sessionId, runId: r.runId, nativeDispatchRunId: r.nativeDispatchRunId,
    responseTiming: projectResponseTiming(r),
    sentAt: messageSentAt(r), acceptedAt: r.acceptedAt, preparedAt: r.preparedAt, settledAt: r.settledAt,
    excluded: Boolean(r.options?.internalOperation || r.options?.deliveryOnly || r.options?.recordUserMessage === false),
    deliveries: (r.deliveries || []).filter(d => d.kind === 'content' && time(d.createdAt) >= time(r.settledAt))
      .map(d => ({ state: d.state, deliveredAt: d.deliveredAt, connector: d.connector, surfaceKind: d.surfaceKind, publicationRequestId: d.publicationRequestId })) };
}
export function projectRun(r) {
  if (!r) return null;
  return { id: r.id, sessionId: r.sessionId, requestId: r.requestId, state: r.state,
    startedAt: r.startedAt, completedAt: r.completedAt, contextTokens: r.contextInputTokens };
}
export function projectInjection(manifest) {
  // Retain only a size, never a second copy of prompts or user text.
  const text = manifest?.modelContext;
  return { id: manifest?.id, sessionId: manifest?.sessionId,
    injectionBytes: typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : null,
    injectionChars: typeof text === 'string' ? [...text].length : null, sources: injectionSources(manifest) };
}
export function runMeasurement(ledger, run, request, injection = null) {
  const validRun = run?.id === ledger.runId && run.sessionId === ledger.sessionId;
  const validRequest = validRun && request?.runId === ledger.runId && request.sessionId === ledger.sessionId && !request.excluded && !request.nativeDispatchRunId;
  const ds = validRequest ? request.deliveries || [] : [];
  const deliveryEnd = ds.length && ds.every(d => d.state === 'delivered' && Number.isFinite(time(d.deliveredAt))) ? Math.max(...ds.map(d => time(d.deliveredAt))) : null;
  const finals = validRequest && request.responseTiming ? ds.filter(d => d.connector === 'feishu' && (!d.surfaceKind || d.surfaceKind === 'final') && (!d.publicationRequestId || d.publicationRequestId === request.requestId)) : [];
  const finalEnd = finals.length && finals.every(d => d.state === 'delivered' && Number.isFinite(time(d.deliveredAt))) ? Math.max(...finals.map(d => time(d.deliveredAt))) : null;
  const finalDeliveryMs = validRequest && run.state === 'completed' && finalEnd !== null ? span(request.acceptedAt, finalEnd) : null;
  const stages = finalDeliveryMs !== null ? {
    total: finalDeliveryMs,
    wait: span(request.acceptedAt, run.startedAt),
    run: span(run.startedAt, run.completedAt),
    send: span(run.completedAt, finalEnd),
  } : null;
  // Every phase uses the same complete, ordered cohort. Missing timestamps are
  // unknown, not zero; retain the independently valid end-to-end observation.
  const deliveryStages = stages && Object.values(stages).every(finite) ? stages : null;
  const journey = deliveryStages && request.sentAt !== null && request.sentAt !== undefined ? {
    receive: span(request.sentAt, request.acceptedAt),
    prepare: span(request.acceptedAt, request.preparedAt),
    launch: span(request.preparedAt, run.startedAt),
    run: deliveryStages.run, send: deliveryStages.send,
    total: span(request.sentAt, finalEnd),
  } : null;
  const journeyStages = journey && Object.values(journey).every(finite) ? journey : null;
  return { sessionId: ledger.sessionId, sources: validRun ? injection?.sources || [] : [], runId: ledger.runId, at: time(ledger.ts), model: ledger.model || 'unknown', tool: ledger.tool || 'unknown',
    state: validRun ? run.state : 'unknown',
    background: ledger.backgroundOperation === true || request?.excluded === true,
    responseEligible: validRequest && !ledger.backgroundOperation && request.responseTiming !== null && request.responseTiming !== undefined, responseAt: validRequest ? time(request?.acceptedAt) : NaN, sentAt: validRequest ? time(request.sentAt) : NaN,
    metrics: { finalDeliveryMs, deliveryStages, journeyStages,
      firstResponseMs: validRequest && request.responseTiming ? span(request.sentAt, request.responseTiming.firstContentAt) : null,
      injectionChars: validRun && injection?.id === ledger.runId && injection.sessionId === ledger.sessionId && finite(injection.injectionChars) ? injection.injectionChars : null,
      firstContentMs: validRequest ? span(request.acceptedAt, request.responseTiming?.firstContentAt) : null,
      firstReplyMs: validRequest ? span(request.acceptedAt, request.responseTiming?.firstReplyAt) : null,
      prepareMs: validRequest ? span(request.acceptedAt, request.preparedAt) : null,
      launchMs: validRequest ? span(request.preparedAt, run.startedAt) : null,
      runMs: validRun ? span(run.startedAt, run.completedAt) : null,
      deliveryMs: deliveryEnd !== null ? span(request.settledAt, deliveryEnd) : null,
      requestMs: validRequest ? span(request.acceptedAt, request.settledAt) : null,
      contextTokens: finite(ledger.contextTokens) ? ledger.contextTokens : validRun && finite(run.contextTokens) ? run.contextTokens : null,
      inputTokens: finite(ledger.inputTokens) ? ledger.inputTokens : null,
      injectionBytes: validRun && injection?.id === ledger.runId && injection.sessionId === ledger.sessionId
        && finite(injection.injectionBytes) ? injection.injectionBytes : null } };
}
const metricNames = ['firstContentMs', 'firstReplyMs', 'prepareMs', 'launchMs', 'runMs', 'deliveryMs', 'requestMs', 'contextTokens', 'inputTokens', 'injectionBytes'];
export function summarizeMeasurements(samples) {
  return Object.fromEntries(metricNames.map(name => {
    return [name, timingStats(samples.map(s => s.metrics[name]))];
  }));
}
// Compare consecutive, disjoint observed Run samples within the same Session/model/tool.
// This is a display-only heuristic, not a task score, alert delivery or incident state.
export function measurementSignals(samples) {
  const cohorts = new Map();
  for (const s of samples.filter(s => !s.background)) { const k = JSON.stringify([s.model, s.tool]); if (!cohorts.has(k)) cohorts.set(k, []); cohorts.get(k).push(s); }
  const signals = [];
  for (const cohort of cohorts.values()) {
    cohort.sort((a,b) => b.at-a.at);
    for (const name of ['firstContentMs','firstReplyMs','prepareMs','launchMs','runMs','contextTokens','inputTokens','injectionBytes']) {
      const recent = cohort.slice(0, 3).filter(s => finite(s.metrics[name]));
      const baseline = cohort.slice(3, 23).filter(s => finite(s.metrics[name]));
      if (recent.length < 3 || baseline.length < 10) continue;
      const current = recent.reduce((sum,s) => sum+s.metrics[name],0)/recent.length;
      const normal = baseline.reduce((sum,s) => sum+s.metrics[name],0)/baseline.length;
      const floor = name === 'runMs' ? 60000 : name.endsWith('Ms') ? 1000 : 10000;
      if (normal > 0 && current >= normal*2 && current-normal >= floor) signals.push({ metric:name, ratio:current/normal,
        severity:current>=normal*3?'critical':'warning', current, baseline:normal, recentCount:recent.length, baselineCount:baseline.length,
        model:cohort[0].model, tool:cohort[0].tool, recentFrom:new Date(recent.at(-1).at).toISOString(), baselineFrom:new Date(baseline.at(-1).at).toISOString() });
    }
  }
  return signals;
}

export function createSessionMonitoringReader({ configDir=CONFIG_DIR, runsDir=CHAT_RUNS_DIR, sessionsFile=CHAT_SESSIONS_FILE,
  getUsage=queryUsageLedger, getPeople=listPeopleForClient, now=Date.now, maxRuns=1000, maxReadBytes=64*1024*1024, includeInjection=true }={}) {
  const windows=new Map(), files=new Map();
  async function projected(file, project, coverage, limit=2*1024*1024) {
    try {
      const s=await stat(file), version=`${s.ino}:${s.mtimeMs}:${s.size}`, cached=files.get(file);
      if(cached?.version===version) { coverage.cacheHits++; return cached.value; }
      if(s.size>limit || coverage.bytesRead+s.size>maxReadBytes) { coverage.limitedFiles++; return null; }
      coverage.bytesRead+=s.size;
      const value=project(JSON.parse(await readFile(file,'utf8')));
      files.set(file,{version,value}); if(files.size>20000)files.delete(files.keys().next().value);
      return value;
    } catch(e) { if(e.code!=='ENOENT')coverage.readErrors++; return null; }
  }
  async function collect(days, dashboard) {
    const started=now(), coverage={bytesRead:0,cacheHits:0,limitedFiles:0,readErrors:0,missingRuns:0,missingRequests:0,missingInjections:0};
    const [usage, people, raw] = await Promise.all([getUsage({days,top:10000,...(dashboard ? { startMs: businessStart(started)-(days-1)*DAY, endMs: started, includeDailyTrend:true, dailyBoundaryOffsetMs:BUSINESS_OFFSET, dailyTimezoneOffsetMs:8*3600000, dailyTimezone:'Asia/Shanghai', includeTrendRuns:true, trendRunLimit:maxRuns } : {})}),getPeople(),readFile(sessionsFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '[]';throw e;})]);
    let contextExperiment = null;
    try {
      const experiment = await currentExperiment(join(configDir, 'feature-experiments'));
      if (experiment) {
        const { active, spec } = experiment;
        contextExperiment = { id: spec.id, mode: spec.mode,
          state: active.enabled === false ? 'stopped' : active.enrollmentEnabled === false ? 'paused' : 'running',
          reviewEnabled: active.reviewEnabled !== false, since: spec.since,
          people: spec.personIds.map(id => { const p = people.find(person => person.id === id); return label(p?.name || p?.handle) || '指定参与者'; }),
          sampleRate: spec.sampleRate, observationHours: spec.observationHours };
      }
    } catch { contextExperiment = { state: 'unavailable' }; }
    const metadata=JSON.parse(raw), list=Array.isArray(metadata)?metadata:metadata.sessions||[];
    const rows=new Map(list.filter(s=>!s.archived).map(s=>[s.id,{sessionId:s.id,name:label(s.name),model:label(s.model),activeRunId:s.activeRunId,...sessionOwnership(s,people)}]));
    for(const bucket of usage.bySession||[]) { const s=list.find(s=>s.id===bucket.sessionId); if(!rows.has(bucket.sessionId))rows.set(bucket.sessionId,{sessionId:bucket.sessionId,name:label(s?.name||bucket.sessionName),model:label(s?.model),activeRunId:s?.activeRunId,...sessionOwnership(s||{},people),archived:s?.archived===true}); }
    const firstRuns = new Map();
    async function firstRun(sessionId) {
      if (!firstRuns.has(sessionId)) firstRuns.set(sessionId, (async () => {
        for(let seq=1;seq<=32;seq++) {
          const event = await projected(join(configDir,'chat-history',sessionId,'events',String(seq).padStart(9,'0')+'.json'), e => ({type:e.type,role:e.role,runId:e.runId,requestId:e.requestId}),coverage);
          if(!event) return null;
          if(event.type==='message' && event.role==='user') return event.runId || null;
        }
        return null;
      })());
      return firstRuns.get(sessionId);
    }
    const ledger=(dashboard ? usage.trendRuns || usage.topRuns || [] : usage.topRuns||[]).slice().sort((a,b)=>time(b.ts)-time(a.ts)).slice(0,maxRuns), grouped=new Map();
    for(let i=0;i<ledger.length;i+=8) await Promise.all(ledger.slice(i,i+8).map(async l=>{
      if(!safeId(l.runId)||!safeId(l.sessionId))return;
      const run=await projected(join(runsDir,l.runId,'status.json'),projectRun,coverage);
      let request=null;
      if(run?.requestId) {
        const k=key(l.sessionId,run.requestId);
        request=await projected(join(configDir,'requests','active',k+'.json'),projectRequest,coverage)
          ||await projected(join(configDir,'requests','archive',k+'.json'),projectRequest,coverage);
      }
      if(!run)coverage.missingRuns++;
      if(!request)coverage.missingRequests++;
      const injection=includeInjection ? await projected(join(runsDir,l.runId,'manifest.json'),projectInjection,coverage) : null;
      const sample=runMeasurement(l,run,request,injection);
      if(dashboard && !sample.background) { const first = await firstRun(l.sessionId); sample.firstSessionRun = first ? first === l.runId : null; }
      if(includeInjection && !sample.background && !finite(sample.metrics.injectionBytes))coverage.missingInjections++;
      if(!grouped.has(l.sessionId))grouped.set(l.sessionId,[]);grouped.get(l.sessionId).push(sample);
    }));
    for(const row of rows.values()) {const samples=(grouped.get(row.sessionId)||[]).filter(s => !dashboard || s.at >= time(usage.window?.start));row.sampledRuns=samples.length;row.metrics=summarizeMeasurements(samples.filter(s=>!s.background));row.backgroundRuns=samples.filter(s=>s.background).length;row.signals=measurementSignals(samples);row.diagnosisMeasurements=diagnosisMeasurements(samples,now());}
    const allSamples=[...grouped.values()].flat();
    const agentDashboard=dashboard ? buildAgentDashboard(usage,allSamples,started,coverage) : null;
    if (agentDashboard) agentDashboard.documents = await readContextDocuments();
    return {generatedAt:new Date(now()).toISOString(),agentDashboard,contextExperiment,responseTiming:summarizeResponseTiming([...grouped.values()].flat(),days,now()),window:usage.window,currentSessionCount:list.filter(s=>!s.archived).length,usage:{...usage,topRuns:[],trendRuns:undefined},sessions:[...rows.values()],
      coverage:{...coverage,eligibleRuns:usage.runCount,sampledRuns:ledger.filter(s=>!dashboard || time(s.ts)>=time(usage.window?.start)).length,truncated:usage.runCount>ledger.filter(s=>!dashboard || time(s.ts)>=time(usage.window?.start)).length||coverage.limitedFiles>0,
        collectionMs:now()-started,cacheSeconds:60,apiAttribution:'unavailable'},
      semantics:{timing:'已落账 Run 的 Request/Run 时间戳；受理到准备包含排队，执行包含等待，阶段有各自样本数',
        context:'前台 Run 最近回传上下文的均值；不是模型每次调用均值，也不是累计输入',
        signals:'同 Session/模型/Harness，最近3个前台Run对此前最多20个（至少10个）；2倍黄色、3倍红色，另需最小增量；仅页面提示'} };
  }
  return async ({days=1,dashboard=false}={})=>{
    days=[1,7,30].includes(Number(days))?Number(days):1;
    const cacheKey=String(days)+':'+dashboard;
    const c=windows.get(cacheKey);if(c&&(c.pending||now()-c.at<60000))return c.pending||c.value;
    const entry={at:now()};entry.pending=collect(days,dashboard).then(value=>{entry.value=value;entry.pending=null;entry.at=now();return value;}).catch(e=>{windows.delete(cacheKey);throw e;});windows.set(cacheKey,entry);return entry.pending;
  };
}
export const readSessionMonitoring=createSessionMonitoringReader();
// The seven-day dashboard has a separate bounded cache; keep diagnostic sampling
// and the legacy selected-window reader's budgets unchanged.
export const readDashboardSessions=createSessionMonitoringReader({maxRuns:5000,maxReadBytes:256*1024*1024});

export function summarizeSessionOverview(sessions) {
  const measured = sessions.filter(s => finite(s.totalTokens));
  const injections = sessions.map(s => s.metrics.injectionBytes).filter(m => m?.count > 0 && finite(m.mean));
  const injectionCount = injections.reduce((sum, m) => sum + m.count, 0);
  return {
    currentSessions: sessions.filter(s => !s.archived).length,
    usageSessions: measured.length,
    meanUsageTokens: measured.length ? measured.reduce((sum,s) => sum+s.totalTokens,0)/measured.length : null,
    injectionCount, injectionSessions: injections.length,
    meanInjectionBytes: injectionCount ? injections.reduce((sum,m) => sum+m.mean*m.count,0)/injectionCount : null,
  };
}

// Compact native Monitor projection. No sidebar, prompts or duplicated bucket totals.
export async function compactSessionMonitoring(value, getActivity) {
  const usage = new Map((value.usage.bySession || []).map(s => [s.sessionId, s]));
  const sessions = [];
  for (let i = 0; i < value.sessions.length; i += 8) {
    sessions.push(...await Promise.all(value.sessions.slice(i, i + 8).map(async s => {
      let activity;
      try { activity = await getActivity({ id: s.sessionId, activeRunId: s.activeRunId }); }
      catch { activity = { run: { state: 'unknown' }, queue: { count: null } }; }
      return { sessionId: s.sessionId, name: s.name, model: s.model, archived: s.archived === true,
        groupId: s.groupId, personId: s.personId, activity,
        totalTokens: usage.get(s.sessionId)?.totalTokens ?? null,
        metrics: Object.fromEntries(Object.entries(s.metrics).filter(([, m]) => m.count > 0)), signals: s.signals };
    })));
  }
  return { generatedAt: value.generatedAt, stateObservedAt: new Date().toISOString(), window: value.window,
    agentDashboard: value.agentDashboard ? { ...value.agentDashboard, currentRunning: sessions.filter(s => s.activity?.run?.state === 'running').length, unknownStates: sessions.filter(s => s.activity?.run?.state === 'unknown').length, todayActiveSessions: new Set([...(value.usage.dailyTrend?.days?.at(-1)?.sessionIds || []), ...sessions.filter(s=>s.activity?.run?.state==='running').map(s=>s.sessionId)]).size } : null,
    contextExperiment: value.contextExperiment ?? null, responseTiming: value.responseTiming,
    coverage: value.coverage, totals: value.usage.totals, usageQuality: value.usage.quality, summary: { ...summarizeSessionOverview(sessions), currentSessions: value.currentSessionCount ?? summarizeSessionOverview(sessions).currentSessions },
    groups: Object.fromEntries(value.sessions.map(s => [s.groupId, s.groupName])),
    people: Object.fromEntries(value.sessions.map(s => [s.personId, s.personName])), sessions };
}

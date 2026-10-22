import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createRecordStore } from '../lib/durable-records.mjs';
import { fingerprint, publishRecord, readRecord, records, safeId } from './feature-experiment-store.mjs';
import { requests } from './requests.mjs';
import { runDir } from './runs.mjs';
import { getHistoryHeadSeq, loadHistory } from './history.mjs';

const ROOT = join(CONFIG_DIR, 'feature-observations');
const DAY = 86400000;
const stores = new Map();
const store = root => { if (!stores.has(root)) stores.set(root, createRecordStore(join(root, 'executions'))); return stores.get(root); };
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const effective = options => options?.groupDeliverySelfReviewPolicy || options?.messageReplyPolicy;

export function validateFeatureTrials(value) {
  if (!value) return [];
  if (value.version !== 1 || !Array.isArray(value.trials) || value.trials.length > 32) fail('Invalid feature observation registry');
  const ids = new Set();
  for (const t of value.trials) {
    if (!safeId(t.id) || ids.has(t.id) || !safeId(t.projectId) || !safeId(t.featureId)
      || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 120
      || typeof t.enabled !== 'boolean' || !Number.isInteger(t.durationDays) || t.durationDays < 1 || t.durationDays > 31
      || !Array.isArray(t.personIds) || !t.personIds.length || t.personIds.some(id => !safeId(id))
      || !Array.isArray(t.metrics) || t.metrics.length > 12
      || t.metrics.some(m => !safeId(m.id) || typeof m.label !== 'string' || m.label.length > 120)
      || new Set(t.metrics.map(m => m.id)).size !== t.metrics.length) fail('Invalid feature observation trial');
    ids.add(t.id);
  }
  return value.trials;
}
async function trials(root) { return validateFeatureTrials(await readRecord(join(root, 'config.json'))); }

// A passive observation contract; no random assignment, model call or scheduler.
export async function captureFeatureObservation(options, root = ROOT, now = Date.now()) {
  if (effective(options)?.selfReview !== true || options.internalOperation || options.automationTitle) return null;
  try {
    const trial = (await trials(root)).find(t => t.enabled && t.featureId === 'delivery-self-review' && t.personIds.includes(options.viewPersonId));
    if (!trial) return null;
    const window = await readRecord(join(root, trial.id, 'window.json'));
    if (window && (window.specHash !== fingerprint(trial) || now >= window.endsAt)) return null;
    return { trialId: trial.id, featureId: trial.featureId, specHash: fingerprint(trial), metrics: trial.metrics };
  } catch (error) { console.warn('[feature-observation] ' + error.message); return null; }
}

export async function observeFeatureAdmission(record, root = ROOT, now = Date.now()) {
  const observation = record.options?.featureObservation;
  if (!observation) return;
  try {
    const trial = (await trials(root)).find(t => t.id === observation.trialId);
    if (!trial?.enabled || fingerprint(trial) !== observation.specHash) return;
    const window = await publishRecord(join(root, trial.id, 'window.json'), { specHash: observation.specHash,
      spec: trial, startsAt: now, endsAt: now + trial.durationDays * DAY });
    if (now >= window.endsAt || window.specHash !== observation.specHash) return;
    const policy = effective(record.options);
    await publishRecord(join(root, trial.id, 'inputs', fingerprint([record.sessionId, record.requestId]) + '.json'), {
      sessionId: record.sessionId, requestId: record.requestId, runId: record.runId,
      at: now, scope: policy.scope, ruleHash: policy.deliverySelfReview?.sha256 || null,
    });
  } catch (error) { console.warn('[feature-observation] admission record failed: ' + error.message); }
}

export function featureObservationPrompt(observation, requestId) {
  if (!observation) return '';
  const quotedId = "'" + String(requestId).replaceAll("'", "'\\''") + "'";
  return `本次交付自检纳入已开启的功能观察。最终交付前最多记录一次核对阶段：先运行 remotelab feature-observation begin --request-id ${quotedId}，再核对实际成果；完成后用 remotelab feature-observation finish --request-id ${quotedId} --file <JSON绝对路径> 保存结果。JSON为 {outcome:"passed|repaired|blocked|not_applicable",metrics:{${observation.metrics.map(m => `${JSON.stringify(m.id)}:0`).join(',')}},checks:[{criterion:"实际验收条件",verdict:"pass|fail|unknown",evidenceSeqs:[实际工具/附件事件编号]}]}。指标含义：${observation.metrics.map(m => `${m.id}=${m.label}`).join('；')}。事件编号从当前 Session 的 /events?filter=all 核对，不编造；短问答不需要额外成果，用 not_applicable。记录失败如实保留缺口，不重复自检、阻塞交付或新发消息。观察只记录证据，不代替验收。`;
}

// Codex exposes cumulative provider counters. Other Harnesses remain unknown
// until their adapter supplies equivalent counters; never use whole-run usage.
export async function readFeatureMeter(runId, { firstAtOrAfter = null } = {}) {
  const path = join(runDir(runId), 'spool.jsonl');
  try {
    if ((await stat(path)).size > 64 * 1024 * 1024) return null;
    let meter = null;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      let row, event;
      try { row = JSON.parse(line); event = row.json || JSON.parse(row.line || '{}'); } catch { continue; }
      const usage = event.featureUsage;
      if (event.type !== 'remotelab.context_metrics' || !usage?.threadId
        || ['inputTokens', 'cachedInputTokens', 'outputTokens'].some(k => !Number.isSafeInteger(usage[k]) || usage[k] < 0)) continue;
      meter = { ...usage, at: row.ts };
      if (firstAtOrAfter !== null && Date.parse(row.ts) >= firstAtOrAfter) return meter;
    }
    return firstAtOrAfter === null ? meter : null;
  } catch { return null; }
}
export function featureUsageDelta(before, after) {
  const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens'];
  if (!before || !after || before.threadId !== after.threadId || before.at === after.at
    || keys.some(k => after[k] < before[k])) return null;
  const value = Object.fromEntries(keys.map(k => [k, after[k] - before[k]]));
  return { ...value, totalTokens: value.inputTokens + value.outputTokens,
    source: 'provider_counter_delta', from: before.at, to: after.at };
}

export async function recordFeatureExecution(record, input, { root = ROOT, now = Date.now(), meter = readFeatureMeter } = {}) {
  const observation = record.options?.featureObservation;
  if (!observation || effective(record.options)?.selfReview !== true) fail('当前输入未启用本次功能观察');
  const window = await readRecord(join(root, observation.trialId, 'window.json'));
  if (!window || window.specHash !== observation.specHash) fail('观察窗口缺失或已变更');
  const executionRunId = record.nativeDispatchRunId || record.runId;
  const key = fingerprint([observation.trialId, executionRunId]).slice(0, 24);
  const existing = await store(root).get(key);
  if (input.action === 'begin' && existing?.startedAt || input.action === 'finish' && existing?.finishedAt) return existing;
  if (input.action === 'begin') {
    if (now >= window.endsAt) fail('观察窗口已结束');
    const [baseline, evidenceAfterSeq] = await Promise.all([meter(executionRunId), getHistoryHeadSeq(record.sessionId)]);
    return store(root).mutate(key, previous => previous?.startedAt ? previous : ({ schema: 1, id: key,
      trialId: observation.trialId, sessionId: record.sessionId, requestId: record.requestId,
      runId: executionRunId, startedAt: now, baseline, evidenceAfterSeq }));
  }
  if (input.action !== 'finish' || !existing?.startedAt) fail('请先记录开始核对');
  if (!['passed', 'repaired', 'blocked', 'not_applicable'].includes(input.outcome)
    || !Array.isArray(input.checks) || input.checks.length > 30) fail('Invalid review outcome');
  const metrics = input.metrics || {};
  if (Object.keys(metrics).some(k => !observation.metrics.some(m => m.id === k))
    || Object.values(metrics).some(v => !Number.isSafeInteger(v) || v < 0)) fail('Invalid observation metrics');
  const seqs = [...new Set(input.checks.flatMap(c => c.evidenceSeqs || []))];
  if (seqs.length > 150 || seqs.some(s => !Number.isSafeInteger(s) || s < 1)) fail('Invalid evidence references');
  const events = (await Promise.all(seqs.map(seq => loadHistory(record.sessionId,
    { fromSeq: seq, toSeq: seq, includeBodies: false })))).flat();
  const usable = new Set(events.filter(e => ['tool_result', 'artifact', 'file_change', 'attachment_delivery', 'source_delivery'].includes(e.type)
    || e.type === 'message' && e.role === 'assistant' && e.attachments?.length).map(e => e.seq));
  for (const check of input.checks) {
    if (typeof check.criterion !== 'string' || !check.criterion.trim() || check.criterion.length > 500
      || !['pass', 'fail', 'unknown'].includes(check.verdict) || !Array.isArray(check.evidenceSeqs)
      || check.evidenceSeqs.some(seq => !usable.has(seq))
      || check.verdict !== 'unknown' && !check.evidenceSeqs.length) fail('检查项需要原任务真实工具或附件事件编号');
  }
  if (input.outcome !== 'not_applicable' && !input.checks.length) fail('缺少实际验收检查项');
  if (['passed', 'repaired'].includes(input.outcome) && input.checks.some(c => c.verdict !== 'pass')) fail('未通过或未知检查项不能报告全部通过');
  const after = await meter(executionRunId);
  return store(root).mutate(key, previous => previous?.finishedAt ? previous : ({ ...previous,
    finishedAt: now, durationMs: now - previous.startedAt, outcome: input.outcome, metrics,
    // Provider counters arrive after the finish tool returns. Reporting reads
    // the first samples following both boundaries; no timer or extra model turn.
    checks: input.checks, usage: null, after,
    evidenceLevel: 'agent_report_with_event_refs' }));
}

export async function readFeatureObservations({ root = ROOT, now = Date.now(), lookup = requests.byRequest, meter = readFeatureMeter } = {}) {
  const configured = await trials(root), executions = await store(root).active();
  const report = [];
  for (const config of configured) {
    const window = await readRecord(join(root, config.id, 'window.json'));
    const spec = window?.spec || config;
    const inputs = await records(join(root, config.id, 'inputs'));
    let delivered = 0, pending = 0, missing = 0;
    for (const row of inputs.items) {
      const request = await lookup(row.sessionId, row.requestId);
      if (!request) missing++;
      else if (request.nativeReceipt?.accepted === true) delivered++;
      else pending++;
    }
    const rows = [];
    for (const row of executions.filter(e => e.trialId === config.id)) {
      let usage = null;
      if (row.finishedAt) {
        const [before, after] = await Promise.all([meter(row.runId, { firstAtOrAfter: row.startedAt }),
          meter(row.runId, { firstAtOrAfter: row.finishedAt })]);
        usage = featureUsageDelta(before, after);
      }
      rows.push({ ...row, usage });
    }
    const finished = rows.filter(r => r.finishedAt), measured = finished.filter(r => r.usage);
    const sum = k => measured.reduce((n, r) => n + r.usage[k], 0);
    const daily = new Map();
    const day = at => {
      const key = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
      if (!daily.has(key)) daily.set(key, { day: key, inputs: 0, started: 0, finished: 0, measured: 0, totalTokens: null });
      return daily.get(key);
    };
    for (const row of inputs.items) day(row.at).inputs++;
    for (const row of rows) {
      const d = day(row.startedAt); d.started++;
      if (row.finishedAt) d.finished++;
      if (row.usage) { d.measured++; d.totalTokens = (d.totalTokens || 0) + row.usage.totalTokens; }
    }
    report.push({ id: config.id, projectId: spec.projectId, featureId: spec.featureId, name: spec.name,
      state: !window ? 'waiting_for_activation' : now >= window.endsAt ? 'completed' : config.enabled ? 'observing' : 'paused',
      window: window ? { startsAt: window.startsAt, endsAt: window.endsAt } : null,
      durationDays: spec.durationDays, admittedInputs: inputs.items.length, deliveredInputs: delivered,
      pendingDelivery: pending, missingRequests: missing, started: rows.length, finished: finished.length,
      inputScopes: { person: inputs.items.filter(r => r.scope === 'person').length, group: inputs.items.filter(r => r.scope === 'group').length },
      daily: [...daily.values()].sort((a,b) => a.day.localeCompare(b.day)),
      unfinished: rows.length - finished.length, outcomes: Object.fromEntries(['passed','repaired','blocked','not_applicable'].map(k => [k, finished.filter(r => r.outcome === k).length])),
      metrics: spec.metrics.map(m => ({ ...m, value: finished.reduce((n, r) => n + (r.metrics?.[m.id] || 0), 0),
        reported: finished.filter(r => Number.isInteger(r.metrics?.[m.id])).length })),
      usage: { measured: measured.length, unknown: finished.length - measured.length,
        inputTokens: measured.length ? sum('inputTokens') : null, cachedInputTokens: measured.length ? sum('cachedInputTokens') : null,
        outputTokens: measured.length ? sum('outputTokens') : null, totalTokens: measured.length ? sum('totalTokens') : null },
      partial: inputs.partial || missing > 0, records: rows,
      semantics: '已启用输入、原生接收、Agent自检回执分别计数。效果为带事件引用的Agent自报，需结合原任务核验，不等于人验收。Token取begin和finish之后首个provider采样之差，包含阶段上下文和记录编排；不是开启相对于关闭的净增成本。采样尚未到达或缺失保持未知。' });
  }
  return { generatedAt: new Date(now).toISOString(), trials: report };
}

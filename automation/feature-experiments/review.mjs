import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_HISTORY_DIR, CHAT_RUNS_DIR } from '../../lib/config.mjs';
import { queryUsageLedger } from '../../chat/usage-ledger.mjs';
import { getHistoryHeadSeq, loadHistory, readEventBody } from '../../chat/history.mjs';
import { fingerprint, readRecord, records, publishRecord, validateLabels, validateScores, timeMs } from '../../chat/feature-experiment-store.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const retainedTypes = new Set(['message', 'tool_use', 'tool_result', 'source_delivery', 'attachment_delivery', 'status']);
export async function collectCase(assignment, spec, dependencies = {}) {
  const head = await (dependencies.head || getHistoryHeadSeq)(assignment.sessionId);
  const maxEvents = 1500, maxChars = 60000;
  const stored = await (dependencies.history || loadHistory)(assignment.sessionId, { fromSeq: 1, toSeq: Math.min(head, maxEvents), includeBodies: false });
  const end = timeMs(assignment.assignedAt) + spec.observationHours * 3600000;
  const window = stored.filter(e => Number.isFinite(timeMs(e.timestamp)) && timeMs(e.timestamp) <= end);
  const runIds = [...new Set(window.map(e => e.runId).filter(Boolean))];
  const runs = [];
  for (const runId of runIds) {
    if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) continue;
    const status = await (dependencies.run || (id => readRecord(join(CHAT_RUNS_DIR, id, 'status.json'))))(runId);
    if (status) runs.push(status);
  }
  const events = [];
  let chars = 0, omitted = 0, partial = head > maxEvents, unavailableBodies = 0;
  for (const e of window) {
    if (!retainedTypes.has(e.type)) continue;
    let body = e.content || e.output || e.toolInput || '';
    if (e.bodyRef) {
      try {
        if (dependencies.body) body = await dependencies.body(assignment.sessionId, e.seq);
        else {
          // Stat before reading. The canonical body reader owns path resolution.
          const bodyPath = join(CHAT_HISTORY_DIR, assignment.sessionId, 'bodies', e.bodyRef + '.txt');
          if ((await stat(bodyPath)).size > 300000) throw new Error('body budget exceeded');
          body = (await readEventBody(assignment.sessionId, e.seq))?.value || '';
        }
      } catch { unavailableBodies++; partial = true; body = '[body unavailable; do not infer its content]'; }
    }
    if (typeof body !== 'string') body = JSON.stringify(body);
    const row = { seq: e.seq, type: e.type, role: e.role, toolName: e.toolName,
      state: e.state, exitCode: e.exitCode, kind: e.kind, content: body };
    if (JSON.stringify(row).length + chars > maxChars) { partial = true; omitted++; continue; }
    chars += JSON.stringify(row).length; events.push(row);
  }
  const usage = await (dependencies.usage || queryUsageLedger)({ sessionId: assignment.sessionId,
    startMs: timeMs(assignment.assignedAt), endMs: end, top: 100 });
  const finishedInWindow = r => terminal.has(r.state) && Number.isFinite(timeMs(r.completedAt)) && timeMs(r.completedAt) <= end;
  return { caseId: fingerprint([spec.id, assignment.sessionId]).slice(0, 24),
    initialRequest: assignment.baseline.query, events,
    coverage: { partial, omitted, unavailableBodies, historyHead: head, scanned: stored.length,
      observationEnd: new Date(end).toISOString(), ongoing: runs.some(r => !finishedInWindow(r)),
      missingRunStates: runIds.length - runs.length,
      outcomeBoundary: 'Observed conversation/tool/receipt evidence only; artifact correctness requires actual readback evidence.' },
    // Timing and usage are not shown to the semantic judge.
    metrics: { usage: { totals: usage.totals, quality: usage.quality, runCount: usage.runCount },
      runs: runs.map(r => ({ id: r.id, state: finishedInWindow(r) ? r.state : 'ongoing-at-cutoff', tool: r.tool, model: r.model,
      startedAt: r.startedAt, completedAt: r.completedAt,
      durationMs: finishedInWindow(r) && Number.isFinite(timeMs(r.startedAt))
        ? timeMs(r.completedAt) - timeMs(r.startedAt) : null })) } };
}

export async function prepareBatch(experiment, now = Date.now(), dependencies = {}) {
  const { items: assignments, partial } = await records(join(experiment.directory, 'assignments'));
  const candidates = assignments.filter(a => a.sampled && now >= timeMs(a.assignedAt) + experiment.spec.observationHours * 3600000)
    .sort((a, b) => timeMs(a.assignedAt) - timeMs(b.assignedAt));
  const selected = [];
  for (const a of candidates) {
    const caseId = fingerprint([experiment.spec.id, a.sessionId]).slice(0, 24);
    if (await readRecord(join(experiment.directory, 'evaluated', caseId + '.json'))) continue;
    selected.push(a);
    if (selected.length >= experiment.spec.maxNightlyCases) break;
  }
  if (!selected.length) return { pending: 0, assignmentCoveragePartial: partial };
  // Existing pending batch is immutable across failures and following nights.
  const pending = await readRecord(join(experiment.directory, 'pending.json'));
  if (pending && !await readRecord(join(experiment.directory, 'batches', pending.id, 'committed.json'))) return pending;
  const id = fingerprint([experiment.spec.id, selected.map(a => a.sessionId), experiment.spec.rubricVersion]).slice(0, 24);
  const directory = join(experiment.directory, 'batches', id);
  const cases = [], mapping = [], labels = [];
  let chars = 0;
  for (const a of selected) {
    const entry = await collectCase(a, experiment.spec, dependencies);
    // Whole-case budget: no selection by success, tags, arm or score.
    const size = JSON.stringify(entry).length;
    if (cases.length && chars + size > 180000) break;
    chars += size;
    mapping.push({ caseId: entry.caseId, sessionId: a.sessionId, arm: a.arm,
      assignedStrategy: a.assignedStrategy, metrics: entry.metrics });
    delete entry.metrics;
    cases.push(entry);
    labels.push({ caseId: entry.caseId, initialRequest: a.baseline.query,
      attachmentCount: a.baseline.attachmentCount, initialSource: a.baseline.sourceContext,
      instruction: 'Use only this frozen initial input. No outcome, duration or retries are baseline labels.' });
  }
  await publishRecord(join(directory, 'mapping.json'), mapping);
  await publishRecord(join(directory, 'labels-input.json'), { schema: 1, cases: labels });
  const packet = await publishRecord(join(directory, 'scores-input.json'), { schema: 1,
    rubricVersion: experiment.spec.rubricVersion, cases });
  const batch = await publishRecord(join(directory, 'batch.json'), { id, preparedAt: new Date(now).toISOString(),
    evidenceHash: fingerprint(packet), caseCount: cases.length, assignmentCoveragePartial: partial });
  return batch;
}

export async function saveLabels(experiment, batchId, labels) {
  const directory = join(experiment.directory, 'batches', batchId);
  validateLabels(await readRecord(join(directory, 'labels-input.json')), labels);
  const value = await publishRecord(join(directory, 'labels.json'), labels);
  if (fingerprint(value) !== fingerprint(labels)) throw new Error('Labels already frozen; cannot revise after outcome access');
  return { saved: true, count: labels.length };
}
export async function scorePacket(experiment, batchId) {
  const directory = join(experiment.directory, 'batches', batchId);
  if (!await readRecord(join(directory, 'labels.json'))) throw new Error('Submit frozen baseline labels before reading outcomes');
  return readRecord(join(directory, 'scores-input.json'));
}
export async function saveDraft(experiment, batchId, scores, runId) {
  if (!/^run_[a-zA-Z0-9_-]+$/.test(runId || '')) throw new Error('Actual scoring Run required');
  const packet = await scorePacket(experiment, batchId);
  validateScores(packet, scores);
  const path = join(experiment.directory, 'batches', batchId, 'drafts', runId + '.json');
  const draft = { runId, evidenceHash: fingerprint(packet), rubricVersion: experiment.spec.rubricVersion,
    scores, at: new Date().toISOString() };
  const stored = await publishRecord(path, draft);
  if (fingerprint(stored.scores) !== fingerprint(scores)) throw new Error('Run already submitted a different draft');
  return { submitted: true, committed: false };
}
export async function commitDrafts(experiment, readRun = id => readRecord(join(CHAT_RUNS_DIR, id, 'status.json'))) {
  const batches = await records(join(experiment.directory, 'batch-index'));
  let committed = 0;
  for (const ref of batches.items) {
    const dir = join(experiment.directory, 'batches', ref.id);
    const existing = await readRecord(join(dir, 'committed.json'));
    if (existing) {
      // Repair indexes after a crash between durable receipt and per-case indexes.
      for (const row of existing.scores) await publishRecord(join(experiment.directory, 'evaluated', row.caseId + '.json'), { batchId: ref.id });
      continue;
    }
    const drafts = await records(join(dir, 'drafts'));
    for (const draft of drafts.items) {
      const run = await readRun(draft.runId);
      if (run?.state !== 'completed' || await readRecord(join(experiment.directory, `stop-${draft.runId}.json`))) continue;
      const expected = experiment.spec.judge;
      if (expected && (run.tool !== expected.tool || run.model !== expected.model || run.effort !== expected.effort)) continue;
      const packet = await readRecord(join(dir, 'scores-input.json'));
      if (draft.evidenceHash !== fingerprint(packet)) throw new Error('Scoring evidence hash changed');
      validateScores(packet, draft.scores);
      const receipt = await publishRecord(join(dir, 'committed.json'), { ...draft,
        judge: { tool: run.tool, model: run.model, effort: run.effort }, committedAt: new Date().toISOString(),
        semantics: 'Model judgments with structural validation; not independent business acceptance.' });
      for (const row of receipt.scores) await publishRecord(join(experiment.directory, 'evaluated', row.caseId + '.json'), { batchId: ref.id });
      committed++; break;
    }
  }
  return { committed };
}
export async function report(experiment) {
  const assignments = await records(join(experiment.directory, 'assignments'));
  const groups = Object.fromEntries(['A', 'B'].map(arm => [arm, { assigned: 0, sampled: 0, evaluated: 0,
    pass: 0, partial: 0, fail: 0, insufficientEvidence: 0, criteria: {}, labels: {}, exposures: { prepared: 0, partial: 0, fallback: 0, disabled: 0, sessionsWithoutReceipt: 0 }, measured: { durationsMs: [], usageCases: 0, unknownUsageCases: 0, excludedUsageRuns: 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, estimatedCostUsd: 0, unpricedTokenCount: 0 }, models: {} }]));
  for (const a of assignments.items) {
    const g = groups[a.arm]; g.assigned++; if (a.sampled) g.sampled++;
    const receipts = await records(join(experiment.directory, 'exposures', a.sessionId));
    if (!receipts.items.length) g.exposures.sessionsWithoutReceipt++;
    for (const r of receipts.items) { if (r.disabled) g.exposures.disabled++; if (r.state in g.exposures) g.exposures[r.state]++; }
  }
  const batchIndex = await records(join(experiment.directory, 'batch-index'));
  for (const batch of batchIndex.items) {
    const dir = join(experiment.directory, 'batches', batch.id);
    const receipt = await readRecord(join(dir, 'committed.json'));
    if (!receipt) continue;
    const mapping = await readRecord(join(dir, 'mapping.json'));
    const labels = await readRecord(join(dir, 'labels.json'));
    for (const row of receipt.scores) {
      const match = mapping.find(m => m.caseId === row.caseId), g = groups[match.arm];
      for (const run of match.metrics.runs) {
        if (Number.isFinite(run.durationMs)) g.measured.durationsMs.push(run.durationMs);
        const model = run.tool + ':' + run.model; g.models[model] = (g.models[model] || 0) + 1;
      }
      g.measured.excludedUsageRuns += match.metrics.usage?.quality?.excludedRunCount || 0;
      if (match.metrics.usage?.runCount > 0) {
        g.measured.usageCases++;
        for (const k of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'estimatedCostUsd', 'unpricedTokenCount']) g.measured[k] += match.metrics.usage.totals?.[k] || 0;
      } else g.measured.unknownUsageCases++;
      const completion = row.criteria.find(c => c.id === 'task_completion').verdict;
      g.evaluated++; g[completion === 'insufficient-evidence' ? 'insufficientEvidence' : completion]++;
      for (const c of row.criteria) { g.criteria[c.id] ||= {}; g.criteria[c.id][c.verdict] = (g.criteria[c.id][c.verdict] || 0) + 1; }
      for (const [key, value] of Object.entries(labels.find(l => l.caseId === row.caseId).tags)) {
        const bucket = key + ':' + value; g.labels[bucket] ||= { n: 0, taskPass: 0 };
        g.labels[bucket].n++; if (completion === 'pass') g.labels[bucket].taskPass++;
      }
    }
  }
  for (const g of Object.values(groups)) {
    g.pendingOrUnscored = g.sampled - g.evaluated;
    const durations = g.measured.durationsMs.sort((a, b) => a - b);
    g.measured.uncachedInputTokens = Math.max(0, g.measured.inputTokens - g.measured.cachedInputTokens);
    g.measured.completedRunCount = durations.length;
    g.measured.durationP50Ms = durations.length ? durations[Math.floor((durations.length - 1) * .5)] : null;
    g.measured.durationP95Ms = durations.length ? durations[Math.ceil((durations.length - 1) * .95)] : null;
    delete g.measured.durationsMs;
  }
  return { experimentId: experiment.spec.id, mode: experiment.spec.mode, groups,
    coveragePartial: assignments.partial || batchIndex.partial,
    interpretation: 'Overall randomized samples first; baseline-label views are exploratory. Model pass is not verified business success. Small samples cannot establish equivalence.' };
}

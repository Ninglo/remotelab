import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRecord, readRecord, currentExperiment, assignSession, eligibleSession, CRITERIA, validateScores } from '../chat/feature-experiment-store.mjs';
import { experimentBackground } from '../chat/feature-experiment-context.mjs';
import { collectCase, prepareBatch, saveLabels, scorePacket, saveDraft, commitDrafts, report } from '../automation/feature-experiments/review.mjs';
import { runReview } from '../automation/feature-experiments/runner.mjs';

const root = await mkdtemp(join(tmpdir(), 'feature-experiment-'));
try {
  const spec = { schema: 1, id: 'context-pilot', kind: 'context-background-v1', mode: 'ab', personIds: ['person_owner'],
    since: '2026-10-01T00:00:00Z', sampleRate: .25, observationHours: 24, maxNightlyCases: 10, rubricVersion: 'context-background-v1' };
  await publishRecord(join(root, spec.id, 'spec.json'), spec);
  await publishRecord(join(root, 'active.json'), { id: spec.id, enabled: true });
  const exp = await currentExperiment(root);
  const session = { id: 's1', created: '2026-10-13T01:00:00Z', initiatedByIdentityId: 'identity_owner' };
  const input = { personId: 'person_owner', identityId: 'identity_owner', query: '请检查报告中的数字', requestId: 'r1', sourceContext: { connector: 'feishu' } };
  for (const bad of [{ created: '2026-09-30' }, { forkedFromSessionId: 'old' }, { internalRole: 'scheduled_execution' }, { externalTriggerId: 'trg_test' }, { groupFeed: true }]) {
    assert.ok(!eligibleSession(spec, { ...session, ...bad }, input, true));
  }
  assert.ok(!eligibleSession(spec, session, { ...input, personId: 'someone_else' }, true));
  assert.ok(!eligibleSession(spec, session, { ...input, automated: true }, true));
  assert.ok(!eligibleSession(spec, session, input, false));
  // Competing first turns must converge on exactly one durable random choice.
  const competing = await Promise.all(Array.from({ length: 8 }, (_, i) => assignSession(exp, session, input, { verified: true, draw: () => i % 2 ? .9 : .1 })));
  assert.ok(competing.every(a => a.arm === competing[0].arm && a.sampled === competing[0].sampled));
  assert.equal((await assignSession(exp, session, input, { verified: true, draw: () => { throw Error('redraw'); } })).arm, competing[0].arm);
  const oldSession = { ...session, id: 's_old' }, newSession = { ...session, id: 's_new' };
  let calls = 0;
  const deps = { root, verify: () => true, draw: () => .1, retrieve: async () => { calls++; return { text: 'old scoped context', partial: false }; } };
  assert.equal(await experimentBackground(oldSession, input, deps), 'old scoped context');
  assert.equal(await experimentBackground(oldSession, input, deps), 'old scoped context');
  assert.equal(calls, 1, 'prepared request context is durable and idempotent');
  assert.equal(await experimentBackground(newSession, input, { ...deps, draw: () => .9 }), '');
  assert.equal(calls, 1, 'on-demand arm does no automatic retrieval');
  assert.equal(await experimentBackground({ ...session, id: 's_other' }, input, { ...deps, verify: () => false }), '');
  assert.equal(calls, 1);
  await experimentBackground(oldSession, { ...input, requestId: 'r2' }, { ...deps, retrieve: async () => { throw Error('source down'); } });
  const summary = await report(exp);
  assert.equal(summary.groups.A.exposures.fallback, 1);
  assert.equal(summary.groups.A.exposures.prepared, 1);
  assert.equal(await experimentBackground(session, input, { ...deps, root: join(root, 'off') }), '');

  const assignment = { ...(await readRecord(join(exp.directory, 'assignments', 's_old.json'))), assignedAt: '2026-10-10T00:00:00Z' };
  await writeFile(join(exp.directory, 'assignments', 's_old.json'), JSON.stringify(assignment));
  const evidence = { head: async () => 3, history: async () => [
    { seq: 1, timestamp: '2026-10-10T00:00:00Z', type: 'message', role: 'user', content: input.query, runId: 'run_business' },
    { seq: 2, timestamp: '2026-10-10T00:01:00Z', type: 'tool_result', bodyRef: 'body', runId: 'run_business' },
    { seq: 3, timestamp: '2026-10-12T00:00:00Z', type: 'message', role: 'assistant', content: 'late success', runId: 'run_business' }],
    body: async () => 'actual readback: all numbers verified',
    run: async () => ({ id: 'run_business', state: 'completed', startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:02:00Z', tool: 'codex', model: 'fixed' }),
    usage: async () => ({ runCount: 1, totals: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 50, estimatedCostUsd: .001 }, quality: {} }) };
  const item = await collectCase(assignment, spec, evidence);
  assert.equal(item.events.length, 2, 'evidence after fixed outcome cutoff is excluded');
  assert.equal(item.coverage.ongoing, false);
  assert.equal(item.metrics.runs[0].durationMs, 120000);
  const late = await collectCase(assignment, spec, { ...evidence, run: async () => ({ ...await evidence.run(), completedAt: '2026-10-12T00:00:00Z' }) });
  assert.equal(late.coverage.ongoing, true, 'later completion cannot certify earlier success');
  const missing = await collectCase(assignment, spec, { ...evidence, body: async () => { throw Error('lost'); } });
  assert.equal(missing.coverage.partial, true);
  const large = await collectCase({ ...assignment, baseline: { ...assignment.baseline, query: 'x'.repeat(200000) } }, spec, evidence);
  assert.equal(large.coverage.initialRequestOmitted, true);
  assert.equal(large.coverage.partial, true);
  assert.ok(JSON.stringify(large).length < 65000, 'even the first case has a bounded review packet');
  const batch = await prepareBatch(exp, Date.parse('2026-10-11T01:00:00Z'), evidence);
  assert.equal(batch.caseCount, 1);
  await publishRecord(join(exp.directory, 'batch-index', batch.id + '.json'), { id: batch.id });
  await assert.rejects(scorePacket(exp, batch.id), /before reading outcomes/);
  const labels = [{ caseId: item.caseId, tags: { workType: 'data', initialMaterial: 'none', modality: 'text', requestedWrite: 'no' }, reason: '初始要求核查数字' }];
  await saveLabels(exp, batch.id, labels);
  await assert.rejects(saveLabels(exp, batch.id, [{ ...labels[0], tags: { ...labels[0].tags, workType: 'coding' } }]), /already frozen/);
  const packet = await scorePacket(exp, batch.id);
  const scores = [{ caseId: item.caseId, criteria: CRITERIA.map(id => ({ id, verdict: 'insufficient-evidence', reason: 'fixture does not independently prove all acceptance criteria', evidenceSeqs: [] })) }];
  const forged = structuredClone(scores); forged[0].criteria[0] = { id: 'task_completion', verdict: 'pass', reason: 'fake citation', evidenceSeqs: [999] };
  assert.throws(() => validateScores(packet, forged), /Invalid verdict/);
  forged[0].criteria[0].evidenceSeqs = [2];
  assert.throws(() => validateScores({ cases: [missing] }, forged), /Partial evidence/);
  await saveDraft(exp, batch.id, scores, 'run_judge');
  assert.equal((await commitDrafts(exp, async () => ({ state: 'running' }))).committed, 0);
  assert.equal((await commitDrafts(exp, async () => ({ state: 'cancelled' }))).committed, 0);
  assert.equal((await commitDrafts(exp, async () => ({ state: 'completed', tool: 'codex', model: 'fixed', effort: 'medium' }))).committed, 1);
  const evaluated = join(exp.directory, 'evaluated', item.caseId + '.json');
  await rm(evaluated); await commitDrafts(exp, async () => { throw Error('must repair from committed receipt'); });
  assert.ok(await readRecord(evaluated));
  const result = await report(exp);
  assert.equal(result.groups.A.evaluated, 1); assert.equal(result.groups.A.insufficientEvidence, 1);
  assert.equal(result.groups.A.measured.totalTokens, 100);
  assert.equal(result.groups.A.measured.durationP95Ms, 120000);
  const aa = { ...exp, spec: { ...spec, mode: 'aa' } };
  const aaAssignment = await assignSession(aa, { ...session, id: 's_aa' }, input, { verified: true, draw: () => .1 });
  assert.equal(aaAssignment.assignedStrategy, 'on-demand', 'AA changes no intervention');
  const previousRun = process.env.REMOTELAB_RUN_ID, previousSession = process.env.REMOTELAB_SESSION_ID;
  process.env.REMOTELAB_RUN_ID = 'run_judge'; process.env.REMOTELAB_SESSION_ID = 'judge_session';
  await writeFile(join(exp.directory, 'state.json'), JSON.stringify({ version: 1, attempts: [], active: { runId: 'run_judge', sessionId: 'judge_session', batch } }));
  const retryLabels = await runReview(root, 'labels-input', null, { worker: { config: {}, api: async () => ({ run: { sessionId: 'judge_session', state: 'running' } }) } });
  assert.equal(retryLabels.labelsFrozen, true);
  assert.deepEqual(retryLabels.frozenLabels, labels, 'a resumed reviewer reuses frozen labels');
  const hookWorker = { config: {}, api: async route => route.startsWith('/api/runs/')
    ? { run: { id: 'run_judge', sessionId: 'judge_session', state: 'completed' } }
    : { totals: { totalTokens: 123 } } };
  const after = await runReview(root, 'after', null, { worker: hookWorker });
  assert.equal(after.trigger, true);
  const storedReport = await readRecord(join(exp.directory, 'latest-report.json'));
  assert.equal(storedReport.scoringAttempts[0].tokens, 123, 'judge costs stay separate from business costs');
  assert.equal(storedReport.groups.A.measured.totalTokens, 100);
  if (previousRun === undefined) delete process.env.REMOTELAB_RUN_ID; else process.env.REMOTELAB_RUN_ID = previousRun;
  if (previousSession === undefined) delete process.env.REMOTELAB_SESSION_ID; else process.env.REMOTELAB_SESSION_ID = previousSession;
  const paused = { config: { enabled: false }, conditions: () => { throw Error('no resources when disabled'); } };
  assert.equal((await runReview(root, 'gate', null, { worker: paused })).trigger, false);
  console.log('PASS feature experiment ownership, randomization, exposure, fixed windows, evidence, freezing, terminal commits and crash recovery');
} finally { await rm(root, { recursive: true, force: true }); }

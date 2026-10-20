import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initialState, ingest, selectBatch, changedLines, validateResult, commitReview, read, save, transact } from '../automation/dreaming/store.mjs';
import { resourceDecision, budgetDecision, createWorker } from '../automation/dreaming/runner.mjs';

const root = await mkdtemp(join(tmpdir(), 'dreaming-test-'));
try {
  const source = join(root, 'source.md'), missing = join(root, 'missing.md');
  const config = { enabled: true, timezone: 'Asia/Shanghai', inputs: [{ path: source, baselineOnly: true }, { path: missing }],
    minIdleSeconds: 300, maxDailyAttempts: 2, maxDailyObservedTokens: 80000, cooldownSeconds: 21600,
    maxRunMs: 180000, maxBatchChars: 9600, maxBatchItems: 4, maxLoadPerCpu: 0.7, minFreeMemoryRatio: 0.1,
    quotaReservePercent: 20, memoryPaths: [] };
  const state = initialState();
  await writeFile(source, '原规则\n旧事实\n');
  await ingest(root, config, state);
  assert.equal(state.pending.length, 0, 'existing rules are baselined, not replayed as new evidence');
  assert.equal(state.coverage[1].state, 'unavailable');
  await writeFile(source, '原规则\n更正后的事实\n');
  await ingest(root, config, state);
  assert.equal(state.pending.length, 1);
  assert.match(state.pending[0].excerpt, /\+2: 更正后的事实/);
  assert.match(state.pending[0].excerpt, /-2: 旧事实/);
  await ingest(root, config, state);
  assert.equal(state.pending.length, 1, 'same input is never counted twice');
  assert.match(changedLines('x\nx', 'x'), /-2/);
  const sections = join(root, 'sections.md'), sectionState = initialState();
  await writeFile(sections, '## AI labor\nallowed\n### Detail\nallowed too\n## Other\nexcluded\n');
  await ingest(root, { ...config, inputs: [{ path: sections, heading: '## AI labor' }] }, sectionState);
  assert.match(sectionState.pending[0].excerpt, /allowed too/);
  assert.doesNotMatch(sectionState.pending[0].excerpt, /excluded/);
  await writeFile(sections, '## Renamed\nunknown\n');
  await ingest(root, { ...config, inputs: [{ path: sections, heading: '## AI labor' }] }, sectionState);
  assert.equal(sectionState.coverage[0].state, 'unavailable');
  assert.equal(sectionState.pending.length, 1, 'missing section does not consume old material');
  const batch = selectBatch(state, config);
  const result = { batchId: batch.id, finding: '只记录事实修正，尚未证明方法效果', reviewedIds: batch.items.map(i => i.id),
    candidates: [{ kind: 'method', change: '核对原始来源', overlap: '已有规则', destination: '行动手册候选', validation: '后续独立任务对比', evidenceIds: [batch.items[0].id] }], validations: [] };
  assert.throws(() => validateResult({ ...result, reviewedIds: [] }, batch), /coverage/);
  assert.throws(() => validateResult({ ...result, candidates: [{ ...result.candidates[0], evidenceIds: ['invented'] }] }, batch), /provenance/);
  assert.throws(() => validateResult({ ...result, validations: [{ candidateId: 'invented', status: 'supported', evidenceIds: result.reviewedIds, reason: 'no' }] }, batch), /new evidence/);
  const active = { runId: 'run_test', sessionId: 'session_test', batch, at: new Date().toISOString() };
  state.attempts.push({ runId: active.runId, at: active.at });
  await commitReview(root, state, active, result);
  await commitReview(root, state, active, result);
  assert.equal(state.pending.length, 0); assert.equal(state.candidates.length, 1, 'idempotent commit');
  const oversized = Array.from({ length: 8 }, (_, i) => ({ ...state.candidates[0], id: `candidate-${i}`,
    change: 'x'.repeat(1600), overlap: 'x'.repeat(1600), validation: 'x'.repeat(1600), destination: 'x'.repeat(1600), history: [{ details: 'x'.repeat(100000) }] }));
  const context = selectBatch({ ...state, candidates: oversized }, config).candidates;
  assert.ok(JSON.stringify(context).length <= 6005);
  assert.ok(context.every(c => !c.history), 'old review histories cannot accumulate in the next model context');
  await ingest(root, config, state); assert.equal(state.pending.length, 0);
  const noIdle = { status: 'ready', sessions: [], idleSince: new Date().toISOString(), host: { loadPerCpu: 0.1, freeMemoryRatio: 0.5 } };
  assert.equal(resourceDecision(config, noIdle).trigger, false);
  assert.equal(resourceDecision(config, { ...noIdle, idleSince: new Date(Date.now() - 600000).toISOString() }).trigger, true);
  const own = { id: 's', activity: { run: { state: 'running' }, queue: { count: 0 }, compact: { state: 'idle' } } };
  assert.equal(resourceDecision(config, { ...noIdle, sessions: [own] }, 's').trigger, true);
  assert.equal(resourceDecision(config, { ...noIdle, sessions: [own] }, 'another').trigger, false);
  assert.equal(resourceDecision(config, { ...noIdle, sessions: [{ ...own, activity: { ...own.activity, queue: { count: 1 } } }] }, 's').trigger, false);
  assert.equal(resourceDecision(config, { ...noIdle, sessions: [own] }, 'another', Date.now(), true).trigger, true, 'claimed run ignores competing foreground');
  assert.equal(resourceDecision(config, { ...noIdle, host: { loadPerCpu: 2, freeMemoryRatio: 0.5 } }, 's', Date.now(), true).trigger, false, 'claimed run retains host protection');
  assert.equal(resourceDecision(config, { status: 'observing', sessions: [] }).trigger, false);
  assert.equal(budgetDecision(config, { ...initialState(), attempts: [{ at: new Date().toISOString() }, { at: new Date().toISOString() }] }).trigger, false);
  assert.equal(budgetDecision(config, { ...initialState(), attempts: [{ at: new Date(Date.now() - 22000000).toISOString(), tokens: 90000 }] }).trigger, false);

  // Native terminal state controls consumption. Cancellation cannot promote a staged result.
  await save(join(root, 'config.json'), config);
  let nativeState = 'cancelled';
  const worker = await createWorker(root, { client: {}, api: async path => {
    if (path.startsWith('/api/runs/')) return { run: { id: active.runId, sessionId: active.sessionId, state: nativeState } };
    if (path.startsWith('/api/usage/')) return { totals: { totalTokens: 1234 } };
    throw new Error('Unexpected mock request: ' + path);
  } });
  const original = { ...initialState(), pending: batch.items, active, attempts: [{ runId: active.runId, at: active.at }] };
  await save(join(root, 'state.json'), original); await save(join(root, `result-${active.runId}.json`), result);
  await worker.after(active.runId, active.sessionId);
  let finished = await read(join(root, 'state.json'));
  assert.equal(finished.pending.length, batch.items.length); assert.equal(finished.candidates.length, 0); assert.equal(finished.active, null);
  nativeState = 'completed'; await save(join(root, 'state.json'), original);
  await worker.after(active.runId, active.sessionId); await worker.after(active.runId, active.sessionId);
  finished = await read(join(root, 'state.json'));
  assert.equal(finished.pending.length, 0); assert.equal(finished.candidates.length, 1); assert.equal(finished.attempts[0].tokens, 1234);
  assert.ok((await readFile(join(root, 'reviews', `${active.runId}.json`), 'utf8')).includes(batch.id));
  await assert.rejects(worker.after(active.runId, 'wrong'), /ownership/);
  await transact(root, s => { s.marker = 'atomic'; }); assert.equal((await read(join(root, 'state.json'))).marker, 'atomic');
  console.log('Dreaming: incremental intake, provenance, resource/cost boundaries, terminal acceptance and idempotent recovery passed');

  // Real detached hook/guard against an isolated fake platform, never a live model.
  const liveRoot = join(root, 'lifecycle');
  let busy = false, hostOverload = false, stoppedRun = false, resolveCancel, resolveObserved;
  let runState = 'accepted';
  const observed = new Promise(resolve => { resolveObserved = resolve; });
  const cancelled = new Promise(resolve => { resolveCancel = resolve; });
  const server = createServer((req, res) => {
    if (req.url.startsWith('/?token=')) { res.writeHead(302, { 'set-cookie': 'test=dreaming' }); res.end(); return; }
    let data;
    if (req.url === '/api/automation/resources') data = { resources: { ...noIdle, idleSince: new Date(Date.now() - 600000).toISOString(), sessions: busy ? [own] : [], host: hostOverload ? { loadPerCpu: 2, freeMemoryRatio: 0.5 } : noIdle.host } };
    else if (req.url === '/api/schedules') data = { schedules: busy ? [{ id: 'other', enabled: true, gate: { mode: 'direct' }, nextRunAt: new Date().toISOString() }] : [] };
    else if (req.url.startsWith('/api/codex-auth/rate-limits')) data = { codexUsage: { status: 'ready', checkedAt: new Date().toISOString(), accountRevision: 'test', buckets: [{ id: 'codex', primary: { remainingPercent: 90 } }] } };
    else if (req.url === '/api/codex-auth/status') { data = { codexAuth: { accountRevision: 'test' } }; if (busy) resolveObserved(); }
    else if (req.url === '/api/runs/run_guard/cancel') { stoppedRun = true; data = { ok: true }; resolveCancel(); setImmediate(() => { for (const ws of wss.clients) ws.send(JSON.stringify({ type: 'session_invalidated', sessionId: 'guard-session' })); }); }
    else if (req.url === '/api/runs/run_guard') data = { run: { id: 'run_guard', sessionId: 'guard-session', state: stoppedRun ? 'cancelled' : runState } };
    else if (req.url.startsWith('/api/usage/')) data = { totals: { totalTokens: 0 } };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authFile = join(root, 'auth.json');
  await save(authFile, { version: 2, people: [], serviceToken: 'isolated-test-token' });
  await save(join(liveRoot, 'config.json'), { ...config, inputs: [{ path: source }], authFile, baseUrl: `http://127.0.0.1:${server.address().port}` });
  const real = await createWorker(liveRoot);
  try {
    assert.equal((await real.before('run_guard', 'guard-session')).trigger, true, 'real guard ready before launch');
    const guardState = await read(join(liveRoot, 'state.json'));
    assert.equal(guardState.attempts.length, 1);
    assert.equal((await real.before('run_guard', 'guard-session')).trigger, true, 'retry reuses the guard and admission');
    assert.equal((await read(join(liveRoot, 'state.json'))).attempts.length, 1);
    runState = 'running';
    assert.equal((await real.claim('run_guard', 'guard-session')).proceed, true);
    const claimed = (await read(join(liveRoot, 'state.json'))).attempts[0];
    assert.ok(claimed.claimedAt, 'a successful model claim establishes actual execution');
    assert.equal(claimed.batchItemCount, guardState.active.batch.items.length);
    busy = true;
    for (const ws of wss.clients) ws.send(JSON.stringify({ type: 'sessions_invalidated' }));
    let observationTimeout;
    try { await Promise.race([observed, new Promise((_, reject) => { observationTimeout = setTimeout(() => reject(new Error('Guard did not inspect foreground event')), 5000); })]); }
    finally { clearTimeout(observationTimeout); }
    assert.equal((await real.claim('run_guard', 'guard-session')).proceed, true, 'claim retry retains successful admission during foreground work');
    const liveBatch = guardState.active.batch;
    await save(join(liveRoot, 'draft-run_guard.json'), { batchId: liveBatch.id, finding: 'isolated test', reviewedIds: liveBatch.items.map(i => i.id), candidates: [], validations: [] });
    assert.equal((await real.finish('run_guard', 'guard-session')).staged, true, 'finish succeeds despite foreground and due schedules');
    assert.equal(stoppedRun, false, 'foreground event after claim does not cancel');
    hostOverload = true;
    for (const ws of wss.clients) ws.send(JSON.stringify({ type: 'sessions_invalidated' }));
    let timeout;
    try { await Promise.race([cancelled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Guard did not yield')), 5000); })]); }
    finally { clearTimeout(timeout); }
    assert.match((await read(join(liveRoot, 'stop-run_guard.json'))).reason, /主机/);
    await real.after('run_guard', 'guard-session');
    assert.equal((await read(join(liveRoot, 'state.json'))).active, null);
    console.log('Dreaming: real prelaunch readiness, retry reuse, claimed-run foreground continuity, finish, host protection and terminal recovery passed');
  } catch (error) {
    console.error(await readFile(join(liveRoot, 'guard-run_guard.log'), 'utf8').catch(() => 'no guard log'));
    console.error(await readFile(join(liveRoot, 'audit.jsonl'), 'utf8').catch(() => 'no audit'));
    throw error;
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
} finally { await rm(root, { recursive: true, force: true }); }

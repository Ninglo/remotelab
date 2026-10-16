import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { createRequestRuntime } from '../chat/request-runtime.mjs';
import { createRequestCompletion } from '../chat/request-completion.mjs';
import { createFeishuReadPacer } from '../lib/feishu-read-pacer.mjs';
const root = await mkdtemp(join(tmpdir(), 'core-async-'));
setIsolatedTestHome(root);
const runs = await import('../chat/runs.mjs');
const { createRequestStore } = await import('../chat/requests.mjs');
const { createNativeRequestDispatcher } = await import('../chat/native-request-dispatch.mjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let runtime, child;
try {
  const store = createRequestStore(join(root, 'requests'));
  const head = (await store.accept({ sessionId: 's', requestId: 'head', text: 'head' })).record;
  const queued = (await store.accept({ sessionId: 's', requestId: 'queued', text: 'queued' })).record;
  const entered = deferred(), prepare = deferred();
  runtime = createRequestRuntime({ store, prepare: async () => { entered.resolve(); await prepare.promise; },
    observe: () => {}, reconcile: async () => {}, onError: e => { throw e; } });
  const active = runtime.tick('s'); await entered.promise;
  await runtime.removeQueued('s', 'queued');
  assert.equal((await store.get(queued.key)).result.state, 'cancelled', 'queued removal does not await slow preparation');
  await assert.rejects(runtime.removeQueued('s', 'head'), { code: 'REQUEST_NOT_QUEUED' });
  prepare.resolve(); await active; runtime.stop(); await runtime.idle();

  const forwarded = (await store.accept({ sessionId: 's', requestId: 'native', text: 'supplement' })).record;
  const nativeEntered = deferred(), nativePrepared = deferred(); let recorded = 0;
  const dispatcher = createNativeRequestDispatcher({ store, getManifest: async () => ({ inputMode: 'native' }),
    getRun: async () => ({ state: 'running' }), prepareInput: async () => { nativeEntered.resolve(); await nativePrepared.promise; return 'text'; },
    changed: async () => {}, recordInput: async () => { recorded++; }, runDirectory: () => root,
    settle: async () => {}, onError: e => { throw e; } });
  runtime = createRequestRuntime({ store, prepare: async () => {}, observe: () => {}, reconcile: async () => {},
    forward: (r,h) => dispatcher.forward(r,h), onError: e => { throw e; } });
  const forwarding = runtime.tick('s'); await nativeEntered.promise;
  await runtime.removeQueued('s', forwarded.requestId);
  nativePrepared.resolve(); await forwarding;
  assert.equal(recorded, 0, 'a late prepared supplement cannot resurrect a withdrawn request');
  runtime.stop(); await runtime.idle();

  await store.settle(head.key, { state: 'completed' });
  await store.mutate(head.key, r => ({ ...r, releasedAt: 'done' }));
  let clock = 0, good = 0, bad = 0;
  const slow = deferred(), independent = deferred();
  const complete = createRequestCompletion({ store, now: () => clock, retryMs: 10 });
  const effects = { good: async () => { good++; independent.resolve(); },
    bad: async () => { bad++; if (bad === 1) throw Error('integration unavailable'); }, slow: () => slow.promise };
  const completing = complete(head, effects); await independent.promise;
  assert.equal(good, 1, 'independent completion runs while another effect is still pending');
  // Let the independent failure receipt commit while the slow effect stays blocked.
  await new Promise(setImmediate); await store.idle();
  clock = 20;
  await complete(head, effects, { wait: false });
  await new Promise(setImmediate); await store.idle();
  assert.equal(bad, 2, 'a stalled effect cannot prevent another effect retrying');
  assert.equal((await store.get(head.key)).postCompletionPending, true);
  slow.resolve(); await completing;
  await createRequestCompletion({ store, now: () => clock, retryMs: 10 })(head, effects);
  assert.equal(good, 1, 'completed effects are not replayed after restart');
  assert.equal(bad, 2); assert.equal((await store.get(head.key)).postCompletionPending, false);

  const pace = createFeishuReadPacer({ intervalMs: 0 });
  const blocked = deferred(), started = deferred();
  const first = pace(() => { started.resolve(); return blocked.promise; }); await started.promise;
  assert.equal(await pace(async () => 'independent'), 'independent', 'read pacing does not wait for preceding responses');
  blocked.resolve(); await first;

  const run = await runs.createRun({ status: { sessionId: 'ownership' }, manifest: {} });
  const fixture = join(root, 'writer.mjs');
  await writeFile(fixture, `import { updateExecutionRun } from ${JSON.stringify(new URL('../chat/runs.mjs', import.meta.url).href)};
await updateExecutionRun(${JSON.stringify(run.id)}, { state: 'running', toolProcessId: 123 });
await updateExecutionRun(${JSON.stringify(run.id)}, r => { process.send('entered'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); return {...r,state:'completed'}; });`);
  child = fork(fixture, [], { env: process.env, stdio: ['ignore','ignore','inherit','ipc'] });
  await once(child, 'message');
  await runs.requestRunCancel(run.id);
  await runs.updateRun(run.id, { normalizedByteOffset: 99 });
  const current = await runs.getRun(run.id);
  assert.equal(current.cancelRequested, true); assert.equal(current.toolProcessId, 123);
  assert.equal(current.normalizedByteOffset, 99);
  await assert.rejects(stat(join(runs.runDir(run.id), '.mutation-lock')), { code: 'ENOENT' });
  const exited = once(child,'exit'); child.kill('SIGKILL'); await exited;
  const inferred = { exitCode: 1, error: 'missing' };
  await runs.writeRunResult(run.id, inferred, { onlyIfMissing: true });
  await runs.updateRecoveryRun(run.id, { state: 'failed', result: inferred });
  await runs.updateExecutionRun(run.id, current => ({ ...current, toolProcessId: 456 }));
  assert.equal(JSON.parse(await readFile(join(runs.runDir(run.id), 'execution.json'), 'utf8')).state, 'running',
    'an unrelated executor update must not adopt a recovery inference as fact');
  const real = { exitCode: 0, completedAt: new Date().toISOString() };
  await runs.writeRunResult(run.id, real);
  await runs.updateExecutionRun(run.id, { state: 'completed', result: real, failureReason: null });
  assert.deepEqual(await runs.getRunResult(run.id), real);
  assert.equal((await runs.getRun(run.id)).state, 'completed', 'real execution wins over recovery inference');
  assert.equal((await runs.getRun(run.id)).cancelRequested, true, 'execution completion cannot erase cancellation intent');
  assert.equal((await runs.getRun(run.id)).normalizedByteOffset, 99);

  const spool = join(runs.runDir(run.id), 'spool.jsonl');
  await writeFile(spool, '{"line":"par');
  const partial = await runs.readRunSpoolDelta(run.id);
  assert.equal(partial.nextOffset, 0); assert.deepEqual(partial.records, []);
  await appendFile(spool, 'tial"}\n');
  const full = await runs.readRunSpoolDelta(run.id, { startOffset: partial.nextOffset });
  assert.equal(full.records[0].line, 'partial', 'file events cannot discard an incomplete spool record');
  const manager = await import('../chat/session-manager.mjs');
  const metadata = await import('../chat/session-meta-store.mjs');
  const session = await manager.createSession(root, 'codex', 'read-only queries');
  const terminalRun = await runs.createRun({ status: { sessionId: session.id, state: 'completed' }, manifest: {} });
  await metadata.mutateSessionMeta(session.id, draft => { draft.activeRunId = terminalRun.id; return true; });
  const beforeMeta = await readFile(join(root, '.config/remotelab/chat-sessions.json'), 'utf8');
  const beforeRun = await readFile(join(runs.runDir(terminalRun.id), 'status.json'), 'utf8');
  await manager.getSession(session.id);
  await manager.listSessions();
  await manager.getHistory(session.id);
  await manager.getRunState(terminalRun.id);
  assert.equal(await readFile(join(root, '.config/remotelab/chat-sessions.json'), 'utf8'), beforeMeta);
  assert.equal(await readFile(join(runs.runDir(terminalRun.id), 'status.json'), 'utf8'), beforeRun,
    'queries cannot finalize execution or mutate its state');
  await manager.killAll();
  console.log('core async boundaries: withdrawal, native preparation race, completion isolation/restart, paced starts, cross-process ownership, late result and partial spool passed');
} finally {
  runtime?.stop(); if (child && child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

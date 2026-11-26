import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-run-reconciler-'));
setIsolatedTestHome(home);
try {
  const runs = await import('../chat/runs.mjs');
  const { createDetachedRunReconciler } = await import('../chat/run-reconciler.mjs');
  const { readProcessIdentity } = await import('../lib/process-identity.mjs');
  const old = new Date(Date.now() - 60_000).toISOString();
  const success = { completedAt: new Date().toISOString(), exitCode: 0, signal: null, cancelled: false };
  const makeRun = () => runs.createRun({ status: {
    sessionId: 'reconciliation-test', state: 'running', runnerProcessId: 2147483647,
  }, manifest: {} });
  const reconcile = (overrides = {}) => createDetachedRunReconciler({
    ...runs, graceMs: 5_000, nowIso: () => new Date().toISOString(),
    collectRunOutputPreview: async () => '', ...overrides,
  });

  // The controller read "no result" while the runner was still finishing.
  // Before liveness checking, the runner committed success and exited.
  const finished = await makeRun();
  const stale = await runs.updateRun(finished.id, { missingResultDetectedAt: old });
  await runs.writeRunResult(finished.id, success);
  await runs.updateRun(finished.id, { state: 'completed', result: success });
  await reconcile()(finished.id, stale);
  assert.deepEqual(await runs.getRunResult(finished.id), success,
    'a stale running snapshot must not overwrite a completed runner result');
  assert.equal((await runs.getRun(finished.id)).state, 'completed');
  assert.deepEqual(await runs.readRunSpoolRecords(finished.id), [], 'no false failure diagnostic');

  // Startup can briefly lack a launch receipt. Observing a live process must
  // reset that observation, so a later disappearance gets a fresh grace period.
  const recovered = await makeRun();
  await reconcile()(recovered.id, recovered);
  assert.ok((await runs.getRun(recovered.id)).missingResultDetectedAt);
  await runs.updateRun(recovered.id, { missingResultDetectedAt: old });
  await writeFile(join(runs.runDir(recovered.id), 'launch.json'), JSON.stringify({
    identity: await readProcessIdentity(process.pid),
  }));
  await reconcile()(recovered.id, await runs.getRun(recovered.id));
  assert.equal((await runs.getRun(recovered.id)).missingResultDetectedAt, null);
  await rm(join(runs.runDir(recovered.id), 'launch.json'));
  await reconcile()(recovered.id, await runs.getRun(recovered.id));
  assert.equal(await runs.getRunResult(recovered.id), null, 'later loss gets its own grace period');
  await runs.updateRun(recovered.id, { missingResultDetectedAt: old });
  await reconcile()(recovered.id, await runs.getRun(recovered.id));
  assert.match((await runs.getRunResult(recovered.id)).error, /Detached runner disappeared/,
    'a real disappearance must still fail after the grace period');

  // During pre-claim startup the process is real even before a single tool
  // event. A reused PID or a live losing launcher must not hide owner loss.
  const identity = await readProcessIdentity(process.pid);
  const starting = await makeRun();
  const preclaim = await runs.updateRun(starting.id, { state: 'accepted', runnerProcessId: process.pid,
    runnerSpawnIdentity: identity, missingResultDetectedAt: old });
  await reconcile()(starting.id, preclaim);
  assert.equal(await runs.getRunResult(starting.id), null);
  assert.equal((await runs.getRun(starting.id)).missingResultDetectedAt, null);
  const reused = { ...identity, birth: 'different-process' };
  const claimedPath = join(runs.runDir(starting.id), 'launch.json');
  await writeFile(claimedPath, JSON.stringify({ identity: reused }));
  await reconcile()(starting.id, await runs.updateRun(starting.id, { missingResultDetectedAt: old }));
  assert.match((await runs.getRunResult(starting.id)).error, /Detached runner disappeared/);

  const lateClaim = await makeRun();
  await reconcile({ collectRunOutputPreview: async () => {
    await writeFile(join(runs.runDir(lateClaim.id), 'launch.json'), JSON.stringify({ identity }));
    return '';
  } })(lateClaim.id, await runs.updateRun(lateClaim.id, { missingResultDetectedAt: old }));
  assert.equal(await runs.getRunResult(lateClaim.id), null);
  assert.equal((await runs.getRun(lateClaim.id)).missingResultDetectedAt, null);

  // A result may arrive during slow diagnostic work, after the fresh read.
  const late = await makeRun();
  const lateSnapshot = await runs.updateRun(late.id, { missingResultDetectedAt: old });
  await reconcile({ collectRunOutputPreview: async () => {
    await runs.writeRunResult(late.id, success);
    return 'provider completed';
  } })(late.id, lateSnapshot);
  assert.deepEqual(await runs.getRunResult(late.id), success,
    'conditional result commit must preserve a late result even without terminal status');
  assert.deepEqual(await runs.readRunSpoolRecords(late.id), []);

  // A cancellation needs no grace period and must not be reported as failure.
  const cancelled = await makeRun();
  await reconcile()(cancelled.id, await runs.updateRun(cancelled.id, { cancelRequested: true }));
  assert.equal((await runs.getRun(cancelled.id)).state, 'cancelled');
  assert.equal((await runs.getRunResult(cancelled.id)).cancelled, true);
  assert.equal((await runs.getRunResult(cancelled.id)).error, undefined);
  console.log('test-run-reconciler: ok (completion race, recovered liveness, late result, genuine loss, cancellation)');
} finally {
  await rm(home, { recursive: true, force: true });
}

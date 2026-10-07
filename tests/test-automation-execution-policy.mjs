import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = await mkdtemp(join(tmpdir(), 'automation-hook-recovery-'));
process.env.REMOTELAB_CONFIG_DIR = home;
process.env.REMOTELAB_MEMORY_DIR = join(home, 'memory');
const policy = await import('../lib/automation-execution-policy.mjs');
try {
  assert.throws(() => policy.normalizeAutomationPolicy({ minIdleSeconds: -1 }), /minIdleSeconds/);
  assert.throws(() => policy.normalizeAutomationPolicy({ beforeLaunch: { mode: 'direct' } }), /script/);
  const automationPolicy = policy.normalizeAutomationPolicy({ minIdleSeconds: 300,
    afterRun: { mode: 'script', runtime: 'bash', source: 'echo yes' } });
  const manifest = { folder: home, scheduleId: 'fixture-task', automationPolicy };
  let run = { id: 'fixture-cancelled', sessionId: 'fixture-session', state: 'running' };
  const updateRun = async (id, fn) => { assert.equal(id, run.id); run = fn(run); return run; };
  await policy.registerAutomationHook(run.id, manifest);
  await policy.registerAutomationHook(run.id, manifest);
  const pendingFile = join(home, 'automation-execution-hooks.json');
  assert.deepEqual(JSON.parse(await readFile(pendingFile)), [run.id], 'restart intent is durable and deduplicated');
  let observed = 0;
  const options = { getRun: async () => run, getManifest: async () => manifest,
    observe: () => observed++, updateRun };
  await policy.recoverAutomationHooks(options); assert.equal(observed, 1);
  run = { ...run, state: 'cancelled', finalizedAt: new Date().toISOString() };
  // Recover the same on-disk intent through a fresh module instance. No model
  // runner, worker guard or foreground request is available to do this work.
  const restarted = await import('../lib/automation-execution-policy.mjs?restart-fixture');
  await Promise.all(await restarted.recoverAutomationHooks(options));
  await restarted.reconcileAutomationHook(run, manifest, { updateRun });
  assert.ok(run.automationHookCompletedAt);
  assert.deepEqual(JSON.parse(await readFile(pendingFile)), []);
  console.log('automation hooks: independent cancellation accounting and durable restart recovery passed');
} finally { await rm(home, { recursive: true, force: true }); }

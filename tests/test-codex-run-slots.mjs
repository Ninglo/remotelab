import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-run-slots-'));
setIsolatedTestHome(root);
const { CodexAccounts } = await import('../lib/codex-accounts.mjs');
const { readProcessIdentity } = await import('../lib/process-identity.mjs');
const home = join(root, 'default');
const pool = new CodexAccounts({ root: join(root, 'accounts'), defaultHome: home });
const directory = join(pool.root, 'runs', createHash('sha256').update(home).digest('hex'));
const ownerFile = key => join(directory, key, 'active.lock', 'owner.json');
const acquire = options => pool.acquireForRun({ waitTimeoutMs: 5000, ...options });
const blocked = error => error.code === 'CODEX_ACCOUNT_CAPACITY_WAIT' && error.routingReasons.occupancy_unknown === 1;
let runner, toolPid;
try {
  await pool.mutate(data => Object.assign(data.accounts[0], { account: { type: 'chatgpt' }, maxConcurrent: 1, priority: 1 }));
  const slot = await acquire({});
  for (const body of ['', '{"leaseId":', '{}']) {
    await writeFile(ownerFile(slot.lease.queueKey), body);
    await assert.rejects(acquire({ wait: false }), blocked);
  }
  await assert.rejects(acquire({ waitTimeoutMs: 30 }), { code: 'CODEX_ACCOUNT_OCCUPANCY_UNCONFIRMED' });
  const fallback = await pool.add('Other shared account');
  await pool.mutate(data => { data.accounts.find(a => a.id === fallback.id).account = { type: 'chatgpt' }; });
  const otherSlot = await acquire({ wait: false });
  assert.equal(otherSlot.id, fallback.id, 'unknown slot does not block other eligible accounts');
  await otherSlot.lease.release();
  await pool.setRoutingEnabled(fallback.id, false);
  await pool.setRoutingSettings('default', { maxConcurrent: 2 });
  const safeSlot = await acquire({ wait: false });
  assert.equal(safeSlot.id, 'default', 'unknown slot reserves only one place');
  await safeSlot.lease.release();
  await pool.setRoutingSettings('default', { maxConcurrent: 1 });
  const next = await acquire({ onWait: async info => {
    assert.equal(info.reasons.occupancy_unknown, 1);
    assert.equal(await slot.lease.release(), true, 'corrupt owner must not strand a normally finishing slot');
  } });
  assert.equal(await slot.lease.release(), false);
  assert.equal(await slot.lease.setToolProcessId(process.pid), false, 'late PID update must not resurrect old slot');
  const publication = next.lease.setToolProcessId(process.pid);
  assert.equal(await next.lease.release(), true);
  assert.equal(await publication, true);

  const legacy = randomUUID();
  await mkdir(join(directory, legacy, 'active.lock'), { recursive: true });
  await writeFile(ownerFile(legacy), '');
  await assert.rejects(acquire({ wait: false }), blocked);
  await rm(join(directory, legacy), { recursive: true });

  if (process.platform !== 'win32') {
    const runId = 'run_' + 'a'.repeat(24);
    const key = `slot-${runId}-${randomUUID()}`;
    runner = spawn(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e','setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
      child.on('spawn', () => console.log(child.pid));
      child.on('exit', () => process.exit());
    `], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const [ready] = await once(runner.stdout, 'data');
    toolPid = Number(String(ready).trim());
    assert(toolPid > 0);
    const run = join(root, 'chat-runs', runId);
    await mkdir(run, { recursive: true });
    const identity = await readProcessIdentity(runner.pid);
    assert(identity);
    await writeFile(join(run, 'launch.json'), JSON.stringify({ runId, pid: runner.pid, identity }));
    await writeFile(join(run, 'execution.json'), JSON.stringify({ runnerProcessId: runner.pid, runnerLaunchMode: 'detached-process' }));
    await mkdir(join(directory, key, 'active.lock'), { recursive: true });
    await writeFile(ownerFile(key), '{');
    const exited = once(runner, 'exit');
    runner.kill('SIGKILL');
    await exited;
    await assert.rejects(acquire({ wait: false }), error => error.routingReasons.at_capacity === 1,
      'child survives its runner, even before the child PID was recorded');
    process.kill(toolPid, 'SIGTERM');
    toolPid = null;
    await rm(join(directory, key), { recursive: true });

    // Use a separate group with no orphaned children to make the exit check
    // portable to test containers whose PID 1 does not reap orphan zombies.
    runner = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
      { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    await once(runner.stdout, 'data');
    const deadIdentity = await readProcessIdentity(runner.pid);
    assert(deadIdentity);
    await writeFile(join(run, 'launch.json'), JSON.stringify({ runId, pid: runner.pid, identity: deadIdentity }));
    await writeFile(join(run, 'execution.json'), JSON.stringify({ runnerProcessId: runner.pid, runnerLaunchMode: 'detached-process' }));
    const deadKey = `slot-${runId}-${randomUUID()}`;
    await mkdir(join(directory, deadKey, 'active.lock'), { recursive: true });
    await writeFile(ownerFile(deadKey), '{');
    const allExited = once(runner, 'exit');
    runner.kill('SIGKILL');
    await allExited;
    const recovered = await acquire({ wait: false });
    assert.equal(recovered.allocation.activeBefore, 0);
    await recovered.lease.release();
  }
  console.log('Codex run slots: corrupt reads, scoped timeout, fallback, release, legacy safety and detached child recovery passed');
} finally {
  if (toolPid) { try { process.kill(toolPid, 'SIGKILL'); } catch {} }
  if (runner?.exitCode == null && runner?.signalCode == null) runner?.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

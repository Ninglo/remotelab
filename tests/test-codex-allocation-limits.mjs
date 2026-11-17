import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-allocation-limits-'));
setIsolatedTestHome(root);
const { CodexAccounts } = await import('../lib/codex-accounts.mjs');
const { bindSessionAccount } = await import('../lib/codex-session-routing.mjs');
const pool = new CodexAccounts({ root: join(root, 'accounts'), defaultHome: join(root, 'default') });
const held = [];
let child;
const acquire = async (sessionId, options = {}) => {
  const slot = await pool.acquireForRun({ sessionId, waitTimeoutMs: 5000, ...options }); held.push(slot); return slot;
};
const releaseAll = async () => { await Promise.all(held.splice(0).map(s => s.lease.release())); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
try {
  const a = await pool.add('Limited A'), alias = await pool.add('A alias'), b = await pool.add('Limited B');
  const personal = await pool.ensurePersonalAccount('person_fixture');
  await pool.mutate(data => {
    for (const account of data.accounts) {
      account.identityId = account.id === alias.id ? a.id : account.id;
      account.account = { type: 'chatgpt' };
      account.usage = { status: 'ready', checkedAt: new Date().toISOString(), buckets: [
        { id: 'codex', primary: { remainingPercent: 80, resetsAt: new Date(Date.now() + 3600000).toISOString() } },
      ] };
    }
  });
  await pool.setRoutingSettings('default', { maxConcurrent: null, priority: 2 });
  await pool.setRoutingSettings(a.id, { maxConcurrent: 3, priority: 1 });
  await pool.setRoutingSettings(b.id, { maxConcurrent: 3, priority: 1 });
  assert.equal((await pool.account(alias.id)).maxConcurrent, 3);
  for (const patch of [{ maxConcurrent: 0 }, { maxConcurrent: -1 }, { maxConcurrent: 1.5 }, { maxConcurrent: '3' },
    { priority: -1 }, { priority: null }, { priority: 1.5 }, {}]) {
    await assert.rejects(pool.setRoutingSettings(a.id, patch));
  }
  await assert.rejects(pool.setRoutingSettings(personal.id, { maxConcurrent: 3 }));
  const batch = await Promise.all(Array.from({ length: 30 }, (_, i) => acquire('burst-' + i)));
  assert.equal(batch.filter(s => s.id === a.id || s.id === alias.id).length, 3, 'aliases share the cap');
  assert.equal(batch.filter(s => s.id === b.id).length, 3);
  assert.equal(batch.filter(s => s.id === 'default').length, 24, 'overflow uses unlimited lower priority');
  assert(!batch.some(s => s.id === personal.id));
  const status = await pool.list();
  assert.equal(status.accounts.find(s => s.id === a.id).activeExecutions, 3);
  assert.equal(status.accounts.find(s => s.id === a.id).routingState, 'at_capacity');
  await releaseAll();

  await bindSessionAccount(pool.root, 'old-automation', await pool.account('default'), 'old', Date.now());
  assert.notEqual((await acquire('old-automation')).id, 'default', 'priority wins over old Session affinity');
  await releaseAll();
  await pool.policy(undefined, undefined, [a.id]);
  await pool.setRoutingSettings(a.id, { maxConcurrent: 1 });
  let owner = await acquire('same-session');
  await assert.rejects(acquire('same-session', { wait: false }), { code: 'CODEX_ACCOUNT_CAPACITY_WAIT' },
    'an independent helper in the same Session cannot bypass the cap');
  const entered = deferred();
  const queued = acquire('queued', { onWait: entered.resolve });
  await entered.promise;
  assert.equal((await pool.list()).waitingCount, 1);
  await owner.lease.release();
  owner = await queued;
  assert.equal((await pool.list()).waitingCount, 0);

  const cancelled = deferred(); let cancel = false;
  const cancelledWork = acquire('cancelled', { onWait: cancelled.resolve, isCancelled: () => cancel });
  const cancellation = assert.rejects(cancelledWork, { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
  await cancelled.promise; cancel = true;
  await pool.setRoutingSettings(a.id, { priority: 1 });
  await cancellation;
  assert.equal((await pool.list()).waitingCount, 0);
  await assert.rejects(acquire('deadline', { waitTimeoutMs: 20 }), { code: 'CODEX_ACCOUNT_WAIT_TIMEOUT' });
  assert.equal((await pool.list()).waitingCount, 0);

  const expanding = deferred();
  const expanded = acquire('expanded', { onWait: expanding.resolve });
  await expanding.promise;
  await pool.setRoutingSettings(alias.id, { maxConcurrent: 2 });
  await expanded;
  await pool.setRoutingSettings(a.id, { maxConcurrent: 1 });
  assert.equal((await pool.list()).accounts.find(s => s.id === a.id).activeExecutions, 2, 'shrinking drains without killing');
  await assert.rejects(acquire('over-lowered-limit', { wait: false }), { code: 'CODEX_ACCOUNT_CAPACITY_WAIT' });
  await releaseAll();
  const restarted = new CodexAccounts({ root: pool.root, defaultHome: pool.defaultHome });
  const resumed = await restarted.acquireForRun({ sessionId: 'restarted' });
  assert.equal(resumed.allocation.maxConcurrent, 1); await resumed.lease.release();

  const moduleUrl = new URL('../lib/codex-accounts.mjs', import.meta.url).href;
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {CodexAccounts} from ${JSON.stringify(moduleUrl)};
    const p = new CodexAccounts({root: process.argv[1], defaultHome: process.argv[2]});
    await p.acquireForRun({sessionId:'crash-owner'});
    process.stdout.write('ready\\n'); setInterval(()=>{},1000);
  `, pool.root, pool.defaultHome], { stdio: ['ignore', 'pipe', 'pipe'] });
  const childReady = deferred(); let output = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) childReady.resolve(); });
  let childError = ''; child.stderr.on('data', chunk => { childError += chunk; });
  const startupDeadline = setTimeout(() => childReady.resolve(), 5000);
  await childReady.promise; clearTimeout(startupDeadline); assert.match(output, /ready/, childError);
  const afterCrashWaiting = deferred();
  const afterCrash = acquire('after-crash', { onWait: afterCrashWaiting.resolve });
  await afterCrashWaiting.promise;
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const recovered = await afterCrash;
  assert.equal(recovered.id, a.id, 'dead runner slot is recovered without a release notification');
  await releaseAll();

  await pool.mutate(data => { data.accounts.find(x => x.id === a.id).cooldownUntil = Date.now() + 80; });
  const cooling = deferred();
  const cooled = acquire('after-cooldown', { onWait: cooling.resolve }); await cooling.promise; await cooled;
  await releaseAll();
  await pool.policy(undefined, undefined, []);
  await assert.rejects(acquire('disabled-pool'), { code: 'CODEX_NO_AVAILABLE_ACCOUNT' });
  console.log('Allocation limits: concurrent overflow, aliases, priority, helpers, wait/release, config wake, cancellation, deadline, drain, restart and crash recovery passed');
} finally {
  child?.kill('SIGKILL'); await releaseAll(); await rm(root, { recursive: true, force: true });
}

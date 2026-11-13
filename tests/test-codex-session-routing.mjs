import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts } from '../lib/codex-accounts.mjs';
import { readSessionAccount } from '../lib/codex-session-routing.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-session-routing-'));
let now = Date.now();
const pool = new CodexAccounts({ root: join(root, 'codex-accounts'), defaultHome: join(root, 'default'), now: () => now });
const usage = remaining => ({ status: 'ready', checkedAt: new Date(now).toISOString(), buckets: [
  { id: 'codex', primary: { remainingPercent: remaining, resetsAt: new Date(now + 3600000).toISOString() } },
] });
const slots = [];
const acquire = async sessionId => { const slot = await pool.acquireForRun({ sessionId }); slots.push(slot); return slot; };
try {
  const a = await pool.add('A'), b = await pool.add('B'), alias = await pool.add('A duplicate'), signedOut = await pool.add('not logged in');
  await pool.mutate(data => {
    for (const account of data.accounts) {
      if (account.id === signedOut.id) continue;
      account.identityId = account.id === alias.id ? a.id : account.id;
      account.account = { type: 'chatgpt' }; account.usage = usage(100);
    }
  });
  const oldDir = join(root, 'chat-runs', 'run_' + 'a'.repeat(24)); await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'status.json'), JSON.stringify({ sessionId: 'legacy', codexAccount: { id: b.id, selectedAt: new Date(now).toISOString() } }));
  await pool.policy(undefined, true);
  assert.equal((await readSessionAccount(pool.root, 'legacy')).accountId, b.id);
  const batch = await Promise.all(Array.from({ length: 12 }, (_, n) => acquire('new-' + n)));
  const counts = Object.values(batch.reduce((totals, slot) => { totals[slot.id] = (totals[slot.id] || 0) + 1; return totals; }, {}));
  assert.deepEqual(counts, [4, 4, 4], 'simultaneous Sessions share independent accounts evenly, including startup reservations');
  assert(!batch.some(slot => slot.id === signedOut.id));
  assert.equal(new Set(batch.map(slot => slot.id)).size, 3, 'duplicate subscription is not extra capacity');
  const first = batch[0];
  await pool.select(first.id === b.id ? a.id : b.id);
  assert.equal((await acquire('new-0')).id, first.id, 'a changed default never moves a bound conversation');
  await Promise.all(slots.map(slot => slot.lease.release())); slots.length = 0;
  const restarted = new CodexAccounts({ root: pool.root, defaultHome: pool.defaultHome, now: () => now });
  const continued = await restarted.acquireForRun({ sessionId: 'new-0' });
  assert.equal(continued.id, first.id); await continued.lease.release();
  await pool.markRateLimited(first.id);
  await assert.rejects(acquire('new-0'), /限流冷却.*自动切换已关闭/);
  const other = await acquire('after-429'); assert.notEqual(other.id, first.id);
  await other.lease.release();
  await pool.markRateLimited(a.id);
  assert.equal((await pool.account(alias.id)).cooldownUntil, (await pool.account(a.id)).cooldownUntil,
    'a duplicate login cannot bypass its subscription cooldown');
  now += 61_000;
  assert.equal((await acquire('new-0')).id, first.id, 'cooldown recovery keeps the same account');
  await pool.policy(undefined, false);
  assert.equal((await acquire('new-0')).id, first.id, 'turning balancing off preserves bindings');
  await pool.policy(undefined, true);
  await pool.mutate(data => { for (const account of data.accounts) account.usage = usage(0); });
  await assert.rejects(acquire('all-exhausted'), /暂无可用/);
  await assert.rejects(acquire('new-0'), /额度已耗尽.*自动切换已关闭/);
  await pool.mutate(data => { for (const account of data.accounts) account.usage = usage(100); });
  // Healthy accounts refresh at different times in real installations. A stale
  // sample must not make an idle account lose to an already busy fresh one.
  await Promise.all(slots.map(slot => slot.lease.release())); slots.length = 0;
  await pool.mutate(data => {
    for (const account of data.accounts) {
      delete account.cooldownUntil;
      if (account.id !== b.id) account.usage = { ...usage(100), checkedAt: new Date(now - 61_000).toISOString() };
    }
  });
  const held = await acquire('legacy'); assert.equal(held.id, b.id);
  const idle = await acquire('stale-but-idle'); assert.notEqual(idle.id, b.id,
    'quota freshness never outweighs lower execution load');
  await held.lease.release(); await idle.lease.release();
  await pool.mutate(data => {
    data.pendingSessions = {};
    for (const account of data.accounts) { account.lastAssignedSequence = 0; account.usage = usage(100); }
  });
  const background = await acquire('legacy');
  const prepared = [];
  for (let n = 0; n < 3; n++) {
    const helper = await acquire('prepared-' + n); prepared.push(helper.id); await helper.lease.release();
  }
  assert.equal(new Set(prepared).size, 3, 'completed helpers retain startup reservations instead of repeatedly selecting a briefly idle account');
  const primary = await pool.acquireForRun({ sessionId: 'prepared-0', runId: 'primary' }); slots.push(primary);
  assert.equal(primary.id, prepared[0]);
  assert.equal((await pool.read()).pendingSessions['prepared-0'], undefined, 'main runner replaces the startup reservation');
  await primary.lease.release(); await background.lease.release();
  await assert.rejects(pool.acquireForRun({ sessionId: 'cancelled', isCancelled: () => true }), { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
  assert.equal(await readSessionAccount(pool.root, 'cancelled'), null);
  await pool.mutate(data => { data.accounts.find(account => account.id === first.id).identityId = 'changed-login'; });
  await assert.rejects(acquire('new-0'), /登录身份已改变/);
  await pool.policy(true);
  const migrated = await acquire('new-0');
  assert.notEqual(migrated.id, first.id, 'changed login can migrate when switching is enabled');
  assert.equal((await readSessionAccount(pool.root, 'new-0')).accountId, migrated.id);
  await migrated.lease.release();
  await pool.markExhausted(migrated.id);
  const recovered = await acquire('new-0');
  assert.notEqual(recovered.id, migrated.id, 'exhausted binding migrates');
  await recovered.lease.release();
  const afterRestart = await restarted.acquireForRun({ sessionId: 'new-0' });
  assert.equal(afterRestart.id, recovered.id, 'migration survives restart');
  await afterRestart.lease.release();
  const excluded = (await pool.read()).accounts.map(account => account.id);
  await assert.rejects(pool.acquireForRun({ sessionId: 'new-0', excludedAccountIds: excluded }), /暂无可用/);
  assert.equal((await readSessionAccount(pool.root, 'new-0')).accountId, recovered.id, 'failed selection preserves binding');
  await Promise.all(slots.map(slot=>slot.lease.release()));slots.length=0;
  await pool.mutate(data=>{for(const a of data.accounts){a.usage=usage(90);delete a.cooldownUntil;delete a.blockedUntil;}});
  const reserve=await acquire('reserve-session');await reserve.lease.release();
  await pool.mutate(data=>{data.accounts.find(a=>a.id===reserve.id).usage=usage(8);});
  const heldReserve=await pool.registerRun(await pool.account(reserve.id),await pool.read(),{isCancelled:()=>false,runId:'held',sessionId:'reserve-session'});
  const pinned=await acquire('reserve-session');assert.equal(pinned.id,reserve.id);await pinned.lease.release();await heldReserve.lease.release();
  await assert.rejects(pool.acquireForRun({sessionId:'reserve-session',isCancelled:()=>true}),{code:'PROVIDER_RUNTIME_QUEUE_CANCELLED'});
  assert.equal((await readSessionAccount(pool.root,'reserve-session')).accountId,reserve.id);
  const proactive=await acquire('reserve-session');assert.notEqual(proactive.id,reserve.id);await proactive.lease.release();
  assert.equal((await pool.read()).switchEvents.at(-1).reason,'reserve');
  await Promise.all(slots.map(slot => slot.lease.release())); slots.length = 0;
  await pool.mutate(data => {
    data.pendingSessions = {};
    for (const account of data.accounts) {
      account.usage = usage(90); delete account.cooldownUntil; delete account.blockedUntil;
    }
  });
  const beforePause = await acquire('pause-existing'); await beforePause.lease.release();
  const allowed = (await pool.read()).accounts.filter(account => account.account && account.id !== beforePause.id).slice(0, 2).map(account => account.id);
  const restricted = await pool.policy(true, true, allowed);
  assert.deepEqual(restricted.routingAccountIds, allowed);
  assert.equal(restricted.accounts.find(account => account.id === beforePause.id).routingEnabled, false);
  const afterPause = await acquire('pause-existing');
  assert(allowed.includes(afterPause.id), 'a paused binding migrates without deleting its login');
  assert((await pool.account(beforePause.id)).account);
  await afterPause.lease.release();
  await assert.rejects(pool.select(beforePause.id), /暂停分流/);
  await assert.rejects(pool.policy(undefined, undefined, ['not-an-id']), /账号编号/);
  await assert.rejects(pool.policy(undefined, undefined, ['12345678-1234-1234-1234-123456789012']), /不存在/);
  assert.deepEqual((await pool.policy(true)).routingAccountIds, allowed, 'old policy clients preserve restrictions');
  await pool.mutate(data => { for (const account of data.accounts) account.usage = usage(allowed.includes(account.id) ? 0 : 90); });
  await pool.policy(true);
  assert(allowed.includes((await pool.read()).activeId), 'reserve switching never selects a paused backup');
  await assert.rejects(pool.acquireForRun(), /暂无可用/, 'exhausted enabled accounts never fall back outside the allowed pool');
  await pool.mutate(data => { for (const account of data.accounts) account.usage = usage(90); });
  const helperSlots = await Promise.all(Array.from({ length: 6 }, () => pool.acquireForRun())); slots.push(...helperSlots);
  assert(helperSlots.every(slot => allowed.includes(slot.id)), 'helpers cannot bypass the restriction');
  assert.deepEqual(Object.values(helperSlots.reduce((counts, slot) => {
    counts[slot.id] = (counts[slot.id] || 0) + 1; return counts;
  }, {})), [3, 3], 'sessionless helpers balance across enabled accounts');
  assert.equal(await readSessionAccount(pool.root, ''), null);
  await Promise.all(helperSlots.map(slot => slot.lease.release()));
  await pool.mutate(data => {
    data.automationRouting = { accountId: beforePause.id, scheduleIds: ['paused-schedule'], maxConcurrentRuns: 1 };
  });
  const scheduled = await pool.acquireForRun({ sessionId: 'paused-schedule', scheduleId: 'paused-schedule' }); slots.push(scheduled);
  assert(allowed.includes(scheduled.id), 'a schedule preference cannot reactivate a paused account');
  await scheduled.lease.release();
  await pool.mutate(data => { delete data.automationRouting; });
  await pool.policy(false, false, []);
  await assert.rejects(pool.acquireForRun(), /暂停分流/);
  await assert.rejects(acquire('pause-existing'), /暂停分流/);
  await pool.policy(true, true, []);
  await assert.rejects(pool.acquireForRun(), /暂无可用/);
  await assert.rejects(acquire('pause-existing'), /暂无可用/);
  const pausedRestart = new CodexAccounts({ root: pool.root, defaultHome: pool.defaultHome, now: () => now });
  await assert.rejects(pausedRestart.acquireForRun(), /暂无可用/);
  await pool.policy(undefined, undefined, null);
  assert.equal((await pool.list()).routingAccountIds, null);
  assert((await pool.list()).accounts.every(account => account.routingEnabled));
  console.log('Codex Session routing: balanced reservations, duplicate identities, sticky turns, legacy migration, restart, disable, cooldown, exhaustion and cancellation passed');
} finally {
  await Promise.all(slots.map(slot => slot.lease.release()));
  await rm(root, { recursive: true, force: true });
}

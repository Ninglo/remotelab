import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, classifyCodexAccountFailure } from '../lib/codex-accounts.mjs';
import { readSessionAccount } from '../lib/codex-session-routing.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-routing-'));
let now = Date.now();
const pool = new CodexAccounts({ root: join(root, 'accounts'), defaultHome: join(root, 'default'), now: () => now });
const slots = [];
const acquire = async sessionId => { const slot = await pool.acquireForRun({ sessionId }); slots.push(slot); return slot; };
const release = async () => { await Promise.all(slots.splice(0).map(s => s.lease.release())); };
const usage = remaining => ({ status: 'ready', checkedAt: new Date(now).toISOString(), buckets: [
  { id: 'codex', primary: { remainingPercent: remaining, resetsAt: new Date(now + 3600000).toISOString() } },
] });
try {
  const a = await pool.add('A'), b = await pool.add('B'), alias = await pool.add('A duplicate');
  const signedOut = await pool.add('signed out');
  const personal = await pool.ensurePersonalAccount('person_test');
  await pool.mutate(data => {
    data.balanceSessions = false; data.autoSwitch = false;
    for (const account of data.accounts) {
      if (account.id === signedOut.id) continue;
      account.identityId = account.id === alias.id ? a.id : account.id;
      account.account = { type: 'chatgpt' }; account.usage = usage(90);
    }
  });
  const batch = await Promise.all(Array.from({ length: 12 }, (_, i) => acquire('new-' + i)));
  const counts = Object.values(batch.reduce((out, s) => { out[s.id] = (out[s.id] || 0) + 1; return out; }, {}));
  assert.deepEqual(counts, [4, 4, 4], 'legacy false switches do not disable balanced admission');
  assert(!batch.some(s => [alias.id, signedOut.id, personal.id].includes(s.id)));
  const first = batch[0];
  await release();
  const restarted = new CodexAccounts({ root: pool.root, defaultHome: pool.defaultHome, now: () => now });
  const continued = await restarted.acquireForRun({ sessionId: 'new-0' });
  assert.equal(continued.id, first.id); await continued.lease.release();
  await pool.setRoutingEnabled(first.id, false);
  const migrated = await acquire('new-0');
  assert.notEqual(migrated.id, first.id, 'disable migrates existing bindings with autoSwitch off');
  assert.equal((await readSessionAccount(pool.root, 'new-0')).accountId, migrated.id);
  await release();
  await pool.markRateLimited(migrated.id, { kind: 'capacity', model: 'test-model' });
  const next = await acquire('new-0'); assert.notEqual(next.id, migrated.id);
  const listed = (await pool.list()).accounts.find(a => a.id === migrated.id);
  assert.equal(listed.lastFailure.kind, 'capacity'); assert.equal(listed.lastFailure.model, 'test-model');
  assert.equal(listed.cooldownUntil, now + 60000);
  await release();
  now += 61000;
  await pool.policy(false, false, []);
  await assert.rejects(acquire('empty'), error => error.code === 'CODEX_NO_AVAILABLE_ACCOUNT'
    && error.routingReasons.disabled_or_credentials === 5);
  assert.equal(await readSessionAccount(pool.root, 'empty'), null);
  await pool.setRoutingEnabled(b.id, true);
  assert.equal((await acquire('restored')).id, b.id, 're-enable works without any other switch');
  await release();
  await pool.mutate(data => { data.accounts.find(a => a.id === b.id).usage = usage(0); });
  await assert.rejects(acquire('exhausted'), error => error.routingReasons.quota_exhausted === 1);
  await pool.mutate(data => { data.accounts.find(a => a.id === b.id).usage = usage(7); });
  assert.equal((await acquire('low-positive')).id, b.id, 'low positive quota is usable');
  await release();
  await pool.policy(undefined, undefined, null);
  await pool.mutate(data => {
    data.pendingSessions = {};
    for (const account of data.accounts) { account.usage = usage(90); delete account.cooldownUntil; }
  });
  const helpers = [];
  for (let i = 0; i < 3; i++) { const s = await acquire('prepared-' + i); helpers.push(s.id); await s.lease.release(); }
  assert.equal(new Set(helpers).size, 3, 'completed helpers reserve a balanced startup slot');
  const main = await pool.acquireForRun({ sessionId: 'prepared-0', runId: 'main' }); slots.push(main);
  assert.equal(main.id, helpers[0]);
  assert.equal((await pool.read()).pendingSessions['prepared-0'], undefined);
  await assert.rejects(pool.acquireForRun({ sessionId: 'cancelled', isCancelled: () => true }), { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
  assert.equal(await readSessionAccount(pool.root, 'cancelled'), null);
  await release();
  const held = await acquire('held');
  await pool.setRoutingEnabled(held.id, false);
  assert((await pool.registeredRuns(await pool.account(held.id))).length, 'disable preserves running work');
  assert.notEqual((await acquire('held')).id, held.id);
  await release();
  await pool.policy(undefined, undefined, null);
  const identityBound = await acquire('identity-change'); await release();
  await pool.mutate(data => {
    data.accounts.find(a => a.id === identityBound.id).identityId = 'replacement-login';
  });
  assert.notEqual((await acquire('identity-change')).id, identityBound.id, 'changed identity is not reused silently');
  await release();
  const allIds = (await pool.read()).accounts.map(a => a.id);
  await assert.rejects(pool.acquireForRun({ sessionId: 'excluded', excludedAccountIds: allIds }),
    error => error.code === 'CODEX_NO_AVAILABLE_ACCOUNT');
  for (const [text, kind] of [['usage_limit_reached', 'quota_exhausted'], ['model is at capacity; try again', 'capacity'],
    ['capacity limit exceeded', 'capacity'], ['429 Too many requests', 'rate_limited'], ['network timeout', null]]) {
    assert.equal(classifyCodexAccountFailure(new Error(text)), kind);
  }
  console.log('Shared routing: concurrent balance, aliases, personal isolation, restart, disable, recovery, diagnostics, helpers and cancellation passed');
} finally { await release(); await rm(root, { recursive: true, force: true }); }

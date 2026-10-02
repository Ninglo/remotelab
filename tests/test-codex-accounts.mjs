import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, subscriptionAvailability, isSubscriptionExhausted } from '../lib/codex-accounts.mjs';
import { createCodexAccountListAuthManager } from '../chat/codex-account-list-auth.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-account-list-'));
const home = join(root, 'legacy'); await mkdir(join(home, 'sessions'), { recursive: true });
await writeFile(join(home, 'auth.json'), '{"tokens":{}}', { mode: 0o600 });
await writeFile(join(home, 'config.toml'), 'model="test-model"');
const now = Date.now(); const stamp = new Date(now).toISOString();
const usage = (remaining, age = 0) => ({ status: 'ready', checkedAt: new Date(now - age).toISOString(),
  buckets: [{ id: 'codex', primary: { remainingPercent: remaining, windowDurationMins: 10080,
    resetsAt: new Date(now + 86400_000).toISOString() }, secondary: null }] });
assert.equal(subscriptionAvailability(usage(0), '', now), 'exhausted');
assert.equal(subscriptionAvailability(usage(100), '', now), 'available');
assert.equal(subscriptionAvailability(usage(0, 61_000), '', now), 'unknown');
assert.equal(subscriptionAvailability({ ...usage(0), checkedAt: 'invalid' }, '', now), 'unknown');
assert.equal(subscriptionAvailability({ ...usage(0), status: 'unavailable' }, '', now), 'unknown');
assert.equal(subscriptionAvailability({ ...usage(0), buckets: [{ id: 'gpt-reserve', primary: usage(0).buckets[0].primary }] }, '', now), 'unknown');
assert.equal(isSubscriptionExhausted(new Error("You've hit your usage limit")), true);
assert.equal(isSubscriptionExhausted('usage_limit_reached'), true);
for (const failure of ['429 Too many requests', '401 Unauthorized', 'Network disconnected', 'model is not supported', 'subscription limit information unavailable']) {
  assert.equal(isSubscriptionExhausted(failure), false);
}
const responses = new Map([[home, usage(0)]]); let queries = 0;
const query = async ({ env, includeRateLimits, credentialStore }) => {
  queries++; assert.equal(includeRateLimits, true);
  if (env.CODEX_HOME !== home) assert.equal(credentialStore, 'file');
  const limits = responses.get(env.CODEX_HOME);
  if (limits instanceof Error) throw limits;
  return { account: { type: 'chatgpt', name: 'Test', email: 'test@example.invalid', planType: 'pro' },
    usage: limits || usage(100), accountRevision: 'revision', checkedAt: stamp };
};
const pool = new CodexAccounts({ root: join(root, 'pool'), defaultHome: home, query, now: () => now });
try {
  const backup = await pool.add('<img src=x onerror=alert(1)>');
  await writeFile(join(backup.home, 'auth.json'), '{"tokens":{"account_id":"synthetic"}}');
  assert.equal(await realpath(join(backup.home, 'sessions')), join(home, 'sessions'));
  assert.equal(await realpath(join(backup.home, 'config.toml')), join(home, 'config.toml'));
  const originalAuth = await readFile(join(home, 'auth.json'), 'utf8');
  await pool.refresh(backup.id, 'fake'); await pool.policy(true);
  let slot = await pool.acquireForRun({ command: 'fake' });
  assert.equal(slot.id, backup.id, 'exhausted subscription switches to an independently authenticated account');
  assert.equal((await pool.read()).activeId, backup.id);
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), originalAuth, 'switching never clears or rewrites another authorization');
  const count = queries; await pool.refresh(backup.id, 'fake');
  assert.equal(queries, count, 'monitoring does not compete with an active credential owner');
  assert.equal((await pool.list()).accounts.some(a => 'home' in a), false, 'public list has no credential paths');
  await slot.lease.release();
  const restarted = new CodexAccounts({ root: pool.root, defaultHome: home, query, now: () => now });
  assert.equal((await restarted.read()).activeId, backup.id);
  assert.equal((await restarted.read()).autoSwitch, true, 'selection and policy survive restart');
  responses.set(backup.home, usage(0));
  await assert.rejects(pool.acquireForRun({ command: 'fake' }), { code: 'CODEX_ACCOUNTS_EXHAUSTED' });
  responses.set(backup.home, usage(100));
  await pool.markExhausted(backup.id);
  await assert.rejects(pool.acquireForRun({ command: 'fake' }), { code: 'CODEX_ACCOUNTS_EXHAUSTED' });
  await pool.refresh(backup.id, 'fake');
  responses.set(backup.home, new Error('temporary network failure'));
  const refreshed = await pool.refresh(backup.id, 'fake');
  assert.equal(refreshed.usage.status, 'unavailable');
  await pool.policy(false);
  slot = await pool.acquireForRun({ command: 'fake' }); assert.equal(slot.id, backup.id); await slot.lease.release();
  await pool.mutate(data => { for (const a of data.accounts) a.identityId = 'e'.repeat(64); });
  await pool.policy(true);
  await assert.rejects(pool.acquireForRun({ command: 'fake', exclude: ['default'] }), { code: 'CODEX_ACCOUNTS_EXHAUSTED' },
    'another login for the same subscription is not a fallback');
  await pool.mutate(data => { for (const a of data.accounts) a.identityId = ''; });
  await pool.policy(false);

  let logoutCalls = 0;
  const facade = createCodexAccountListAuthManager({ pool, resolveCommand: async () => 'fake',
    createManager: ({ resolveHome }) => ({
      async startDeviceLogin() { await writeFile(join(await resolveHome(), 'auth.json'), '{"tokens":{}}');
        return { loggedIn: false, deviceLoginActive: true, userCode: 'test-code' }; },
      async getStatus() { return { loggedIn: true, deviceLoginActive: false }; },
      async stopActiveLogin() {}, async logout() { logoutCalls++; },
    }) });
  const adding = await facade.switchAccount(); assert.equal(adding.deviceLoginActive, true);
  const completed = await facade.getStatus(); assert.equal(completed.loggedIn, true);
  assert.equal(logoutCalls, 0, 'adding a second account never logs out the first');
  await facade.switchAccount({ accountId: backup.id }); assert.equal(logoutCalls, 0);
  assert.equal((await pool.read()).activeId, backup.id);
  console.log('Codex account persistence, independent authorization, quota admission, retry classification and credential ownership passed');
} finally { await rm(root, { recursive: true, force: true }); }

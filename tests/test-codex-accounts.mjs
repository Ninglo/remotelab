import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, subscriptionAvailability, isSubscriptionExhausted } from '../lib/codex-accounts.mjs';
import { pollCodexAccounts } from '../chat/codex-account-monitor.mjs';
import { createCodexAccountListAuthManager } from '../chat/codex-account-list-auth.mjs';
import { codexAccountRevision, readCodexAuthMetadata } from '../lib/codex-account-status.mjs';

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
  const account = { type: 'chatgpt', name: 'Test', email: 'test@example.invalid', planType: 'pro' };
  return { account, usage: limits || usage(100),
    accountRevision: codexAccountRevision((await readCodexAuthMetadata(env.CODEX_HOME)).revision, account), checkedAt: stamp };
};
const pool = new CodexAccounts({ root: join(root, 'pool'), defaultHome: home, query, now: () => now });
try {
  const cleanBase = join(root, 'fresh-default');
  const freshPool = new CodexAccounts({ root: join(root, 'fresh-pool'), defaultHome: cleanBase, query });
  const firstFreshAccount = await freshPool.add();
  assert.equal(await realpath(join(firstFreshAccount.home, 'sessions')), join(cleanBase, 'sessions'),
    'new installations share conversation storage before the first account creates a thread');
  const backup = await pool.add('<img src=x onerror=alert(1)>');
  await writeFile(join(backup.home, 'auth.json'), '{"tokens":{"account_id":"synthetic"}}');
  assert.equal(await realpath(join(backup.home, 'sessions')), join(home, 'sessions'));
  assert.equal(await realpath(join(backup.home, 'config.toml')), join(home, 'config.toml'));
  const originalAuth = await readFile(join(home, 'auth.json'), 'utf8');
  await pool.refresh(backup.id, 'fake'); await pool.policy(true);
  let rotation = true;
  pool.query = async options => {
    if (rotation) { rotation = false; throw new Error('Codex account changed; check status again'); }
    return query(options);
  };
  assert.equal((await pool.refresh(backup.id, 'fake')).usage.status, 'ready', 'a refreshed authorization is reread once in place');
  pool.query = query;
  await pool.refresh('default', 'fake');
  let slot = await pool.acquireForRun();
  assert.equal(slot.id, backup.id, 'the background sample switches an exhausted default');
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), originalAuth, 'switching never rewrites another authorization');
  const count = queries; await pool.refresh(backup.id, 'fake');
  assert.equal(queries, count, 'idle monitoring skips active requests');
  assert.equal(await pool.lease(await pool.account(), { wait: false }), null, 'logout and login cannot mutate an active authorization');
  assert.equal((await pool.list()).accounts.some(a => 'home' in a), false, 'public list has no credential paths');
  await slot.lease.release();
  assert.equal(await pool.inUse(await pool.account()), false, 'completed requests release their liveness records');
  const restarted = new CodexAccounts({ root: pool.root, defaultHome: home, query, now: () => now });
  assert.equal((await restarted.read()).activeId, backup.id);
  assert.equal((await restarted.read()).autoSwitch, true);

  responses.set(home, usage(100)); await pool.refresh('default', 'fake');
  await pool.select('default');
  const running = await pool.acquireForRun();
  await pool.observeUsage('default', usage(10));
  assert.equal((await pool.read()).activeId, backup.id, '10% reserve changes only the default for subsequent requests');
  assert.equal(running.home, home, 'an ongoing request keeps its original authorization');
  const later = await pool.acquireForRun(); assert.equal(later.id, backup.id);
  await later.lease.release(); await running.lease.release();

  await pool.select('default'); await pool.observeUsage('default', usage(11));
  assert.equal((await pool.read()).activeId, 'default', '11% remains on the current account');
  await pool.observeUsage('default', { status: 'unavailable', buckets: [] });
  assert.equal((await pool.read()).activeId, 'default', 'unavailable quota never means exhausted');
  await pool.mutate(data => {
    data.accounts.find(a => a.id === 'default').usage = usage(0, 61_000);
  });
  await pool.policy(true); assert.equal((await pool.read()).activeId, 'default', 'stale quota does not trigger switching');
  await pool.mutate(data => { for (const a of data.accounts) a.identityId = 'e'.repeat(64); });
  await pool.observeUsage('default', usage(0));
  assert.equal((await pool.read()).activeId, 'default', 'a second login for the same subscription is not a backup');
  await pool.mutate(data => { for (const a of data.accounts) a.identityId = ''; });
  await pool.markExhausted('default');
  assert.equal((await pool.read()).activeId, backup.id, 'a confirmed failure updates the next request even without a zero quota sample');
  responses.set(backup.home, new Error('temporary network failure'));
  assert.equal((await pool.refresh(backup.id, 'fake')).usage.status, 'unavailable');
  assert.equal((await pool.read()).activeId, backup.id);

  for (const autoSwitch of [true, false]) {
    await pool.policy(autoSwitch);
    const monitor = await pool.lease(await pool.account(), { wait: false });
    assert.ok(monitor);
    const before = queries;
    let foregroundQueries = 0;
    pool.query = async () => { foregroundQueries++; throw new Error('Foreground must never query quota'); };
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Foreground waited for an account')), 3000); });
    let first, second;
    try {
      [first, second] = await Promise.race([Promise.all([pool.acquireForRun(), pool.acquireForRun()]), deadline]);
      assert.equal(first.id, backup.id); assert.equal(second.id, backup.id, 'same-account requests remain concurrent');
      assert.equal(queries, before);
      assert.equal(foregroundQueries, 0, 'foreground selection performs zero quota RPCs, even while monitoring is busy');
    } finally {
      clearTimeout(timer); await first?.lease.release(); await second?.lease.release(); await monitor.release(); pool.query = query;
    }
  }
  responses.set(home, usage(9)); responses.set(backup.home, usage(100));
  await pool.mutate(data => {
    data.activeId = 'default'; data.autoSwitch = true;
    for (const account of data.accounts) { account.usage = usage(100, 31_000); delete account.blockedUntil; }
  });
  const beforeBackground = queries;
  await pollCodexAccounts({ pool, resolveCommand: async () => 'fake' });
  assert.equal((await pool.read()).activeId, backup.id, 'the instance background monitor switches the default without an external fleet service');
  assert.equal(queries - beforeBackground, 2);
  await pollCodexAccounts({ pool, resolveCommand: async () => 'fake' });
  assert.equal(queries - beforeBackground, 2, 'background cycles reuse fresh quota from any observer');
  await pool.policy(false);
  await pool.mutate(data => { for (const account of data.accounts) account.usage = usage(80, 31_000); });
  const beforeDisabledMonitoring = queries;
  await pollCodexAccounts({ pool, resolveCommand: async () => 'fake' });
  assert.equal(queries - beforeDisabledMonitoring, 2, 'quota sampling continues when automatic switching is disabled');
  assert.equal((await pool.read()).activeId, backup.id, 'disabled switching never changes the selected account');

  let logoutCalls = 0;
  const facade = createCodexAccountListAuthManager({ pool, resolveCommand: async () => 'fake',
    createManager: ({ resolveHome }) => ({
      async startDeviceLogin() { await writeFile(join(await resolveHome(), 'auth.json'), '{"tokens":{}}');
        return { loggedIn: false, deviceLoginActive: true, userCode: 'test-code' }; },
      async getStatus() { return { loggedIn: true, deviceLoginActive: false }; },
      async stopActiveLogin() {}, async logout() { logoutCalls++; },
    }) });
  const adding = await facade.switchAccount(); assert.equal(adding.deviceLoginActive, true);
  const beforeCompletion = queries;
  const [completed, secondStatus, thirdStatus] = await Promise.all([facade.getStatus(), facade.getStatus(), facade.getStatus()]);
  assert.equal(queries - beforeCompletion, 1, "concurrent polling completes one login once");
  assert.equal(completed.accountRevision, secondStatus.accountRevision);
  assert.equal(secondStatus.accountRevision, thirdStatus.accountRevision);
  assert.equal(completed.loggedIn, true);
  const current = await pool.account();
  assert.equal(completed.accountRevision, codexAccountRevision((await readCodexAuthMetadata(current.home)).revision, current.account));
  await pool.observeUsage(current.id, usage(75));
  assert.equal((await facade.getRateLimits()).accountRevision, (await facade.getStatus()).accountRevision,
    'live quota and the saved account share the same credential revision');
  assert.equal(logoutCalls, 0, 'adding a second account never logs out the first');
  await facade.switchAccount({ accountId: backup.id }); assert.equal(logoutCalls, 0);
  assert.equal((await pool.read()).activeId, backup.id);
  responses.set(backup.home, usage(100)); await pool.refresh(backup.id, 'fake'); await pool.policy(true);
  const firstJob = await pool.acquireForRun({ command: 'fake' });
  const secondJob = await pool.acquireForRun({ command: 'fake' });
  assert.equal(firstJob.id, secondJob.id, 'ordinary concurrency does not change the selected account');
  await firstJob.lease.release(); await secondJob.lease.release();
  await assert.rejects(pool.acquireForRun({ isCancelled: () => true }), { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
  console.log('Codex background reserve switching, concurrent request startup without quota RPCs, persistence and independent login passed');
} finally { await rm(root, { recursive: true, force: true }); }

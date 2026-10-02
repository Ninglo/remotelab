import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, subscriptionAvailability, isSubscriptionExhausted } from '../lib/codex-accounts.mjs';
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
  responses.set(backup.home, usage(100)); await pool.policy(true);
  const firstJob = await pool.acquireForRun({ command: 'fake' });
  const secondJob = await pool.acquireForRun({ command: 'fake' });
  assert.notEqual(firstJob.id, secondJob.id, 'a free authorization runs concurrently instead of waiting behind a busy account');
  await firstJob.lease.release(); await secondJob.lease.release();

  const waitingPool = new CodexAccounts({ root: join(root, 'waiting-pool'), defaultHome: home, query, now: () => now });
  const waitingBackup = await waitingPool.add('Waiting backup');
  responses.set(home, usage(100));
  await waitingPool.policy(true);
  const heldFirst = await waitingPool.acquireForRun({ command: 'fake' });
  const heldSecond = await waitingPool.acquireForRun({ command: 'fake' });
  assert.equal(heldSecond.id, waitingBackup.id);
  await waitingPool.select(heldFirst.id);
  let notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  let cancelled = false;
  const nextJob = waitingPool.acquireForRun({ command: 'fake', isCancelled: () => cancelled,
    onWait: notifyWaiting });
  await waiting;
  // Keep the first account occupied and release only the other account after
  // admission. The former waitForId path would remain stuck behind the first.
  await heldSecond.lease.release();
  let deadline;
  try {
    const resumed = await Promise.race([nextJob,
      new Promise((_, reject) => { deadline = setTimeout(() => {
        cancelled = true;
        reject(new Error('Waiting job did not take the newly free account'));
      }, 1000); })]);
    assert.equal(resumed.id, heldSecond.id);
    await resumed.lease.release();
  } finally {
    clearTimeout(deadline);
    cancelled = true;
    await heldFirst.lease.release();
  }
  await assert.rejects(waitingPool.acquireForRun({ command: 'fake', isCancelled: () => true }),
    { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
  console.log('Codex account persistence, independent authorization, quota admission, retry classification and credential ownership passed');
} finally { await rm(root, { recursive: true, force: true }); }

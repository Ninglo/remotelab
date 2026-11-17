import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-account-lifecycle-'));
setIsolatedTestHome(root);
const { CodexAccounts } = await import('../lib/codex-accounts.mjs');
const { createCodexAccountListAuthManager } = await import('../chat/codex-account-list-auth.mjs');
const home = join(root, 'codex'); await mkdir(home);
let failure = null, lastQuery;
const query = async options => {
  lastQuery = options;
  if (failure) throw failure;
  return { account: { type: 'chatgpt', name: 'Test' }, checkedAt: new Date().toISOString(),
    accountRevision: 'test', usage: { status: 'ready', buckets: [{ id: 'codex', primary: {
      remainingPercent: 100, resetsAt: new Date(Date.now() + 3600000).toISOString(),
    } }] } };
};
const pool = new CodexAccounts({ root: join(root, 'pool'), defaultHome: home, query });
try {
  const disabled = await pool.add('Disabled');
  const legacy = await pool.read(); delete legacy.disabledAccountIds;
  legacy.routingAccountIds = ['default'];
  await writeFile(pool.file, JSON.stringify(legacy));
  const added = await pool.add('New');
  assert.deepEqual((await pool.read()).disabledAccountIds, [disabled.id]);
  assert.equal((await pool.list()).accounts.find(a => a.id === added.id).routingEnabled, true);
  assert.equal((await pool.list()).accounts.find(a => a.id === disabled.id).routingEnabled, false);
  assert.equal(added.sqliteHome, home, 'new authorizations reuse the existing conversation index');
  assert.notEqual(added.home, home, 'credentials remain in a separate home');
  await pool.policy(true, true, []);
  const afterAllDisabled = await pool.add('After disabling all');
  assert.equal((await pool.list()).accounts.find(a => a.id === afterAllDisabled.id).routingEnabled, true);

  let onExit, logoutCalls = 0;
  const facade = createCodexAccountListAuthManager({ pool, resolveCommand: async () => 'fixture',
    createManager: ({ resolveHome, resolveSqliteHome, onLoginExit }) => {
      onExit = onLoginExit;
      return {
        async startDeviceLogin() {
          assert.equal(await resolveSqliteHome(), home);
          await writeFile(join(await resolveHome(), 'auth.json'), '{"tokens":{}}');
          return { loggedIn: false, deviceLoginActive: true };
        },
        async getStatus() { return { loggedIn: true, deviceLoginActive: false }; },
        async stopActiveLogin() {}, async logout() { logoutCalls++; },
      };
    } });
  await facade.startDeviceLogin();
  const newId = (await pool.read()).accounts.at(-1).id;
  onExit(); // Completion must persist even if the browser has stopped polling.
  await facade.getStatus(); // Wait for the manager's serialized completion.
  assert.equal((await pool.read()).activeId, newId);
  assert.equal((await pool.account(newId)).credentialIssue, '');
  assert.equal(lastQuery.includeRateLimits, false, 'login completion does not wait for quota');
  assert.equal(lastQuery.env.CODEX_SQLITE_HOME, home);
  const account = await pool.account(newId);
  const free = await pool.lease(account, { wait: false }); assert.ok(free); await free.release();

  await pool.setRoutingEnabled(newId, false);
  await facade.startDeviceLogin({ accountId: newId });
  onExit(); await facade.getStatus();
  assert.equal((await pool.list()).accounts.find(a => a.id === newId).routingEnabled, false,
    'reauthorization must not undo an explicit disable');
  const released = await pool.lease(account, { wait: false }); assert.ok(released); await released.release();

  await facade.startDeviceLogin({ accountId: newId }); failure = Error('temporary identity failure');
  await assert.rejects(facade.getStatus(), /temporary identity failure/); failure = null;
  const recovered = await pool.lease(account, { wait: false }); assert.ok(recovered); await recovered.release();
  await pool.refresh(newId, 'fixture');
  await pool.setRoutingEnabled(newId, true);
  await pool.policy(true, true, [newId]);
  const run = await pool.acquireForRun({ sessionId: 'running-before-removal' });
  assert.equal(run.id, newId); assert.equal(run.sqliteHome, home);
  const before = await readFile(join(account.home, 'auth.json'), 'utf8');
  await facade.removeAccount(newId);
  assert.equal(await pool.inUse(account), true, 'removal does not stop a running task');
  assert.equal(await readFile(join(account.home, 'auth.json'), 'utf8'), before);
  assert.equal(logoutCalls, 0);
  assert.equal((await pool.list()).accounts.some(a => a.id === newId), false);
  await assert.rejects(pool.acquireForRun({ sessionId: 'after-removal' }), /暂无可用/);
  await assert.rejects(pool.setRoutingEnabled(newId, true), /不存在/);
  await facade.removeAccount(newId); // Uncertain responses can be retried safely.
  await run.lease.release();
  for (const a of (await pool.list()).accounts) await facade.removeAccount(a.id);
  assert.equal((await facade.getStatus()).loggedIn, false);
  assert.equal((await pool.list()).accounts.length, 0);
  const replacement = await pool.add('Replacement');
  assert.equal((await pool.list()).accounts.find(a => a.id === replacement.id).routingEnabled, true);
  console.log('Legacy migration, default enable, automatic login completion, failure recovery and in-use removal passed');
} finally { await rm(root, { recursive: true, force: true }); }

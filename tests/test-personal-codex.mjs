import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'personal-codex-'));
setIsolatedTestHome(root);
const { CodexAccounts } = await import('../lib/codex-accounts.mjs');
const { readCodexAuthMetadata } = await import('../lib/codex-account-status.mjs');
const { createPersonalCodexAuthManager } = await import('../chat/personal-codex-auth.mjs');
const { createCodexAccountListAuthManager } = await import('../chat/codex-account-list-auth.mjs');
const { captureCodexAccountPolicy } = await import('../chat/codex-account-context.mjs');
const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
const { handlePersonalCodexRoutes } = await import('../chat/router-personal-codex-routes.mjs');
const { publishPersonalCodexFallbackNotice } = await import('../chat/personal-codex-notice.mjs');
const { readSessionAccount } = await import('../lib/codex-session-routing.mjs');
let now = Date.now();
const stamp = () => new Date(now).toISOString();
const usage = remaining => ({ status: 'ready', checkedAt: stamp(), buckets: [{ id: 'codex',
  primary: { remainingPercent: remaining, resetsAt: new Date(now + 3600_000).toISOString() } }] });
const responses = new Map();
const home = join(root, 'shared'); await mkdir(home);
const query = async ({ env }) => ({ account: (await readCodexAuthMetadata(env.CODEX_HOME)).revision
  ? { type: 'chatgpt', email: 'synthetic@example.invalid' } : null,
  usage: responses.get(env.CODEX_HOME) || usage(100), checkedAt: stamp() });
const pool = new CodexAccounts({ root: join(root, 'pool'), defaultHome: home, query, now: () => now });
async function authorize(account, sub) {
  await writeFile(join(account.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'workspace',
    id_token: 'x.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.x' } }), { mode: 0o600 });
  return pool.inspect(account, 'fixture');
}
async function selected(options) {
  const slot = await pool.acquireForRun(options);
  await slot.lease.release(); return slot;
}
try {
  await authorize(await pool.account(), 'shared');
  const a = await pool.ensurePersonalAccount('person_a'), b = await pool.ensurePersonalAccount('person_b');
  await authorize(a, 'private-a'); await pool.setPersonalEnabled(a.id, 'person_a', true);
  await authorize(b, 'private-b'); await pool.setPersonalEnabled(b.id, 'person_b', true);
  assert.equal((await pool.ensurePersonalAccount('person_a')).id, a.id);
  const [one, two] = await Promise.all([pool.ensurePersonalAccount('person_race'), pool.ensurePersonalAccount('person_race')]);
  assert.equal(one.id, two.id, 'concurrent login starts cannot create two accounts for one person');
  const policy = await pool.executionPolicy('person_a');
  const opts = { sessionId: 'owned-session', accountPolicy: policy };
  for (const autoSwitch of [false, true]) {
    await pool.policy(autoSwitch, true);
    assert.equal((await selected(opts)).id, a.id, 'private preferred regardless of shared allocator options');
    assert.equal((await selected({ sessionId: 'other-session' })).id, 'default', 'others cannot use a private account');
  }
  assert.equal(await readSessionAccount(pool.root, 'owned-session'), null, 'private usage does not contaminate shared Session affinity');
  assert.equal((await pool.list()).accounts.length, 1, 'admin shared list excludes private metadata');
  await assert.rejects(pool.select(a.id));
  await assert.rejects(pool.policy(undefined, undefined, [a.id]));
  await assert.rejects(selected({ accountPolicy: { ...policy, personId: 'person_b' } }), /绑定已变更/);
  await assert.rejects(pool.setPersonalEnabled(a.id, 'person_b', true), /本人/);
  const running = await pool.acquireForRun(opts);
  assert.equal(await pool.lease(await pool.account(a.id), { wait: false }), null, 'reauth/logout cannot mutate active credentials');
  await running.lease.release();
  responses.set(a.home, usage(1)); await pool.inspect(a, 'fixture');
  assert.equal((await selected(opts)).id, a.id, 'low positive personal quota is not shared fallback');
  responses.set(a.home, { status: 'unavailable', buckets: [] }); await pool.inspect(a, 'fixture');
  assert.equal((await selected(opts)).id, a.id, 'unknown quota retains private authorization');
  await pool.markRateLimited(a.id);
  await assert.rejects(selected(opts), /限流/, 'rate limiting alone must not consume shared quota');
  await pool.mutate(data => { delete data.accounts.find(entry => entry.id === a.id).cooldownUntil; });
  responses.set(a.home, usage(0)); await pool.inspect(a, 'fixture');
  const fallback = await selected(opts);
  assert.equal(fallback.id, 'default'); assert.equal(fallback.personalFallback.reason, 'personal_quota_exhausted');
  responses.set(a.home, usage(100)); await pool.inspect(a, 'fixture');
  assert.equal((await selected(opts)).id, a.id, 'recovered quota takes precedence over saved shared affinity');
  assert.equal((await selected({ ...opts, excludedAccountIds: [a.id], confirmedExhaustedAccountIds: [a.id] })).id,
    'default', 'runner exhaustion evidence permits fallback before asynchronous quota-cache projection');
  await pool.markExhausted(a.id);
  assert.equal((await selected(opts)).id, 'default', 'explicit provider exhaustion is sufficient without zero sample');
  await pool.inspect(a, 'fixture');
  await pool.setPersonalEnabled(a.id, 'person_a', false);
  await assert.rejects(selected(opts), /重新授权/);
  await pool.setPersonalEnabled(a.id, 'person_a', true);
  // A rejected duplicate must not poison the original accepted authorization.
  const c = await pool.ensurePersonalAccount('person_c');
  await assert.rejects(authorize(c, 'shared'), /已绑定/);
  await pool.inspect(await pool.account(), 'fixture');
  assert.equal((await selected({})).id, 'default');
  await assert.rejects(authorize(c, 'private-a'), /已绑定/);
  await pool.inspect(a, 'fixture'); assert.equal((await selected(opts)).id, a.id);
  const sharedDuplicate = await pool.add('duplicate');
  await assert.rejects(authorize(sharedDuplicate, 'private-a'), /已绑定/);
  assert.equal((await pool.list()).accounts.find(entry => entry.id === sharedDuplicate.id).routingEnabled, false);
  await pool.inspect(a, 'fixture'); assert.equal((await selected(opts)).id, a.id);
  const publicManager = createCodexAccountListAuthManager({ pool, resolveCommand: async () => 'fixture' });
  await assert.rejects(publicManager.startDeviceLogin({ accountId: a.id }), /个人|公共/);
  const document = { people: [{ id: 'person_a', identities: [{ id: 'identity_a' }] }] };
  assert.equal((await captureCodexAccountPolicy({ viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a' }, pool, document)).personalAccountId, a.id);
  assert.equal((await captureCodexAccountPolicy({ viewPersonId: 'person_b', initiatedByIdentityId: 'identity_a' }, pool, document)).personalAccountId, null);
  // Scheduled/internal admissions have no human payer; absent identity is not
  // authority to inherit the Session creator's private account.
  const sharedPolicy = { version: 1, personId: '', personalAccountId: null };
  for (const options of [
    {},
    { internalOperation: 'trigger_delivery' },
    { initiatedByIdentityId: 'identity_missing' },
    { initiatedByIdentityId: 'identity_missing', viewPersonId: 'person_a' },
    { viewPersonId: 'person_a' },
    { initiatedByIdentityId: 'identity_a' },
    { initiatedByIdentityId: 'identity_a', viewPersonId: 'person_b' },
    { internalOperation: 'trigger_delivery', viewPersonId: null },
  ]) assert.deepEqual(await captureCodexAccountPolicy(options, pool, document), sharedPolicy);
  const { SYSTEM_PERSON_ID } = await import('../lib/auth-config.mjs');
  assert.deepEqual(await captureCodexAccountPolicy({
    initiatedByIdentityId: 'identity_system', viewPersonId: SYSTEM_PERSON_ID,
  }, pool, { people: [{ id: SYSTEM_PERSON_ID, identities: [{ id: 'identity_system' }] }] }), sharedPolicy);
  const head = { key: 'head', options: { codexAccountPolicy: policy }, runtimeSelection: { tool: 'codex' } };
  const input = { key: 'input', options: { codexAccountPolicy: policy }, runtimeSelection: { tool: 'codex' } };
  assert.equal(canForwardNativeRequest(input, head), true);
  assert.equal(canForwardNativeRequest({ ...input, options: { codexAccountPolicy: await pool.executionPolicy('person_b') } }, head), false);
  assert.equal(canForwardNativeRequest({ ...input, options: {} }, head), false);
  // Independent device jobs, cancellation, completion and restart persistence.
  const managers = new Map();
  const manager = createPersonalCodexAuthManager({ pool, resolveCommand: async () => 'fixture',
    createManager({ resolveHome }) {
      const state = { available: true, loggedIn: false, deviceLoginActive: false, phase: 'idle' };
      const api = { state, getStatus: async () => ({ ...state }),
        startDeviceLogin: async () => Object.assign(state, { deviceLoginActive: true, phase: 'awaiting', userCode: 'ABCD-EFGH',
          expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        stopActiveLogin: async () => { state.deviceLoginActive = false; },
        logout: async () => { await rm(join(resolveHome(), 'auth.json'), { force: true }); state.loggedIn = false; },
      };
      managers.set(resolveHome(), api); return api;
    } });
  await manager.startDeviceLogin('person_login1'); await manager.startDeviceLogin('person_login2');
  const login1 = await pool.personalAccount('person_login1'), login2 = await pool.personalAccount('person_login2');
  await manager.cancelLogin('person_login2');
  assert.equal((await manager.getStatus('person_login1')).deviceLoginActive, true);
  assert.equal((await manager.getStatus('person_login2')).deviceLoginActive, false);
  // Write a completed provider cache while the login job owns the account lease.
  await writeFile(join(login1.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'workspace',
    id_token: 'x.' + Buffer.from(JSON.stringify({ sub: 'login1' })).toString('base64url') + '.x' } }));
  Object.assign(managers.get(login1.home).state, { loggedIn: true, deviceLoginActive: false });
  assert.equal((await manager.getStatus('person_login1')).loggedIn, true);
  const restarted = createPersonalCodexAuthManager({ pool, resolveCommand: async () => 'fixture' });
  assert.equal((await restarted.getStatus('person_login1')).loggedIn, true);
  await manager.logout('person_login1');
  assert.equal((await pool.executionPolicy('person_login1')).personalAccountId, null);
  assert.equal((await readCodexAuthMetadata(login1.home)).revision, '');
  assert.equal((await pool.list()).accounts.some(entry => entry.id === login1.id), false, 'unbinding never turns the account into a shared account');
  assert.equal((await pool.personalAccount('person_login2')).id, login2.id);
  await manager.startDeviceLogin('person_login2');
  await manager.shutdown();
  const afterShutdown = await pool.lease(login2, { wait: false });
  assert(afterShutdown, 'graceful shutdown releases pending device authorization');
  await afterShutdown.release();
  // HTTP handler never trusts supplied owners or accepts service authority.
  const calls = [];
  async function route(authSession, path, method = 'GET', body) {
    let response;
    const req = Readable.from(body ? [JSON.stringify(body)] : []); req.url = path; req.method = method;
    await handlePersonalCodexRoutes({ req, res: { setHeader() {} }, pathname: path, authSession,
      writeJson: (_, status, data) => { response = { status, data }; },
      authManager: { getStatus: async person => { calls.push(person); return { loggedIn: false }; },
        startDeviceLogin: async person => { calls.push(person); return { deviceLoginActive: true }; } } });
    return response;
  }
  assert.equal((await route({ personId: 'person_a' }, '/api/personal-codex/status')).status, 200);
  assert.deepEqual(calls, ['person_a']);
  assert.equal((await route({ personId: 'person_a', authKind: 'service' }, '/api/personal-codex/status')).status, 403);
  assert.equal((await route({ personId: 'person_a' }, '/api/personal-codex/device-login', 'POST', { personId: 'person_b' })).status, 400);
  // Deterministic, restart-safe notice, separate from model publication.
  let record = { key: 'request-key', requestId: 'request', options: { codexAccountPolicy: policy },
    deliveryPlan: { connector: 'fixture' } };
  const events = [], deliveries = new Map();
  const deps = { store: { byRunId: async () => record, mutate: async (_, fn) => { record = fn(record); } },
    history: async () => events, append: async (_, event) => events.push(event),
    enqueue: async delivery => { deliveries.set(delivery.responseId, delivery); return { id: 'receipt' }; } };
  const run = { id: 'run', sessionId: 'session', requestId: record.requestId, personalCodexFallback: fallback.personalFallback };
  assert.equal(await publishPersonalCodexFallbackNotice(run, deps), true);
  assert.equal(await publishPersonalCodexFallbackNotice(run, deps), false);
  delete record.personalCodexFallbackNotice;
  assert.equal(await publishPersonalCodexFallbackNotice(run, deps), true);
  assert.equal(events.length, 1); assert.equal(events[0].role, 'system'); assert.equal(deliveries.size, 1);
  assert.match(events[0].content, /公共账号池/);
  console.log('PASS: personal ownership, isolation, fallback boundaries, recovery, independent binding, route authorization, native steering and durable notice');
} finally { await rm(root, { recursive: true, force: true }); }

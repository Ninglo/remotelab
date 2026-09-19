import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexAccountStatus } from '../lib/codex-account-status.mjs';
import { createCodexAuthManager } from '../chat/codex-auth.mjs';
import { handleCodexAuthRoutes } from '../chat/router-codex-auth-routes.mjs';

const home = await mkdtemp(join(tmpdir(), 'codex-account-test-'));
const command = join(home, 'codex');
const requestLog = join(home, 'requests.jsonl');
await copyFile(new URL('./fixtures/codex-account.cjs', import.meta.url), command);
await chmod(command, 0o755);
const env = { PATH: process.env.PATH, CODEX_HOME: home };
const query = options => readCodexAccountStatus({ command, env, ...options });
const provider = data => writeFile(join(home, 'provider.json'), JSON.stringify(data));
const login = (name = 'Test Name', email = 'test@example.com') => writeFile(join(home, 'auth.json'), JSON.stringify({
  tokens: { id_token: `header.${Buffer.from(JSON.stringify({ name, email })).toString('base64url')}.signature`, access_token: 'SECRET access', refresh_token: 'SECRET refresh' },
}));
const limits = { rateLimitsByLimitId: {
  codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 105, windowDurationMins: 10080, resetsAt: 1901000000 } },
  extra: { limitName: '<b>Extra</b>', primary: { usedPercent: 0, windowDurationMins: 60 } },
  missing: { primary: { usedPercent: null, windowDurationMins: 60 } },
} };
async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
try {
  assert.equal((await query()).account, null);
  await login();
  await provider({ account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro', access_token: 'SECRET' }, limits });
  const first = await query({ includeRateLimits: true });
  assert.deepEqual(first.account, { type: 'chatgpt', email: 'test@example.com', planType: 'pro', name: 'Test Name' });
  assert.equal(first.usage.buckets.length, 2);
  assert.equal(first.usage.buckets[0].primary.remainingPercent, 75);
  assert.equal(first.usage.buckets[0].secondary.remainingPercent, 0);
  assert.equal(first.usage.buckets[1].primary.resetsAt, null);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|id_token|access_token|refresh_token/);
  await provider({ account: { type: 'chatgpt', email: 'different@example.com' } });
  assert.equal((await query()).account.name, '', 'never combine names from different accounts');
  await provider({ error: true });
  assert.equal((await query({ includeRateLimits: true })).usage.status, 'unavailable');
  await provider({ hang: true });
  assert.equal((await query({ includeRateLimits: true, timeoutMs: 250 })).usage.status, 'unavailable');
  const previousRateLimitRequests = (await readFile(requestLog, 'utf8')).split('\n').filter(s => s.includes('account/rateLimits/read')).length;
  const controller = new AbortController();
  const cancelled = query({ includeRateLimits: true, timeoutMs: 5000, signal: controller.signal });
  await waitFor(async () => {
    const current = (await readFile(requestLog, 'utf8')).split('\n').filter(s => s.includes('account/rateLimits/read')).length;
    return current > previousRateLimitRequests;
  }, 'cancellable rate-limit request to start');
  controller.abort();
  await assert.rejects(cancelled, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  await provider({ account: { type: 'apiKey' } });
  assert.equal((await query({ includeRateLimits: true })).usage.status, 'unsupported');
  await provider({ changeAuth: '{"tokens":{}}', limits });
  await assert.rejects(query({ includeRateLimits: true }), /account changed/);
  await login();
  await provider({ limits });
  let clock = Date.now();
  const manager = createCodexAuthManager({ resolveCommand: async () => command, resolveHome: () => home, baseEnv: () => env, now: () => clock });
  const status = await manager.getStatus();
  assert.equal(status.account.name, 'Test Name');
  const [a, b] = await Promise.all([manager.getRateLimits(), manager.getRateLimits()]);
  assert.deepEqual(a, b);
  assert.equal(a.accountRevision, status.accountRevision);
  const requests = () => readFile(join(home, 'requests.jsonl'), 'utf8');
  const count = (await requests()).split('\n').filter(s => s.includes('account/rateLimits/read')).length;
  await manager.getRateLimits();
  assert.equal((await requests()).split('\n').filter(s => s.includes('account/rateLimits/read')).length, count);
  await provider({ limits: { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } } });
  await login('Second Name');
  const changed = await manager.getRateLimits();
  assert.notEqual(changed.accountRevision, a.accountRevision);
  assert.equal(changed.buckets[0].primary.remainingPercent, 50);
  await provider({ limits });
  const refreshed = await manager.getRateLimits({ force: true });
  assert.equal(refreshed.buckets[0].primary.remainingPercent, 75);
  clock += 61_000;
  await provider({ error: true });
  assert.equal((await manager.getRateLimits()).status, 'unavailable');
  assert.equal((await manager.logout()).account, null);
  assert.equal((await manager.getRateLimits()).status, 'signed_out');
  assert.equal((await manager.getStatus()).accountRevision, '');
  const calls = (await requests()).trim().split('\n').map(s => JSON.parse(s).method);
  assert.ok(calls.every(method => ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'].includes(method)), 'no AI turns or threads');
  for (const pathname of ['/api/codex-auth/status', '/api/codex-auth/rate-limits']) {
    for (const role of ['visitor', undefined]) {
      let code;
      await handleCodexAuthRoutes({ req: { method: 'GET' }, res: {}, pathname, authSession: { role }, writeJson: (_r, status) => { code = status; }, authManager: {} });
      assert.equal(code, 403);
    }
  }
  console.log('Codex account, usage, cache, privacy, switch and owner-boundary tests passed');
} finally { await rm(home, { recursive: true, force: true }); }

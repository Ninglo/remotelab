import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'http-codex-balance-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'), bin = join(home, 'bin'), codexHome = join(home, '.codex');
await mkdir(config, { recursive: true }); await mkdir(bin); await mkdir(codexHome);
process.env.REMOTELAB_MACHINE_CODEX_HOME = codexHome;
process.env.CODEX_HOME = codexHome;
await copyFile(new URL('./fixtures/codex-session-routing.cjs', import.meta.url), join(bin, 'codex'));
await chmod(join(bin, 'codex'), 0o755);
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'fixture-token' }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ fixture: { expiry: Date.now() + 3600000, role: 'owner' } }));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'balance-fixture', name: 'Balance fixture',
  command: join(bin, 'codex'), runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user',
  models: [{ id: 'fixture', label: 'Fixture' }] }]));
const { codexAccounts: pool } = await import('../lib/codex-accounts.mjs');
const accounts = [await pool.account(), await pool.add('B'), await pool.add('C')];
for (const [n, account] of accounts.entries()) {
  await writeFile(join(account.home, 'fixture.json'), JSON.stringify({ id: 'account-' + n, hold: true }));
  await writeFile(join(account.home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'workspace-' + n,
    id_token: 'x.' + Buffer.from(JSON.stringify({ sub: 'synthetic-' + n })).toString('base64url') + '.x' } }));
  await pool.refresh(account.id, join(bin, 'codex'));
}
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server, logs = '';
const runs = [];
async function request(method, path, body) {
  const response = await fetch(base + path, { method, headers: { Cookie: 'session_token=fixture', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert(response.ok, JSON.stringify(data)); return data;
}
async function waitFor(check, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs; let interval = 250;
  while (true) {
    const value = await check(); if (value) return value;
    if (Date.now() >= deadline || (server && (server.exitCode !== null || server.signalCode))) throw new Error(`Timeout/exit: ${label}\n${logs.slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, interval)); interval = Math.min(interval * 2, 2000);
  }
}
async function start() {
  server = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env,
    CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, REMOTELAB_PROJECT_ROOT: process.cwd(),
    REMOTELAB_CHAT_BASE_URL: base, REMOTELAB_MEMORY_DIR: join(home, 'memory'), REMOTELAB_WORK_ROOT_DIR: home,
    PATH: `${bin}:${process.env.PATH}`, SECURE_COOKIES: '0', REMOTELAB_MEMORY_WRITEBACK: 'off',
    REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await waitFor(() => request('GET', '/api/auth/me').then(() => true, () => false), 'test instance ready');
  console.log('Isolated RemoteLab HTTP instance ready on loopback port', port);
}
async function stop() {
  if (server && server.exitCode === null && !server.signalCode) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
}
const state = async id => (await request('GET', '/api/runs/' + id)).run;
async function submit(sessionId, text) {
  const response = await request('POST', `/api/sessions/${sessionId}/messages`, { requestId: 'balance-' + Date.now() + Math.random(),
    text, tool: 'balance-fixture', model: 'fixture' });
  runs.push(response.run.id); return response.run.id;
}
const invocations = async () => (await readFile(join(config, 'balance-invocations.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  await start();
  const policy = await request('POST', '/api/codex-auth/accounts/policy', { balanceSessions: true });
  assert.equal(policy.accountList.balanceSessions, true);
  const sessions = await Promise.all(Array.from({ length: 6 }, (_, n) => request('POST', '/api/sessions', {
    folder: home, tool: 'balance-fixture', name: 'Balanced ' + n }).then(r => r.session.id)));
  const firstRuns = await Promise.all(sessions.map(id => submit(id, 'Hold this synthetic turn.')));
  await waitFor(async () => (await invocations()).length === 6, 'six native turns started');
  const firstStates = await Promise.all(firstRuns.map(state));
  const distribution = Object.values(firstStates.reduce((counts, run) => {
    const id = run.codexAccount.id; counts[id] = (counts[id] || 0) + 1; return counts;
  }, {}));
  assert.deepEqual(distribution, [2, 2, 2]);
  console.log('Six concurrent Sessions distributed 2/2/2 across three accounts.');
  const pids = firstStates.map(run => run.toolProcessId);
  await stop();
  for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0), 'control-plane restart preserves executing providers');
  await start(); await writeFile(join(config, 'release'), 'released');
  for (const id of firstRuns) await waitFor(async () => { const run = await state(id); if (run.state === 'failed') throw new Error(run.failureReason); return run.state === 'completed'; }, 'detached run completion');
  for (const id of sessions) await waitFor(async () => (await request('GET', '/api/sessions/' + id)).session.activity.run.state === 'idle', 'session settles');
  console.log('Test service restarted during execution; all six original runs completed.');
  const secondRuns = await Promise.all(sessions.map(id => submit(id, 'Continue the same conversation.')));
  for (const [n, id] of secondRuns.entries()) {
    const run = await waitFor(async () => { const run = await state(id); if (run.state === 'failed') throw new Error(run.failureReason); return run.state === 'completed' && run; }, 'same-account continuation');
    assert.equal(run.codexAccount.id, firstStates[n].codexAccount.id);
    assert.equal(run.codexThreadId, firstStates[n].codexThreadId);
  }
  assert.equal((await invocations()).length, 12, 'restart neither repeats nor drops native turns');
  console.log('All six follow-ups retained their account and native thread; no duplicated turns.');
  // Force a provider-side 429 after admission and verify terminal failure,
  // cooldown projection, and no retry on any other account.
  const accountId = firstStates[0].codexAccount.id;
  const account = accounts.find(account => account.id === accountId);
  await writeFile(join(account.home, 'fixture.json'), JSON.stringify({ id: 'limited', fail: 'exceeded retry limit, last status: 429 Too Many Requests' }));
  const failed = await submit(sessions[0], 'One rate-limited attempt.');
  await waitFor(async () => (await state(failed)).state === 'failed', '429 termination');
  await waitFor(async () => (await pool.account(accountId)).cooldownUntil > Date.now(), '429 cooldown persisted');
  assert.equal((await invocations()).length, 13);
  const blocked = await submit(sessions[0], 'Keep my original account.');
  const blockedState = await waitFor(async () => { const run = await state(blocked); return run.state === 'failed' && run; }, 'bound cooldown refusal');
  assert.match(blockedState.failureReason, /不自动切换/);
  assert.equal((await invocations()).length, 13, 'bound cooldown does not launch or replay');
  const fresh = (await request('POST', '/api/sessions', { folder: home, tool: 'balance-fixture' })).session.id;
  const healthy = await submit(fresh, 'Use an available account.');
  const healthyState = await waitFor(async () => { const run = await state(healthy); return run.state === 'completed' && run; }, 'new Session bypasses cooled account');
  assert.notEqual(healthyState.codexAccount.id, accountId);
  console.log('429 cooldown blocks further use without moving a bound Session; new Sessions use healthy accounts.');
  console.log('PASS: isolated HTTP instance, policy, parallel native execution, live restart, conversation continuity, no replay, rate-limit isolation.');
} finally {
  await writeFile(join(config, 'release'), 'released').catch(() => {});
  await stop();
  for (const id of runs) {
    const run = JSON.parse(await readFile(join(config, 'chat-runs', id, 'status.json'), 'utf8').catch(() => '{}'));
    if (!['completed', 'failed', 'cancelled'].includes(run.state)) for (const pid of [run.toolProcessId, run.runnerProcessId]) {
      if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'http-personal-codex-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'), bin = join(home, 'bin'), codexHome = join(home, '.codex');
await mkdir(config, { recursive: true }); await mkdir(bin); await mkdir(codexHome);
process.env.REMOTELAB_MACHINE_CODEX_HOME = codexHome; process.env.CODEX_HOME = codexHome;
await copyFile(new URL('./fixtures/codex-personal-account.cjs', import.meta.url), join(bin, 'codex'));
await chmod(join(bin, 'codex'), 0o755);
const people = ['a', 'b', 'admin'].map((id, index) => ({ id: 'person_' + id, name: id, handle: id,
  credentials: [{ id: 'credential_' + id, type: 'token', token: String(index + 1).repeat(64) }],
  identities: [{ id: 'identity_' + id, kind: 'web', realm: 'remotelab', subjectId: id }] }));
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_admin',
  administratorPersonIds: ['person_admin'], serviceToken: 'f'.repeat(64), people }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify(Object.fromEntries(people.map(p =>
  [p.handle, { personId: p.id, expiry: Date.now() + 3600_000 }]))));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'personal-fixture', name: 'Personal fixture',
  command: join(bin, 'codex'), runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user',
  models: [{ id: 'fixture', label: 'Fixture' }] }]));
const { codexAccounts: pool } = await import('../lib/codex-accounts.mjs');
await writeFile(join(codexHome, 'fixture.json'), JSON.stringify({ id: 'shared', remaining: 100 }));
await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'workspace',
  id_token: 'x.' + Buffer.from(JSON.stringify({ sub: 'shared' })).toString('base64url') + '.x' } }));
await pool.refresh('default', join(bin, 'codex'));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const base = 'http://127.0.0.1:' + port;
let server, browser, logs = ''; const runs = [];
async function call(who, path, body, expected = 200) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(who === 'service' ? { Authorization: 'Bearer ' + 'f'.repeat(64) } : { Cookie: 'session_token=' + who }),
    'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs; let delay = 250;
  while (true) {
    const value = await check(); if (value) return value;
    if (Date.now() > deadline || server?.exitCode != null || server?.signalCode) throw new Error(label + '\n' + logs.slice(-5000));
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 2000);
  }
}
async function start() {
  server = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env,
    CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, REMOTELAB_PROJECT_ROOT: process.cwd(),
    REMOTELAB_CHAT_BASE_URL: base, REMOTELAB_MEMORY_DIR: join(home, 'memory'), REMOTELAB_WORK_ROOT_DIR: home,
    PATH: bin + ':' + process.env.PATH, SECURE_COOKIES: '0', REMOTELAB_MEMORY_WRITEBACK: 'off',
    REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', c => { logs += c; }); server.stderr.on('data', c => { logs += c; });
  await waitFor(() => call('a', '/api/auth/me').then(() => true, () => false), 'server startup');
}
async function stop() {
  if (server && server.exitCode === null && !server.signalCode) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
}
async function submit(who, sessionId) {
  const result = await call(who, '/api/sessions/' + sessionId + '/messages', {
    requestId: 'personal-test-' + Date.now() + Math.random(), text: 'Continue fixture task.', tool: 'personal-fixture', model: 'fixture',
    codexAccountPolicy: { personId: 'person_b', personalAccountId: 'forged' },
  }, 202);
  runs.push(result.run.id); return result.run.id;
}
const getRun = async id => (await call('admin', '/api/runs/' + id)).run;
async function finished(id, failed = false) {
  return waitFor(async () => { const run = await getRun(id);
    if (run.state === 'failed' && !failed) throw new Error(run.failureReason);
    return (failed ? run.state === 'failed' : run.state === 'completed') && run;
  }, 'run completion');
}
async function idle(sessionId) {
  await waitFor(async () => (await call('admin', '/api/sessions/' + sessionId)).session.activity.run.state === 'idle', 'session idle');
}
try {
  await start();
  await call('a', '/api/codex-auth/status', undefined, 403);
  await call('service', '/api/personal-codex/status', undefined, 403);
  await call('a', '/api/personal-codex/device-login', { personId: 'person_b' }, 400);
  const states = await Promise.all(['a', 'b'].map(who => call(who, '/api/personal-codex/device-login', { restart: true })));
  assert(states.every(result => result.codexAuth.userCode === 'ABCD-EFGH'));
  const a = await pool.personalAccount('person_a'), b = await pool.personalAccount('person_b');
  for (const [account, sub] of [[a, 'a'], [b, 'b']]) await writeFile(join(account.home, 'approve.json'), JSON.stringify({ sub }));
  for (const who of ['a', 'b']) await waitFor(async () => (await call(who, '/api/personal-codex/status')).codexAuth.loggedIn, 'binding ' + who);
  const shared = await call('admin', '/api/codex-auth/status');
  assert.equal(shared.codexAuth.accountList.accounts.length, 1);
  assert(!JSON.stringify(shared).includes(a.id));
  const sessions = {};
  for (const who of ['a', 'b', 'admin']) sessions[who] = (await call(who, '/api/sessions',
    { folder: home, tool: 'personal-fixture', name: who }, 201)).session.id;
  const initial = await Promise.all(['a', 'b', 'admin'].map(async who => finished(await submit(who, sessions[who]))));
  assert.deepEqual(initial.map(run => run.codexAccount.id), [a.id, b.id, 'default']);
  assert.equal(initial[0].codexAccount.scope, 'personal');
  for (const id of Object.values(sessions)) await idle(id);
  await writeFile(join(a.home, 'fixture.json'), JSON.stringify({ id: 'a', fail: 'usage_limit_reached', remaining: 100 }));
  const failedOver = await finished(await submit('a', sessions.a));
  assert.equal(failedOver.codexAccount.id, 'default');
  assert.equal(failedOver.codexThreadId, initial[0].codexThreadId);
  assert.equal(failedOver.codexFailover.attempts.length, 1);
  assert.equal(failedOver.personalCodexFallback.personId, 'person_a');
  await idle(sessions.a);
  const { loadHistory } = await import('../chat/history.mjs');
  assert((await loadHistory(sessions.a)).some(event => event.source === 'personal_codex_fallback'), 'web fallback notice is retained even without source delivery');
  await stop(); await start();
  assert.equal((await call('a', '/api/personal-codex/status')).codexAuth.loggedIn, true);
  assert.equal((await loadHistory(sessions.a)).filter(event => event.source === 'personal_codex_fallback').length, 1);
  await writeFile(join(a.home, 'fixture.json'), JSON.stringify({ id: 'a', remaining: 100 }));
  await call('a', '/api/personal-codex/status?refresh=1');
  const recovered = await finished(await submit('a', sessions.a));
  assert.equal(recovered.codexAccount.id, a.id); await idle(sessions.a);
  await writeFile(join(a.home, 'fixture.json'), JSON.stringify({ id: 'a', remaining: 100, fail: '429 Too Many Requests' }));
  const rateLimited = await finished(await submit('a', sessions.a), true);
  assert.equal(rateLimited.codexAccount.id, a.id);
  assert.equal(rateLimited.personalCodexFallback, undefined); await idle(sessions.a);
  console.log('PASS: real HTTP member/admin/service boundaries, two independent device logins, owner routing, exhaustion continuation and notice, restart, recovery and no fallback on 429');
  if (process.env.PERSONAL_CODEX_TEST_PLAYWRIGHT) {
    const { chromium } = await import(pathToFileURL(process.env.PERSONAL_CODEX_TEST_PLAYWRIGHT));
    browser = await chromium.launch({ executablePath: process.env.PERSONAL_CODEX_TEST_CHROME, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
    await context.addCookies([{ name: 'session_token', value: 'a', url: base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?tab=settings&skipInstall=1#settings-personal-codex');
    await page.locator('#personalCodexStatus').filter({ hasText: /已绑定|Bound/ }).waitFor().catch(async error => {
      console.error({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0, 3500) }); throw error;
    });
    assert.equal(await page.locator('#settingsCodexAuthSection').count(), 0, 'members have no public account controls');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile has no horizontal overflow');
    await page.locator('#personalCodexBind').click();
    await page.locator('#personalCodexCode').filter({ hasText: 'ABCD-EFGH' }).waitFor();
    assert.equal(await page.locator('#personalCodexAuthorize').getAttribute('href'), 'https://auth.openai.com/codex/device');
    await page.screenshot({ path: join(home, 'personal-codex-mobile.png'), fullPage: true });
    await page.locator('#personalCodexCancel').click();
    await page.locator('#personalCodexDevice').waitFor({ state: 'hidden' });
    assert.equal((await call('b', '/api/personal-codex/status')).codexAuth.loggedIn, true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#myCodexButton').click();
    await page.locator('#personalCodexBind').click();
    await page.locator('#personalCodexCode').filter({ hasText: 'ABCD-EFGH' }).waitFor();
    await writeFile(join(a.home, 'approve.json'), JSON.stringify({ sub: 'a' }));
    await page.locator('#personalCodexStatus').filter({ hasText: '已绑定' }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#personalCodexUnbind').click();
    await page.locator('#personalCodexStatus').filter({ hasText: '未绑定' }).waitFor();
    assert.equal((await pool.executionPolicy('person_a')).personalAccountId, null);
    assert.deepEqual(errors, []);
    if (process.env.PERSONAL_CODEX_TEST_SCREENSHOT) await copyFile(join(home, 'personal-codex-mobile.png'), process.env.PERSONAL_CODEX_TEST_SCREENSHOT);
    console.log('PASS: real desktop/mobile binding UI, direct link, authorization code, cancel/retry, automatic completion, unbind and no JavaScript errors');
    await context.close();
  }
} finally {
  await browser?.close();
  if (server?.exitCode === null && !server.signalCode) {
    await Promise.allSettled(['a', 'b'].map(who => call(who, '/api/personal-codex/cancel-login', {})));
  }
  await stop();
  for (const id of runs) {
    const run = JSON.parse(await readFile(join(config, 'chat-runs', id, 'status.json'), 'utf8').catch(() => '{}'));
    if (!['completed', 'failed', 'cancelled'].includes(run.state)) for (const pid of [run.toolProcessId, run.runnerProcessId]) {
      if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

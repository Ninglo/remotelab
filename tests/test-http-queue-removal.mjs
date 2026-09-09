// Optional browser coverage: append <playwright module> <artifact directory>.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'http-queue-removal-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
const bin = join(home, 'bin');
const release = join(home, 'release');
await mkdir(config, { recursive: true });
await mkdir(bin);
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'fixture-token' }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ fixture: { expiry: Date.now() + 3600000, role: 'owner' } }));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'queue-fixture', name: 'Queue fixture',
  command: 'queue-fixture', runtimeFamily: 'codex-json', promptMode: 'bare-user',
  models: [{ id: 'fixture', label: 'Fixture' }], reasoning: { kind: 'enum', levels: ['low'], default: 'low' } }]));
await writeFile(join(bin, 'queue-fixture'), `#!/usr/bin/env node
const { existsSync } = require('node:fs');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
const timeout = setTimeout(() => process.exit(1), 45000);
const poll = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  clearInterval(poll); clearTimeout(timeout);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
}, 25);
`);
await chmod(join(bin, 'queue-fixture'), 0o755);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server;
let browser;
let logs = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let n = 0; n < 150; n++) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timeout: ${label}\n${logs.slice(-3000)}`);
}
async function request(method, path, body, authenticated = true) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: {
    ...(authenticated ? { Cookie: 'session_token=fixture' } : {}), 'Content-Type': 'application/json',
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function start() {
  server = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env,
    CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, SECURE_COOKIES: '0',
    PATH: `${bin}:${process.env.PATH}`, REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  await waitFor(() => request('GET', '/api/auth/me').then(r => r.status === 200, () => false), 'server startup');
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await once(server, 'exit');
}
try {
  await start();
  const created = await request('POST', '/api/sessions', { folder: home, tool: 'queue-fixture', name: 'Queue removal' });
  assert.equal(created.status, 201);
  const id = created.body.session.id;
  const sessionPath = `/api/sessions/${id}`;
  const removePath = requestId => `${sessionPath}/queue/${encodeURIComponent(requestId)}`;
  const submit = (requestId, text = requestId) => request('POST', `${sessionPath}/messages`, { requestId, text, tool: 'queue-fixture', model: 'fixture' });
  const first = await submit('first');
  await waitFor(() => request('GET', sessionPath).then(r => r.body.session.activity.run.state === 'running'), 'first starts');
  const mistakeId = 'feishu:mistake/one';
  const mistake = await submit(mistakeId);
  assert.equal(mistake.body.queued, true);
  await submit('last');
  assert.equal((await request('DELETE', removePath(mistakeId), undefined, false)).status, 401);
  assert.equal((await request('DELETE', removePath('first'))).status, 409, 'cannot remove active request');
  assert.equal((await request('DELETE', removePath('missing'))).status, 404);
  assert.equal((await request('DELETE', `${sessionPath}/queue/%ZZ`)).status, 400);
  const other = await request('POST', '/api/sessions', { folder: home, tool: 'queue-fixture' });
  assert.equal((await request('DELETE', `/api/sessions/${other.body.session.id}/queue/${encodeURIComponent(mistakeId)}`)).status, 404);
  const removed = await request('DELETE', removePath(mistakeId));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.session.queuedMessages.map(x => x.requestId), ['last']);
  assert.equal(removed.body.session.activity.queue.count, 1);
  assert.equal((await request('DELETE', removePath(mistakeId))).status, 200);
  assert.equal((await request('GET', `/api/runs/${mistake.body.run.id}`)).body.run.state, 'cancelled');
  const replay = await submit(mistakeId);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.queued, false);
  assert.equal(replay.body.response.state, 'cancelled');

  if (process.argv[2]) {
    const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
    const output = resolve(process.argv[3]);
    await mkdir(output, { recursive: true });
    for (let n = 0; n < 6; n++) await submit(`browser-${n}`);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'en-US' });
    await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?session=${id}&tab=sessions`);
    const panel = page.locator('#queuedPanel');
    await panel.locator('.queued-panel-header').click();
    assert.equal(await panel.locator('.queued-item-remove').count(), 7, 'all queued messages are removable');
    await page.screenshot({ path: join(output, 'queue-desktop.png') });
    const buttons = panel.locator('.queued-item-remove');
    // Remove an older row using the keyboard, then a newer row on a phone viewport.
    await buttons.nth(1).focus();
    await page.keyboard.press('Enter');
    await waitFor(async () => await buttons.count() === 6, 'keyboard removal');
    await page.setViewportSize({ width: 390, height: 844 });
    await buttons.last().click();
    await waitFor(async () => await buttons.count() === 5, 'mobile removal');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(output, 'queue-mobile.png') });
    await page.reload();
    await panel.locator('.queued-panel-header').click();
    assert.equal(await buttons.count(), 5, 'removed rows stay absent after reload');
    assert.deepEqual(errors, []);
    for (let n = 1; n < 5; n++) assert.equal((await request('DELETE', removePath(`browser-${n}`))).status, 200);
    await browser.close(); browser = null;
  }

  await stop();
  await start();
  const recovered = await request('GET', sessionPath);
  assert.deepEqual(recovered.body.session.queuedMessages.map(x => x.requestId), ['last'], 'restart retains removal');
  assert.equal((await request('GET', `/api/runs/${mistake.body.run.id}`)).body.run.state, 'cancelled');
  await writeFile(release, 'release');
  await waitFor(() => request('GET', sessionPath).then(r => r.body.session.activity.run.state === 'idle' && r.body.session.activity.queue.count === 0), 'remaining FIFO drains');
  const history = await request('GET', `${sessionPath}/events?after=0`);
  const userInputs = history.body.events.filter(event => event.type === 'message' && event.role === 'user');
  assert.deepEqual(userInputs.map(event => event.requestId), ['first', 'last'], 'removed messages never enter the transcript');
  await assert.rejects(readFile(join(config, 'chat-runs', mistake.body.run.id, 'launch.json')), { code: 'ENOENT' });
  assert.equal((await request('GET', `/api/runs/${first.body.run.id}`)).body.run.state, 'completed');
  console.log('HTTP queue removal: auth, scope, encoded IDs, conflict, idempotence, replay, live restart and FIFO passed');
} finally {
  await writeFile(release, 'release').catch(() => {});
  await browser?.close();
  await stop();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

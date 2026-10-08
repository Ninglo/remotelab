import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'usage-http-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'), bin = join(home, 'bin');
await mkdir(config, { recursive: true }); await mkdir(bin);
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({
  fixture: { expiry: Date.now() + 3600000, role: 'owner' },
  connector: { expiry: Date.now() + 3600000, role: 'owner', authKind: 'service' },
}));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-native', command: 'fake-native', name: 'Fixture',
  runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user', models: [{ id: 'fake-model', label: 'Fixture' }] }]));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: repo,
  env: { ...process.env, HOME: home, CHAT_PORT: String(port), SECURE_COOKIES: '0',
    REMOTELAB_MEMORY_WRITEBACK: 'off', PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
const ready = new Promise((resolve, reject) => {
  server.stdout.on('data', chunk => { logs += chunk; if (logs.includes('Chat server listening')) resolve(); });
  server.stderr.on('data', chunk => { logs += chunk; });
  server.once('exit', () => reject(new Error(logs)));
});
async function request(method, path, body, connector = false) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: `session_token=${connector ? 'connector' : 'fixture'}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}
async function until(predicate) {
  const deadline = Date.now() + 15000;
  let delay = 25;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(1000, delay * 2);
  }
  throw new Error(`Question did not change state\n${logs}`);
}
try {
  await ready;
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/api/usage/analysis')).status, 401, 'analysis requires authentication');
  const me = (await request('GET', '/api/auth/me')).json;
  assert.ok(me.person?.id);
  const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-native', model: 'fake-model' });
  assert.equal(created.status, 201);
  const sessionId = created.json.session.id;
  const sourceContext = { connector: 'feishu', sourceRouteId: 'fixture', chatId: 'fixture-group', rootId: 'fixture-topic',
    sender: { openId: 'fixture-human', senderType: 'user', name: me.person.name, handle: me.person.handle } };
  const messages = `/api/sessions/${sessionId}/messages`;
  const accepted = await request('POST', messages, { text: 'ASK_NATIVE_QUESTION', requestId: 'feishu-start', sourceContext }, true);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  const pending = await until(async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events
    ?.find(event => event.messageKind === 'user_question' && event.questionState === 'pending'));
  assert.equal(pending.questionDeadline, null);
  const query = () => request('GET', `/api/usage/analysis?sessionId=${sessionId}`);
  let summary = (await query()).json;
  const firstInput = summary.events.find(event => event.event === 'message_submitted');
  assert.equal(firstInput.surface, 'feishu'); assert.equal(firstInput.actorKind, 'human');
  assert.ok(firstInput.personHash); assert.ok(firstInput.conversationKey);
  assert.ok(summary.events.some(event => event.event === 'question_state' && event.state === 'pending' && event.runId === pending.runId));
  const clientEvent = { event: 'session_open', eventId: 'browser-open', sessionId, personHash: 'spoofed', personId: 'spoofed',
    actorKind: 'agent', surface: 'feishu', content: 'private-client-content', props: { token: 'private-secret' } };
  assert.equal((await request('POST', '/api/usage/events', { events: [clientEvent] })).status, 202);
  assert.equal((await request('POST', '/api/usage/events', { events: [clientEvent] })).status, 202);
  assert.equal((await request('POST', '/api/usage/events', { events: [{ ...clientEvent, event: 'run_state' }] })).status, 400);
  assert.equal((await request('POST', '/api/usage/events', { events: [clientEvent] }, true)).status, 403);
  const answer = { text: '2', requestId: 'web-answer', nativeQuestionId: pending.questionId, nativeQuestionAnswerSource: 'control' };
  assert.equal((await request('POST', messages, answer)).status, 202);
  assert.equal((await request('POST', messages, answer)).status, 200, 'retry of durable input is idempotent');
  await until(async () => (await query()).json.events.some(event => event.event === 'question_state' && event.state === 'answered'));
  await until(async () => (await query()).json.events.some(event => event.event === 'run_state' && event.state === 'completed'));
  assert.equal((await query()).json.events.filter(event => event.event === 'run_state' && event.state === 'completed').length, 1, 'answering a question does not manufacture a second completed Run');
  assert.equal((await request('POST', messages, { text: 'Continue in original Feishu topic', requestId: 'feishu-return', sourceContext }, true)).status, 202);
  summary = (await query()).json;
  const browser = summary.events.find(event => event.eventId === 'browser-open');
  assert.equal(browser.surface, 'web'); assert.equal(browser.actorKind, 'human');
  assert.equal(browser.personHash, firstInput.personHash, 'verified Web and Feishu identities link to the same person');
  assert.equal(summary.byEvent.session_open, 1);
  assert.equal(summary.byEvent.message_submitted, 3, 'duplicates and question controls count once');
  assert.equal(summary.paths.feishuStarted, 1); assert.equal(summary.paths.webOpened, 1);
  assert.equal(summary.paths.webContinued, 1); assert.equal(summary.paths.originalFeishuContinued, 1);
  const raw = JSON.stringify(summary);
  for (const privateText of ['ASK_NATIVE_QUESTION', 'private-client-content', 'private-secret', 'spoofed', 'fixture-human', 'fixture-topic', 'fixture-group']) {
    assert.equal(raw.includes(privateText), false, `analytics strips ${privateText}`);
  }
  if (process.argv[2]) {
    const { chromium } = await import(process.argv[2]);
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
      await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + `/?tab=tasks&monitor=usage&session=${sessionId}`);
      await page.waitForSelector('#usageAnalysisContent table');
      assert.equal(await page.locator('#monitoringUsage').isVisible(), true);
      assert.equal(await page.locator('#monitoringAutomations').isVisible(), false);
      await page.locator('#monitoringOverviewTab').click();
      assert.equal(await page.locator('#monitoringOverview').isVisible(), true);
      await page.locator('#monitoringUsageTab').click();
      await page.waitForSelector('#usageAnalysisContent table');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator('#monitoringUsage').isVisible(), true);
      assert.deepEqual(errors, [], 'the real workbench and analysis load without browser errors');
      await page.evaluate(() => window.RemoteLabUsage.flush());
      const afterBrowser = (await request('GET', '/api/usage/analysis')).json;
      assert.ok(afterBrowser.events.some(event => event.event === 'ui_action' && event.action === 'monitor_usage'));
      await page.setViewportSize({ width: 1100, height: 850 });
      await page.goto(base + `/?tab=sessions&session=${sessionId}`);
      await page.waitForSelector('.msg-assistant');
      await page.locator('.msg-assistant').last().scrollIntoViewIfNeeded();
      await page.evaluate(() => window.RemoteLabUsage.flush());
      await page.evaluate(async () => { await refreshCurrentSession(); await window.RemoteLabUsage.flush(); });
      await until(async () => (await query()).json.events.some(event => event.event === 'content_presented'));
      const conversationEvents = (await query()).json.events;
      assert.ok(conversationEvents.some(event => event.event === 'session_open' && event.visitId), 'actual Web session entry is observed');
      assert.ok(conversationEvents.some(event => event.event === 'content_presented'), 'foreground viewport presentation is observed');
      const presented = conversationEvents.filter(event => event.event === 'content_presented');
      const unique = new Set(presented.map(event => [event.visitId,event.sessionId,event.historySeq,event.kind,event.state].join(':')));
      assert.equal(presented.length, unique.size, 'refresh does not count the same presented message twice');

    } finally { await browser.close(); }
  }
  console.log('http usage events: authenticated cross-surface identity, native waits, retries, privacy and analysis passed');
} finally {
  server.kill('SIGTERM'); await once(server, 'exit'); await rm(home, { recursive: true, force: true });
}

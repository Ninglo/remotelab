// Optional browser gate: node tests/test-chat-mobile-voice-browser.mjs <playwright module> <artifact directory>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const artifacts = resolve(process.argv[3]);
const root = await mkdtemp(join(tmpdir(), 'remotelab-mobile-voice-browser-'));
const config = join(root, 'config');
await Promise.all([mkdir(config), mkdir(artifacts, { recursive: true })]);
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, serviceToken: 'fixture-service', primaryPersonId: 'alpha',
  people: [{ id: 'alpha', name: 'Alpha', handle: 'alpha', credentials: [], identities: [], preferences: {} },
    { id: 'beta', name: 'Beta', handle: 'beta', credentials: [], identities: [], preferences: {} }] }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({
  'mobile-voice-fixture': { expiry: Date.now() + 3600000, personId: 'alpha', personName: 'Alpha', identityId: 'alpha-web', preferredLanguage: 'zh-CN' },
  'mobile-voice-other': { expiry: Date.now() + 3600000, personId: 'beta', personName: 'Beta', identityId: 'beta-web' },
}));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: resolve('.'), env: { ...process.env,
  CHAT_PORT: String(port), REMOTELAB_INSTANCE_ROOT: root, REMOTELAB_CONFIG_DIR: config,
  REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1', SECURE_COOKIES: '0',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Server startup timeout: ${serverOutput}`)), 15000);
    server.once('exit', code => { clearTimeout(deadline); reject(new Error(`Server exited ${code}: ${serverOutput}`)); });
    server.stdout.on('data', chunk => { serverOutput += chunk; if (serverOutput.includes('Chat server listening on')) { clearTimeout(deadline); resolve(); } });
    server.stderr.on('data', chunk => { serverOutput += chunk; });
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'session_token', value: 'mobile-voice-fixture', url: baseUrl }]);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const installTransport = async () => page.evaluate(() => {
    window.remotelabGetVoiceInputInstanceSettings = () => ({ provider: 'doubao', appId: 'fixture', accessToken: 'fixture', resourceId: 'fixture' });
    class VoiceSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; this.handlers = new Map(); window.__voiceSocket = this;
        queueMicrotask(() => { this.readyState = 1; this.emit('open'); this.emit('message', { type: 'status', phase: 'ready' }); }); }
      addEventListener(type, handler) { this.handlers.set(type, handler); }
      emit(type, payload) { this.handlers.get(type)?.({ data: JSON.stringify(payload), code: 1000 }); }
      send(payload) { if (typeof payload === 'string' && JSON.parse(payload).type === 'stop') window.__voiceStop = true; }
      close() { this.readyState = 3; this.emit('close'); }
    }
    window.WebSocket = VoiceSocket;
    window.__sent = [];
    sendMessage = () => { window.__sent.push(msgInput.value); msgInput.value = ''; msgInput.dispatchEvent(new Event('input', { bubbles: true })); };
    msgInput.disabled = false;
    window.remotelabRefreshVoiceInputUi();
    window.remotelabRefreshMobileVoiceUi({ preferences: true });
  });
  await page.goto(baseUrl); await page.waitForFunction(() => !!window.remotelabRefreshMobileVoiceUi); await installTransport();
  const cdp = await context.newCDPSession(page);
  async function startHold(selector) {
    const box = await page.locator(selector).boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await page.waitForFunction(() => window.remotelabVoiceCapture.getState().phase === 'recording');
    return box;
  }
  const endHold = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const final = text => page.evaluate(text => window.__voiceSocket.emit('message', { type: 'done', transcript: text }), text);

  await page.locator('#voiceBtn').tap();
  await page.waitForFunction(() => !document.getElementById('mobileVoiceHold').hidden && !document.getElementById('mobileVoiceMode').disabled);
  const persisted = JSON.parse(await readFile(join(config, 'auth.json'), 'utf8'));
  assert.equal(persisted.people.find(person => person.id === 'alpha').preferences.mobileInputMode, 'voice');
  const forbidden = await context.request.patch(`${baseUrl}/api/people/beta`, { data: { mobileInputMode: 'voice' } });
  assert.equal(forbidden.status(), 403);
  assert.equal((await context.request.patch(`${baseUrl}/api/people/alpha`, { data: { mobileInputMode: 'invalid' } })).status(), 400);
  await page.reload(); await page.waitForFunction(() => !!window.remotelabRefreshMobileVoiceUi); await installTransport();
  assert.equal(await page.locator('#mobileVoiceHold').isVisible(), true, 'saved voice mode survives a real page reload');
  await page.screenshot({ path: join(artifacts, 'mobile-voice-ready.png') });
  await startHold('#mobileVoiceHold');
  assert.equal(await page.locator('#mobileVoicePanel').isVisible(), true);
  const visiblePanel = await page.locator('#mobileVoicePanel').boundingBox();
  assert.ok(visiblePanel.y > 0 && visiblePanel.width <= 390);
  await page.screenshot({ path: join(artifacts, 'mobile-voice-recording.png') });
  await endHold(); await page.waitForFunction(() => window.__voiceStop === true);
  await page.evaluate(() => window.__voiceSocket.emit('message', { type: 'transcript', transcript: '检查' }));
  await page.locator('#sendBtn').tap();
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  await final('请帮我检查任务状态'); await page.waitForFunction(() => window.__sent.length === 1);

  await startHold('#mobileVoiceHold');
  const cancelBox = await page.locator('#mobileVoiceCancel').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cancelBox.x + cancelBox.width / 2, y: cancelBox.y + cancelBox.height / 2 }] });
  await endHold(); await page.waitForFunction(() => document.getElementById('mobileVoicePanel').hidden);
  assert.equal(await page.evaluate(() => window.__sent.length), 1, 'a native touch slide cancels without sending');

  await startHold('#mobileVoiceHold'); await endHold(); await page.locator('#mobileVoiceEdit').tap();
  await final('先改字再发送'); await page.waitForFunction(() => document.getElementById('mobileVoicePanel').hidden);
  assert.equal(await page.locator('#msgInput').inputValue(), '先改字再发送');
  assert.equal(await page.evaluate(() => window.__sent.length), 1);
  await page.screenshot({ path: join(artifacts, 'mobile-voice-edit.png') });
  await page.setViewportSize({ width: 1050, height: 850 });
  assert.equal(await page.locator('#msgInput').isVisible(), true);
  assert.equal(await page.locator('#mobileVoiceHold').isVisible(), false);
  assert.equal(await page.locator('#mobileVoiceMode').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('test-chat-mobile-voice-browser: real touch, audio capture with simulated recognition, auto-send, slide cancellation, editing, persisted mode and ownership passed');
} finally {
  await browser.close();
  server.kill('SIGTERM'); if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
  await rm(root, { recursive: true, force: true });
}

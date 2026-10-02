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
// Chromium reads real varying-volume PCM through getUserMedia and the AudioWorklet.
const audioFile = join(root, 'voice-envelope.wav');
const sampleRate = 48000, audioFrames = sampleRate * 3;
const audio = Buffer.alloc(44 + audioFrames * 2);
audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audioFrames * 2, 40);
for (let index = 0; index < audioFrames; index++) {
  const time = index / sampleRate;
  const envelope = time < 0.4 || time > 1.5 ? 0 : 0.12 * Math.sin(Math.PI * (time - 0.4) / 1.1) ** 2;
  audio.writeInt16LE(Math.round(32767 * envelope * Math.sin(2 * Math.PI * 220 * time)), 44 + index * 2);
}
await writeFile(audioFile, audio);
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: resolve('.'), env: { ...process.env,
  CHAT_PORT: String(port), REMOTELAB_INSTANCE_ROOT: root, REMOTELAB_CONFIG_DIR: config,
  REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1', SECURE_COOKIES: '0',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audioFile}`] });
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
  assert.ok((await page.locator('.input-wrapper').boundingBox()).height <= 85, 'voice mode is one compact composer row');
  assert.equal(await page.locator('#sendBtn').isVisible(), false, 'an empty voice composer has no text to send');
  await page.screenshot({ path: join(artifacts, 'mobile-voice-ready.png') });
  await startHold('#mobileVoiceHold');
  assert.equal(await page.locator('#mobileVoicePanel').isVisible(), true);
  const visiblePanel = await page.locator('#mobileVoicePanel').boundingBox();
  assert.ok(visiblePanel.y > 0 && visiblePanel.width <= 390);
  const waveform = await page.evaluate(() => new Promise(resolve => {
    const samples = []; let start;
    function sample(time) {
      start ??= time;
      samples.push(Array.from(document.querySelectorAll('.mobile-voice-level i'), bar => parseFloat(getComputedStyle(bar).height)));
      if (time - start >= 3200) resolve(samples); else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }));
  assert.ok(waveform.some(heights => Math.max(...heights) > 12), 'real captured sound raises the waveform');
  assert.ok(waveform.some(heights => Math.max(...heights) - Math.min(...heights) > 5), 'volume history gives different bar heights');
  assert.ok(waveform.some(heights => Math.max(...heights) < 4.5), 'captured silence settles to a quiet baseline');
  await page.screenshot({ path: join(artifacts, 'mobile-voice-recording.png') });
  await endHold(); await page.waitForFunction(() => window.__voiceStop === true);
  await page.evaluate(() => window.__voiceSocket.emit('message', { type: 'transcript', transcript: '检查' }));
  await page.evaluate(() => document.getElementById('sendBtn').click());
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  await final('请帮我检查任务状态'); await page.waitForFunction(() => document.getElementById('mobileVoicePanel').hidden);
  assert.equal(await page.evaluate(() => window.__sent.length), 0, 'the final result waits for the user to check it');
  assert.equal(await page.locator('#msgInput').inputValue(), '请帮我检查任务状态');
  assert.equal(await page.evaluate(() => document.activeElement.id === 'msgInput'), false, 'review keeps the keyboard closed');
  assert.equal(await page.locator('#sendBtn').isVisible(), true);
  await page.screenshot({ path: join(artifacts, 'mobile-voice-review.png') });
  await page.locator('#msgInput').fill('请帮我检查服务状态');
  await page.locator('#sendBtn').tap();
  assert.deepEqual(await page.evaluate(() => window.__sent), ['请帮我检查服务状态']);

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
  for (const size of [{ width: 320, height: 568, scheme: 'light' }, { width: 390, height: 844, scheme: 'light' },
    { width: 430, height: 932, scheme: 'dark' }, { width: 320, height: 568, scheme: 'dark' }]) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.emulateMedia({ colorScheme: size.scheme });
    await page.locator('#msgInput').fill('');
    const suffix = `${size.width}-${size.scheme}`;
    await page.screenshot({ path: join(artifacts, `voice-ready-${suffix}.png`) });
    await startHold('#mobileVoiceHold');
    const spoken = '请帮我把手机端的语音输入整理得简洁一些，取消和改字入口都要清楚，长内容也能看得下。';
    await page.evaluate(text => window.__voiceSocket.emit('message', { type: 'transcript', transcript: text }), spoken);
    for (const selector of ['#mobileVoicePanel', '#mobileVoiceHold', '#mobileVoiceCancel', '#mobileVoiceEdit']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1
        && bounds.y + bounds.height <= size.height + 1, `${selector} fits ${suffix}`);
      if (selector !== '#mobileVoicePanel') assert.ok(bounds.height >= 44, `${selector} retains a touch target`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(artifacts, `voice-recording-${suffix}.png`) });
    const choice = await page.locator('#mobileVoiceEdit').boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: choice.x + choice.width / 2, y: choice.y + choice.height / 2 }] });
    await endHold();
    await page.screenshot({ path: join(artifacts, `voice-recognizing-${suffix}.png`) });
    await final(spoken); await page.waitForFunction(() => document.getElementById('mobileVoicePanel').hidden);
    assert.equal(await page.locator('#msgInput').inputValue(), spoken);
    assert.equal(await page.evaluate(() => window.__sent.length), 1, 'sliding to edit keeps text for an explicit send');
    await page.screenshot({ path: join(artifacts, `voice-edit-${suffix}.png`) });
  }
  await page.locator('#msgInput').fill('');
  await page.locator('#mobileVoiceMode').tap();
  await page.waitForFunction(() => document.getElementById('mobileVoiceHold').hidden && !document.getElementById('mobileVoiceMode').disabled);
  assert.equal(await page.locator('#msgInput').isVisible(), true);
  await startHold('#voiceBtn'); await endHold();
  await page.locator('#mobileVoiceEdit').tap();
  await final('文字模式也能改字'); await page.waitForFunction(() => document.getElementById('mobileVoicePanel').hidden);
  assert.equal(await page.locator('#msgInput').inputValue(), '文字模式也能改字');
  assert.equal(await page.evaluate(() => window.__sent.length), 1);
  await page.locator('#msgInput').fill('');
  await page.locator('#voiceBtn').tap();
  await page.waitForFunction(() => !document.getElementById('mobileVoiceHold').hidden && !document.getElementById('mobileVoiceMode').disabled);
  await page.setViewportSize({ width: 1050, height: 850 });
  await page.waitForFunction(() => !document.getElementById('msgInput').hidden);
  assert.equal(await page.locator('#msgInput').isVisible(), true);
  assert.equal(await page.locator('#mobileVoiceHold').isVisible(), false);
  assert.equal(await page.locator('#mobileVoiceMode').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('test-chat-mobile-voice-browser: real audio volume history, review/edit before manual send, 320/390/430px light/dark layouts, native touch cancel/edit and persisted mode passed (recognition simulated)');
} finally {
  await browser.close();
  server.kill('SIGTERM'); if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
  await rm(root, { recursive: true, force: true });
}

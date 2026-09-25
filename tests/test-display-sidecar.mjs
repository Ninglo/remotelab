#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { decodeGifFrames } from '../display/gif-frames.mjs';
import { prepareAnimatedPreview, previewBundleId, previewFrameId, renderAnimatedPreview, renderAnimatedPreviewJpeg } from '../display/preview-animation.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-display-test-'));
const configDir = join(root, 'config');
await mkdir(configDir, { recursive: true });
const personA = 'person_display_a';
const personB = 'person_display_b';
const animatedGif = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
  33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 1, 0, 59,
]);
const decodedGif = decodeGifFrames(animatedGif);
assert.equal(decodedGif.frames.length, 2);
assert.notDeepEqual(decodedGif.frames[0].png, decodedGif.frames[1].png, 'GIF frames must actually differ');
const installerSource = await readFile(new URL('../display/install.sh', import.meta.url), 'utf8');
assert(installerSource.includes('check-device') && installerSource.indexOf('check-device') < installerSource.indexOf(' enroll "$enrollment_url"'), 'hardware must be checked before enrollment');
await writeFile(join(configDir, 'auth.json'), JSON.stringify({
  version: 2,
  serviceToken: 'a'.repeat(64),
  primaryPersonId: personA,
  people: [
    {
      id: personA,
      name: 'Display A',
      credentials: [],
      identities: [{ id: 'identity_display_a', kind: 'web', realm: 'remotelab', subjectId: 'display-a' }],
    },
    {
      id: personB,
      name: 'Display B',
      credentials: [],
      identities: [{ id: 'identity_display_b', kind: 'web', realm: 'remotelab', subjectId: 'display-b' }],
    },
  ],
}));

function reservePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 25;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(250, delay * 2);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const apiPort = await reservePort();
const displayPort = await reservePort();
let sessionsUnavailable = false;
const api = createServer((req, res) => {
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=test; Path=/' });
    res.end();
    return;
  }
  if (req.url === '/api/sessions') {
    if (sessionsUnavailable) { res.writeHead(503); res.end('sessions unavailable'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [
      {
        name: 'Display A session',
        initiatedByIdentityId: 'identity_display_a',
        conversation: { connector: 'feishu' },
        lastUserMessageAt: Date.now(),
        activity: { run: { state: 'running', startedAt: new Date().toISOString() }, queue: { count: 0 } },
        lastAssistantMessageAt: 0,
        deliveryIssueCount: 0,
      },
      {
        name: 'Display B session',
        initiatedByIdentityId: 'identity_display_b',
        activity: { run: { state: 'running', startedAt: new Date().toISOString() }, queue: { count: 0 } },
        lastAssistantMessageAt: 0,
        deliveryIssueCount: 0,
      },
      {
        name: '项目审阅',
        initiatedByIdentityId: 'identity_display_a',
        activity: { run: { state: 'idle' }, queue: { count: 0 } },
        lastAssistantMessageAt: Date.now(),
        lastReviewedAt: 0,
        workSummary: { summary: '整理本周进展' },
        deliveryIssueCount: 0,
      },
    ] }));
    return;
  }
  if (req.url === '/api/automation-tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: [
      { createdByIdentityId: 'identity_display_a', state: 'active', enabled: true, nextRunAt: new Date(Date.now() + 60_000).toISOString() },
      { createdByIdentityId: 'identity_display_b', state: 'failed', enabled: false, lastExecution: { state: 'failed', completedAt: new Date().toISOString() } },
    ] }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => api.listen(apiPort, '127.0.0.1', resolve));

const displaySpawn = {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    HOME: root,
    REMOTELAB_CONFIG_DIR: configDir,
    REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${apiPort}`,
    REMOTELAB_DISPLAY_PORT: String(displayPort),
    REMOTELAB_DISPLAY_RENDER_MODE: 'signals',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
};
let logs = '';
function launchDisplay() {
  const proc = spawn(process.execPath, ['display/server.mjs'], displaySpawn);
  proc.stdout.on('data', (chunk) => { logs += chunk; });
  proc.stderr.on('data', (chunk) => { logs += chunk; });
  return proc;
}
let child = launchDisplay();

try {
  await waitFor(`http://127.0.0.1:${displayPort}/healthz`);
  const upgradeScript = await fetch(`http://127.0.0.1:${displayPort}/upgrade-agent.sh`);
  assert.equal(upgradeScript.status, 200);
  assert.match(await upgradeScript.text(), /Existing pairing and screen layout were kept/);
  const admin = (await readFile(join(configDir, 'display-admin-token'), 'utf8')).trim();
  const publicHeaders = {
    Authorization: `Bearer ${admin}`,
    'Content-Type': 'application/json',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'remotelab.example',
    'X-Forwarded-Prefix': '/display',
  };
  const enrollmentResponse = await fetch(`http://127.0.0.1:${displayPort}/v1/enrollments`, {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ personId: personA }),
  });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  assert.match(enrollment.command, /https:\/\/remotelab\.example\/display\/install\.sh/);
  assert.match(enrollment.enrollmentUrl, /https:\/\/remotelab\.example\/display\/v1\/enroll\/rld_enroll_/);

  const enrollmentPath = new URL(enrollment.enrollmentUrl).pathname.replace(/^\/display/, '');
  const joinedResponse = await fetch(`http://127.0.0.1:${displayPort}${enrollmentPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test display', hostname: 'test-mac', platform: 'darwin' }),
  });
  assert.equal(joinedResponse.status, 201);
  const joined = await joinedResponse.json();
  assert.match(joined.deviceId, /^display-/);
  assert.match(joined.deviceToken, /^rld_device_/);

  const reused = await fetch(`http://127.0.0.1:${displayPort}${enrollmentPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(reused.status, 410, 'enrollment must be one-use');

  const framePath = new URL(joined.frameUrl).pathname.replace(/^\/display/, '');
  const deniedFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`);
  assert.equal(deniedFrame.status, 401);
  const frame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.equal(frame.headers.get('x-remotelab-display-running'), '1');
  const png = Buffer.from(await frame.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const contentUrl = `http://127.0.0.1:${displayPort}/v1/people/${personA}/content`;
  const contentPayload = { sentence: '今天先做好一件事', gifBase64: animatedGif.toString('base64') };
  const deniedContent = await fetch(contentUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contentPayload) });
  assert.equal(deniedContent.status, 401);
  const savedContent = await fetch(contentUrl, { method: 'PUT', headers: publicHeaders, body: JSON.stringify(contentPayload) });
  assert.equal(savedContent.status, 200);
  assert.equal((await savedContent.json()).sentence, contentPayload.sentence);
  const ownContent = await fetch(contentUrl, { headers: publicHeaders });
  assert.equal((await ownContent.json()).configured, true);
  const otherContent = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personB}/content`, { headers: publicHeaders });
  assert.equal((await otherContent.json()).configured, false, 'other people keep their own screen');
  const image = await fetch(`${contentUrl}.gif`, { headers: publicHeaders });
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), animatedGif);
  const personalFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(personalFrame.headers.get('x-remotelab-display-poll-seconds'), '0.45');
  assert.notDeepEqual(Buffer.from(await personalFrame.arrayBuffer()), png);
  const previewUrl = `http://127.0.0.1:${displayPort}/v1/people/${personA}/preview-frame`;
  const todoUrl = `http://127.0.0.1:${displayPort}/v1/people/${personA}/todos`;
  assert.equal((await fetch(todoUrl)).status, 401, 'To do data requires admin authentication');
  const createdTodo = await fetch(todoUrl, { method: 'POST', headers: publicHeaders,
    body: JSON.stringify({ title: '筛选候选人', dueAt: null, progress: { current: 37, target: 100, unit: '位' } }) });
  assert.equal(createdTodo.status, 201);
  const task = (await createdTodo.json()).item;
  assert.equal(task.progress.current, 37);
  const anotherPersonTodos = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personB}/todos`, { headers: publicHeaders });
  assert.deepEqual((await anotherPersonTodos.json()).items, [], 'To do items are scoped to a Person');
  const advancedTodo = await fetch(`${todoUrl}/${task.id}`, { method: 'PATCH', headers: publicHeaders,
    body: JSON.stringify({ progress: { current: 100 }, status: 'in_progress' }) });
  assert.equal((await advancedTodo.json()).item.status, 'in_progress');
  const todoStatus = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personA}/status`, { headers: publicHeaders });
  assert.equal((await todoStatus.json()).reminderSources.todo.items[0].progress.current, 100);
  const previewPayload = { pngBase64: png.toString('base64') };
  const deniedPreview = await fetch(previewUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(previewPayload) });
  assert.equal(deniedPreview.status, 401, 'only the local administrator can publish a frame');
  const badPreview = await fetch(previewUrl, { method: 'PUT', headers: publicHeaders, body: JSON.stringify({ pngBase64: Buffer.from('bad').toString('base64') }) });
  assert.equal(badPreview.status, 400, 'preview must be a full-size PNG');
  const savedPreview = await fetch(previewUrl, { method: 'PUT', headers: publicHeaders, body: JSON.stringify(previewPayload) });
  assert.equal(savedPreview.status, 200);
  assert.equal((await savedPreview.json()).configured, true);
  const pairedPreviewFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.deepEqual(Buffer.from(await pairedPreviewFrame.arrayBuffer()), png, 'paired device must fetch the custom preview');
  const jpegFramePath = framePath.replace(/frame\.png$/, 'frame.jpg');
  const pairedJpegFrame = await fetch(`http://127.0.0.1:${displayPort}${jpegFramePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(pairedJpegFrame.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...Buffer.from(await pairedJpegFrame.arrayBuffer()).subarray(0, 2)], [255, 216]);
  const otherPreview = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personB}/preview-frame`, { headers: publicHeaders });
  assert.equal((await otherPreview.json()).configured, false, 'another Person must not inherit the preview');
  const animation = [{ gifBase64: animatedGif.toString('base64'), box: { x: 100, y: 100, width: 40, height: 40 }, fit: 'contain' }];
  const preparedAnimation = prepareAnimatedPreview(png, animation);
  assert.notDeepEqual(renderAnimatedPreview(preparedAnimation, 0), renderAnimatedPreview(preparedAnimation, 450), 'different GIF frames must produce different complete display images');
  assert.notDeepEqual(renderAnimatedPreviewJpeg(preparedAnimation, 0), renderAnimatedPreviewJpeg(preparedAnimation, 450), 'direct JPEG frames must animate too');
  const animatedPreview = await fetch(previewUrl, { method: 'PUT', headers: publicHeaders, body: JSON.stringify({ pngBase64: png.toString('base64'), animations: animation }) });
  assert.equal(animatedPreview.status, 200);
  const animatedReceipt = await animatedPreview.json();
  assert.equal(animatedReceipt.animationCount, 1);
  assert.equal(animatedReceipt.frameId, previewFrameId(png, animation));
  const animatedDeviceFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(animatedDeviceFrame.headers.get('x-remotelab-display-poll-seconds'), '0.45');
  assert.notDeepEqual(Buffer.from(await animatedDeviceFrame.arrayBuffer()), png, 'device must receive the composed GIF frame');
  const animatedJpegFrame = await fetch(`http://127.0.0.1:${displayPort}${jpegFramePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(animatedJpegFrame.headers.get('x-remotelab-display-poll-seconds'), '0.18');
  assert.equal(animatedJpegFrame.headers.get('x-remotelab-display-animated'), '1');
  assert.deepEqual([...Buffer.from(await animatedJpegFrame.arrayBuffer()).subarray(0, 2)], [255, 216]);
  const negotiatedJpegFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: 'image/jpeg' } });
  assert.equal(negotiatedJpegFrame.headers.get('content-type'), 'image/jpeg');
  assert.equal(negotiatedJpegFrame.headers.get('x-remotelab-display-poll-seconds'), '0.18');
  assert.deepEqual([...Buffer.from(await negotiatedJpegFrame.arrayBuffer()).subarray(0, 2)], [255, 216]);
  const bundleAccept = 'application/vnd.remotelab.display-frames+json;v=1';
  const animationBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: bundleAccept } });
  assert.equal(animationBundle.status, 200);
  assert.equal(animationBundle.headers.get('content-type'), 'application/vnd.remotelab.display-frames+json');
  const bundle = await animationBundle.json();
  assert.equal(bundle.frameId, animatedReceipt.frameId);
  assert.equal(bundle.intervalMs, 180);
  assert.equal(bundle.frames.length, decodedGif.frames.length);
  assert.notEqual(bundle.frames[0], bundle.frames[1], 'local loop must contain distinct composed GIF frames');
  assert.deepEqual([...Buffer.from(bundle.frames[0], 'base64').subarray(0, 2)], [255, 216]);
  const unchangedBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: `${bundleAccept};id=${bundle.frameId}` } });
  assert.equal(unchangedBundle.status, 304);
  const fasterBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: bundleAccept.replace('v=1', 'v=2') } });
  assert.equal(fasterBundle.status, 200);
  const faster = await fasterBundle.json();
  assert.equal(faster.version, 2);
  assert.equal(faster.intervalMs, 100);
  assert.equal(faster.bundleId, previewBundleId(faster.frameId, 2, 100, 'starter'));
  assert.notEqual(faster.bundleId, previewBundleId(faster.frameId, 2, 50), 'timing changes must invalidate the cached bundle');
  assert.equal(faster.frames.length, decodedGif.frames.length);
  assert.notEqual(faster.frames[0], faster.frames[1]);
  const completedBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: `${bundleAccept.replace('v=1', 'v=2')};id=${faster.bundleId}` } });
  assert.equal(completedBundle.status, 200);
  const completed = await completedBundle.json();
  assert.equal(completed.bundleId, previewBundleId(completed.frameId, 2, 100));
  assert.equal(completed.frames.length, decodedGif.frames.length);
  const unchangedFastBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}`, Accept: `${bundleAccept.replace('v=1', 'v=2')};id=${completed.bundleId}` } });
  assert.equal(unchangedFastBundle.status, 304);
  const wrongBundle = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: 'Bearer invalid-token', Accept: bundleAccept } });
  assert.equal(wrongBundle.status, 401);
  const animationStatus = await fetch(previewUrl, { headers: publicHeaders });
  const animationState = await animationStatus.json();
  assert.equal(animationState.animationDelivery[0]?.deviceId, joined.deviceId);
  assert.equal(animationState.animationDelivery[0]?.samples, 6);
  assert.equal(animationState.animationDelivery[0]?.lastFormat, 'jpeg-bundle');
  assert.equal(animationState.animationDelivery[0]?.bundleFrameCount, decodedGif.frames.length);
  assert.equal(animationState.animationDelivery[0]?.sourceFrameId, bundle.frameId);
  const heartbeatPath = new URL(joined.heartbeatUrl).pathname.replace(/^\/display/, '');
  const playbackReport = await fetch(`http://127.0.0.1:${displayPort}${heartbeatPath}`, {
    method: 'POST', headers: { Authorization: `Bearer ${joined.deviceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usbFrames: 42, usbAckMs: Date.now(), usbFrameMs: 12,
      animationFrames: faster.frames.length, bundleFrameId: faster.frameId, targetIntervalMs: 100, actualIntervalMs: 106 }),
  });
  assert.equal(playbackReport.status, 200);
  const playbackStatus = await fetch(previewUrl, { headers: publicHeaders });
  const playback = (await playbackStatus.json()).devicePlayback[0];
  assert.equal(playback?.bundleFrameId, bundle.frameId);
  assert.equal(playback?.targetIntervalMs, 100);
  assert.equal(playback?.actualIntervalMs, 106);
  const stillOtherPreview = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personB}/preview-frame`, { headers: publicHeaders });
  assert.equal((await stillOtherPreview.json()).configured, false, 'GIF preview remains scoped to its Person');
  const invalidGif = await fetch(contentUrl, { method: 'PUT', headers: publicHeaders, body: JSON.stringify({ sentence: 'still here', gifBase64: 'not-a-gif' }) });
  assert.equal(invalidGif.status, 400);
  const currentContent = await fetch(contentUrl, { headers: publicHeaders });
  assert.equal((await currentContent.json()).sentence, contentPayload.sentence, 'failed upload must preserve saved content');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = launchDisplay();
  await waitFor(`http://127.0.0.1:${displayPort}/healthz`);
  const persistedContent = await fetch(contentUrl, { headers: publicHeaders });
  assert.equal((await persistedContent.json()).configured, true, 'personal content survives a restart');
  const persistedPreview = await fetch(previewUrl, { headers: publicHeaders });
  assert.equal((await persistedPreview.json()).configured, true, 'preview survives a sidecar restart');
  const persistedAnimatedFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(persistedAnimatedFrame.headers.get('x-remotelab-display-poll-seconds'), '0.45', 'animated preview survives a sidecar restart');
  const clearedPreview = await fetch(previewUrl, { method: 'DELETE', headers: publicHeaders });
  assert.equal(clearedPreview.status, 200);
  const restoredStatus = await fetch(contentUrl, { method: 'DELETE', headers: publicHeaders });
  assert.equal(restoredStatus.status, 200);
  const afterDelete = await fetch(contentUrl, { headers: publicHeaders });
  assert.equal((await afterDelete.json()).configured, false);

  const sourcePath = `http://127.0.0.1:${displayPort}/v1/people/${personA}/sources/evaluation`;
  const now = Date.now();
  const sourcePacket = {
    schemaVersion: 1, sequence: 1, label: 'Evaluation',
    observedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
    signals: [{
      id: 'run-42', phase: 'attention', urgency: 'high', title: '评测等待确认',
      summary: '请在原应用检查。', subject: 'RoboDojo', destination: '去评测页面',
      occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      evidence: 'confirmed',
    }],
  };
  const sourceDenied = await fetch(sourcePath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sourcePacket) });
  assert.equal(sourceDenied.status, 401, 'only local admin authority can publish signals');
  const sourceWrite = await fetch(sourcePath, { method: 'PUT', headers: publicHeaders, body: JSON.stringify(sourcePacket) });
  assert.equal(sourceWrite.status, 200);
  assert.equal((await sourceWrite.json()).changed, true);
  const sourceAgain = await fetch(sourcePath, { method: 'PUT', headers: publicHeaders, body: JSON.stringify(sourcePacket) });
  assert.equal((await sourceAgain.json()).reason, 'duplicate');
  const sourceConflict = await fetch(sourcePath, { method: 'PUT', headers: publicHeaders, body: JSON.stringify({ ...sourcePacket, label: 'Changed' }) });
  assert.equal(sourceConflict.status, 409);
  const statusA = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personA}/status`, { headers: publicHeaders });
  const statusAJson = await statusA.json();
  assert.equal(statusAJson.reminderSources.automation.configured, 1);
  assert.equal(statusAJson.reminderSources.automation.active, 1);
  assert.equal(statusAJson.reminderSources.automation.failures24h, 0, 'other Person failures stay private');
  assert.equal(statusAJson.reminderSources.feishu.conversations, 1);
  assert.equal(statusAJson.reminderSources.feishu.recentConversations, 1);
  assert.equal(statusAJson.metrics.pendingReview, 1);
  assert.deepEqual(statusAJson.metrics.pendingResults, [{ name: '项目审阅', context: '整理本周进展' }]);
  assert.equal(statusA.status, 200);
  assert.equal(statusAJson.scene.signal.title, '评测等待确认');
  const statusB = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personB}/status`, { headers: publicHeaders });
  const statusBJson = await statusB.json();
  assert.equal(statusBJson.reminderSources.automation.configured, 1);
  assert.equal(statusBJson.reminderSources.automation.failures24h, 1);
  assert.equal(statusBJson.reminderSources.feishu.conversations, 0, 'other Person Feishu sessions stay private');
  assert.deepEqual(statusBJson.metrics.pendingResults, [], 'another Person result stays private');
  assert.equal(statusB.status, 200);
  assert.equal(statusBJson.snapshot.signals.some((signal) => signal.sourceId === 'evaluation'), false);
  const preview = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personA}/preview.png`, { headers: publicHeaders });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  const sourceFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(sourceFrame.status, 200);
  assert.notDeepEqual(Buffer.from(await sourceFrame.arrayBuffer()), png, 'published signal should change the real device frame');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = launchDisplay();
  await waitFor(`http://127.0.0.1:${displayPort}/healthz`);
  const recovered = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personA}/status`, { headers: publicHeaders });
  assert.equal((await recovered.json()).scene.signal.title, '评测等待确认', 'a source snapshot must survive sidecar restart');
  const withdrawn = await fetch(sourcePath, {
    method: 'PUT', headers: publicHeaders,
    body: JSON.stringify({ ...sourcePacket, sequence: 2, signals: [] }),
  });
  assert.equal(withdrawn.status, 200);
  sessionsUnavailable = true;
  const staleStatus = await fetch(`http://127.0.0.1:${displayPort}/v1/people/${personA}/status`, { headers: publicHeaders });
  assert.equal((await staleStatus.json()).scene.kind, 'stale', 'unavailable RemoteLab data must not be shown as fresh');
  const staleFrame = await fetch(`http://127.0.0.1:${displayPort}${framePath}`, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(staleFrame.status, 200, `device should still receive an honest stale frame: ${staleFrame.status === 200 ? '' : await staleFrame.text()} ${logs.slice(-1200)}`);
  sessionsUnavailable = false;

  const personADevices = await fetch(`http://127.0.0.1:${displayPort}/v1/devices?personId=${personA}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(personADevices.status, 200);
  assert.deepEqual((await personADevices.json()).devices.map((device) => device.id), [joined.deviceId]);
  const personBDevices = await fetch(`http://127.0.0.1:${displayPort}/v1/devices?personId=${personB}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(personBDevices.status, 200);
  assert.deepEqual((await personBDevices.json()).devices, [], 'people must not see each other\'s displays');

  const wrongOwnerRevoke = await fetch(`http://127.0.0.1:${displayPort}/v1/devices/${joined.deviceId}?personId=${personB}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(wrongOwnerRevoke.status, 404, 'another person must not revoke the display');

  const installer = await fetch(`http://127.0.0.1:${displayPort}/install.sh`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), /launchctl bootstrap/);
  const removedSettings = await fetch(`http://127.0.0.1:${displayPort}/settings?admin=${encodeURIComponent(admin)}`);
  assert.equal(removedSettings.status, 404, 'display management belongs in the main RemoteLab Settings UI');
  console.log('ok - person-scoped display enrollment, inventory, frame auth, and installer');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => api.close(resolve));
  await rm(root, { recursive: true, force: true });
}

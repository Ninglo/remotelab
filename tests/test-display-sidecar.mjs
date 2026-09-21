#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'remotelab-display-test-'));
const configDir = join(root, 'config');
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));

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
const api = createServer((req, res) => {
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'session_token=test; Path=/' });
    res.end();
    return;
  }
  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [{
      name: 'Display test',
      activity: { run: { state: 'running', startedAt: new Date().toISOString() }, queue: { count: 0 } },
      lastAssistantMessageAt: 0,
      deliveryIssueCount: 0,
    }] }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => api.listen(apiPort, '127.0.0.1', resolve));

const child = spawn(process.execPath, ['display/server.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    HOME: root,
    REMOTELAB_CONFIG_DIR: configDir,
    REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${apiPort}`,
    REMOTELAB_DISPLAY_PORT: String(displayPort),
    REMOTELAB_DISPLAY_PUBLIC_BASE_URL: `http://127.0.0.1:${displayPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

try {
  await waitFor(`http://127.0.0.1:${displayPort}/healthz`);
  const admin = (await readFile(join(configDir, 'display-admin-token'), 'utf8')).trim();
  const enrollmentResponse = await fetch(`http://127.0.0.1:${displayPort}/v1/enrollments?admin=${encodeURIComponent(admin)}`, { method: 'POST' });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json();
  assert.match(enrollment.command, /install\.sh/);
  assert.match(enrollment.enrollmentUrl, /\/v1\/enroll\/rld_enroll_/);

  const joinedResponse = await fetch(enrollment.enrollmentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test display', hostname: 'test-mac', platform: 'darwin' }),
  });
  assert.equal(joinedResponse.status, 201);
  const joined = await joinedResponse.json();
  assert.match(joined.deviceId, /^display-/);
  assert.match(joined.deviceToken, /^rld_device_/);

  const reused = await fetch(enrollment.enrollmentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(reused.status, 410, 'enrollment must be one-use');

  const deniedFrame = await fetch(joined.frameUrl);
  assert.equal(deniedFrame.status, 401);
  const frame = await fetch(joined.frameUrl, { headers: { Authorization: `Bearer ${joined.deviceToken}` } });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.equal(frame.headers.get('x-remotelab-display-running'), '1');
  const png = Buffer.from(await frame.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const installer = await fetch(`http://127.0.0.1:${displayPort}/install.sh`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), /launchctl bootstrap/);
  console.log('ok - instance-local display enrollment, one-use token, frame auth, and installer');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => api.close(resolve));
  await rm(root, { recursive: true, force: true });
}

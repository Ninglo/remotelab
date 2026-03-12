#!/usr/bin/env node
import assert from 'assert/strict';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-session';

function randomPort() {
  return 45000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Cookie: ownerCookie,
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-build-info-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );

  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitFor(async () => {
    try {
      const res = await request(port, '/login', { Cookie: '' });
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function fetchBuildInfo(port) {
  const res = await request(port, '/api/build-info', { Cookie: '' });
  assert.equal(res.status, 200, 'build info endpoint should respond');
  return { headers: res.headers, payload: JSON.parse(res.text) };
}

async function connectWs(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: ownerCookie },
    });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const seed = Date.now().toString(36);
  const frontendProbePath = join(repoRoot, 'static', 'chat', `__build_info_probe_${seed}.js`);
  const serviceProbePath = join(repoRoot, 'chat', `__service_build_probe_${seed}.mjs`);
  const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8');
  let server = null;
  let ws = null;

  try {
    server = await startServer({ home, port });
    ws = await connectWs(port);
    const wsMessages = [];
    ws.on('message', (data) => {
      try {
        wsMessages.push(JSON.parse(data.toString()));
      } catch {}
    });

    assert.doesNotMatch(
      bootstrapSource,
      /window\.setInterval\(/,
      'frontend build refresh should not depend on timer polling',
    );

    const initialBuild = await fetchBuildInfo(port);
    const initial = initialBuild.payload;
    assert.ok(initial.serviceLabel, 'build info should expose a service label');
    assert.ok(initial.serviceTitle, 'build info should expose a service title');
    assert.match(
      initial.serviceLabel,
      new RegExp(`^Ver ${escapeRegex(initial.serviceVersion)}(?: · |$)`),
      'service label should lead with the user-facing release version',
    );
    assert.ok(initial.frontendFingerprint, 'build info should expose a frontend fingerprint');
    assert.match(initial.frontendLabel, /^ui:/, 'frontend label should be compact and explicit');
    assert.equal(
      initial.label,
      `${initial.serviceLabel} · ${initial.frontendLabel}`,
      'combined label should join service and frontend identities',
    );
    assert.equal(
      initial.title,
      `${initial.serviceTitle} · ${initial.frontendTitle}`,
      'combined title should join service and frontend descriptions',
    );
    assert.equal(
      initialBuild.headers['x-remotelab-service-build'],
      initial.serviceTitle,
      'build info headers should expose the service identity',
    );
    assert.equal(
      initialBuild.headers['x-remotelab-frontend-build'],
      initial.frontendTitle,
      'build info headers should expose the frontend identity',
    );

    const loginPage = await request(port, '/login', { Cookie: '' });
    assert.equal(loginPage.status, 200, 'login page should render');
    assert.match(loginPage.text, new RegExp(escapeRegex(initial.label)));

    const chatPage = await request(port, '/');
    assert.equal(chatPage.status, 200, 'chat page should render');
    assert.match(chatPage.text, new RegExp(escapeRegex(`Build ${initial.label}`)));
    assert.match(chatPage.text, new RegExp(escapeRegex(initial.title)));

    await sleep(350);
    writeFileSync(frontendProbePath, 'window.__REMOTELAB_BUILD_INFO_PROBE__ = true;\n', 'utf8');
    await waitFor(
      () => wsMessages.some((msg) => msg.type === 'build_invalidated'),
      'frontend build invalidation websocket hint',
    );

    const frontendUpdatedBuild = await fetchBuildInfo(port);
    const frontendUpdated = frontendUpdatedBuild.payload;
    assert.equal(
      frontendUpdated.serviceAssetVersion,
      initial.serviceAssetVersion,
      'frontend edits should not change the running service identity',
    );
    assert.equal(
      frontendUpdated.serviceFingerprint,
      initial.serviceFingerprint,
      'frontend edits should keep the service fingerprint stable',
    );
    assert.notEqual(
      frontendUpdated.frontendFingerprint,
      initial.frontendFingerprint,
      'frontend edits should update the frontend fingerprint without restart',
    );
    assert.notEqual(
      frontendUpdated.assetVersion,
      initial.assetVersion,
      'official page version should move when frontend assets change',
    );

    await stopServer(server);
    server = null;

    writeFileSync(serviceProbePath, 'export const __REMOTELAB_SERVICE_BUILD_PROBE__ = true;\n', 'utf8');
    await sleep(50);

    server = await startServer({ home, port });
    const restartedBuild = await fetchBuildInfo(port);
    const restarted = restartedBuild.payload;
    assert.notEqual(
      restarted.serviceAssetVersion,
      initial.serviceAssetVersion,
      'service restart with server-tree changes should update the backend version',
    );
    assert.notEqual(
      restarted.serviceFingerprint,
      initial.serviceFingerprint,
      'service restart should refresh the startup fingerprint when backend files change',
    );
    assert.equal(
      restarted.frontendFingerprint,
      frontendUpdated.frontendFingerprint,
      'backend restart alone should keep the current frontend fingerprint',
    );

    console.log('✅ Build info versioning validated');
  } finally {
    ws?.close();
    await stopServer(server);
    rmSync(frontendProbePath, { force: true });
    rmSync(serviceProbePath, { force: true });
  }
}

main().catch((err) => {
  console.error('❌ Build info versioning test failed:', err);
  process.exitCode = 1;
});

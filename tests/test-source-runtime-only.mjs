#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const loginTemplatePath = join(repoRoot, 'templates', 'login.html');

function randomPort() {
  return 43000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        headers: extraHeaders,
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-source-runtime-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(join(configDir, 'auth-sessions.json'), '{}\n', 'utf8');
  return { home };
}

async function startServer({ home, port, fakeReleaseRoot }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_ENABLE_ACTIVE_RELEASE: '1',
      REMOTELAB_ACTIVE_RELEASE_ROOT: fakeReleaseRoot,
      REMOTELAB_ACTIVE_RELEASE_ID: 'obsolete-release-id',
      REMOTELAB_ACTIVE_RELEASE_FILE: join(home, '.config', 'remotelab', 'active-release.json'),
      REMOTELAB_DISABLE_ACTIVE_RELEASE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitFor(async () => {
    try {
      const res = await request(port, '/login');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'source runtime startup');

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const seed = Date.now().toString(36);
  const fakeReleaseRoot = join(home, 'missing-release-root');
  const sourceProbeName = `__source_runtime_probe_${seed}.js`;
  const sourceProbePath = join(repoRoot, 'static', 'chat', sourceProbeName);
  const originalLoginTemplate = readFileSync(loginTemplatePath, 'utf8');
  const loginMarker = `__SOURCE_RUNTIME_MARKER_${seed}__`;
  let server = null;

  try {
    server = await startServer({ home, port, fakeReleaseRoot });

    const buildInfoRes = await request(port, '/api/build-info');
    assert.equal(buildInfoRes.status, 200, 'build info endpoint should respond');
    const buildInfo = JSON.parse(buildInfoRes.text);
    assert.equal(buildInfo.runtimeMode, 'source', 'runtime should stay source-backed');
    assert.equal(buildInfo.releaseId, null, 'source-backed runtime should not expose a release id');

    writeFileSync(loginTemplatePath, `${originalLoginTemplate}\n${loginMarker}\n`, 'utf8');
    const loginRes = await request(port, '/login');
    assert.equal(loginRes.status, 200, 'login page should still render');
    assert.ok(loginRes.text.includes(loginMarker), 'runtime should serve source template edits directly');

    writeFileSync(sourceProbePath, 'window.__REMOTELAB_SOURCE_RUNTIME_PROBE__ = true;\n', 'utf8');
    const sourceProbeRes = await request(port, `/chat/${sourceProbeName}`);
    assert.equal(sourceProbeRes.status, 200, 'runtime should serve new source static files directly');
    assert.match(sourceProbeRes.text, /SOURCE_RUNTIME_PROBE/);

    console.log('test-source-runtime-only: ok');
  } finally {
    await stopServer(server);
    writeFileSync(loginTemplatePath, originalLoginTemplate, 'utf8');
    rmSync(sourceProbePath, { force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('test-source-runtime-only: failed');
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createReleaseSnapshot } from '../lib/release-runtime.mjs';

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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-release-runtime-'));
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

async function startServer({ home, port, snapshotRoot, releaseId }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_DISABLE_ACTIVE_RELEASE: '0',
      REMOTELAB_ENABLE_ACTIVE_RELEASE: '1',
      REMOTELAB_ACTIVE_RELEASE_ROOT: snapshotRoot,
      REMOTELAB_ACTIVE_RELEASE_ID: releaseId,
      REMOTELAB_SOURCE_PROJECT_ROOT: repoRoot,
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
  }, 'release server startup');

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
  const release = await createReleaseSnapshot({ releaseId: `test-release-${seed}` });
  const sourceProbeName = `__release_source_probe_${seed}.js`;
  const sourceProbePath = join(repoRoot, 'static', 'chat', sourceProbeName);
  const originalLoginTemplate = readFileSync(loginTemplatePath, 'utf8');
  const loginMarker = `__RELEASE_TEMPLATE_PROBE_${seed}__`;
  let server = null;

  try {
    server = await startServer({
      home,
      port,
      snapshotRoot: release.snapshotRoot,
      releaseId: release.releaseId,
    });

    const buildInfoRes = await request(port, '/api/build-info');
    assert.equal(buildInfoRes.status, 200, 'build info endpoint should respond');
    const buildInfo = JSON.parse(buildInfoRes.text);
    assert.equal(buildInfo.runtimeMode, 'release', 'active release runtime should advertise release mode');
    assert.equal(buildInfo.releaseId, release.releaseId, 'release runtime should expose the active release id');

    writeFileSync(loginTemplatePath, `${originalLoginTemplate}\n${loginMarker}\n`, 'utf8');
    const loginRes = await request(port, '/login');
    assert.equal(loginRes.status, 200, 'login page should still render');
    assert.ok(!loginRes.text.includes(loginMarker), 'release runtime should ignore source template edits after activation');

    writeFileSync(sourceProbePath, 'window.__REMOTELAB_SOURCE_PROBE__ = true;\n', 'utf8');
    const sourceProbeRes = await request(port, `/chat/${sourceProbeName}`);
    assert.notEqual(sourceProbeRes.status, 200, 'release runtime should not expose new source static files until the next release');

    console.log('test-release-runtime-snapshot: ok');
  } finally {
    await stopServer(server);
    writeFileSync(loginTemplatePath, originalLoginTemplate, 'utf8');
    rmSync(sourceProbePath, { force: true });
    rmSync(release.snapshotRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('test-release-runtime-snapshot: failed');
  console.error(error);
  process.exitCode = 1;
});

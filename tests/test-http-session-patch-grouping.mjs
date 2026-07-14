#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 33000 + Math.floor(Math.random() * 10000);
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

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-session-patch-grouping-'));
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
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

const { home } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, port });

try {
  const created = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'codex',
    name: 'Patch grouping session',
  });
  assert.equal(created.status, 201, 'session creation should succeed');
  const sessionId = created.json.session.id;

  const invalidGroup = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    group: 123,
  });
  assert.equal(invalidGroup.status, 400, 'invalid group type should be rejected');

  const invalidSpace = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    space: 123,
  });
  assert.equal(invalidSpace.status, 400, 'invalid space type should be rejected');

  const invalidSidebarOrder = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    sidebarOrder: 0,
  });
  assert.equal(invalidSidebarOrder.status, 400, 'invalid sidebar order should be rejected');

  const invalidEntryModeType = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    entryMode: 123,
  });
  assert.equal(invalidEntryModeType.status, 400, 'invalid entry mode type should be rejected');

  const invalidEntryModeValue = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    entryMode: 'top',
  });
  assert.equal(invalidEntryModeValue.status, 400, 'unknown entry mode should be rejected');

  const patched = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    space: '  Product  ',
    group: '  RemoteLab  ',
    description: '  Session-driven orchestration work.  ',
    sidebarOrder: 4,
    entryMode: 'read',
  });
  assert.equal(patched.status, 200, 'session patch should accept space, group, description, sidebar order, and entry mode');
  assert.equal(patched.json.session.space, 'Product', 'patch should trim and persist space');
  assert.equal(patched.json.session.group, 'RemoteLab', 'patch should trim and persist group');
  assert.equal(
    patched.json.session.description,
    'Session-driven orchestration work.',
    'patch should trim and persist description',
  );
  assert.equal(patched.json.session.sidebarOrder, 4, 'patch should persist sidebar order');
  assert.equal(patched.json.session.entryMode, 'read', 'patch should persist entry mode');

  const detail = await request(port, 'GET', `/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200, 'detail route should succeed after patch');
  assert.equal(detail.json.session.space, 'Product', 'detail route should expose patched space');
  assert.equal(detail.json.session.group, 'RemoteLab', 'detail route should expose patched group');
  assert.equal(
    detail.json.session.description,
    'Session-driven orchestration work.',
    'detail route should expose patched description',
  );
  assert.equal(detail.json.session.sidebarOrder, 4, 'detail route should expose patched sidebar order');
  assert.equal(detail.json.session.entryMode, 'read', 'detail route should expose patched entry mode');

  const listed = await request(port, 'GET', '/api/sessions');
  assert.equal(listed.status, 200, 'session list should succeed');
  const listedSession = (listed.json.sessions || []).find((entry) => entry.id === sessionId);
  assert.ok(listedSession, 'session list should include the patched session');
  assert.equal(listedSession.space, 'Product', 'session list should expose patched space');
  assert.equal(listedSession.group, 'RemoteLab', 'session list should expose patched group');
  assert.equal(
    listedSession.description,
    'Session-driven orchestration work.',
    'session list should expose patched description',
  );
  assert.equal(listedSession.sidebarOrder, 4, 'session list should expose patched sidebar order');
  assert.equal(listedSession.entryMode, 'read', 'session list should expose patched entry mode');

  const cleared = await request(port, 'PATCH', `/api/sessions/${sessionId}`, {
    space: null,
    group: null,
    description: '',
    sidebarOrder: null,
    entryMode: null,
  });
  assert.equal(cleared.status, 200, 'patch should accept clearing space, group, description, sidebar order, and entry mode');
  assert.equal(cleared.json.session.space, undefined, 'patch should clear space');
  assert.equal(cleared.json.session.group, undefined, 'patch should clear group');
  assert.equal(cleared.json.session.description, undefined, 'patch should clear description');
  assert.equal(cleared.json.session.sidebarOrder, undefined, 'patch should clear sidebar order');
  assert.equal(cleared.json.session.entryMode, 'resume', 'clearing entry mode should fall back to resume');

  console.log('test-http-session-patch-grouping: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}

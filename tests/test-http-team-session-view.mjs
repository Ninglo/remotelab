#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { scryptSync } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const adminCookie = 'session_token=team-view-admin';

function randomPort() {
  return 44000 + Math.floor(Math.random() * 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyText = body === null
      ? ''
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(bodyText ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-team-session-view-'));
  const configDir = join(home, 'config');
  const workRoot = join(home, 'workspace');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const ownerPasswordHash = scryptSync('admin-password', salt, 32, { N: 16384, r: 8, p: 1 });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    username: 'admin',
    passwordHash: `scrypt$16384$8$1$${salt.toString('hex')}$${ownerPasswordHash.toString('hex')}`,
  }, null, 2));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    'team-view-admin': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
  }, null, 2));
  return { home, configDir, workRoot };
}

async function startServer({ home, configDir, workRoot, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_WORK_ROOT_DIR: workRoot,
      REMOTELAB_INSTANCE_ROOT: '',
      REMOTELAB_BRIDGE_BASE_URL: '',
      REMOTELAB_PUBLIC_BASE_URL: '',
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(stderr || `server exited ${child.exitCode}`);
    try {
      return (await request(port, 'GET', '/api/auth/me', null, { Cookie: adminCookie })).status === 200;
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

async function run() {
  const fixture = setupTempHome();
  const port = randomPort();
  let child = null;
  try {
    child = await startServer({ ...fixture, port });

    const initial = await request(port, 'GET', '/api/team-session-view', null, { Cookie: adminCookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.json?.teamSessionView?.enabled, false, 'team view should default off');
    assert.equal(initial.json?.teamSessionView?.canManage, true, 'legacy owner session should be admin');

    const adminLoginForm = new URLSearchParams({
      type: 'password',
      username: 'admin',
      password: 'admin-password',
    }).toString();
    const adminLogin = await request(port, 'POST', '/login', adminLoginForm, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.equal(adminLogin.status, 302, 'existing admin password login should stay compatible');

    const createdAccount = await request(port, 'POST', '/api/team-session-view/accounts', {
      name: 'Video Team',
      username: 'video',
      password: 'video-password',
    }, { Cookie: adminCookie });
    assert.equal(createdAccount.status, 201);
    const accountId = createdAccount.json?.account?.id;
    assert.match(accountId || '', /^user_/);
    assert.equal(createdAccount.json?.account?.passwordHash, undefined, 'password hashes must not be returned');

    const enabled = await request(port, 'PATCH', '/api/team-session-view', { enabled: true }, { Cookie: adminCookie });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json?.teamSessionView?.enabled, true);

    const form = new URLSearchParams({
      type: 'password',
      username: 'video',
      password: 'video-password',
    }).toString();
    const login = await request(port, 'POST', '/login', form, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.equal(login.status, 302, 'member should use the normal login route');
    const memberCookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
    assert.match(memberCookie, /^session_token=/);

    const memberAuth = await request(port, 'GET', '/api/auth/me', null, { Cookie: memberCookie });
    assert.equal(memberAuth.status, 200);
    assert.equal(memberAuth.json?.accountKind, 'member');
    assert.equal(memberAuth.json?.accountId, accountId);
    assert.equal(memberAuth.json?.teamSessionView?.enabled, true);
    assert.equal(memberAuth.json?.teamSessionView?.currentAccount?.name, 'Video Team');

    const memberSession = await request(port, 'POST', '/api/sessions', {
      folder: fixture.workRoot,
      tool: 'codex',
      name: 'Member session',
    }, { Cookie: memberCookie });
    assert.equal(memberSession.status, 201);
    assert.equal(memberSession.json?.session?.userId, accountId);
    assert.equal(memberSession.json?.session?.userName, 'Video Team');

    const adminSession = await request(port, 'POST', '/api/sessions', {
      folder: fixture.workRoot,
      tool: 'codex',
      name: 'Admin session',
    }, { Cookie: adminCookie });
    assert.equal(adminSession.status, 201);
    assert.equal(adminSession.json?.session?.userId, undefined, 'admin sessions should remain unowned');

    const memberList = await request(port, 'GET', '/api/sessions', null, { Cookie: memberCookie });
    assert.equal(memberList.status, 200);
    assert.deepEqual(
      new Set((memberList.json?.sessions || []).map((session) => session.name)),
      new Set(['Member session', 'Admin session']),
      'backend list stays shared because filtering is intentionally frontend-only',
    );

    const memberManageAttempt = await request(port, 'PATCH', '/api/team-session-view', { enabled: false }, {
      Cookie: memberCookie,
    });
    assert.equal(memberManageAttempt.status, 403, 'member cannot alter the shared display configuration');

    const memberPage = await request(port, 'GET', '/', null, { Cookie: memberCookie });
    assert.equal(memberPage.status, 200);
    assert.match(memberPage.text, /"teamSessionView"/);
    assert.match(memberPage.text, new RegExp(accountId));

    const catalogJs = await request(port, 'GET', '/chat/bootstrap-session-catalog.js', null, { Cookie: memberCookie });
    assert.equal(catalogJs.status, 200);
    assert.match(catalogJs.text, /matchesTeamSessionView\(session\)/, 'session catalog should apply member filtering');

    console.log('HTTP team session view tests passed');
  } finally {
    await stopServer(child);
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

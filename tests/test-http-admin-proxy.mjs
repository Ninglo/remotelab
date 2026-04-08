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

function randomPort() {
  return 39000 + Math.floor(Math.random() * 4000);
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

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
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
    if (options.body) req.write(options.body);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-admin-proxy-'));
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
      'owner-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
      'visitor-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'visitor' },
    }, null, 2),
    'utf8',
  );

  return { home };
}

async function startAdminUpstream(port) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    });
    if (req.url === '/' || req.url === '/?view=billing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Fake Admin</title><h1>Fake Admin Home</h1>');
      return;
    }
    if (req.url === '/api/ping?scope=full') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, forwardedPrefix: req.headers['x-forwarded-prefix'] || '' }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, {
        Location: '/login',
        'Set-Cookie': 'admin_session=abc123; HttpOnly; Path=/; SameSite=Lax',
      });
      res.end();
      return;
    }
    if (req.url === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Fake Admin Login</title>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`missing upstream route: ${req.url}`);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, requests };
}

async function stopHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startChatServer({ home, port, adminPort }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      CHAT_ADMIN_UPSTREAM_HOST: '127.0.0.1',
      CHAT_ADMIN_UPSTREAM_PORT: String(adminPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, '/login');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'chat server startup');

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopChatServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'chat server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const adminPort = randomPort();
  const chatPort = randomPort();
  const admin = await startAdminUpstream(adminPort);
  const chat = await startChatServer({ home, port: chatPort, adminPort });
  let adminStopped = false;
  let chatStopped = false;

  try {
    const unauthenticated = await request(chatPort, '/admin');
    assert.equal(unauthenticated.status, 302, 'admin proxy should require main-service auth');
    assert.equal(unauthenticated.headers.location, '/login', 'unauthenticated admin access should redirect to main login');

    const visitorOnly = await request(chatPort, '/admin', {
      headers: { Cookie: 'visitor_session_token=visitor-session' },
    });
    assert.equal(visitorOnly.status, 403, 'visitor sessions should not be allowed to open admin');
    assert.match(visitorOnly.text, /Owner access required/);

    const ownerHeaders = { Cookie: 'session_token=owner-session' };

    const page = await request(chatPort, '/admin?view=billing', { headers: ownerHeaders });
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Fake Admin Home/, 'admin root should proxy to the upstream dashboard page');

    const ping = await request(chatPort, '/admin/api/ping?scope=full', { headers: ownerHeaders });
    assert.equal(ping.status, 200, ping.text);
    assert.equal(ping.json?.ok, true, 'admin API requests should proxy through the main service');
    assert.equal(ping.json?.forwardedPrefix, '/admin', 'admin proxy should pass the forwarded prefix');

    const redirect = await request(chatPort, '/admin/redirect', { headers: ownerHeaders });
    assert.equal(redirect.status, 302, 'upstream redirects should be preserved');
    assert.equal(redirect.headers.location, '/admin/login', 'upstream redirects should be rewritten under /admin');
    assert.ok(
      String(redirect.headers['set-cookie'] || '').includes('Path=/admin'),
      'upstream cookies should be rewritten onto the /admin path',
    );

    assert.equal(admin.requests[0]?.url, '/?view=billing', 'admin root should strip the /admin prefix before proxying');
    assert.equal(admin.requests[0]?.headers['x-forwarded-prefix'], '/admin', 'upstream should receive the admin prefix header');
    assert.equal(admin.requests[1]?.url, '/api/ping?scope=full', 'admin API should proxy without the /admin prefix');
    assert.equal(admin.requests[2]?.url, '/redirect', 'admin redirects should hit the expected upstream path');

    await stopChatServer(chat);
    chatStopped = true;
    await stopHttpServer(admin.server);
    adminStopped = true;

    console.log('test-http-admin-proxy: ok');
  } finally {
    if (!chatStopped) {
      await stopChatServer(chat);
    }
    if (!adminStopped) {
      await stopHttpServer(admin.server);
    }
    rmSync(home, { recursive: true, force: true });
  }
}

await main();

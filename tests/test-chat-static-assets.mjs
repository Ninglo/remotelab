#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

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

function request(port, method, path, body = null, extraHeaders = {}) {
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
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-chat-static-'));
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
  const server = await startServer({ home, port });

  try {
    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200, 'chat page should render for owner session');
    assert.match(page.text, /<script src="\/chat\/bootstrap\.js"/);
    assert.match(page.text, /<script src="\/chat\/session-http\.js"/);
    assert.match(page.text, /<script src="\/chat\/tooling\.js"/);
    assert.match(page.text, /<script src="\/chat\/realtime\.js"/);
    assert.match(page.text, /<script src="\/chat\/ui\.js"/);
    assert.match(page.text, /<script src="\/chat\/compose\.js"/);
    assert.match(page.text, /<script src="\/chat\/init\.js"/);
    assert.match(page.text, /id="appFilterSelect"/);
    assert.ok(!page.text.includes('/chat.js?v='), 'chat page should not pin the chat frontend to a versioned URL');
    assert.ok(!page.text.includes('/marked.min.js?v='), 'chat page should let marked.min.js use normal revalidation');
    assert.ok(!page.text.includes('/manifest.json?v='), 'chat page should let manifest use normal revalidation');

    const apps = await request(port, 'GET', '/api/apps');
    assert.equal(apps.status, 200, 'owner apps endpoint should be available');
    assert.match(apps.text, /"id":"chat"/);
    assert.match(apps.text, /"id":"feishu"/);
    assert.match(apps.text, /"id":"email"/);
    assert.match(apps.text, /"id":"github"/);
    assert.match(apps.text, /"id":"automation"/);

    const createdChat = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'Owner chat session',
    });
    assert.equal(createdChat.status, 201, 'owner chat session should be creatable over HTTP');

    const createdGithub = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'GitHub session',
      appId: 'github',
    });
    assert.equal(createdGithub.status, 201, 'GitHub-scoped session should be creatable over HTTP');

    const githubOnly = await request(port, 'GET', '/api/sessions?appId=github');
    assert.equal(githubOnly.status, 200, 'app-filtered session list should load');
    assert.match(githubOnly.text, /"appId":"github"/);
    assert.doesNotMatch(githubOnly.text, /"name":"Owner chat session"/);

    const splitAsset = await request(port, 'GET', '/chat/bootstrap.js');
    assert.equal(splitAsset.status, 200, 'split chat asset should load');
    assert.equal(
      splitAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'split asset should use safe revalidation caching',
    );
    assert.ok(splitAsset.headers.etag, 'split asset should expose an ETag');
    assert.match(splitAsset.text, /const buildInfo = window\.__REMOTELAB_BUILD__ \|\| \{\};/);

    const splitAsset304 = await request(port, 'GET', '/chat/bootstrap.js', null, {
      'If-None-Match': splitAsset.headers.etag,
    });
    assert.equal(splitAsset304.status, 304, 'split asset should support conditional GETs');
    assert.equal(splitAsset304.text, '', '304 response should not include a body');

    const loader = await request(port, 'GET', '/chat.js');
    assert.equal(loader.status, 200, 'compatibility loader should still exist');
    assert.ok(loader.headers.etag, 'compatibility loader should expose an ETag');

    const loader304 = await request(port, 'GET', '/chat.js', null, {
      'If-None-Match': loader.headers.etag,
    });
    assert.equal(loader304.status, 304, 'loader should also support conditional GETs');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

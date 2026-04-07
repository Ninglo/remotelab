#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 36000 + Math.floor(Math.random() * 6000);
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
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-calendar-feed-'));
  const instanceRoot = join(home, '.remotelab', 'instances', 'trial24');
  const configDir = join(instanceRoot, 'config');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

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
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Thinking', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(join(localBin, 'fake-codex'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(join(localBin, 'fake-codex'), 0o755);

  return { home, instanceRoot };
}

async function seedCalendarEvent(instanceRoot) {
  process.env.REMOTELAB_INSTANCE_ROOT = instanceRoot;
  process.env.REMOTELAB_GUEST_MAINLAND_BASE_URL = 'https://jojotry.nat100.top';
  process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://trial24.jiujianian.dev';
  const { addCalendarFeedEvent } = await import(`../lib/connector-calendar-feed.mjs?test=${Date.now()}`);
  await addCalendarFeedEvent({
    summary: 'Prefix feed event',
    startTime: '2026-04-07T10:00:00Z',
    endTime: '2026-04-07T11:00:00Z',
    timezone: 'Asia/Shanghai',
  });
}

async function startServer({ home, instanceRoot, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_INSTANCE_ROOT: instanceRoot,
      REMOTELAB_GUEST_MAINLAND_BASE_URL: 'https://jojotry.nat100.top',
      REMOTELAB_PUBLIC_BASE_URL: 'https://trial24.jiujianian.dev',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me', null, { Cookie: cookie });
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

const { home, instanceRoot } = setupTempHome();
const port = randomPort();
await seedCalendarEvent(instanceRoot);
const server = await startServer({ home, instanceRoot, port });

try {
  const feedRes = await request(port, 'GET', '/api/connectors/calendar/feed', null, {
    Cookie: cookie,
    Host: 'jojotry.nat100.top',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Prefix': '/trial24',
  });
  assert.equal(feedRes.status, 200, 'calendar feed metadata route should load');
  assert.equal(
    feedRes.json?.subscriptionUrl,
    'https://jojotry.nat100.top/trial24/cal/' + String(feedRes.json?.subscriptionUrl || '').split('/cal/')[1],
    'preferred subscription URL should use the mainland prefixed path',
  );
  assert.equal(
    feedRes.json?.webcalUrl,
    'webcal://jojotry.nat100.top/trial24/cal/' + String(feedRes.json?.subscriptionUrl || '').split('/cal/')[1],
    'preferred webcal URL should use the mainland prefixed path',
  );
  assert.equal(feedRes.json?.subscriptionUrls?.mainland?.includes('/trial24/cal/'), true);
  assert.equal(feedRes.json?.subscriptionUrls?.public?.startsWith('https://trial24.jiujianian.dev/cal/'), true);
  assert.equal(feedRes.json?.variants?.[0]?.kind, 'mainland', 'mainland link should be preferred when available');
  assert.equal(feedRes.json?.eventCount, 1, 'seeded event should be visible in feed metadata');

  const feedToken = String(feedRes.json?.subscriptionUrl || '').split('/cal/')[1]?.replace(/\.ics$/, '');
  assert.ok(feedToken, 'feed metadata should expose a usable token');

  const icsRes = await request(port, 'GET', `/cal/${feedToken}.ics`);
  assert.equal(icsRes.status, 200, 'ics feed endpoint should still load from the backend root path');
  assert.match(icsRes.text, /BEGIN:VCALENDAR/, 'ics response should be a calendar');
  assert.match(icsRes.text, /SUMMARY:Prefix feed event/, 'ics response should include the seeded event');

  console.log('test-http-calendar-feed-prefix: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}

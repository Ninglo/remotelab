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
  return 41000 + Math.floor(Math.random() * 4000);
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
        Cookie: cookie,
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text, buffer });
      });
    });
    req.on('error', reject);
    if (body) {
      if (body instanceof Buffer) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-voice-cleanup-'));
  const configDir = join(home, '.config', 'remotelab');
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
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);

  return { home, localBin };
}

async function startServer({ home, localBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

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

async function createSession(port, name = 'RemoteLab retired voice cleanup session') {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
  });
  assert.equal(res.status, 201, 'session should be created');
  return res.json.session;
}

let chatServer = null;
let home = '';

try {
  const chatPort = randomPort();
  const tempHome = setupTempHome();
  home = tempHome.home;
  chatServer = await startServer({ home: tempHome.home, localBin: tempHome.localBin, port: chatPort });

  const session = await createSession(chatPort);

  const removedEndpointRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {
    providedTranscript: '请帮我把那个服务重起一下',
    rewriteWithContext: true,
  });
  assert.equal(removedEndpointRes.status, 410, 'retired voice cleanup endpoint should return Gone');
  assert.match(removedEndpointRes.json?.error || '', /removed/i, 'retired voice cleanup endpoint should explain that the path is gone');
  assert.match(removedEndpointRes.json?.error || '', /directly/i, 'retired voice cleanup endpoint should tell callers to send messages directly');

  const initialReview = await request(chatPort, 'GET', '/api/voice-review/settings');
  assert.equal(initialReview.status, 200);
  assert.equal(initialReview.json?.settings?.enabled, false, 'new personal review must be off by default');
  assert.equal(initialReview.json?.backend, 'unconfigured', 'a missing API must never select Codex');
  const reviewWhileOff = await request(chatPort, 'POST', '/api/voice-review', { text: '请检查结果' });
  assert.equal(reviewWhileOff.status, 400, 'no model should run until the Person opts in');
  const savedReview = await request(chatPort, 'PATCH', '/api/voice-review/settings', {
    enabled: true,
    terms: ['RoboDojo'],
  });
  assert.equal(savedReview.status, 200);
  assert.deepEqual(savedReview.json?.settings, {
    enabled: true, terms: ['RoboDojo'], provider: { id: '', apiKeyConfigured: false },
  });
  const loadedReview = await request(chatPort, 'GET', '/api/voice-review/settings');
  assert.deepEqual(loadedReview.json?.settings, savedReview.json?.settings);
  const reviewWithoutApi = await request(chatPort, 'POST', '/api/voice-review', { text: '请检查结果' });
  assert.equal(reviewWithoutApi.status, 400);
  assert.match(reviewWithoutApi.json?.error || '', /configured model API/);
  const configuredReview = await request(chatPort, 'PATCH', '/api/voice-review/settings', {
    providerId: 'doubao', apiKey: 'test-personal-secret',
  });
  assert.equal(configuredReview.status, 200);
  assert.equal(configuredReview.json?.backend, 'api');
  assert.deepEqual(configuredReview.json?.settings?.provider, { id: 'doubao', apiKeyConfigured: true });
  assert.equal(JSON.stringify(configuredReview.json).includes('test-personal-secret'), false,
    'the write response must not reveal the API key');
  const loadedProvider = await request(chatPort, 'GET', '/api/voice-review/settings');
  assert.equal(JSON.stringify(loadedProvider.json).includes('test-personal-secret'), false,
    'the read response must not reveal the API key');
  assert.equal(loadedProvider.json?.backend, 'api');

  console.log('test-http-voice-cleanup: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await stopServer(chatServer);
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
}

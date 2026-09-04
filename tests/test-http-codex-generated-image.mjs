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
const threadId = 'thread-generated-image';
const callId = 'exec-generated-image';
const oldCallId = 'exec-old-generated-image';
const expectedImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function randomPort() {
  return 42000 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 15000, intervalMs = 100) {
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
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text, buffer });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-codex-generated-image-'));
  const configDir = join(home, '.config', 'remotelab');
  const codexHome = join(home, '.codex');
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
    JSON.stringify([{
      id: 'fake-codex',
      name: 'Fake Codex',
      command: 'fake-codex',
      runtimeFamily: 'codex-json',
      models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
      reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
    }], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const threadId = ${JSON.stringify(threadId)};
const callId = ${JSON.stringify(callId)};
const oldCallId = ${JSON.stringify(oldCallId)};
const sessionDir = join(process.env.CODEX_HOME, 'sessions', '2026', '09', '04');
const generatedDir = join(process.env.CODEX_HOME, 'generated_images', threadId);
mkdirSync(sessionDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });
writeFileSync(join(generatedDir, callId + '.png'), Buffer.from(${JSON.stringify(expectedImage.toString('base64'))}, 'base64'));
writeFileSync(join(generatedDir, oldCallId + '.png'), Buffer.from(${JSON.stringify(expectedImage.toString('base64'))}, 'base64'));
writeFileSync(
  join(sessionDir, 'rollout-2026-09-04T12-00-00-' + threadId + '.jsonl'),
  [
    {
      timestamp: '2000-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'image_generation_end', call_id: oldCallId }
    },
    {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'image_generation_end', call_id: callId }
    }
  ].map((record) => JSON.stringify(record)).join('\\n') + '\\n'
);
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: '' }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, codexHome };
}

async function startServer({ home, configDir, codexHome, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
      REMOTELAB_MACHINE_CODEX_HOME: codexHome,
      SECURE_COOKIES: '0',
      REMOTELAB_ASSET_STORAGE_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PROVIDER: '',
      REMOTELAB_ASSET_STORAGE_REGION: '',
      REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: '',
      REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      return (await request(port, 'GET', '/api/auth/me')).status === 200;
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

try {
  const { home, configDir, codexHome } = setupTempHome();
  const port = randomPort();
  const chatServer = await startServer({ home, configDir, codexHome, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Codex generated image output',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-codex-generated-image',
      text: 'Generate an image.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');
    const runId = messageRes.json.run.id;

    const result = await waitFor(async () => {
      const runRes = await request(port, 'GET', `/api/runs/${runId}`);
      if (runRes.status !== 200 || runRes.json?.run?.state !== 'completed') return false;
      const eventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
      if (eventsRes.status !== 200) return false;
      const events = eventsRes.json?.events || [];
      const delivery = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'result_file_assets'
        && event.resultRunId === runId
      ));
      return delivery ? { delivery, events } : false;
    }, 'inline generated-image delivery');

    assert.equal(result.delivery.content, 'Generated image ready.');
    assert.equal(result.delivery.attachments?.length, 1, 'one generated image should be attached');
    const attachment = result.delivery.attachments[0];
    assert.equal(attachment.originalName, 'generated-image.png');
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(attachment.renderAs, undefined, 'generated images should render inline');
    assert.ok(attachment.assetId, 'generated image should be published as a normal file asset');

    const artifactEvent = result.events.find((event) => (
      event.type === 'artifact'
      && event.runId === runId
      && event.source === 'provider_session'
    ));
    assert.ok(artifactEvent, 'provider image output should normalize to a generic artifact event');

    const downloadRes = await request(port, 'GET', `/api/assets/${attachment.assetId}/download`);
    assert.equal(downloadRes.status, 200, 'published generated image should be downloadable');
    assert.deepEqual(downloadRes.buffer, expectedImage, 'published asset should preserve the generated image bytes');
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-codex-generated-image: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

#!/usr/bin/env node
import assert from 'assert/strict';
import { Buffer } from 'buffer';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const imageName = 'draft.png';
const imageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9lJawAAAAASUVORK5CYII=',
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-result-file-assets-assistant-images-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  const exportDir = join(home, 'exports');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(exportDir, { recursive: true });

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

  const outputPath = join(exportDir, imageName);
  const assistantMessage = `Preview:\n\n![draft](${outputPath})`;
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { dirname } = require('path');
const outputPath = ${JSON.stringify(outputPath)};
const assistantMessage = ${JSON.stringify(assistantMessage)};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.from(${JSON.stringify(imageBuffer.toString('base64'))}, 'base64'));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-result-file-assets-assistant-images' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: assistantMessage
  }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, outputPath };
}

async function startServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_INSTANCE_ROOT: '',
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
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

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home, configDir, outputPath } = setupTempHome();
  const port = randomPort();
  const chatServer = await startServer({ home, configDir, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Assistant markdown image assets',
      systemPrompt: 'Return generated images when needed.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-result-file-asset-assistant-images',
      text: 'Generate the preview image and return it inline.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');

    const run = await waitForRunTerminal(port, messageRes.json.run.id);
    assert.equal(run.state, 'completed', 'run should complete');

    const resultMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      const generated = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'result_file_assets'
        && event.resultRunId === run.id
      ));
      const original = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && typeof event.content === 'string'
        && event.content.startsWith('Preview:')
      ));
      return generated && original ? { generated, original } : false;
    }, 'assistant markdown image result-file message');

    const generated = resultMessage.generated;
    assert.equal(generated.content, 'Generated file ready to download.', 'generated result message should use the singular copy');
    assert.equal(generated.images?.length, 1, 'generated result message should attach the published image');
    assert.equal(generated.images[0].originalName, imageName, 'generated attachment should preserve the image file name');
    assert.equal(generated.images[0].mimeType, 'image/png', 'generated attachment should preserve the image mime type');

    assert.equal(
      resultMessage.original.content,
      `Preview:\n\n![draft](${outputPath})`,
      'raw assistant history should preserve the original local markdown image path',
    );

    const visibleAssistant = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`);
      if (res.status !== 200) return false;
      const assistant = (res.json?.events || []).find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && typeof event.content === 'string'
        && event.content.startsWith('Preview:')
      ));
      return assistant || false;
    }, 'visible assistant markdown image message');

    const assetId = generated.images[0].assetId;
    assert.equal(
      visibleAssistant.content,
      `Preview:\n\n![draft](/api/assets/${assetId}/download)`,
      'visible assistant content should rewrite the local markdown image path to a published asset URL',
    );
    assert.doesNotMatch(
      visibleAssistant.content,
      new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'visible assistant content should not leak the host-local image path',
    );

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 200, 'published assistant-path image should stream locally');
    assert.equal(downloadRes.headers.get('content-type'), 'image/png', 'published image download should use the image mime type');
    assert.deepEqual(Buffer.from(await downloadRes.arrayBuffer()), imageBuffer, 'downloaded image should match the generated file');
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-result-file-assets-assistant-markdown-images: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

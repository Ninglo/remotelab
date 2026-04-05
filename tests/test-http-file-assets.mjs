#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 36000 + Math.floor(Math.random() * 4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRm(target, attempts = 6, delayMs = 120) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs * (index + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-file-assets-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  const promptFile = join(home, 'captured-prompt.txt');
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
    `#!/usr/bin/env node
const { appendFileSync } = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
if (process.env.REMOTELAB_FAKE_PROMPT_FILE) {
  appendFileSync(process.env.REMOTELAB_FAKE_PROMPT_FILE, prompt + '\\n\\n---PROMPT---\\n\\n', 'utf8');
}
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-file-asset-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'file asset received' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 50);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, promptFile };
}

function readCapturedPrompts(promptFile) {
  if (!existsSync(promptFile)) return [];
  return readFileSync(promptFile, 'utf8')
    .split('\n\n---PROMPT---\n\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function startMockStorageServer(port) {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const key = parsed.pathname;
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] || 'application/octet-stream',
        });
        res.writeHead(200, { ETag: 'mock-etag' });
        res.end('ok');
      });
      return;
    }

    if (req.method === 'GET') {
      const object = objects.get(key);
      if (!object) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': object.contentType,
        'Content-Length': String(object.body.length),
      });
      res.end(object.body);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, objects }));
  });
}

async function startServer({ home, port, promptFile, storagePort }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_FAKE_PROMPT_FILE: promptFile,
      REMOTELAB_ASSET_STORAGE_BASE_URL: `http://127.0.0.1:${storagePort}/bucket`,
      REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PROVIDER: 's3',
      REMOTELAB_ASSET_STORAGE_REGION: 'auto',
      REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: 'test-access-key',
      REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS: '3600',
      REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED: '1',
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

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name: 'File asset session',
  });
  assert.equal(res.status, 201, 'session should be created');
  return res.json.session;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home, promptFile } = setupTempHome();
  const port = randomPort();
  const storagePort = randomPort();
  const { server: storageServer } = await startMockStorageServer(storagePort);
  const chatServer = await startServer({ home, port, promptFile, storagePort });

  try {
    const session = await createSession(port);
    const uploadIntentRes = await request(port, 'POST', '/api/assets/upload-intents', {
      sessionId: session.id,
      originalName: 'big-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 18,
    });
    assert.equal(uploadIntentRes.status, 200, 'upload intent should be created');
    assert.ok(uploadIntentRes.json?.asset?.id, 'upload intent should include asset id');
    assert.equal(uploadIntentRes.json.asset.downloadUrl, `/api/assets/${uploadIntentRes.json.asset.id}/download`, 'upload intent should include a stable download route');

    const uploadUrl = uploadIntentRes.json.upload.url;
    const uploadBody = Buffer.from('video-from-storage');
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: uploadIntentRes.json.upload.headers,
      body: uploadBody,
    });
    assert.equal(uploadRes.status, 200, 'direct upload should succeed');

    const finalizeRes = await request(port, 'POST', `/api/assets/${uploadIntentRes.json.asset.id}/finalize`, {
      sizeBytes: uploadBody.length,
      etag: uploadRes.headers.get('etag') || '',
    });
    assert.equal(finalizeRes.status, 200, 'asset finalize should succeed');
    assert.ok(finalizeRes.json?.asset?.directUrl, 'finalized asset should include a direct download url');

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-file-asset',
      text: 'Please inspect the uploaded video asset.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      images: [{
        assetId: uploadIntentRes.json.asset.id,
        originalName: 'big-video.mp4',
        mimeType: 'video/mp4',
      }],
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message with external asset should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');

    const run = await waitForRunTerminal(port, messageRes.json.run.id);
    assert.equal(run.state, 'completed', 'run should complete after localizing the external asset');

    const eventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events`);
      if (res.status !== 200) return false;
      const userMessage = (res.json.events || []).find((event) => event.type === 'message' && event.role === 'user');
      return userMessage ? { res, userMessage } : false;
    }, 'user message with external asset');

    assert.equal(eventsRes.userMessage.images?.length, 1, 'user message should preserve one file asset');
    assert.equal(eventsRes.userMessage.images[0].assetId, uploadIntentRes.json.asset.id, 'user message should preserve the asset id');
    assert.equal(eventsRes.userMessage.images[0].originalName, 'big-video.mp4', 'user message should preserve the original asset name');

    const capturedPrompt = await waitFor(() => {
      const prompts = readCapturedPrompts(promptFile);
      return prompts.find((prompt) => prompt.includes('big-video.mp4') && prompt.includes('file-assets-cache')) || false;
    }, 'runner prompt with localized file asset');
    assert.match(capturedPrompt, /big-video\.mp4 -> .*file-assets-cache\/fasset_[a-f0-9]{24}-big-video\.mp4/, 'runner prompt should include the localized cache path');

    const cacheDir = join(home, '.config', 'remotelab', 'file-assets-cache');
    const cachedFiles = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
    assert.equal(cachedFiles.length, 1, 'one localized file should be cached locally');
    const cachedBuffer = readFileSync(join(cacheDir, cachedFiles[0]));
    assert.equal(cachedBuffer.toString('utf8'), uploadBody.toString('utf8'), 'localized cached file should match uploaded object contents');

    const assetInfoRes = await request(port, 'GET', `/api/assets/${uploadIntentRes.json.asset.id}`);
    assert.equal(assetInfoRes.status, 200, 'asset metadata route should work');
    assert.equal(assetInfoRes.json.asset.id, uploadIntentRes.json.asset.id, 'asset metadata should match the uploaded asset');
    assert.ok(assetInfoRes.json.asset.directUrl.includes(`/bucket/${uploadIntentRes.json.asset.id}-`) || assetInfoRes.json.asset.directUrl.includes('/bucket/'), 'asset metadata should expose a direct object-storage url');

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${uploadIntentRes.json.asset.id}/download`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 302, 'download route should redirect to object storage');
    assert.ok(String(downloadRes.headers.get('location') || '').includes(`127.0.0.1:${storagePort}`), 'download redirect should point at object storage');
  } finally {
    await stopServer(chatServer);
    await new Promise((resolve) => storageServer.close(resolve));
    await safeRm(home);
  }
  console.log('test-http-file-assets: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

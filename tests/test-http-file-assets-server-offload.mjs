#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 40000 + Math.floor(Math.random() * 4000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-file-assets-offload-'));
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
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-file-asset-offload-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'server upload offloaded' }
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

function startMockStorageServer(port, { transientGetFailures = 0 } = {}) {
  const objects = new Map();
  const stats = {
    getCount: 0,
    transientGetFailuresServed: 0,
  };
  let remainingTransientGetFailures = Math.max(0, Number.parseInt(String(transientGetFailures || 0), 10) || 0);
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
      stats.getCount += 1;
      const object = objects.get(key);
      if (!object) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (remainingTransientGetFailures > 0) {
        remainingTransientGetFailures -= 1;
        stats.transientGetFailuresServed += 1;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Transient not found');
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
    server.listen(port, '127.0.0.1', () => resolve({ server, objects, stats }));
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
      REMOTELAB_ASSET_STORAGE_PROVIDER: 'tos',
      REMOTELAB_ASSET_STORAGE_REGION: 'auto',
      REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: 'test-access-key',
      REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED: '0',
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
    name: 'Server offload session',
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
  const { server: storageServer, objects, stats } = await startMockStorageServer(storagePort, { transientGetFailures: 2 });
  const chatServer = await startServer({ home, port, promptFile, storagePort });

  try {
    const session = await createSession(port);

    const form = new FormData();
    form.set('requestId', 'req-http-file-asset-server-offload');
    form.set('text', 'Please inspect this uploaded note.');
    form.set('tool', 'fake-codex');
    form.set('model', 'fake-model');
    form.set('effort', 'low');
    form.append('attachments', new Blob(['upload-through-host'], { type: 'text/plain' }), 'notes.txt');

    const messageRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'multipart message should be accepted');
    const messageJson = await messageRes.json();
    assert.ok(messageJson?.run?.id, 'multipart message should create a run');

    const run = await waitForRunTerminal(port, messageJson.run.id);
    assert.equal(run.state, 'completed', 'run should complete after localizing the offloaded upload');

    const userMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events`);
      if (res.status !== 200) return false;
      return (res.json.events || []).find((event) => event.type === 'message' && event.role === 'user') || false;
    }, 'user message with offloaded upload');

    assert.equal(userMessage.images?.length, 1, 'user message should keep one uploaded attachment');
    assert.ok(userMessage.images[0].assetId, 'server-ingested upload should be re-published as a file asset');
    assert.equal(userMessage.images[0].originalName, 'notes.txt', 'offloaded upload should preserve the original filename');
    assert.equal(userMessage.images[0].mimeType, 'text/plain', 'offloaded upload should preserve the mime type');
    assert.equal(typeof userMessage.images[0].filename, 'undefined', 'offloaded upload should no longer rely on a local attachment filename');

    assert.equal(objects.size, 1, 'server-side offload should upload one object to storage');
    const [[storedPath, storedObject]] = [...objects.entries()];
    assert.match(
      storedPath,
      new RegExp(`^/bucket/session-assets/${session.id}/\\d{4}/\\d{2}/\\d{2}/fasset_[a-f0-9]{24}-notes\\.txt$`),
      'uploaded object should land under the session-assets prefix',
    );
    assert.equal(storedObject.body.toString('utf8'), 'upload-through-host', 'object storage should receive the uploaded attachment bytes');

    const assetInfoRes = await request(port, 'GET', `/api/assets/${userMessage.images[0].assetId}`);
    assert.equal(assetInfoRes.status, 200, 'asset metadata route should load the offloaded upload');
    assert.equal(assetInfoRes.json.asset.id, userMessage.images[0].assetId, 'asset metadata should match the uploaded asset id');
    assert.ok(String(assetInfoRes.json.asset.directUrl || '').includes(`127.0.0.1:${storagePort}`), 'asset metadata should expose the object-storage direct URL');

    const capturedPrompt = await waitFor(() => {
      const prompts = readCapturedPrompts(promptFile);
      return prompts.find((prompt) => prompt.includes('notes.txt') && prompt.includes('file-assets-cache')) || false;
    }, 'runner prompt with localized offloaded upload');
    assert.equal(stats.transientGetFailuresServed, 2, 'runner localization should absorb transient storage 404s');
    assert.ok(stats.getCount >= 3, 'runner localization should retry storage downloads before succeeding');
    assert.match(
      capturedPrompt,
      /notes\.txt -> .*file-assets-cache\/fasset_[a-f0-9]{24}\.txt/,
      'runner prompt should use the localized cached file path for the offloaded upload',
    );

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${userMessage.images[0].assetId}/download`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 302, 'download route should redirect to object storage for the offloaded upload');
    const redirectUrl = String(downloadRes.headers.get('location') || '');
    assert.ok(redirectUrl.includes(`127.0.0.1:${storagePort}`), 'download redirect should point at object storage');

    const redirected = await fetch(redirectUrl, { method: 'GET' });
    assert.equal(redirected.status, 200, 'redirected object-storage download should succeed');
    assert.equal(await redirected.text(), 'upload-through-host', 'redirected object-storage download should return the uploaded attachment bytes');

    const attachmentDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${userMessage.images[0].assetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(attachmentDownloadRes.status, 302, 'TOS attachment downloads should redirect to object storage');
    const attachmentRedirectUrl = String(attachmentDownloadRes.headers.get('location') || '');
    assert.ok(attachmentRedirectUrl.includes(`127.0.0.1:${storagePort}`), 'attachment redirect should point at object storage');
    const attachmentUrl = new URL(attachmentRedirectUrl);
    assert.match(
      attachmentUrl.searchParams.get('response-content-disposition') || '',
      /^attachment; filename="notes\.txt"/,
      'attachment redirect URL should include content-disposition for the original filename',
    );

    const attachmentRedirected = await fetch(attachmentRedirectUrl, { method: 'GET' });
    assert.equal(attachmentRedirected.status, 200, 'redirected attachment download should succeed');
    assert.equal(await attachmentRedirected.text(), 'upload-through-host', 'redirected attachment download should return the uploaded bytes');
  } finally {
    await stopServer(chatServer);
    await new Promise((resolve) => storageServer.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-file-assets-server-offload: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

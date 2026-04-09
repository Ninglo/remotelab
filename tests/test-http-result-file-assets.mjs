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
const expectedOutputs = Array.from({ length: 5 }, (_, index) => ({
  name: index === 0 ? '演示结果 1.mp4' : `rough cut ${index + 1}.mp4`,
  content: `rendered-video-asset-${index + 1}`,
}));

function randomPort() {
  return 38000 + Math.floor(Math.random() * 2000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-result-file-assets-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  const renderReviewDir = join(home, 'code', 'render-review');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(renderReviewDir, { recursive: true });

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
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const outputs = ${JSON.stringify(expectedOutputs)};
const outputDir = join(process.env.HOME, 'code', 'render-review');
mkdirSync(outputDir, { recursive: true });
for (const output of outputs) {
  writeFileSync(join(outputDir, output.name), output.content, 'utf8');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-result-file-assets' }));
console.log(JSON.stringify({ type: 'turn.started' }));
outputs.forEach((output, index) => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'python cut.py raw-' + (index + 1) + '.MOV --remove cuts-' + (index + 1) + '.json -o "' + output.name + '"',
      aggregated_output: 'Removed 3 segment(s) (12.40s) → ' + output.name,
      exit_code: 0,
      status: 'completed'
    }
  }));
});
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'render complete' }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
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
          contentDisposition: req.headers['content-disposition'] || '',
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
      const responseHeaders = {
        'Content-Type': object.contentType,
        'Content-Length': String(object.body.length),
      };
      const overrideDisposition = parsed.searchParams.get('response-content-disposition');
      if (overrideDisposition) {
        responseHeaders['Content-Disposition'] = overrideDisposition;
      } else if (object.contentDisposition) {
        responseHeaders['Content-Disposition'] = object.contentDisposition;
      }
      res.writeHead(200, responseHeaders);
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

async function startServer({ home, port, storagePort }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
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

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const storagePort = randomPort();
  const { server: storageServer } = await startMockStorageServer(storagePort);
  const chatServer = await startServer({ home, port, storagePort });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Render review result assets',
      systemPrompt: 'Use the local render-review workflow under ~/code/render-review and do a kept-content review before final export.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-result-file-asset',
      text: 'Please render the rough cut and return the result file.',
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
      return generated ? { generated, events } : false;
    }, 'generated result-file message');

    const generated = resultMessage.generated;
    assert.equal(generated.content, 'Generated files ready to download.', 'generated result message should use the plural download-ready copy');
    assert.equal(generated.images?.length, expectedOutputs.length, 'generated result message should attach every published file');
    assert.deepEqual(generated.images.map((image) => image.originalName), expectedOutputs.map((output) => output.name), 'generated result attachments should preserve every exported file name');
    assert.deepEqual(generated.images.map((image) => image.mimeType), expectedOutputs.map(() => 'video/mp4'), 'generated result attachments should preserve the video mime type');
    assert.deepEqual(generated.images.map((image) => image.sizeBytes), expectedOutputs.map((output) => Buffer.byteLength(output.content, 'utf8')), 'generated result attachments should preserve every exported file size');
    assert.ok(generated.images.every((image) => image.renderAs === 'file'), 'generated result attachments should render as download rows');

    const finalAssistant = resultMessage.events.find((event) => event.type === 'message' && event.role === 'assistant' && event.content === 'render complete');
    assert.ok(finalAssistant, 'original assistant completion message should still be present');

    const assetId = generated.images[0].assetId;
    const assetRes = await request(port, 'GET', `/api/assets/${assetId}`);
    assert.equal(assetRes.status, 200, 'published result asset metadata should load');
    assert.equal(assetRes.json.asset.originalName, expectedOutputs[0].name, 'published asset should keep the export filename');

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 302, 'download route should redirect to object storage');
    const redirectUrl = String(downloadRes.headers.get('location') || '');
    const redirectedUrl = new URL(redirectUrl);
    const contentDisposition = redirectedUrl.searchParams.get('response-content-disposition') || '';
    assert.match(contentDisposition, /^attachment; filename="/u, 'download redirect should request an attachment filename');
    assert.match(contentDisposition, /UTF-8''.*%E6%BC%94%E7%A4%BA%E7%BB%93%E6%9E%9C/u, 'download redirect should preserve the original Unicode filename');
    assert.ok(!contentDisposition.includes('fasset_'), 'download redirect Content-Disposition must not contain fasset_ ID');

    const redirected = await fetch(redirectUrl, { method: 'GET' });
    assert.equal(redirected.status, 200, 'redirected object-storage download should succeed');
    assert.equal(await redirected.text(), expectedOutputs[0].content, 'redirected download should return the exported file');
  } finally {
    await stopServer(chatServer);
    await new Promise((resolve) => storageServer.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-result-file-assets: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

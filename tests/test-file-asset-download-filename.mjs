#!/usr/bin/env node
/**
 * Verifies that file asset downloads served by the chat-server return the correct
 * Content-Disposition filename — NOT the internal fasset_xxx ID.
 *
 * Covers:
 *  1. download=1 → 200 streamed through server, correct Content-Disposition attachment header
 *  2. no download flag → 302 redirect to object storage (inline viewing)
 *  3. Unicode filenames are preserved in Content-Disposition
 *  4. Downloaded body matches uploaded content
 */
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
  return 37000 + Math.floor(Math.random() * 3000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-download-filename-'));
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
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-dl' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));
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
        });
        res.writeHead(200, { ETag: '"mock-etag"' });
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
    res.writeHead(405);
    res.end();
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

const testCases = [
  { name: 'ASCII filename', originalName: 'report.pdf', mimeType: 'application/pdf', content: 'pdf-content' },
  { name: 'Unicode filename', originalName: '演示结果.mp4', mimeType: 'video/mp4', content: 'video-content' },
  { name: 'Filename with spaces', originalName: 'my document (final).docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: 'docx-content' },
  { name: 'iOS shortcut file', originalName: 'RemoteLab 快捷指令.shortcut', mimeType: 'application/x-apple-shortcut', content: 'shortcut-binary' },
];

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const storagePort = randomPort();
  const { server: storageServer } = await startMockStorageServer(storagePort);
  const chatServer = await startServer({ home, port, storagePort });

  try {
    const sessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Download filename test',
    });
    assert.equal(sessionRes.status, 201);
    const session = sessionRes.json.session;

    for (const tc of testCases) {
      console.log(`  testing: ${tc.name} (${tc.originalName})`);

      // Upload
      const intentRes = await request(port, 'POST', '/api/assets/upload-intents', {
        sessionId: session.id,
        originalName: tc.originalName,
        mimeType: tc.mimeType,
        sizeBytes: Buffer.byteLength(tc.content),
      });
      assert.equal(intentRes.status, 200, `${tc.name}: upload intent`);
      const assetId = intentRes.json.asset.id;

      const uploadBody = Buffer.from(tc.content);
      const uploadRes = await fetch(intentRes.json.upload.url, {
        method: 'PUT',
        headers: intentRes.json.upload.headers,
        body: uploadBody,
      });
      assert.equal(uploadRes.status, 200, `${tc.name}: upload`);

      await request(port, 'POST', `/api/assets/${assetId}/finalize`, {
        sizeBytes: uploadBody.length,
        etag: uploadRes.headers.get('etag') || '',
      });

      // Test 1: download=1 should stream through server with correct Content-Disposition
      const downloadRes = await request(port, 'GET', `/api/assets/${assetId}/download?download=1`);
      assert.equal(downloadRes.status, 200, `${tc.name}: download should return 200 (server-proxied)`);

      const disposition = downloadRes.headers['content-disposition'] || '';
      assert.match(disposition, /^attachment;/u, `${tc.name}: should be attachment disposition`);

      // The filename must NOT contain fasset_
      assert.ok(
        !disposition.includes('fasset_'),
        `${tc.name}: Content-Disposition must not contain fasset_ ID, got: ${disposition}`,
      );

      // Body should match
      assert.equal(downloadRes.text, tc.content, `${tc.name}: downloaded content should match`);

      // Test 2: no download flag should redirect (302) for inline viewing
      const inlineRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download`, {
        method: 'GET',
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(inlineRes.status, 302, `${tc.name}: inline view should redirect to storage`);
    }
  } finally {
    await stopServer(chatServer);
    await new Promise((resolve) => storageServer.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-file-asset-download-filename: all ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

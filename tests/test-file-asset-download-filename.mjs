#!/usr/bin/env node
/**
 * Verifies that file asset downloads return the correct filename — NOT the
 * internal fasset_xxx ID — via proper Content-Disposition headers from storage.
 *
 * The strategy is:
 *  1. Upload stores the original filename in the asset record.
 *  2. Download redirect URL includes response-content-disposition query param.
 *
 * Covers:
 *  - Upload intent keeps the browser PUT header set CORS-safe
 *  - download=1 → 302 redirect with response-content-disposition=attachment
 *  - inline (no download flag) → 302 redirect with response-content-disposition=inline
 *  - Storage returns Content-Disposition from the redirect override
 *  - No fasset_ prefix in any Content-Disposition
 *  - Unicode, spaces, ASCII, and shortcut filenames all work
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

/**
 * Mock S3/TOS storage server that:
 * - Stores Content-Disposition from PUT request as object metadata
 * - Returns stored Content-Disposition on GET
 * - Honors response-content-disposition query parameter as override
 */
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
      const responseHeaders = {
        'Content-Type': object.contentType,
        'Content-Length': String(object.body.length),
      };
      // Honor response-content-disposition query param (like real S3/TOS)
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
      REMOTELAB_ASSET_STORAGE_PROVIDER: 'tos',
      REMOTELAB_ASSET_STORAGE_REGION: 'cn-beijing',
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
  const { server: storageServer, objects } = await startMockStorageServer(storagePort);
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

      // 1. Create upload intent — browser uploads should stay CORS-safe
      const intentRes = await request(port, 'POST', '/api/assets/upload-intents', {
        sessionId: session.id,
        originalName: tc.originalName,
        mimeType: tc.mimeType,
        sizeBytes: Buffer.byteLength(tc.content),
      });
      assert.equal(intentRes.status, 200, `${tc.name}: upload intent`);
      assert.equal(intentRes.json.upload.headers['Content-Disposition'], undefined, `${tc.name}: upload intent should omit Content-Disposition header`);

      const assetId = intentRes.json.asset.id;

      // 2. Upload with the returned browser-safe headers
      const uploadBody = Buffer.from(tc.content);
      const uploadRes = await fetch(intentRes.json.upload.url, {
        method: 'PUT',
        headers: intentRes.json.upload.headers,
        body: uploadBody,
      });
      assert.equal(uploadRes.status, 200, `${tc.name}: upload`);

      // 3. Storage should not rely on object metadata for the final filename
      const storedObject = [...objects.values()].pop();
      assert.equal(storedObject.contentDisposition, '', `${tc.name}: stored object should not need Content-Disposition metadata`);

      await request(port, 'POST', `/api/assets/${assetId}/finalize`, {
        sizeBytes: uploadBody.length,
        etag: uploadRes.headers.get('etag') || '',
      });

      // 4. download=1 should redirect with response-content-disposition=attachment
      const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download?download=1`, {
        method: 'GET',
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(downloadRes.status, 302, `${tc.name}: download should redirect to storage`);
      const redirectUrl = String(downloadRes.headers.get('location') || '');
      const redirectParsed = new URL(redirectUrl);
      const downloadDisposition = redirectParsed.searchParams.get('response-content-disposition') || '';
      assert.match(downloadDisposition, /^attachment;/u, `${tc.name}: redirect should request attachment disposition`);
      assert.ok(
        !downloadDisposition.includes('fasset_'),
        `${tc.name}: redirect Content-Disposition must not contain fasset_ ID, got: ${downloadDisposition}`,
      );

      // 5. Follow redirect and verify storage returns correct Content-Disposition header
      const storageRes = await fetch(redirectUrl, { method: 'GET' });
      assert.equal(storageRes.status, 200, `${tc.name}: storage download should succeed`);
      const finalDisposition = storageRes.headers.get('content-disposition') || '';
      assert.match(finalDisposition, /^attachment;/u, `${tc.name}: storage should return attachment disposition`);
      assert.ok(
        !finalDisposition.includes('fasset_'),
        `${tc.name}: storage response Content-Disposition must not contain fasset_, got: ${finalDisposition}`,
      );
      assert.equal(await storageRes.text(), tc.content, `${tc.name}: downloaded content should match`);

      // 6. Inline view should also redirect with response-content-disposition=inline
      const inlineRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download`, {
        method: 'GET',
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(inlineRes.status, 302, `${tc.name}: inline view should redirect`);
      const inlineRedirectUrl = String(inlineRes.headers.get('location') || '');
      const inlineParsed = new URL(inlineRedirectUrl);
      const inlineDisposition = inlineParsed.searchParams.get('response-content-disposition') || '';
      assert.match(inlineDisposition, /^inline;/u, `${tc.name}: inline redirect should request inline disposition`);
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

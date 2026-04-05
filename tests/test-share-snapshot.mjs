#!/usr/bin/env node
import assert from 'assert';
import http from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-share-'));
const homeDir = join(tempRoot, 'home');
const configDir = join(homeDir, '.config', 'remotelab');
const port = 7800 + Math.floor(Math.random() * 200);
const token = '0123456789abcdef'.repeat(4);
const base = `http://127.0.0.1:${port}`;

let server = null;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buffer.toString('utf8'), buffer });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request('GET', '/login');
      if (res.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for chat server');
}

function setupAuth() {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({ token }, null, 2), 'utf8');
}

function startServer() {
  server = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  server.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
}

function stopServer() {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
}

async function main() {
  setupAuth();
  startServer();
  await waitForServer();

  const authRes = await request('GET', `/?token=${token}`);
  assert.strictEqual(authRes.status, 302, 'token auth should redirect');
  const cookieHeader = authRes.headers['set-cookie'];
  assert.ok(cookieHeader && cookieHeader[0], 'auth should set a session cookie');
  const cookie = cookieHeader[0].split(';')[0];

  const createRes = await request('POST', '/api/sessions', {
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ folder: homeDir, tool: 'codex' }),
  });
  assert.strictEqual(createRes.status, 201, 'session creation should succeed');
  const session = JSON.parse(createRes.body).session;
  assert.ok(session?.id, 'session id should exist');

  const renameRes = await request('PATCH', `/api/sessions/${session.id}`, {
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ name: 'Share preview title' }),
  });
  assert.strictEqual(renameRes.status, 200, 'session rename should succeed');

  const historyDir = join(configDir, 'chat-history', session.id);
  mkdirSync(join(historyDir, 'events'), { recursive: true });
  mkdirSync(join(historyDir, 'bodies'), { recursive: true });
  writeFileSync(join(historyDir, 'meta.json'), JSON.stringify({
    latestSeq: 6,
    lastEventAt: 6,
    size: 6,
    counts: {
      message: 2,
      message_user: 1,
      message_assistant: 1,
      status: 1,
      reasoning: 1,
      tool_use: 1,
      tool_result: 1,
    },
  }, null, 2), 'utf8');
  const events = [
    {
      type: 'message',
      id: 'evt_000001',
      seq: 1,
      timestamp: 1,
      role: 'user',
      content: 'Please review this snippet.',
      bodyAvailable: true,
      bodyLoaded: true,
      images: [{
        filename: 'inline.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0WQAAAAASUVORK5CYII=',
      }],
    },
    {
      type: 'status',
      id: 'evt_000002',
      seq: 2,
      timestamp: 2,
      role: 'system',
      content: 'thinking',
    },
    {
      type: 'reasoning',
      id: 'evt_000003',
      seq: 3,
      timestamp: 3,
      role: 'assistant',
      content: 'Need to inspect the data flow first.',
      bodyAvailable: true,
      bodyLoaded: true,
    },
    {
      type: 'tool_use',
      id: 'evt_000004',
      seq: 4,
      timestamp: 4,
      role: 'assistant',
      toolName: 'shell',
      toolInput: 'rg -n "share" .',
      bodyAvailable: true,
      bodyLoaded: true,
    },
    {
      type: 'tool_result',
      id: 'evt_000005',
      seq: 5,
      timestamp: 5,
      role: 'system',
      toolName: 'shell',
      output: 'chat/router.mjs: share route',
      exitCode: 0,
      bodyAvailable: true,
      bodyLoaded: true,
    },
    {
      type: 'message',
      id: 'evt_000006',
      seq: 6,
      timestamp: 6,
      role: 'assistant',
      content: 'Done.\n\n```js\nconsole.log("shared snapshot ok");\n```\n\n[external link](https://example.com)',
      bodyAvailable: true,
      bodyLoaded: true,
    },
  ];
  for (const event of events) {
    writeFileSync(
      join(historyDir, 'events', `${String(event.seq).padStart(9, '0')}.json`),
      JSON.stringify(event, null, 2),
      'utf8',
    );
  }

  stopServer();
  await new Promise((resolve) => setTimeout(resolve, 200));
  startServer();
  await waitForServer();

  const shareRes = await request('POST', `/api/sessions/${session.id}/share`, {
    headers: { Cookie: cookie },
  });
  assert.strictEqual(shareRes.status, 201, 'share creation should succeed');
  const sharePayload = JSON.parse(shareRes.body);
  assert.ok(/^share\/snap_[a-f0-9]{48}$/.test(sharePayload.share?.url || ''), 'share URL should be generated');

  const shareId = sharePayload.share.url.split('/').pop();
  const snapshotPath = join(configDir, 'shared-snapshots', `${shareId}.json`);
  assert.ok(existsSync(snapshotPath), 'snapshot file should be persisted');

  const storedSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.strictEqual(storedSnapshot.id, shareId, 'snapshot id should match');
  assert.strictEqual(storedSnapshot.session.tool, 'codex', 'tool should be preserved');
  assert.ok(!JSON.stringify(storedSnapshot).includes('savedPath'), 'snapshot should not leak internal file paths');
  assert.ok(storedSnapshot.events.some((event) => event.type === 'message' && /Please review this snippet/.test(event.content || '')));
  assert.ok(storedSnapshot.events.some((event) => event.type === 'message' && /shared snapshot ok/.test(event.content || '')));
  const storedUserEvent = storedSnapshot.events.find((event) => event.type === 'message' && /Please review this snippet/.test(event.content || ''));
  assert.ok(storedUserEvent?.images?.length === 1, 'user attachment should be preserved');
  const storedAttachment = storedUserEvent.images[0];
  assert.match(storedAttachment.assetId || '', /^asset_[a-f0-9]{24}$/, 'share attachment should be externalized');
  assert.strictEqual(storedAttachment.url, `../share-asset/${shareId}/${storedAttachment.assetId}`, 'share attachment should point at a public share asset URL');
  assert.ok(!('data' in storedAttachment), 'share snapshot should not inline attachment bytes');
  const storedAssetPath = join(configDir, 'shared-snapshots', `${shareId}.assets`, storedAttachment.assetId);
  assert.ok(existsSync(storedAssetPath), 'share asset should be persisted alongside the snapshot');

  const publicShareRes = await request('GET', sharePayload.share.url);
  assert.strictEqual(publicShareRes.status, 200, 'public share page should load without auth');
  assert.strictEqual(publicShareRes.headers['cache-control'], 'public, no-cache, max-age=0, must-revalidate', 'share shell should require validator rechecks');
  assert.ok(publicShareRes.headers.etag, 'share shell should expose an ETag');
  assert.match(publicShareRes.headers['content-security-policy'] || '', /connect-src 'none'/, 'share page CSP should block network access');
  assert.match(publicShareRes.headers['content-security-policy'] || '', /media-src 'self' data: blob:/, 'share page CSP should allow public media playback');
  assert.strictEqual(publicShareRes.headers['referrer-policy'], 'no-referrer', 'share page should suppress referrer leakage');
  assert.match(publicShareRes.body, /<meta name="color-scheme" content="light dark">/);
  assert.match(publicShareRes.body, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/);
  assert.match(publicShareRes.body, /<meta name="theme-color" content="#1e1e1e" media="\(prefers-color-scheme: dark\)">/);
  assert.match(publicShareRes.body, /<title>Share preview title · Shared Snapshot<\/title>/, 'share page title should expose the shared session name');
  assert.match(publicShareRes.body, /<meta name="description" content="A read-only RemoteLab conversation snapshot\.">/, 'share page should expose a generic preview description');
  assert.match(publicShareRes.body, /<meta property="og:title" content="Share preview title">/, 'share page should expose an OG title for previews');
  assert.match(publicShareRes.body, /<meta property="og:description" content="A read-only RemoteLab conversation snapshot\.">/, 'share page should expose an OG description for previews');
  assert.match(publicShareRes.body, new RegExp(`<meta property="og:url" content="${escapeRegex(new URL(sharePayload.share.url, `${base}/`).toString())}">`), 'share page should expose an absolute OG URL for previews');
  assert.match(publicShareRes.body, /<meta name="twitter:card" content="summary">/, 'share page should expose a compact twitter preview card');
  assert.match(publicShareRes.body, /<meta name="twitter:title" content="Share preview title">/, 'share page should mirror the preview title for twitter cards');
  assert.match(publicShareRes.body, /\/favicon\.ico\?v=/, 'share page should fingerprint icon URLs for immutable caching');
  assert.match(publicShareRes.body, /\/icon\.svg\?v=/, 'share page should fingerprint svg icon URLs for immutable caching');
  assert.match(publicShareRes.body, /<body class="visitor-mode share-snapshot-mode">/, 'share page should boot directly into read-only chat mode');
  assert.match(publicShareRes.body, /\/chat\/chat\.css\?v=/, 'share page should reuse the main chat stylesheet');
  assert.match(publicShareRes.body, /\/chat\/bootstrap\.js\?v=/, 'share page should reuse the main chat frontend bootstrap');
  assert.ok(publicShareRes.body.includes(`../share-payload/${shareId}.js`), 'share shell should bootstrap an external payload resource');
  assert.ok(!publicShareRes.body.includes('/share.js'), 'share page should not load the removed legacy share renderer');
  assert.ok(!publicShareRes.body.includes('window.__REMOTELAB_SHARE__ ='), 'share shell should not inline the snapshot payload');
  assert.ok(!publicShareRes.body.includes('Please review this snippet.'), 'share shell should not inline conversation bodies');
  assert.ok(!publicShareRes.body.includes('<section class="hero">'), 'share page should not fall back to the legacy snapshot hero shell');
  assert.match(publicShareRes.body, /<div class="messages-inner" id="messagesInner">/, 'share page should render the shared chat timeline shell');
  assert.match(publicShareRes.body, /<span id="statusText" data-i18n="status\.readOnlySnapshot">read-only snapshot<\/span>/, 'share page should present a read-only status label instead of disconnected by default');
  assert.match(publicShareRes.body, /<textarea id="msgInput" placeholder="Read-only snapshot" data-i18n-placeholder="input\.placeholder\.readOnlySnapshot" disabled><\/textarea>/, 'share page should present a read-only placeholder instead of an editable message box hint');
  assert.match(publicShareRes.body, /<div class="session-mode-banner" id="sessionModeBanner">/, 'share page should render a read-only guidance banner');
  assert.ok(!publicShareRes.body.includes('/api/auth/me'), 'share page should not bootstrap owner auth UI');
  assert.ok(!publicShareRes.body.includes('/ws'), 'share page should not connect to live websocket');
  const publicShare304Res = await request('GET', sharePayload.share.url, {
    headers: {
      'If-None-Match': publicShareRes.headers.etag,
    },
  });
  assert.strictEqual(publicShare304Res.status, 304, 'unchanged share shell should support 304 validation');

  const payloadRes = await request('GET', `/share-payload/${shareId}.js`);
  assert.strictEqual(payloadRes.status, 200, 'public share payload should load without auth');
  assert.strictEqual(payloadRes.headers['cache-control'], 'public, no-cache, max-age=0, must-revalidate', 'share payload should require validator rechecks');
  assert.ok(payloadRes.headers.etag, 'share payload should expose an ETag');
  assert.match(payloadRes.headers['content-type'] || '', /^application\/javascript;/, 'share payload should be served as JavaScript');
  assert.ok(payloadRes.body.includes('window.__REMOTELAB_SHARE__ ='), 'share payload should assign the snapshot data');
  assert.ok(payloadRes.body.includes('displayEvents'), 'share payload should expose chat-ready display events');
  assert.ok(payloadRes.body.includes('eventBlocks'), 'share payload should expose collapsed block payloads for the chat viewer');
  assert.ok(payloadRes.body.includes('Please review this snippet.'), 'share payload should include conversation bodies');
  assert.ok(payloadRes.body.includes(storedAttachment.url), 'share payload should reference external attachment URLs');
  assert.ok(!payloadRes.body.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0WQAAAAASUVORK5CYII='), 'share payload should not inline attachment base64');
  const payload304Res = await request('GET', `/share-payload/${shareId}.js`, {
    headers: {
      'If-None-Match': payloadRes.headers.etag,
    },
  });
  assert.strictEqual(payload304Res.status, 304, 'unchanged share payload should support 304 validation');

  const assetRes = await request('GET', storedAttachment.url);
  assert.strictEqual(assetRes.status, 200, 'public share attachment should load without auth');
  assert.strictEqual(assetRes.headers['cache-control'], 'public, no-cache, max-age=0, must-revalidate', 'share asset should require validator rechecks');
  assert.ok(assetRes.headers.etag, 'share asset should expose an ETag');
  assert.strictEqual(assetRes.headers['content-type'], 'image/png', 'share asset should retain its attachment MIME type');
  assert.match(assetRes.headers['content-disposition'] || '', /^inline; filename="inline\.png"; filename\*=UTF-8''/u, 'public share previews should preserve the original filename');
  assert.ok(assetRes.buffer.length > 0, 'share asset should return binary content');
  const assetDownloadRes = await request('GET', `${storedAttachment.url}?download=1`);
  assert.strictEqual(assetDownloadRes.status, 200, 'public share attachment download should work without auth');
  assert.match(assetDownloadRes.headers['content-disposition'] || '', /^attachment; filename="inline\.png"; filename\*=UTF-8''/u, 'public share downloads should request an attachment filename');
  const asset304Res = await request('GET', storedAttachment.url, {
    headers: {
      'If-None-Match': assetRes.headers.etag,
    },
  });
  assert.strictEqual(asset304Res.status, 304, 'unchanged share asset should support 304 validation');

  const legacyShareId = `snap_${'a'.repeat(48)}`;
  const legacySharePath = join(configDir, 'shared-snapshots', `${legacyShareId}.json`);
  writeFileSync(legacySharePath, JSON.stringify({
    version: 1,
    id: legacyShareId,
    createdAt: new Date(0).toISOString(),
    session: {
      name: 'Legacy attachment share',
      tool: 'codex',
      created: new Date(0).toISOString(),
    },
    events: [{
      type: 'message',
      id: 'evt_legacy_001',
      timestamp: 1,
      role: 'user',
      content: 'Legacy attachment body',
      images: [{
        filename: 'legacy-inline.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0WQAAAAASUVORK5CYII=',
      }],
    }],
    view: { mode: 'share' },
  }, null, 2), 'utf8');
  const legacyShareRes = await request('GET', `/share/${legacyShareId}`);
  assert.strictEqual(legacyShareRes.status, 200, 'legacy inline-data shares should still load');
  const migratedLegacySnapshot = JSON.parse(readFileSync(legacySharePath, 'utf8'));
  const migratedLegacyAttachment = migratedLegacySnapshot.events[0].images[0];
  assert.match(migratedLegacyAttachment.assetId || '', /^asset_[a-f0-9]{24}$/, 'legacy inline shares should migrate to external assets');
  assert.equal(migratedLegacyAttachment.url, `../share-asset/${legacyShareId}/${migratedLegacyAttachment.assetId}`, 'legacy inline shares should gain relative public asset URLs');
  assert.ok(!('data' in migratedLegacyAttachment), 'legacy inline shares should drop embedded base64 after migration');
  assert.ok(existsSync(join(configDir, 'shared-snapshots', `${legacyShareId}.assets`, migratedLegacyAttachment.assetId)), 'legacy migration should materialize asset files');

  rmSync(snapshotPath, { force: true });
  rmSync(join(configDir, 'shared-snapshots', `${shareId}.assets`), { recursive: true, force: true });
  const deletedShareRes = await request('GET', sharePayload.share.url, {
    headers: {
      'If-None-Match': publicShareRes.headers.etag,
    },
  });
  assert.strictEqual(deletedShareRes.status, 404, 'deleted shares should return 404 instead of reusing a cached shell');
  const deletedPayloadRes = await request('GET', `/share-payload/${shareId}.js`, {
    headers: {
      'If-None-Match': payloadRes.headers.etag,
    },
  });
  assert.strictEqual(deletedPayloadRes.status, 404, 'deleted share payloads should return 404 instead of 304');
  const deletedAssetRes = await request('GET', storedAttachment.url, {
    headers: {
      'If-None-Match': assetRes.headers.etag,
    },
  });
  assert.strictEqual(deletedAssetRes.status, 404, 'deleted share assets should return 404 instead of 304');

  const unauthenticatedRemovedRouteRes = await request('GET', `/capture/${session.id}`);
  assert.strictEqual(unauthenticatedRemovedRouteRes.status, 302, 'unknown owner routes should still require auth');

  const removedRouteRes = await request('GET', `/capture/${session.id}`, {
    headers: { Cookie: cookie },
  });
  assert.strictEqual(removedRouteRes.status, 404, 'capture route should be removed for authenticated owners');

  const missingRes = await request('GET', '/share/snap_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.strictEqual(missingRes.status, 404, 'missing share should return 404');

  console.log('✅ Share snapshot flow validated');
}

main()
  .catch((err) => {
    console.error('❌ Share snapshot test failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    rmSync(tempRoot, { recursive: true, force: true });
  });

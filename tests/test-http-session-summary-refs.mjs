#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 36400 + Math.floor(Math.random() * 4000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-session-summary-refs-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });

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

  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const created = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'codex',
      name: 'Summary refs session',
      group: 'HTTP',
      description: 'Refs and summary cache contract',
    });
    assert.equal(created.status, 201, 'session creation should succeed');
    const sessionId = created.json.session.id;

    const list = await request(port, 'GET', '/api/sessions');
    assert.equal(list.status, 200, 'default session list should succeed');
    const listSession = (list.json.sessions || []).find((entry) => entry.id === sessionId);
    assert.ok(listSession, 'default session list should include the created session payload');

    const refs = await request(port, 'GET', '/api/sessions?view=refs');
    assert.equal(refs.status, 200, 'refs-only session list should succeed');
    assert.equal(Array.isArray(refs.json.sessions), false, 'refs-only session list should omit full session payloads');
    const ref = (refs.json.sessionRefs || []).find((entry) => entry.id === sessionId);
    assert.ok(ref, 'refs-only session list should include the created session ref');
    assert.equal(typeof ref.summaryEtag, 'string', 'session refs should expose a summary etag');

    const summary = await request(port, 'GET', `/api/sessions/${sessionId}?view=summary`);
    assert.equal(summary.status, 200, 'summary session route should succeed');
    assert.equal(summary.headers.etag, ref.summaryEtag, 'summary route ETag should match the list ref tag');
    assert.equal(
      Object.prototype.hasOwnProperty.call(summary.json?.session || {}, 'task'),
      false,
      'summary route should omit legacy task metadata',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(summary.json.session, 'queuedMessages'),
      false,
      'summary route should omit queuedMessages',
    );

    const detail = await request(port, 'GET', `/api/sessions/${sessionId}`);
    assert.equal(detail.status, 200, 'detail session route should still succeed');
    assert.equal(
      Object.prototype.hasOwnProperty.call(detail.json?.session || {}, 'task'),
      false,
      'detail route should omit legacy task metadata',
    );
    assert.equal(Array.isArray(detail.json.session.queuedMessages), true, 'detail route should keep queuedMessages for the attached session view');

    const summary304 = await request(port, 'GET', `/api/sessions/${sessionId}?view=summary`, null, {
      'If-None-Match': ref.summaryEtag,
    });
    assert.equal(summary304.status, 304, 'unchanged summary route should revalidate to 304');

    const list304 = await request(port, 'GET', '/api/sessions', null, { 'If-None-Match': list.headers.etag });
    assert.equal(list304.status, 304, 'an unchanged prepared list keeps its ETag');
    const allEvents = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all`);
    const cursor = Math.max(0, ...allEvents.json.events.map(e => e.seq));
    const tail = await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all&afterSeq=${cursor}`);
    assert.equal(tail.status, 200);
    assert.deepEqual(tail.json.events, [], 'the HTTP route honors the cursor instead of returning the full history');
    assert.equal(tail.json.hasMore, false);
    assert.equal((await request(port, 'GET', `/api/sessions/${sessionId}/events?filter=all&afterSeq=-1`)).status, 400);
    const renamed = await request(port, 'PATCH', `/api/sessions/${sessionId}`, { name: 'Changed via HTTP' });
    assert.equal(renamed.status, 200);
    const afterRename = await request(port, 'GET', '/api/sessions');
    assert.equal(afterRename.json.sessions.find(s => s.id === sessionId).name, 'Changed via HTTP');

    // A CLI may edit the metadata file without this process broadcasting a hint.
    const metadataFile = join(home, '.config', 'remotelab', 'chat-sessions.json');
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    metadata.find(s => s.id === sessionId).name = 'Changed by another process';
    writeFileSync(metadataFile, JSON.stringify(metadata));
    const externalChange = await request(port, 'GET', '/api/sessions');
    assert.equal(externalChange.json.sessions.find(s => s.id === sessionId).name, 'Changed by another process',
      'prepared lists immediately detect external metadata writes');

    const archived = await request(port, 'PATCH', `/api/sessions/${sessionId}`, { archived: true });
    assert.equal(archived.status, 200);
    const afterArchive = await request(port, 'GET', '/api/sessions');
    assert.ok(!afterArchive.json.sessions.some(s => s.id === sessionId));
    assert.ok(afterArchive.json.archivedCount > 0);
    const archiveList = await request(port, 'GET', '/api/sessions/archived');
    assert.ok(archiveList.json.sessions.some(s => s.id === sessionId));

    console.log('test-http-session-summary-refs: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

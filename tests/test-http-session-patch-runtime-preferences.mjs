#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-session-patch-'));
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

async function createSession(port, name) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'codex',
    name,
    group: 'Runtime patch',
  });
  assert.equal(res.status, 201, 'session creation should succeed');
  return res.json.session;
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const older = await createSession(port, 'Older session');
    await sleep(25);
    const newer = await createSession(port, 'Newer session');
    const reviewStamp = '2026-03-15T08:09:10.000Z';

    const patched = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      pinned: true,
      workflowState: 'waiting-user',
      workflowPriority: 'urgent',
      tool: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      thinking: true,
      lastReviewedAt: reviewStamp,
    });
    assert.equal(patched.status, 200, 'PATCH should accept pinned and runtime preference fields together');
    assert.equal(patched.json.session?.id, older.id, 'PATCH should return the updated session');
    assert.equal(patched.json.session?.pinned, true, 'PATCH should persist the pinned flag');
    assert.equal(patched.json.session?.workflowState, 'waiting_user', 'PATCH should persist the normalized workflow state');
    assert.equal(patched.json.session?.workflowPriority, 'high', 'PATCH should persist the normalized workflow priority');
    assert.equal(patched.json.session?.tool, 'codex', 'PATCH should persist the tool');
    assert.equal(patched.json.session?.model, 'gpt-6-astra', 'PATCH should persist the model');
    assert.equal(patched.json.session?.effort, 'high', 'PATCH should persist the effort');
    assert.equal(patched.json.session?.thinking, true, 'PATCH should persist the thinking flag');
    assert.equal(patched.json.session?.lastReviewedAt, reviewStamp, 'PATCH should persist the session review timestamp');

    const newest = await createSession(port, 'Newest session');
    const listAfterPin = await request(port, 'GET', '/api/sessions');
    assert.equal(listAfterPin.status, 200, 'listing sessions should succeed after the combined patch');
    assert.deepEqual(
      listAfterPin.json.sessions.slice(0, 3).map((session) => session.id),
      [older.id, newest.id, newer.id],
      'pinned sessions should stay ahead of newer unpinned sessions after runtime preference updates',
    );
    const pinnedListEntry = listAfterPin.json.sessions.find((session) => session.id === older.id);
    assert.equal(pinnedListEntry?.workflowState, 'waiting_user', 'session list payload should keep workflow state for session attention logic');
    assert.equal(pinnedListEntry?.workflowPriority, 'high', 'session list payload should keep workflow priority for session attention logic');
    assert.equal(pinnedListEntry?.lastReviewedAt, reviewStamp, 'session list payload should expose the persisted review timestamp');

    const detail = await request(port, 'GET', `/api/sessions/${older.id}`);
    assert.equal(detail.status, 200, 'session detail should remain readable after the patch');
    assert.equal(detail.json.session?.thinking, true, 'detail should expose persisted thinking');
    assert.equal(detail.json.session?.model, 'gpt-6-astra', 'detail should expose persisted model');
    assert.equal(detail.json.session?.workflowState, 'waiting_user', 'detail should expose persisted workflow state');
    assert.equal(detail.json.session?.workflowPriority, 'high', 'detail should expose persisted workflow priority');
    assert.equal(detail.json.session?.lastReviewedAt, reviewStamp, 'detail should expose the persisted review timestamp');

    const invalidPinned = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      pinned: 'yes',
    });
    assert.equal(invalidPinned.status, 400, 'invalid pinned values should be rejected');

    const invalidThinking = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      thinking: 'maybe',
    });
    assert.equal(invalidThinking.status, 400, 'invalid thinking values should be rejected');

    const invalidWorkflowState = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      workflowState: 'running',
    });
    assert.equal(invalidWorkflowState.status, 400, 'invalid workflow states should be rejected');

    const invalidWorkflowPriority = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      workflowPriority: 'rush',
    });
    assert.equal(invalidWorkflowPriority.status, 400, 'invalid workflow priorities should be rejected');

    const invalidReviewStamp = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      lastReviewedAt: 'not-a-date',
    });
    assert.equal(invalidReviewStamp.status, 400, 'invalid review timestamps should be rejected');

    const unpinned = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      pinned: false,
      workflowState: null,
      workflowPriority: null,
      lastReviewedAt: null,
    });
    assert.equal(unpinned.status, 200, 'unpinned PATCH should still succeed');
    assert.equal(unpinned.json.session?.pinned, undefined, 'unpinned PATCH should clear the pinned flag');
    assert.equal(unpinned.json.session?.workflowState, undefined, 'workflowState should clear when PATCH passes null');
    assert.equal(unpinned.json.session?.workflowPriority, undefined, 'workflowPriority should clear when PATCH passes null');
    assert.equal(unpinned.json.session?.lastReviewedAt, undefined, 'lastReviewedAt should clear when PATCH passes null');

    const listAfterUnpin = await request(port, 'GET', '/api/sessions');
    assert.equal(listAfterUnpin.status, 200, 'listing sessions should still work after unpinning');
    assert.deepEqual(
      listAfterUnpin.json.sessions.slice(0, 3).map((session) => session.id),
      [newest.id, older.id, newer.id],
      'after unpinning, normal recency ordering should resume',
    );

    const staleModelPatch = await request(port, 'PATCH', `/api/sessions/${older.id}`, {
      tool: 'codex',
      model: 'gpt-5.4',
      effort: 'xhigh',
    });
    assert.equal(staleModelPatch.status, 200, 'PATCH should accept stale Codex models by upgrading them');
    assert.equal(
      staleModelPatch.json.session?.model,
      'gpt-6-astra',
      'stale Codex session preferences should upgrade to the product default model',
    );
    assert.equal(staleModelPatch.json.session?.effort, 'xhigh', 'model upgrade should preserve the requested effort');

    console.log('test-http-session-patch-runtime-preferences: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

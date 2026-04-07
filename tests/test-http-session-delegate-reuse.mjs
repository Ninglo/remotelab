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

function randomPort() {
  return 35000 + Math.floor(Math.random() * 4000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-delegate-reuse-'));
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
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Triaged inside delegated child.' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 80);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const configDir = join(home, '.config', 'remotelab');
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      REMOTELAB_INSTANCE_ROOT: '',
      REMOTELAB_CONFIG_DIR: configDir,
      SECURE_COOKIES: '0',
      PATH: `${join(home, '.local', 'bin')}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitFor(
      () => stdout.includes(`Chat server listening on http://127.0.0.1:${port}`),
      'server startup',
      30000,
    );
  } catch (error) {
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null, 'server shutdown after startup failure');
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

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
    tool: 'fake-codex',
    name,
    group: 'Tests',
    description: 'Delegate reuse integration',
  });
  assert.equal(res.status, 201);
  return res.json.session;
}

async function delegateSession(port, sessionId, task) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/delegate`, {
    task,
    tool: 'fake-codex',
  });
  assert.equal(res.status, 201);
  return res.json;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

async function listSessions(port) {
  const res = await request(port, 'GET', '/api/sessions');
  assert.equal(res.status, 200);
  return res.json.sessions || [];
}

async function getEvents(port, sessionId) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
  assert.equal(res.status, 200);
  return res.json.events || [];
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const source = await createSession(port, 'Delegation reuse source');

    const firstTask = 'Create a new independent bug workflow for session delegation recursion. Do not merge into existing issue threads.';
    const secondTask = 'Continue this as the sole independent bug workflow for session delegation recursion, and do not merge into existing issue threads.';

    const first = await delegateSession(port, source.id, firstTask);
    assert.ok(first.session?.id, 'first delegation should return a child session');
    assert.ok(first.run?.id, 'first delegation should launch the child run');
    await waitForRunTerminal(port, first.run.id);

    const second = await delegateSession(port, source.id, secondTask);
    assert.equal(second.session?.id, first.session.id, 'equivalent wording should reuse the existing delegated child');

    const sessions = await listSessions(port);
    assert.equal(sessions.filter((session) => !session.archived).length, 2, 'source + one delegated child should remain visible');

    const events = await getEvents(port, source.id);
    const delegationEvents = events.filter((event) => event.type === 'context_operation' && event.operation === 'delegate_session');
    assert.equal(delegationEvents.length, 1, 'reused delegation should not append a second visible delegation operation');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-session-delegate-reuse: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

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
  return 39000 + Math.floor(Math.random() * 2000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-planning-accept-'));
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
    item: { type: 'agent_message', text: 'finished from fake codex' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 120);
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
      REMOTELAB_SESSION_DISPATCH: 'on',
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
  await sleep(150);
}

async function createSession(port, name) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group: 'Tests',
    description: 'Planning acceptance integration',
  });
  assert.equal(res.status, 201);
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
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, 'Planning acceptance');
    const requestId = 'req-planning-accept';
    const res = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId,
      text: 'Please investigate the workflow design problem before you answer.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });

    assert.equal(res.status, 202, 'accepted planning route should still return 202');
    assert.equal(res.json.requestId, requestId, 'accepted planning response should preserve requestId');
    assert.equal(res.json.queued, false, 'accepted planning response should not masquerade as queued');
    assert.equal(res.json.run, null, 'accepted planning response should not create a run synchronously');
    assert.equal(res.json.session?.activity?.planning?.state, 'checking', 'session activity should expose planning/checking');
    assert.equal(res.json.session?.activity?.planning?.requestId, requestId, 'planning activity should expose the active requestId');

    const detailWithRun = await waitFor(async () => {
      const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
      if (detail.status !== 200) return false;
      const runId = detail.json?.session?.activity?.run?.runId;
      if (!runId) return false;
      return detail.json.session;
    }, 'planning acceptance to promote into a live run');

    assert.equal(detailWithRun.activity?.run?.state, 'running', 'live run should eventually start after planning');
    assert.ok(detailWithRun.activity?.run?.runId, 'live run should expose a run id after planning');

    const detailAfterPlanning = await waitFor(async () => {
      const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
      if (detail.status !== 200) return false;
      return detail.json?.session?.activity?.planning?.state === 'idle'
        ? detail.json.session
        : false;
    }, 'planning state to clear after live run acceptance');

    assert.equal(detailAfterPlanning.activity?.planning?.state, 'idle', 'planning state should eventually clear after acceptance');

    const run = await waitForRunTerminal(port, detailWithRun.activity.run.runId);
    assert.equal(run.requestId, requestId, 'run should keep the original requestId through planning');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-message-planning-acceptance: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

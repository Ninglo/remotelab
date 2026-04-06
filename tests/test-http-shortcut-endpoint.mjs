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
const ownerToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function randomPort() {
  return 35000 + Math.floor(Math.random() * 5000);
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
        Authorization: `Bearer ${ownerToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-shortcut-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: ownerToken }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({}, null, 2),
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
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '800');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-shortcut-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'echo shortcut', aggregated_output: 'shortcut', exit_code: 0, status: 'completed' }
  }));
}, Math.max(40, Math.floor(delay / 3)));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'finished from fake codex' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, delay);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port, delayMs = 800 }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      FAKE_CODEX_DELAY_MS: String(delayMs),
      REMOTELAB_REPLY_SELF_CHECK: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

let tempHome = null;
let server = null;

try {
  tempHome = setupTempHome();
  const port = randomPort();
  server = await startServer({ home: tempHome.home, port, delayMs: 800 });

  const completed = await request(port, 'POST', '/api/shortcut', {
    text: 'Run through the shortcut flow.',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    waitMs: 2000,
    shortcutName: 'Quick Ask',
    inputMode: 'voice',
    externalTriggerId: 'shortcut:test:thread',
  });
  assert.equal(completed.status, 200, 'shortcut endpoint should accept bearer-authenticated requests');
  assert.equal(completed.json.status, 'completed', 'fast shortcut request should complete inline');
  assert.equal(completed.json.reply, 'finished from fake codex', 'completed shortcut response should include the assistant reply');
  assert.equal(completed.json.speech, 'finished from fake codex', 'shortcut response should expose a speech-friendly alias');
  assert.ok(completed.json.sessionId, 'completed shortcut response should include the session id');
  assert.ok(completed.json.runId, 'completed shortcut response should include the run id');

  const sessionDetail = await request(port, 'GET', `/api/sessions/${completed.json.sessionId}`);
  assert.equal(sessionDetail.status, 200, 'created shortcut session should be readable');
  assert.equal(sessionDetail.json.session?.sourceId, 'shortcut', 'shortcut session should persist the connector source id');
  assert.equal(sessionDetail.json.session?.sourceName, 'Shortcut', 'shortcut session should persist the connector source name');

  const sourceContext = await request(port, 'GET', `/api/sessions/${completed.json.sessionId}/source-context`);
  assert.equal(sourceContext.status, 200, 'shortcut source context should be readable');
  assert.equal(sourceContext.json.sourceContext?.session?.channel, 'shortcut', 'shortcut session should store session-level source context');
  assert.equal(sourceContext.json.sourceContext?.session?.shortcutName, 'Quick Ask', 'shortcut session context should keep the shortcut name');
  assert.equal(sourceContext.json.sourceContext?.session?.inputMode, 'voice', 'shortcut session context should keep the input mode');
  assert.equal(sourceContext.json.sourceContext?.message?.channel, 'shortcut', 'shortcut request should also store message-level source context');

  const pending = await request(port, 'POST', '/api/shortcut', {
    text: 'Reuse the shortcut session, but do not wait for completion.',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    waitMs: 10,
    externalTriggerId: 'shortcut:test:thread',
    requestId: 'shortcut:test:pending',
  });
  assert.equal(pending.status, 200, 'shortcut timeout response should still return JSON');
  assert.equal(pending.json.status, 'pending', 'slow shortcut request should downgrade to pending');
  assert.equal(pending.json.sessionId, completed.json.sessionId, 'externalTriggerId should reuse the existing shortcut session');
  assert.ok(pending.json.runId, 'pending shortcut response should still return the run id');
  assert.match(String(pending.json.runState || ''), /^(accepted|running)?$/, 'pending shortcut response should expose the live run state when available');

  const terminalRun = await waitForRunTerminal(port, pending.json.runId);
  assert.equal(terminalRun.state, 'completed', 'pending shortcut run should still finish in the background');

  console.log('test-http-shortcut-endpoint: ok');
} catch (error) {
  if (server) {
    console.error('[debug] chat-server stdout:', server.getStdout());
    console.error('[debug] chat-server stderr:', server.getStderr());
  }
  throw error;
} finally {
  await stopServer(server);
  if (tempHome?.home) {
    rmSync(tempHome.home, { recursive: true, force: true });
  }
}

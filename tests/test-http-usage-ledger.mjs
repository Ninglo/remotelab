#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 36000 + Math.floor(Math.random() * 8000);
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

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-usage-ledger-'));
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
        id: 'fake-claude',
        name: 'Fake Claude',
        command: 'fake-claude',
        runtimeFamily: 'claude-stream-json',
        models: [{ id: 'fake-sonnet', label: 'Fake Sonnet' }],
        reasoning: { kind: 'toggle', label: 'Thinking' },
      },
    ], null, 2),
    'utf8',
  );

  writeFileSync(
    join(localBin, 'fake-claude'),
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-ledger-test' }));
console.log(JSON.stringify({
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'usage ledger ok' }],
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 450
    }
  }
}));
console.log(JSON.stringify({
  type: 'result',
  cost_usd: 0.012345,
  usage: {
    input_tokens: 1200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 450,
    output_tokens: 80
  }
}));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-claude'), 0o755);

  return { home, configDir };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
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

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-claude',
    name: 'Usage Ledger HTTP Test',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

async function main() {
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  let serverStopped = false;

  try {
    const session = await createSession(port);
    const sendRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      text: 'Track this usage.',
      model: 'fake-sonnet',
    });
    assert.equal(sendRes.status, 202, 'message submit should start a run');
    const runId = sendRes.json?.run?.id;
    assert.ok(runId, 'message submit should return a run id');

    const run = await waitForRunTerminal(port, runId);
    assert.equal(run.state, 'completed', 'fake claude run should complete');

    const summary = await waitFor(async () => {
      const res = await request(port, 'GET', '/api/usage/summary?days=1&top=5');
      if (res.status !== 200) return false;
      if ((res.json?.runCount || 0) < 1) return false;
      return res.json;
    }, 'usage ledger summary');

    assert.equal(summary.runCount, 1, 'completed run should be recorded in the usage ledger');
    assert.equal(summary.totals.inputTokens, 1200, 'summary should preserve provider input tokens');
    assert.equal(summary.totals.outputTokens, 80, 'summary should preserve provider output tokens');
    assert.equal(summary.totals.totalTokens, 1280, 'summary should expose input + output totals');
    assert.equal(summary.totals.costUsd, 0.012345, 'summary should preserve provider cost');
    assert.equal(summary.byTool[0].key, 'fake-claude', 'tool breakdown should include the session tool');
    assert.equal(summary.byOperation[0].key, 'user_turn', 'normal chat runs should be tagged as user turns');
    assert.equal(summary.topRuns[0].contextTokens, 1950, 'top runs should expose latest live context');

    const ledgerDir = join(configDir, 'usage-ledger');
    assert.equal(existsSync(ledgerDir), true, 'usage ledger directory should be created');

    await stopServer(server);
    serverStopped = true;

    const ledgerFiles = readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl'));
    assert.ok(ledgerFiles.length >= 1, 'usage ledger should flush to at least one daily JSONL file');

    console.log('test-http-usage-ledger: ok');
  } finally {
    if (!serverStopped) {
      await stopServer(server);
    }
    rmSync(home, { recursive: true, force: true });
  }
}

await main();

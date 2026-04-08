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
const outputName = 'March report.xlsx';
const outputContent = 'local-link-rewriter-output';

function randomPort() {
  return 42000 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(buffer, chunk, limit = 8000) {
  const next = `${buffer}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function formatStartupOutput(stdout, stderr) {
  const sections = [];
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  return sections.join('\n\n');
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-local-link-rewriter-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  const exportDir = join(home, 'exports');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(exportDir, { recursive: true });

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

  const outputPath = join(exportDir, outputName);
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('fs');
const { dirname } = require('path');
const outputPath = ${JSON.stringify(outputPath)};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, ${JSON.stringify(outputContent)}, 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-local-link-rewriter' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: 'Download it here: [${outputName}](' + outputPath + ')'
  }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir };
}

async function startServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_INSTANCE_ROOT: '',
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
      SECURE_COOKIES: '0',
      REMOTELAB_ASSET_STORAGE_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PROVIDER: '',
      REMOTELAB_ASSET_STORAGE_REGION: '',
      REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: '',
      REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        const output = formatStartupOutput(stdout, stderr);
        throw new Error(
          output
            ? `Server exited during startup with ${exitLabel}\n\n${output}`
            : `Server exited during startup with ${exitLabel}`,
        );
      }
      try {
        const res = await request(port, 'GET', '/login', null, { Cookie: '' });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) {
      throw error;
    }
    throw new Error(`${error.message}\n\n${output}`);
  }

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
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  const chatServer = await startServer({ home, configDir, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Local link rewrite',
      systemPrompt: 'Return the generated file to the user.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-local-link-rewriter',
      text: 'Generate a spreadsheet and return it.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');

    const run = await waitForRunTerminal(port, messageRes.json.run.id);
    assert.equal(run.state, 'completed', 'run should complete');

    const allEventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
    assert.equal(allEventsRes.status, 200, 'all-events route should load');
    const rawAssistant = allEventsRes.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(rawAssistant, 'raw event history should include the assistant message');
    assert.match(rawAssistant.content, /\[March report\.xlsx\]\(.+exports\/March report\.xlsx\)/, 'raw history should preserve the original local path');

    const visibleEventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`);
      if (res.status !== 200) return false;
      const assistant = res.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
      return assistant ? { res, assistant } : false;
    }, 'visible assistant message');
    const visibleAssistant = visibleEventsRes.assistant;
    assert.match(
      visibleAssistant.content,
      /\[March report\.xlsx\]\(\/api\/assets\/(fasset_[a-f0-9]{24})\/download\)/,
      'visible assistant content should rewrite the local path to a downloadable asset URL',
    );
    assert.doesNotMatch(
      visibleAssistant.content,
      /exports\/March report\.xlsx/,
      'visible assistant content should not leak the host-local export path',
    );

    const secondVisibleEventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`);
    assert.equal(secondVisibleEventsRes.status, 200, 'visible-events route should remain readable on repeat fetches');
    const secondVisibleAssistant = secondVisibleEventsRes.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
    assert.equal(
      secondVisibleAssistant?.content,
      visibleAssistant.content,
      'repeated visible fetches should reuse the same rewritten download URL instead of creating duplicates',
    );

    const assetIdMatch = visibleAssistant.content.match(/\/api\/assets\/(fasset_[a-f0-9]{24})\/download/);
    assert.ok(assetIdMatch, 'rewritten content should expose a downloadable asset id');
    const assetId = assetIdMatch[1];

    const assetRes = await request(port, 'GET', `/api/assets/${assetId}`);
    assert.equal(assetRes.status, 200, 'rewritten asset metadata should load');
    assert.equal(assetRes.json.asset.originalName, outputName, 'rewritten asset should preserve the original file name');

    const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${assetId}/download?download=1`, {
      method: 'GET',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(downloadRes.status, 200, 'rewritten asset should be downloadable');
    assert.equal(await downloadRes.text(), outputContent, 'rewritten asset download should return the generated file');

    const rawAfterVisibleRes = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
    assert.equal(rawAfterVisibleRes.status, 200, 'all-events route should still load after rewrite-on-read');
    const rawAfterVisibleAssistant = rawAfterVisibleRes.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
    assert.equal(
      rawAfterVisibleAssistant?.content,
      rawAssistant.content,
      'rewrite-on-read should not mutate the stored assistant history payload',
    );
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-local-link-rewriter: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

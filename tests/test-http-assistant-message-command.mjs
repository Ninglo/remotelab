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
const expectedOutputs = [
  {
    name: 'preview.svg',
    content: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#7c3aed"/></svg>',
    mimeType: 'image/svg+xml',
  },
  {
    name: 'notes.txt',
    content: 'generated-notes-ready',
    mimeType: 'text/plain',
  },
];

function randomPort() {
  return 40000 + Math.floor(Math.random() * 2000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-assistant-message-command-'));
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
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const outputs = ${JSON.stringify(expectedOutputs)};
const outputDir = join(process.env.HOME, 'exports');
mkdirSync(outputDir, { recursive: true });
for (const output of outputs) {
  writeFileSync(join(outputDir, output.name), output.content, 'utf8');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-assistant-message-command' }));
console.log(JSON.stringify({ type: 'turn.started' }));
outputs.forEach((output) => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'node export.js --out "' + output.name + '"',
      aggregated_output: 'Generated output -> ' + output.name,
      exit_code: 0,
      status: 'completed'
    }
  }));
});
execFileSync(process.execPath, [
  join(process.env.REMOTELAB_PROJECT_ROOT, 'cli.js'),
  'assistant-message',
  '--text',
  'Generated files attached.',
  '--file',
  join(outputDir, outputs[0].name),
  '--file',
  join(outputDir, outputs[1].name),
  '--json'
], {
  env: process.env,
  stdio: 'ignore',
});
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'done' }
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
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

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/tools');
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
  const chatServer = await startServer({ home, port });

  try {
    const createSessionRes = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Assistant attachment command',
      systemPrompt: 'Use the runtime helper when returning generated local files.',
    });
    assert.equal(createSessionRes.status, 201, 'session should be created');
    const session = createSessionRes.json.session;

    const messageRes = await request(port, 'POST', `/api/sessions/${session.id}/messages`, {
      requestId: 'req-assistant-message-command',
      text: 'Generate local files and return them through the assistant attachment helper.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.ok(messageRes.status === 200 || messageRes.status === 202, 'message should be accepted');
    assert.ok(messageRes.json?.run?.id, 'message should create a run');

    const run = await waitForRunTerminal(port, messageRes.json.run.id);
    assert.equal(run.state, 'completed', 'run should complete');

    const resultMessage = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
      if (res.status !== 200) return false;
      const events = res.json?.events || [];
      const generated = events.find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'assistant_message_command'
        && event.runId === run.id
      ));
      return generated ? { generated, events } : false;
    }, 'assistant attachment helper result message');

    const generated = resultMessage.generated;
    assert.equal(generated.content, 'Generated files attached.', 'assistant helper should preserve the supplied text');
    assert.equal(generated.attachments?.length, expectedOutputs.length, 'assistant helper message should expose every attachment');
    assert.equal(generated.images?.length, expectedOutputs.length, 'assistant helper should preserve the legacy images alias');
    assert.deepEqual(generated.attachments.map((attachment) => attachment.originalName), expectedOutputs.map((output) => output.name), 'assistant helper should preserve each published file name');
    assert.deepEqual(generated.attachments.map((attachment) => attachment.mimeType), expectedOutputs.map((output) => output.mimeType), 'assistant helper should preserve each mime type');
    assert.deepEqual(generated.attachments.map((attachment) => attachment.sizeBytes), expectedOutputs.map((output) => Buffer.byteLength(output.content, 'utf8')), 'assistant helper should preserve each file size');
    assert.ok(generated.attachments.every((attachment) => typeof attachment.assetId === 'string' && attachment.assetId), 'assistant helper should publish attachments as file assets');

    const duplicateGenerated = resultMessage.events.find((event) => (
      event.type === 'message'
      && event.role === 'assistant'
      && event.source === 'result_file_assets'
      && event.resultRunId === run.id
    ));
    assert.equal(duplicateGenerated, undefined, 'helper-delivered attachments should suppress the fallback generated-files message');

    const finalAssistant = resultMessage.events.find((event) => event.type === 'message' && event.role === 'assistant' && event.content === 'done');
    assert.ok(finalAssistant, 'original assistant completion message should still be present');

    for (const [index, attachment] of generated.attachments.entries()) {
      const assetRes = await request(port, 'GET', `/api/assets/${attachment.assetId}`);
      assert.equal(assetRes.status, 200, 'published helper asset metadata should load');
      assert.equal(assetRes.json.asset.originalName, expectedOutputs[index].name, 'published helper asset should keep the original file name');

      const downloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${attachment.assetId}/download`, {
        method: 'GET',
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(downloadRes.status, 200, 'download route should stream the helper-published local file asset');
      assert.equal(await downloadRes.text(), expectedOutputs[index].content, 'download route should return the helper-published file content');
    }
  } finally {
    await stopServer(chatServer);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-assistant-message-command: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}

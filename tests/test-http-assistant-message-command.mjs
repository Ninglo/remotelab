#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { once } from 'node:events';

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
      'test-service': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner', authKind: 'service' },
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
      REMOTELAB_ASSET_STORAGE_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL: '',
      REMOTELAB_ASSET_STORAGE_PROVIDER: '',
      REMOTELAB_ASSET_STORAGE_REGION: '',
      REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: '',
      REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: '',
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

    const task = { taskId: 'http-task', revision: 1, goal: 'HTTP 清单验收', status: 'running', reason: '',
      items: [{ id: 'files', title: '文件', condition: '附件可下载', status: 'pending', evidenceRefs: [] },
        { id: 'reply', title: '答复', condition: '正文已生成', status: 'pending', evidenceRefs: [] }] };
    const boardPath = `/api/sessions/${session.id}/assistant-messages`;
    const initial = await request(port, 'POST', boardPath, { workboard: task, runId: run.id });
    assert.equal(initial.status, 201, JSON.stringify(initial.json)); assert.equal(initial.json.event.source, 'workboard_checklist');
    assert.equal(initial.json.event.workboard.taskId, task.taskId);
    const unsupported = await request(port, 'POST', boardPath, { workboard: { ...task, revision: 2,
      items: task.items.map(item => ({ ...item, status: 'done' })) }, runId: run.id });
    assert.equal(unsupported.status, 400, 'unchecked evidence cannot produce a done card');
    const verified = { ...task, revision: 2, status: 'completed',
      items: task.items.map(item => ({ ...item, status: 'done', evidenceRefs: [generated.seq] })) };
    const update = await request(port, 'POST', boardPath, { workboard: verified, runId: run.id });
    assert.equal(update.status, 201);
    const replay = await request(port, 'POST', boardPath, { workboard: verified, runId: run.id });
    assert.equal(replay.json.event.seq, update.json.event.seq, 'same revision retry returns the original event');
    const competing = await Promise.all(['权限', '输入'].map(reason => request(port, 'POST', boardPath, {
      workboard: { ...verified, revision: 3, status: 'blocked', reason }, runId: 'continued-run',
    })));
    assert.deepEqual(competing.map(value => value.status).sort(), [201, 409], 'concurrent conflicting revisions are serialized');
    const snapshotFile = join(home, 'workboard.json');
    writeFileSync(snapshotFile, JSON.stringify({ ...verified, revision: 4, status: 'running' }));
    const cli = spawn(process.execPath, ['cli.js', 'assistant-message', '--workboard-file', snapshotFile,
      '--session', session.id, '--run-id', 'continued-run', '--base-url', `http://127.0.0.1:${port}`, '--json'], {
      cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cliOutput = '', cliError = '';
    cli.stdout.on('data', value => { cliOutput += value; });
    cli.stderr.on('data', value => { cliError += value; });
    assert.equal((await once(cli, 'exit'))[0], 0, cliError);
    assert.equal(JSON.parse(cliOutput).event.workboard.revision, 4, 'CLI reaches the same validated HTTP contract');

    const patchTask = { ...task, taskId: 'http-patch-task', goal: '增量清单验收' };
    assert.equal((await request(port, 'POST', boardPath, { workboard: patchTask, runId: run.id })).status, 201);
    const patch = items => ({ workboardPatch: { taskId: patchTask.taskId, items }, runId: run.id });
    assert.equal((await request(port, 'POST', boardPath, patch([{ id: 'files', status: 'done' }]))).status, 400);
    const deltas = patchTask.items.map(item => ({ id: item.id, status: 'done', evidenceRefs: [generated.seq] }));
    const merged = await Promise.all(deltas.map(item => request(port, 'POST', boardPath, patch([item]))));
    assert.ok(merged.every(result => result.status === 201), JSON.stringify(merged.map(result => result.json)));
    const readback = await request(port, 'GET', `/api/sessions/${session.id}/workboards?taskId=${patchTask.taskId}`);
    assert.equal(readback.json.task.revision, 3);
    assert.ok(readback.json.task.items.every(item => item.status === 'done'), 'concurrent deltas preserve each other');
    assert.equal(readback.json.session, undefined, 'readback excludes unrelated Session metadata');
    const replayPatch = await request(port, 'POST', boardPath, patch([deltas[1]]));
    assert.equal(replayPatch.json.event.workboard.revision, 3, 'retrying a merged delta adds no revision');
    assert.equal((await request(port, 'POST', boardPath, {
      workboardPatch: { taskId: patchTask.taskId, expectedRevision: 1, status: 'completed' },
    })).status, 409);
    const command = spawn(process.execPath, ['cli.js', 'workboard', 'update', '--task', patchTask.taskId,
      '--task-status', 'completed', '--session', session.id, '--run-id', 'continued-run',
      '--base-url', `http://127.0.0.1:${port}`, '--json'], {
      cwd: repoRoot, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let compactOutput = '', commandError = '';
    command.stdout.on('data', value => { compactOutput += value; });
    command.stderr.on('data', value => { commandError += value; });
    assert.equal((await once(command, 'close'))[0], 0, commandError);
    const receipt = JSON.parse(compactOutput);
    assert.equal(receipt.taskId, patchTask.taskId);
    assert.equal(receipt.revision, 4);
    assert.equal(receipt.status, 'completed');
    assert.ok(receipt.eventSeq);
    assert.equal(receipt.session, undefined);
    assert.equal(receipt.items[0].condition, undefined, 'receipt avoids repeating full criteria');
    const index = await request(port, 'GET', `/api/sessions/${session.id}/workboards`);
    assert.ok(index.json.tasks.some(board => board.taskId === patchTask.taskId));
    assert.ok(index.json.tasks.every(board => board.items === undefined));
    assert.equal((await request(port, 'GET', `/api/sessions/${session.id}/workboards?taskId=missing`)).status, 404);

    // Enabling the instance default takes effect on future admissions, without
    // rebuilding a static member list or relying on the Session's latest owner.
    writeFileSync(join(home, '.config', 'remotelab', 'workboard-opt-ins.json'), JSON.stringify({ defaultEnabled: true }));
    const allWeb = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot, tool: 'fake-codex', name: 'Future web task',
    });
    assert.equal(allWeb.json.session.workboardPilot, true);
    const source = sender => ({ connector: 'feishu', sourceRouteId: 'fixture-bot', chatType: 'group',
      chatId: 'fixture-chat', messageId: `om-${sender}`, sender: { openId: sender } });
    const service = { Cookie: 'session_token=test-service' };
    const group = await request(port, 'POST', '/api/sessions', { folder: repoRoot, tool: 'fake-codex',
      sourceId: 'feishu', sourceContext: source('a'), conversation: { connector: 'feishu', sourceRouteId: 'fixture-bot',
        target: { chatType: 'group', chatId: 'fixture-chat', conversationKind: 'thread' } },
    }, service);
    assert.equal(group.status, 201);
    for (const sender of ['a', 'new-member']) {
      const admission = await request(port, 'POST', `/api/sessions/${group.json.session.id}/messages`, {
        requestId: `workboard-${sender}`, text: 'Generate the fixture files.', tool: 'fake-codex',
        sourceContext: source(sender), sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture-bot',
          target: { chatId: 'fixture-chat', replyMessageId: `om-${sender}`, replyInThread: true } },
      }, service);
      assert.ok([200, 202].includes(admission.status), JSON.stringify(admission.json));
      await waitForRunTerminal(port, admission.json.run.id);
      const read = await request(port, 'GET', `/api/sessions/${group.json.session.id}/events?filter=all`);
      const inbound = read.json.events.find(event => event.role === 'user' && event.requestId === `workboard-${sender}`);
      assert.equal(inbound.workboardAdmission.senderOpenId, sender);
      assert.equal(inbound.workboardAdmission.sourceRouteId, 'fixture-bot');
      assert.ok(inbound.workboardAdmission.personId);
      assert.ok(inbound.workboardAdmission.identityId);
    }

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

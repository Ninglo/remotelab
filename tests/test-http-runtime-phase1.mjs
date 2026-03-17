#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 33000 + Math.floor(Math.random() * 10000);
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
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-phase1-'));
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
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '700');
let cancelled = false;
process.on('SIGTERM', () => {
  cancelled = true;
  setTimeout(() => process.exit(143), 20);
});
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  if (cancelled) return;
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'echo fake', aggregated_output: 'fake', exit_code: 0, status: 'completed' }
  }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'finished from fake codex' }
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
}, delay);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, configDir, localBin };
}

async function startServer({ home, port, delayMs = 700 }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      FAKE_CODEX_DELAY_MS: String(delayMs),
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

function runNodeCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function createSession(port, { name = 'Phase1', group = 'Tests', description = 'HTTP runtime' } = {}) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group,
    description,
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function submitMessage(port, sessionId, requestId, text = 'Run the fake tool') {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(res.status === 202 || res.status === 200, 'submit message should succeed');
  return res;
}

async function submitLegacyMessage(port, sessionId, text = 'Run the fake tool') {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(res.status, 202, 'legacy submit without requestId should succeed');
  return res;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

async function waitForRunState(port, runId, expectedState) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (res.json.run.state !== expectedState) return false;
    return res.json.run;
  }, `run ${runId} ${expectedState}`);
}

function readRunManifest(home, runId) {
  return JSON.parse(
    readFileSync(join(home, '.config', 'remotelab', 'chat-runs', runId, 'manifest.json'), 'utf8'),
  );
}

async function getEvents(port, sessionId) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
  assert.equal(res.status, 200, 'events request should succeed');
  return res.json;
}

async function phase1Contract() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port);
    const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.session.id, session.id);

    const first = await submitMessage(port, session.id, 'req-contract');
    const duplicate = await submitMessage(port, session.id, 'req-contract');
    assert.equal(duplicate.json.duplicate, true, 'same requestId should dedupe');
    assert.equal(first.json.run.id, duplicate.json.run.id, 'duplicate request should reuse run');

    const runRead = await request(port, 'GET', `/api/runs/${first.json.run.id}`);
    assert.equal(runRead.status, 200);
    assert.equal(runRead.json.run.requestId, 'req-contract');
    console.log('phase1-contract: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase2HttpCanonical() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'Canonical', group: 'Tests', description: 'HTTP only' });
    const submit = await submitMessage(port, session.id, 'req-http-only');
    await waitForRunTerminal(port, submit.json.run.id);

    const snapshot = await request(port, 'GET', `/api/sessions/${session.id}`);
    assert.equal(snapshot.status, 200);
    const events = await getEvents(port, session.id);
    assert.ok(events.events.some((event) => event.type === 'message' && event.role === 'user'));
    assert.ok(events.events.some((event) => event.type === 'message' && event.role === 'assistant'));
    console.log('phase2-http-canonical: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase2bLegacyHttpCompat() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, {
      name: 'Legacy HTTP',
      group: 'Tests',
      description: 'Missing requestId still works',
    });
    const submit = await submitLegacyMessage(port, session.id, 'Legacy client message');
    assert.equal(typeof submit.json.requestId, 'string', 'server should mint a compatibility requestId');
    assert.ok(submit.json.requestId.length > 0, 'compatibility requestId should not be empty');
    assert.equal(submit.json.run.requestId, submit.json.requestId, 'run should persist the generated requestId');

    const run = await waitForRunTerminal(port, submit.json.run.id);
    assert.equal(run.requestId, submit.json.requestId, 'terminal run should keep the generated requestId');

    const events = await getEvents(port, session.id);
    assert.ok(
      events.events.some((event) => event.type === 'message' && event.role === 'user' && event.requestId === submit.json.requestId),
      'user message should be recorded with the generated requestId',
    );
    assert.ok(
      events.events.some((event) => event.type === 'message' && event.role === 'assistant' && event.requestId === submit.json.requestId),
      'assistant reply should be linked to the generated requestId',
    );
    console.log('phase2b-legacy-http-compat: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase3Storage() {
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'Storage', group: 'Tests', description: 'Storage' });
    const submit = await submitMessage(port, session.id, 'req-storage');
    await waitForRunTerminal(port, submit.json.run.id);

    const historyRoot = join(configDir, 'chat-history', session.id);
    const runDir = join(configDir, 'chat-runs', submit.json.run.id);
    assert.equal(existsSync(join(historyRoot, 'meta.json')), true, 'history meta should exist');
    assert.equal(existsSync(join(historyRoot, 'events', '000000001.json')), true, 'history events should be sharded');
    assert.equal(existsSync(join(runDir, 'status.json')), true, 'run status should exist');
    assert.equal(existsSync(join(runDir, 'spool.jsonl')), true, 'run spool should exist');
    assert.equal(existsSync(join(runDir, 'result.json')), true, 'run result should exist');
    const eventsDir = join(historyRoot, 'events');
    const eventFiles = ['000000001.json', '000000002.json', '000000003.json'].map((name) => JSON.parse(readFileSync(join(eventsDir, name), 'utf8')));
    assert.ok(eventFiles.every((event, index) => event.seq === index + 1), 'history should be sequence-based');
    console.log('phase3-storage: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase4RunnerThin() {
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'Runner', group: 'Tests', description: 'Thin runner' });
    const submit = await submitMessage(port, session.id, 'req-runner');
    await waitForRunTerminal(port, submit.json.run.id);

    const spoolPath = join(configDir, 'chat-runs', submit.json.run.id, 'spool.jsonl');
    const records = readFileSync(spoolPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.stream === 'stdout' && typeof record.line === 'string'));
    assert.equal(records.some((record) => record.type === 'message'), false, 'runner spool should stay raw');
    console.log('phase4-runner-thin: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase5RestartSurvival() {
  const { home } = setupTempHome();
  const port = randomPort();
  let server = await startServer({ home, port, delayMs: 1600 });
  try {
    const session = await createSession(port, { name: 'Restart', group: 'Tests', description: 'Restart survival' });
    const submit = await submitMessage(port, session.id, 'req-restart', 'slow run');
    await waitFor(async () => {
      const run = await request(port, 'GET', `/api/runs/${submit.json.run.id}`);
      return run.status === 200 && run.json.run.state === 'running';
    }, 'run should enter running state');

    await stopServer(server);
    await sleep(500);
    server = await startServer({ home, port, delayMs: 1600 });

    const finalRun = await waitForRunTerminal(port, submit.json.run.id);
    assert.equal(finalRun.state, 'completed', 'detached run should survive restart');
    const events = await getEvents(port, session.id);
    assert.ok(events.events.some((event) => event.type === 'message' && event.role === 'assistant'));
    console.log('phase5-restart-survival: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase6WsInvalidationOnly() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  let ws;
  try {
    const messages = [];
    ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    });

    const session = await createSession(port, { name: 'WS', group: 'Tests', description: 'Invalidation only' });
    const submit = await submitMessage(port, session.id, 'req-ws');
    await waitForRunTerminal(port, submit.json.run.id);
    await waitFor(() => messages.some((message) => message.type === 'session_invalidated'), 'ws invalidation');
    const forbidden = new Set(['session', 'sessions', 'history', 'event', 'archived_list', 'unarchived', 'sidebar_update']);
    assert.equal(messages.some((message) => forbidden.has(message.type)), false, 'ws should stay invalidation-only');
    console.log('phase6-ws-invalidation-only: ok');
  } finally {
    if (ws) ws.close();
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase7EtagRevalidation() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'ETag', group: 'Tests', description: 'Conditional GETs' });

    const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.headers.etag, 'session detail should include an ETag');

    const detail304 = await request(
      port,
      'GET',
      `/api/sessions/${session.id}`,
      null,
      { 'If-None-Match': detail.headers.etag },
    );
    assert.equal(detail304.status, 304, 'unchanged session detail should revalidate to 304');

    const events = await request(port, 'GET', `/api/sessions/${session.id}/events`);
    assert.equal(events.status, 200);
    assert.ok(events.headers.etag, 'session events should include an ETag');

    const events304 = await request(
      port,
      'GET',
      `/api/sessions/${session.id}/events`,
      null,
      { 'If-None-Match': events.headers.etag },
    );
    assert.equal(events304.status, 304, 'unchanged event history should revalidate to 304');

    const submit = await submitMessage(port, session.id, 'req-etag');
    await waitForRunTerminal(port, submit.json.run.id);

    const detailAfterRun = await request(
      port,
      'GET',
      `/api/sessions/${session.id}`,
      null,
      { 'If-None-Match': detail.headers.etag },
    );
    assert.equal(detailAfterRun.status, 200, 'changed session detail must return a fresh payload');
    assert.notEqual(detailAfterRun.headers.etag, detail.headers.etag, 'session detail ETag should change after a run');

    const eventsAfterRun = await request(
      port,
      'GET',
      `/api/sessions/${session.id}/events`,
      null,
      { 'If-None-Match': events.headers.etag },
    );
    assert.equal(eventsAfterRun.status, 200, 'changed event history must return a fresh payload');
    assert.notEqual(eventsAfterRun.headers.etag, events.headers.etag, 'event history ETag should change after a run');
    console.log('phase7-etag-revalidation: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase8CancelRecovery() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 4000 });
  try {
    const session = await createSession(port, { name: 'Cancel', group: 'Tests', description: 'Cancel recovery' });
    const submit = await submitMessage(port, session.id, 'req-cancel', 'slow run for cancel');
    await waitForRunState(port, submit.json.run.id, 'running');

    const cancel = await request(port, 'POST', `/api/sessions/${session.id}/cancel`);
    assert.equal(cancel.status, 200, 'cancel request should succeed');

    const cancelledRun = await waitForRunTerminal(port, submit.json.run.id);
    assert.equal(cancelledRun.state, 'cancelled', 'cancelled run should reach terminal cancelled state');

    const retry = await submitMessage(port, session.id, 'req-cancel-retry', 'retry after cancel');
    const finalRun = await waitForRunTerminal(port, retry.json.run.id);
    assert.equal(finalRun.state, 'completed', 'session should accept a new run after cancel');
    console.log('phase8-cancel-recovery: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase9StaleResultReconciliation() {
  const { home, configDir } = setupTempHome();
  const port = randomPort();
  let server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'Stale', group: 'Tests', description: 'Stale result reconciliation' });
    const submit = await submitMessage(port, session.id, 'req-stale');
    const finishedRun = await waitForRunTerminal(port, submit.json.run.id);
    assert.equal(finishedRun.state, 'completed', 'initial run should complete');

    await stopServer(server);
    server = null;

    const sessionsPath = join(configDir, 'chat-sessions.json');
    const runStatusPath = join(configDir, 'chat-runs', submit.json.run.id, 'status.json');
    const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const sessionRecord = sessions.find((entry) => entry.id === session.id);
    assert.ok(sessionRecord, 'session record should exist');
    sessionRecord.activeRunId = submit.json.run.id;
    writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2), 'utf8');

    const status = JSON.parse(readFileSync(runStatusPath, 'utf8'));
    status.state = 'running';
    status.completedAt = null;
    status.finalizedAt = null;
    status.result = null;
    status.failureReason = null;
    status.cancelRequested = true;
    status.cancelRequestedAt = new Date().toISOString();
    writeFileSync(runStatusPath, JSON.stringify(status, null, 2), 'utf8');

    server = await startServer({ home, port });

    const cancel = await request(port, 'POST', `/api/sessions/${session.id}/cancel`);
    assert.equal(cancel.status, 200, 'stale completed run should self-heal when cancel is pressed');
    if (cancel.json.run) {
      assert.equal(cancel.json.run.state, 'completed', 'stale completed run should reconcile to completed');
    } else {
      assert.equal(cancel.json.session.activity?.run?.state, 'idle', 'stale completed run may self-heal before cancel executes');
    }

    const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
    assert.equal(detail.status, 200, 'session detail should still load');
    assert.equal(detail.json.session.activity?.run?.state, 'idle', 'session should no longer appear running');
    assert.equal(detail.json.session.activeRunId, undefined, 'session should clear activeRunId after reconciliation');

    const retry = await submitMessage(port, session.id, 'req-stale-retry', 'retry after stale completed run');
    const retriedRun = await waitForRunTerminal(port, retry.json.run.id);
    assert.equal(retriedRun.state, 'completed', 'session should accept a new run after stale-state reconciliation');
    console.log('phase9-stale-result-reconciliation: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase10EventIndexContract() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const session = await createSession(port, { name: 'Event index', group: 'Tests', description: 'Display timeline + lazy hidden blocks' });
    const submit = await submitMessage(port, session.id, 'req-index-contract');
    await waitForRunTerminal(port, submit.json.run.id);

    const events = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible&afterSeq=0&limit=1`);
    assert.equal(events.status, 200, 'event history should load successfully');
    assert.ok(Array.isArray(events.json.events), 'event history should return an events array');
    assert.equal(events.json.filter, 'visible', 'visible timeline requests should advertise the active event filter');
    assert.ok(events.json.events.length >= 3, 'event history should ignore limit pagination and return the full display timeline');
    assert.equal(
      events.json.events.some((event) => event.type === 'tool_use' || event.type === 'tool_result'),
      false,
      'main display timeline should not inline hidden tool events',
    );

    const userMessage = events.json.events.find((event) => event.type === 'message' && event.role === 'user');
    assert.ok(userMessage, 'display timeline should still expose the user message');
    assert.equal(userMessage.content, 'Run the fake tool', 'user message content should stay inline for the visible timeline');
    assert.equal(userMessage.bodyAvailable, undefined, 'visible user messages should not advertise a lazy body');

    const assistantMessage = events.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(assistantMessage, 'display timeline should expose the assistant summary message');
    assert.equal(assistantMessage.content, 'finished from fake codex', 'assistant summary should stay inline for the visible timeline');
    assert.equal(assistantMessage.bodyAvailable, undefined, 'visible assistant messages should not advertise a lazy body');

    const collapsedBlock = events.json.events.find((event) => event.type === 'thinking_block' && event.state === 'completed');
    assert.ok(collapsedBlock, 'display timeline should expose a completed thought block for hidden work');
    assert.ok(collapsedBlock.blockStartSeq >= 1, 'collapsed block should expose a starting sequence');
    assert.ok(collapsedBlock.blockEndSeq >= collapsedBlock.blockStartSeq, 'collapsed block should expose an ending sequence');

    const block = await request(
      port,
      'GET',
      `/api/sessions/${session.id}/events/blocks/${collapsedBlock.blockStartSeq}-${collapsedBlock.blockEndSeq}`,
    );
    assert.equal(block.status, 200, 'collapsed event block should load on demand');
    assert.ok(Array.isArray(block.json.events), 'collapsed event block should return hidden events');

    const toolUse = block.json.events.find((event) => event.type === 'tool_use');
    assert.ok(toolUse, 'collapsed event block should include tool use');
    assert.equal(toolUse.toolInput, 'echo fake', 'collapsed event block should inline the full tool input');

    const toolResult = block.json.events.find((event) => event.type === 'tool_result');
    assert.ok(toolResult, 'collapsed event block should include tool result');
    assert.equal(toolResult.output, 'fake', 'collapsed event block should inline the full tool result');

    const toolUseBody = await request(port, 'GET', `/api/sessions/${session.id}/events/${toolUse.seq}/body`);
    assert.equal(toolUseBody.status, 200, 'legacy tool use body route should still load on demand');
    assert.equal(toolUseBody.json.body.value, 'echo fake', 'legacy tool use body route should preserve the full inline payload');

    const fullEvents = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
    assert.equal(fullEvents.status, 200, 'raw event index should still be available through the explicit all filter');
    assert.equal(fullEvents.json.filter, 'all', 'raw event index responses should advertise the active event filter');
    assert.ok(
      fullEvents.json.events.some((event) => event.type === 'tool_use'),
      'raw event index should still expose tool use events when explicitly requested',
    );
    assert.ok(
      fullEvents.json.events.some((event) => event.type === 'tool_result'),
      'raw event index should still expose tool result events when explicitly requested',
    );

    console.log('phase10-event-index-contract: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase11ForkSession() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1200 });
  try {
    const session = await createSession(port, { name: 'Fork parent', group: 'Tests', description: 'Fork route contract' });
    const submit = await submitMessage(port, session.id, 'req-fork-parent', 'Run the fake tool before forking');
    await waitForRunTerminal(port, submit.json.run.id);

    const fork = await request(port, 'POST', `/api/sessions/${session.id}/fork`);
    assert.equal(fork.status, 201, 'fork should create a new child session');
    assert.ok(fork.json.session?.id, 'fork should return the child session');
    assert.notEqual(fork.json.session.id, session.id, 'fork should create a distinct child id');
    assert.equal(fork.json.session.name, 'fork - Fork parent', 'fork should use the fixed child naming convention');
    assert.equal(fork.json.session.forkedFromSessionId, session.id, 'fork should record the parent session id');

    const parentEvents = await getEvents(port, session.id);
    const childEvents = await getEvents(port, fork.json.session.id);
    assert.equal(childEvents.events.length, parentEvents.events.length, 'fork should copy the full event history');
    assert.equal(
      childEvents.events.some((event) => Object.prototype.hasOwnProperty.call(event, 'runId')),
      false,
      'forked history should strip run ids',
    );
    assert.equal(
      childEvents.events.some((event) => Object.prototype.hasOwnProperty.call(event, 'requestId')),
      false,
      'forked history should strip request ids',
    );

    const running = await createSession(port, { name: 'Fork busy', group: 'Tests', description: 'Fork rejection while running' });
    const runningSubmit = await submitMessage(port, running.id, 'req-fork-busy', 'slow run for rejection');
    await waitForRunState(port, runningSubmit.json.run.id, 'running');
    const reject = await request(port, 'POST', `/api/sessions/${running.id}/fork`);
    assert.equal(reject.status, 409, 'fork should reject running sessions');
    assert.equal(reject.json.error, 'Session is running');

    console.log('phase11-fork-session: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase12QueuedMessageRouteContract() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1200 });
  try {
    const session = await createSession(port, {
      name: 'Queued route',
      group: 'Tests',
      description: 'HTTP queued response contract',
    });

    const first = await submitMessage(port, session.id, 'req-queued-first', 'Keep the fake run busy');
    await waitForRunState(port, first.json.run.id, 'running');

    const queued = await submitMessage(port, session.id, 'req-queued-second', 'Follow-up while busy');
    assert.equal(queued.status, 202, 'queued follow-up should still return 202');
    assert.equal(queued.json.duplicate, false, 'new queued follow-up should not be marked duplicate');
    assert.equal(queued.json.queued, true, 'route should expose queued follow-up state');
    assert.equal(queued.json.run, null, 'queued follow-up should not create a new run immediately');
    assert.equal(queued.json.session?.id, session.id, 'route should still return the refreshed session');
    assert.equal(queued.json.session?.activity?.run?.state, 'running', 'session activity should expose the active run state');
    assert.equal(queued.json.session?.activity?.queue?.state, 'queued', 'session activity should expose the queued follow-up state');
    assert.equal(queued.json.session?.activity?.queue?.count, 1, 'session activity should expose the queued follow-up count');
    assert.equal(Array.isArray(queued.json.session?.queuedMessages), true, 'queued follow-up responses should include queued message details for the attached session view');
    assert.equal(queued.json.session?.queuedMessages?.[0]?.requestId, 'req-queued-second', 'queued follow-up responses should preserve the original queued request id');

    const duplicateQueued = await submitMessage(port, session.id, 'req-queued-second', 'Duplicate queued follow-up');
    assert.equal(duplicateQueued.status, 200, 'duplicate queued follow-up should return idempotent 200');
    assert.equal(duplicateQueued.json.duplicate, true, 'duplicate queued follow-up should report duplicate');
    assert.equal(duplicateQueued.json.queued, true, 'duplicate queued follow-up should still report queued');
    assert.equal(duplicateQueued.json.run, null, 'duplicate queued follow-up should not create a new run');
    assert.equal(Array.isArray(duplicateQueued.json.session?.queuedMessages), true, 'duplicate queued follow-up responses should still include queued message details while the queue entry exists');
    assert.equal(duplicateQueued.json.session?.queuedMessages?.[0]?.requestId, 'req-queued-second', 'duplicate queued follow-up responses should keep the queued request id stable');

    await waitForRunTerminal(port, first.json.run.id);
    await waitFor(async () => {
      const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
      if (detail.status !== 200) return false;
      return detail.json.session?.activity?.run?.state === 'idle'
        && detail.json.session?.activity?.queue?.state === 'idle';
    }, 'queued follow-up should finish draining before cleanup', 12000);

    console.log('phase12-queued-message-route-contract: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase13DelegateSession() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1200 });
  try {
    const session = await createSession(port, {
      name: 'Delegate parent',
      group: 'Tests',
      description: 'Delegate route contract',
    });
    const submit = await submitMessage(port, session.id, 'req-delegate-parent', 'Please investigate the board design problem before delegating');
    await waitForRunTerminal(port, submit.json.run.id);

    const delegate = await request(port, 'POST', `/api/sessions/${session.id}/delegate`, {
      task: 'Figure out a lightweight child-session strategy for parallel work.',
    });
    assert.equal(delegate.status, 201, 'delegate should create a child session');
    assert.ok(delegate.json.session?.id, 'delegate should return the child session');
    assert.ok(delegate.json.run?.id, 'delegate should start the child session immediately');
    assert.notEqual(delegate.json.session.id, session.id, 'delegate should create a distinct child session id');
    assert.equal(delegate.json.session.delegatedFromSessionId, undefined, 'delegate should not persist parent-child metadata on the child session');
    assert.equal(delegate.json.session.rootSessionId, undefined, 'delegate should not persist lineage metadata on the child session');
    assert.equal(delegate.json.session.delegatedAt, undefined, 'delegate should not persist delegated timestamps on the child session');

    const childRun = await waitForRunTerminal(port, delegate.json.run.id);
    assert.equal(childRun.state, 'completed', 'delegated child run should complete');

    const manifest = readRunManifest(home, delegate.json.run.id);
    assert.match(manifest.prompt || '', /Figure out a lightweight child-session strategy for parallel work\./, 'delegated prompt should include the requested child task');
    assert.match(manifest.prompt || '', /Please investigate the board design problem before delegating/, 'delegated prompt should include the latest parent user message');
    assert.match(manifest.prompt || '', /finished from fake codex/, 'delegated prompt should include the latest parent assistant result');
    assert.doesNotMatch(manifest.prompt || '', /echo fake/, 'delegated prompt should omit intermediate tool details from the parent');

    const parentEvents = await getEvents(port, session.id);
    const delegateNotice = parentEvents.events.find((event) => event.type === 'message' && event.role === 'assistant' && event.messageKind === 'session_delegate_notice');
    assert.ok(delegateNotice, 'delegation should append a visible handoff note to the parent session');
    assert.match(delegateNotice.content || '', /Spawned a parallel session/, 'handoff note should describe the spawn');
    assert.match(delegateNotice.content || '', new RegExp(`session=${delegate.json.session.id}`), 'handoff note should include a direct session link');
    assert.match(delegateNotice.content || '', /Figure out a lightweight child-session strategy for parallel work\./, 'handoff note should include the delegated task');

    const running = await createSession(port, {
      name: 'Delegate busy',
      group: 'Tests',
      description: 'Delegate while running',
    });
    const runningSubmit = await submitMessage(port, running.id, 'req-delegate-busy', 'slow run for delegate rejection');
    await waitForRunState(port, runningSubmit.json.run.id, 'running');
    const runningDelegate = await request(port, 'POST', `/api/sessions/${running.id}/delegate`, {
      task: 'Spawn a child anyway',
    });
    assert.equal(runningDelegate.status, 201, 'delegate should work even when the source session is currently running');
    assert.ok(runningDelegate.json.session?.id, 'running-source delegation should still create a child session');
    assert.ok(runningDelegate.json.run?.id, 'running-source delegation should still create a child run');

    console.log('phase13-delegate-session: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase14SessionSpawnCli() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1200 });
  try {
    const session = await createSession(port, {
      name: 'CLI parent',
      group: 'Tests',
      description: 'CLI helper contract',
    });

    const cli = await runNodeCli(
      ['cli.js', 'session-spawn', '--task', 'Return a focused child-session result.', '--wait', '--json'],
      {
        HOME: home,
        REMOTELAB_SESSION_ID: session.id,
        REMOTELAB_CHAT_BASE_URL: `http://127.0.0.1:${port}`,
      },
    );
    assert.equal(cli.code, 0, `session-spawn CLI should exit cleanly: ${cli.stderr}`);
    const payload = JSON.parse(cli.stdout);
    assert.equal(payload.sourceSessionId, session.id, 'CLI should default to REMOTELAB_SESSION_ID');
    assert.equal(payload.task, 'Return a focused child-session result.', 'CLI should echo the delegated task');
    assert.equal(typeof payload.sessionId, 'string', 'CLI should return the child session id');
    assert.equal(typeof payload.runId, 'string', 'CLI should return the child run id');
    assert.match(payload.sessionUrl || '', new RegExp(`session=${payload.sessionId}`), 'CLI should return a direct session URL');
    assert.equal(payload.state, 'completed', 'CLI --wait should return the terminal child state');
    assert.equal(payload.reply, 'finished from fake codex', 'CLI --wait should return the child assistant reply');

    const parentEvents = await getEvents(port, session.id);
    const delegateNotice = parentEvents.events.find((event) => event.type === 'message' && event.role === 'assistant' && event.messageKind === 'session_delegate_notice');
    assert.ok(delegateNotice, 'CLI helper should still append a visible handoff note to the source session');

    console.log('phase14-session-spawn-cli: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function phase15NoDuplicateDuringReadHammer() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, delayMs: 1200 });
  try {
    const session = await createSession(port, {
      name: 'Read hammer',
      group: 'Tests',
      description: 'Repeated read requests should not duplicate transcript output',
    });

    const submit = await submitMessage(port, session.id, 'req-read-hammer', 'Hammer the read paths while the fake run is active');
    await waitForRunState(port, submit.json.run.id, 'running');

    for (let round = 0; round < 6; round += 1) {
      const batch = [];
      for (let index = 0; index < 6; index += 1) {
        batch.push(request(port, 'GET', `/api/sessions/${session.id}`));
        batch.push(request(port, 'GET', `/api/sessions/${session.id}?view=sidebar`));
        batch.push(request(port, 'GET', `/api/sessions/${session.id}/events`));
        batch.push(request(port, 'GET', `/api/runs/${submit.json.run.id}`));
      }
      const responses = await Promise.all(batch);
      for (const response of responses) {
        assert.equal(response.status, 200, 'repeated read hammer requests should succeed');
      }
      await sleep(60);
    }

    await waitForRunTerminal(port, submit.json.run.id);
    await waitFor(async () => {
      const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
      if (detail.status !== 200) return false;
      return detail.json.session?.activity?.run?.state === 'idle';
    }, 'session should settle after the read hammer', 12000);

    const fullEvents = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
    assert.equal(fullEvents.status, 200, 'full event list should load after the read hammer');

    const assistantMessages = (fullEvents.json?.events || []).filter(
      (event) => event.type === 'message' && event.role === 'assistant' && event.content === 'finished from fake codex',
    );
    assert.equal(assistantMessages.length, 1, 'final assistant message should be committed exactly once');

    const toolResults = (fullEvents.json?.events || []).filter(
      (event) => event.type === 'tool_result' && event.output === 'fake',
    );
    assert.equal(toolResults.length, 1, 'tool result should be committed exactly once');

    console.log('phase15-no-duplicate-during-read-hammer: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

const phase = process.argv[2] || 'all';
const phases = {
  phase1: phase1Contract,
  phase2: phase2HttpCanonical,
  phase2b: phase2bLegacyHttpCompat,
  phase3: phase3Storage,
  phase4: phase4RunnerThin,
  phase5: phase5RestartSurvival,
  phase6: phase6WsInvalidationOnly,
  phase7: phase7EtagRevalidation,
  phase8: phase8CancelRecovery,
  phase9: phase9StaleResultReconciliation,
  phase10: phase10EventIndexContract,
  phase11: phase11ForkSession,
  phase12: phase12QueuedMessageRouteContract,
  phase13: phase13DelegateSession,
  phase14: phase14SessionSpawnCli,
  phase15: phase15NoDuplicateDuringReadHammer,
};

if (phase === 'all') {
  for (const key of Object.keys(phases)) {
    await phases[key]();
  }
} else if (phases[phase]) {
  await phases[phase]();
} else {
  console.error(`Unknown phase: ${phase}`);
  process.exit(1);
}

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

function randomPort() {
  return 48000 + Math.floor(Math.random() * 1000);
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
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchEventBody(port, sessionId, seq) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events/${seq}/body`);
  assert.equal(res.status, 200, 'event body request should succeed');
  return res.json?.body?.value || '';
}

async function resolveMessageContent(port, sessionId, event) {
  if (!event) return '';
  if (event.type !== 'message') return '';
  if (typeof event.content === 'string' && event.content) return event.content;
  if (!event.bodyAvailable || !Number.isInteger(event.seq)) return '';
  return fetchEventBody(port, sessionId, event.seq);
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-custom-prompt-shape-'));
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
        id: 'fake-catpaw',
        name: 'Fake CatPaw CLI',
        command: 'fake-catpaw',
        runtimeFamily: 'claude-stream-json',
        promptMode: 'bare-user',
        flattenPrompt: true,
        models: [{ id: 'sonnet', label: 'Claude Sonnet' }],
        reasoning: { kind: 'toggle', label: 'Thinking' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-catpaw'),
    `#!/usr/bin/env node
const promptIndex = process.argv.indexOf('-p');
const prompt = promptIndex === -1 ? '' : (process.argv[promptIndex + 1] || '');
if (/\\n/.test(prompt) || /Memory System|User message:|Current user message:|Agent instructions/.test(prompt)) {
  console.error('bad prompt shape');
  process.exit(1);
}
console.log(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-catpaw-session',
}));
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-catpaw-session',
  message: {
    role: 'assistant',
    type: 'message',
    id: 'msg_fake_catpaw',
    model: 'sonnet',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: 'text', text: prompt }],
  },
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'fake-catpaw-session',
  result: prompt,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
}));
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-catpaw'), 0o755);
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

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-catpaw',
    name: 'Custom prompt shaping',
    group: 'Tests',
    description: 'bare user prompt + flatten',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function submitMessage(port, sessionId) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'req-custom-tool-prompt-shaping',
    text: 'Line one.\n\nLine two.',
    tool: 'fake-catpaw',
    model: 'sonnet',
    thinking: true,
  });
  assert.ok(res.status === 202 || res.status === 200, 'submit message should succeed');
  return res.json.run;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

const { home } = setupTempHome();
const port = randomPort();
const server = await startServer({ home, port });

try {
  const session = await createSession(port);
  const run = await submitMessage(port, session.id);
  const terminal = await waitForRunTerminal(port, run.id);

  assert.equal(terminal.state, 'completed', 'custom prompt shaping should let the structured run complete');
  assert.ok((terminal.normalizedEventCount || 0) > 0, 'structured provider should emit normalized events');

  const eventsRes = await request(port, 'GET', `/api/sessions/${session.id}/events`);
  assert.equal(eventsRes.status, 200, 'events request should succeed');
  assert.ok(Array.isArray(eventsRes.json.events), 'event history should return an events array');

  const assistant = eventsRes.json.events.find((event) => event.type === 'message' && event.role === 'assistant');
  assert.ok(assistant, 'assistant reply should be present');
  const assistantContent = await resolveMessageContent(port, session.id, assistant);
  assert.equal(
    assistantContent,
    'Line one. Line two.',
    'bare-user + flattenPrompt should pass only the flattened user text to the provider',
  );

  console.log('test-custom-tool-prompt-shaping: ok');
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}

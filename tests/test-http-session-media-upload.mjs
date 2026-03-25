#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-media-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  const promptFile = join(home, 'captured-prompt.txt');
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
const { appendFileSync } = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
if (process.env.REMOTELAB_FAKE_PROMPT_FILE) {
  appendFileSync(process.env.REMOTELAB_FAKE_PROMPT_FILE, prompt + '\\n\\n---PROMPT---\\n\\n', 'utf8');
}
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-media-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'video received' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 80);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home, promptFile };
}

function readCapturedPrompts(promptFile) {
  if (!existsSync(promptFile)) return [];
  return readFileSync(promptFile, 'utf8')
    .split('\n\n---PROMPT---\n\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function startServer({ home, port, promptFile }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_FAKE_PROMPT_FILE: promptFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

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

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name: 'Media upload session',
  });
  assert.equal(res.status, 201, 'session should be created');
  return res.json.session;
}

async function submitVideoMessage(port, sessionId) {
  return submitMultipartMessage(port, sessionId, {
    requestId: 'req-video-upload',
    text: 'Please inspect the attached video.',
    mimeType: 'video/mp4',
    filename: 'clip.mp4',
    body: Buffer.from('fake-video-binary'),
  });
}

async function submitMultipartMessage(port, sessionId, {
  requestId,
  text,
  mimeType,
  filename,
  body,
}) {
  const formData = new FormData();
  formData.set('requestId', requestId);
  formData.set('text', text);
  formData.set('tool', 'fake-codex');
  formData.set('model', 'fake-model');
  formData.set('effort', 'low');
  formData.append('images', new Blob([body], { type: mimeType }), filename);

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: formData,
  });
  const responseText = await res.text();
  let json = null;
  try { json = responseText ? JSON.parse(responseText) : null; } catch {}
  return { status: res.status, json, text: responseText, headers: Object.fromEntries(res.headers.entries()) };
}

async function submitAssistantMultipartMessage(port, sessionId, {
  requestId,
  text = '',
  source = 'connector_attachment_test',
  mimeType,
  filename,
  body,
}) {
  const formData = new FormData();
  if (requestId) formData.set('requestId', requestId);
  formData.set('text', text);
  formData.set('source', source);
  formData.append('attachments', new Blob([body], { type: mimeType }), filename);

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/assistant-messages`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: formData,
  });
  const responseText = await res.text();
  let json = null;
  try { json = responseText ? JSON.parse(responseText) : null; } catch {}
  return { status: res.status, json, text: responseText, headers: Object.fromEntries(res.headers.entries()) };
}

async function submitJsonMessage(port, sessionId, requestId, text) {
  return request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

try {
  const { home, promptFile } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port, promptFile });
  try {
    const session = await createSession(port);
    const submitRes = await submitVideoMessage(port, session.id);
    assert.ok(submitRes.status === 202 || submitRes.status === 200, 'multipart media submission should be accepted');
    assert.ok(submitRes.json?.run?.id, 'accepted media submission should create a run');

    const run = await waitForRunTerminal(port, submitRes.json.run.id);
    assert.equal(run.state, 'completed', 'video upload run should complete successfully');

    const eventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events`);
      if (res.status !== 200) return false;
      const userMessage = (res.json.events || []).find((event) => event.type === 'message' && event.role === 'user');
      return userMessage ? { res, userMessage } : false;
    }, 'user message with video attachment');

    assert.equal(eventsRes.userMessage.images?.length, 1, 'user event should preserve the attachment reference');
    assert.equal(eventsRes.userMessage.attachments?.length, 1, 'user event should expose the canonical attachment alias');
    assert.equal(eventsRes.userMessage.images[0].mimeType, 'video/mp4', 'user event should preserve video mime type');
    assert.equal(eventsRes.userMessage.images[0].originalName, 'clip.mp4', 'user event should preserve the original filename');
    assert.match(eventsRes.userMessage.images[0].filename || '', /\.mp4$/, 'stored filename should keep the video extension');
    assert.equal(eventsRes.userMessage.images[0].savedPath, undefined, 'user event should not expose the internal attachment path');
    assert.equal(eventsRes.userMessage.attachments[0].originalName, 'clip.mp4', 'attachment alias should preserve the original filename');

    const mediaRes = await request(port, 'GET', `/api/media/${eventsRes.userMessage.images[0].filename}`);
    assert.equal(mediaRes.status, 200, 'uploaded video should be downloadable from the media route');
    assert.match(mediaRes.headers['content-type'] || '', /^video\/mp4/, 'media route should serve the correct video MIME type');

    const prompt = await waitFor(() => {
      const prompts = readCapturedPrompts(promptFile);
      return prompts.find((entry) => /\[User attached video: clip\.mp4 -> .*\.mp4\]/.test(entry)) || false;
    }, 'captured runner prompt');
    assert.match(prompt, /\[User attached video: clip\.mp4 -> .*\.mp4\]/, 'runner prompt should include the original video name and stored path');

    const fileSession = await createSession(port);
    const fileSubmitRes = await submitMultipartMessage(port, fileSession.id, {
      requestId: 'req-generic-file-upload',
      text: 'Please inspect the attached file.',
      mimeType: 'text/csv',
      filename: 'report.csv',
      body: Buffer.from('col1,col2\n1,2\n', 'utf8'),
    });
    assert.ok(fileSubmitRes.status === 202 || fileSubmitRes.status === 200, 'multipart generic file submission should be accepted');
    assert.ok(fileSubmitRes.json?.run?.id, 'accepted generic file submission should create a run');

    const fileRun = await waitForRunTerminal(port, fileSubmitRes.json.run.id);
    assert.equal(fileRun.state, 'completed', 'generic file upload run should complete successfully');

    const fileEventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${fileSession.id}/events`);
      if (res.status !== 200) return false;
      const userMessage = (res.json.events || []).find((event) => event.type === 'message' && event.role === 'user');
      return userMessage ? { res, userMessage } : false;
    }, 'user message with generic file attachment');

    assert.equal(fileEventsRes.userMessage.images?.length, 1, 'user event should preserve the generic file attachment reference');
    assert.equal(fileEventsRes.userMessage.attachments?.length, 1, 'generic file event should expose the canonical attachment alias');
    assert.equal(fileEventsRes.userMessage.images[0].mimeType, 'text/csv', 'user event should preserve generic file mime type');
    assert.equal(fileEventsRes.userMessage.images[0].originalName, 'report.csv', 'user event should preserve the generic file name');
    assert.match(fileEventsRes.userMessage.images[0].filename || '', /\.csv$/, 'stored filename should keep the generic file extension');
    assert.equal(fileEventsRes.userMessage.images[0].savedPath, undefined, 'generic file event should not expose the internal attachment path');

    const fileMediaRes = await request(port, 'GET', `/api/media/${fileEventsRes.userMessage.images[0].filename}`);
    assert.equal(fileMediaRes.status, 200, 'generic file should be downloadable from the media route');
    assert.equal(fileMediaRes.buffer.toString('utf8'), 'col1,col2\n1,2\n', 'downloaded generic file should keep its contents');

    const updatedPrompt = await waitFor(() => {
      const prompts = readCapturedPrompts(promptFile);
      return prompts.find((entry) => /\[User attached file: report\.csv -> .*\.csv\]/.test(entry)) || false;
    }, 'captured generic-file runner prompt');
    assert.match(updatedPrompt, /\[User attached file: report\.csv -> .*\.csv\]/, 'runner prompt should include the original file name and stored path');

    const followUpRes = await submitJsonMessage(port, fileSession.id, 'req-generic-file-follow-up', 'Continue using the same attached file.');
    assert.ok(followUpRes.status === 202 || followUpRes.status === 200, 'follow-up message should be accepted');
    assert.ok(followUpRes.json?.run?.id, 'follow-up message should create a run');

    const followUpRun = await waitForRunTerminal(port, followUpRes.json.run.id);
    assert.equal(followUpRun.state, 'completed', 'follow-up run should complete successfully');

    const followUpPrompt = await waitFor(() => {
      const prompts = readCapturedPrompts(promptFile);
      return prompts.find((entry) => (
        /RemoteLab session continuity handoff for this existing conversation\./.test(entry)
        && /\[Attached files: report\.csv -> .*\.csv\]/.test(entry)
      )) || false;
    }, 'follow-up prompt with continued attachment path');
    assert.match(followUpPrompt, /RemoteLab session continuity handoff for this existing conversation\./, 'follow-up prompt should include session continuation');
    assert.match(followUpPrompt, /\[Attached files: report\.csv -> .*\.csv\]/, 'follow-up prompt should carry the stored attachment path into continuation context');

    const assistantSubmitRes = await submitAssistantMultipartMessage(port, fileSession.id, {
      requestId: 'req-assistant-attachment',
      text: '',
      source: 'connector_attachment_test',
      mimeType: 'text/plain',
      filename: 'export.txt',
      body: Buffer.from('assistant-generated-export', 'utf8'),
    });
    assert.equal(assistantSubmitRes.status, 201, 'assistant attachment API should accept attachment-only assistant messages');
    assert.equal(assistantSubmitRes.json?.event?.role, 'assistant', 'assistant attachment API should append an assistant event');
    assert.equal(assistantSubmitRes.json?.event?.source, 'connector_attachment_test', 'assistant attachment API should preserve the event source');
    assert.equal(assistantSubmitRes.json?.event?.content, '', 'assistant attachment API should allow attachment-only messages');
    assert.equal(assistantSubmitRes.json?.event?.attachments?.length, 1, 'assistant attachment API should return the canonical attachment list');
    assert.equal(assistantSubmitRes.json?.event?.images?.length, 1, 'assistant attachment API should keep the legacy images alias during migration');

    const assistantEventsRes = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${fileSession.id}/events?filter=all`);
      if (res.status !== 200) return false;
      const assistantMessage = (res.json.events || []).find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && event.source === 'connector_attachment_test'
      ));
      return assistantMessage ? { res, assistantMessage } : false;
    }, 'assistant attachment-only message');

    assert.equal(assistantEventsRes.assistantMessage.attachments?.length, 1, 'assistant message should expose canonical attachments to the client');
    assert.equal(assistantEventsRes.assistantMessage.images?.length, 1, 'assistant message should still expose the legacy images alias');
    assert.equal(assistantEventsRes.assistantMessage.attachments[0].originalName, 'export.txt', 'assistant attachment message should preserve the exported filename');

    const assistantMediaRes = await request(port, 'GET', `/api/media/${assistantEventsRes.assistantMessage.attachments[0].filename}`);
    assert.equal(assistantMediaRes.status, 200, 'assistant attachment should be downloadable from the media route');
    assert.equal(assistantMediaRes.buffer.toString('utf8'), 'assistant-generated-export', 'assistant attachment download should preserve the file contents');

    console.log('test-http-session-media-upload: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

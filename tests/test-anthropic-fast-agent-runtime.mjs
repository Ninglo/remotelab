#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const commandPath = join(repoRoot, 'scripts', 'anthropic-fast-agent.mjs');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address?.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitFor(condition, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
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

function setupTempHome(providerBaseUrl) {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-anthropic-fast-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({ 'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' } }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'anthropic-fast-agent.json'),
    JSON.stringify({
      apiKey: 'test-anthropic-key',
      baseUrl: providerBaseUrl,
      model: 'claude-sonnet-4-6',
      maxIterations: 2,
      maxTokens: 4096,
      requestTimeoutMs: 5000,
      bashTimeoutMs: 5000,
      maxToolOutputChars: 4000,
      tools: {
        bash: true,
        list_dir: true,
        read_file: true,
        clipboard_read: false,
        clipboard_write: false,
        open_app: false,
        notify: false,
      },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'micro-agent',
        name: 'Micro Agent',
        toolProfile: 'micro-agent',
        command: commandPath,
        runtimeFamily: 'claude-stream-json',
        promptMode: 'bare-user',
        flattenPrompt: true,
        models: [
          { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
        ],
        reasoning: { kind: 'none', label: 'Thinking' },
      },
    ], null, 2),
    'utf8',
  );

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

  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function startProviderServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    await new Promise((resolve) => req.on('end', resolve));

    if (req.method === 'POST' && req.url === '/v1/messages') {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);

      const lastMessage = Array.isArray(parsed.messages) ? parsed.messages[parsed.messages.length - 1] : null;
      const hasToolResult = lastMessage?.role === 'user'
        && Array.isArray(lastMessage?.content)
        && lastMessage.content.some((block) => block.type === 'tool_result');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!hasToolResult) {
        res.end(JSON.stringify({
          id: 'msg_tool',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 8 },
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'bash',
            input: { command: 'printf hello-from-anthropic-fast-agent' },
          }],
        }));
        return;
      }

      res.end(JSON.stringify({
        id: 'msg_final',
        type: 'message',
        role: 'assistant',
        model: parsed.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 14, output_tokens: 6 },
        content: [{
          type: 'text',
          text: 'Anthropic fast agent completed.',
        }],
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    port: server.address().port,
  };
}

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'micro-agent',
    name: 'Anthropic Fast Runtime',
    group: 'Tests',
    description: 'Anthropic-backed custom fast agent',
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function submitMessage(port, sessionId) {
  const res = await request(port, 'POST', `/api/sessions/${sessionId}/messages`, {
    requestId: 'req-anthropic-fast-runtime',
    text: 'Please do a quick local check and tell me the result.',
    tool: 'micro-agent',
    model: 'claude-sonnet-4-6',
    thinking: false,
  });
  assert.ok(res.status === 202 || res.status === 200, 'submit message should succeed');
  return res.json.run;
}

async function waitForRunTerminal(port, runId) {
  let run = null;
  await waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    run = res.json.run;
    return ['completed', 'failed', 'cancelled'].includes(run.state);
  }, `run ${runId} terminal`, 15000);
  return run;
}

const provider = await startProviderServer();
const { home } = setupTempHome(`http://127.0.0.1:${provider.port}`);
const port = await getFreePort();
const server = await startServer({ home, port });

try {
  const session = await createSession(port);
  const run = await submitMessage(port, session.id);
  const terminal = await waitForRunTerminal(port, run.id);

  assert.equal(terminal.state, 'completed', `run should complete: ${server.getStderr()}`);
  assert.ok((terminal.normalizedEventCount || 0) > 0, 'Anthropic custom fast agent should emit normalized events');

  let eventsRes = null;
  await waitFor(async () => {
    const res = await request(port, 'GET', `/api/sessions/${session.id}/events`);
    if (res.status !== 200 || !Array.isArray(res.json?.events)) return false;
    eventsRes = res;
    return res.json.events.some(
      (event) => event.type === 'message'
        && event.role === 'assistant'
        && /Anthropic fast agent completed\./.test(event.content || ''),
    );
  }, 'final assistant reply', 15000);

  assert.ok(eventsRes, 'events request should succeed');
  assert.equal(
    eventsRes.json.events.some((event) => event.type === 'thinking_block' && Array.isArray(event.toolNames) && event.toolNames.includes('bash')),
    true,
    'history should include a collapsed thinking block for the bash tool turn',
  );
  assert.equal(
    eventsRes.json.events.some((event) => event.type === 'message' && event.role === 'assistant' && /Anthropic fast agent completed\./.test(event.content || '')),
    true,
    'history should include the final assistant reply',
  );

  assert.equal(provider.requests.length >= 2, true, 'fake Anthropic provider should receive both the tool call and the follow-up request');
  assert.equal(parsedPrompt(provider.requests[0]), 'Please do a quick local check and tell me the result.', 'bare-user prompt mode should pass only the user text');
  assert.equal(
    provider.requests[1]?.messages?.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result' && /hello-from-anthropic-fast-agent/.test(block.content || ''))),
    true,
    'tool result should be forwarded back to the provider',
  );

  console.log('test-anthropic-fast-agent-runtime: ok');
} finally {
  await stopServer(server);
  await new Promise((resolve) => provider.server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

function parsedPrompt(payload) {
  return payload?.messages?.[0]?.content?.[0]?.text || '';
}

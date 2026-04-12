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
  return 34000 + Math.floor(Math.random() * 10000);
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

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { Cookie: cookie },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
          }
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-server-micro-bootstrap-'));
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
    join(localBin, 'codex'),
    '#!/usr/bin/env bash\nexit 0\n',
    'utf8',
  );
  chmodSync(join(localBin, 'codex'), 0o755);

  return { home, configDir, localBin };
}

async function startServer({ home, localBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
      REMOTELAB_REPLY_SELF_CHECK: 'off',
      PATH: `${localBin}:${process.env.PATH || ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(async () => {
    try {
      const response = await request(port, 'GET', '/api/auth/me');
      return response.status === 200;
    } catch {
      return false;
    }
  }, 'chat server startup');

  return { child, getStderr: () => stderr };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'chat server shutdown');
}

const { home, configDir, localBin } = setupTempHome();
const port = randomPort();
let server = null;

try {
  const toolsPath = join(configDir, 'tools.json');
  assert.equal(existsSync(toolsPath), false, 'fresh instance should start without tools.json');

  server = await startServer({ home, localBin, port });

  await waitFor(() => existsSync(toolsPath), 'default micro-agent bootstrap');
  const tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
  const microAgent = tools.find((tool) => tool.id === 'micro-agent');

  assert.ok(microAgent, 'startup should seed a default micro-agent tool');
  assert.equal(microAgent.toolProfile, 'micro-agent');
  assert.equal(microAgent.visibility, 'private');
  assert.match(microAgent.command, /scripts\/micro-agent-router\.mjs$/);
  assert.equal(microAgent.runtimeFamily, 'claude-stream-json');

  const response = await request(port, 'GET', '/api/tools');
  assert.equal(response.status, 200, response.text);
  assert.equal(
    response.json?.tools?.some((tool) => tool.id === 'micro-agent'),
    true,
    'seeded micro-agent should be visible through the tools API',
  );
} finally {
  await stopServer(server);
  rmSync(home, { recursive: true, force: true });
}

console.log('test-chat-server-default-micro-agent-bootstrap: ok');

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_CREATION_MAX_BYTES } from '../chat/router-session-main-routes.mjs';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testHome = await mkdtemp(join(tmpdir(), 'remotelab-session-body-limit-'));
setIsolatedTestHome(testHome);
const configDir = join(testHome, '.config', 'remotelab');
const binDir = join(testHome, '.local', 'bin');
const cookie = 'session_token=session-body-limit';

await mkdir(configDir, { recursive: true });
await mkdir(binDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(configDir, 'auth-sessions.json'), JSON.stringify({
  'session-body-limit': { expiry: Date.now() + 60_000, role: 'owner' },
}));
await writeFile(join(configDir, 'tools.json'), JSON.stringify([{
  id: 'fake-codex',
  name: 'Fake Codex',
  command: 'fake-codex',
  runtimeFamily: 'codex-json',
  models: [{ id: 'fake-model', label: 'Fake model' }],
}]));
await writeFile(join(binDir, 'fake-codex'), '#!/usr/bin/env node\n');
await chmod(join(binDir, 'fake-codex'), 0o755);

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));

function request(method, pathname, payload = null) {
  const encoded = payload === null ? '' : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Cookie: cookie,
        ...(payload === null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded),
        }),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function waitForServer(child, logs) {
  const deadline = Date.now() + 15_000;
  let delayMs = 25;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup\n${logs.value}`);
    try {
      const result = await request('GET', '/api/auth/me');
      if (result.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw new Error(`Timed out waiting for server startup\n${logs.value}`);
}

const logs = { value: '' };
const server = spawn(process.execPath, ['chat-server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOME: testHome,
    CHAT_PORT: String(port),
    CHAT_BIND_HOST: '127.0.0.1',
    SECURE_COOKIES: '0',
    PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH || ''}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { logs.value += chunk; });
server.stderr.on('data', chunk => { logs.value += chunk; });

try {
  await waitForServer(server, logs);

  const acceptedPayload = {
    folder: testHome,
    tool: 'fake-codex',
    description: 'a'.repeat(60 * 1024),
  };
  const acceptedBytes = Buffer.byteLength(JSON.stringify(acceptedPayload));
  assert(acceptedBytes > 10 * 1024 && acceptedBytes < SESSION_CREATION_MAX_BYTES);
  const accepted = await request('POST', '/api/sessions', acceptedPayload);
  assert.equal(accepted.status, 201, `a ${acceptedBytes}-byte Session body should be accepted`);

  const oversizedPayload = {
    folder: testHome,
    tool: 'fake-codex',
    description: 'b'.repeat(SESSION_CREATION_MAX_BYTES),
  };
  const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedPayload));
  const rejected = await request('POST', '/api/sessions', oversizedPayload);
  assert.equal(rejected.status, 413);
  assert.equal(rejected.json?.code, 'BODY_TOO_LARGE');
  assert.equal(rejected.json?.route, 'POST /api/sessions');
  assert.equal(rejected.json?.maxBytes, SESSION_CREATION_MAX_BYTES);
  assert.equal(rejected.json?.receivedBytes, oversizedBytes);
  assert.match(rejected.json?.error || '', /maximum is 65536 bytes \(64 KiB\)/);
  assert.match(rejected.json?.error || '', /POST \/api\/sessions\/:sessionId\/messages/);

  const recovery = await request('POST', '/api/sessions', {
    folder: testHome,
    tool: 'fake-codex',
    name: 'after readable 413',
  });
  assert.equal(recovery.status, 201, 'the server should remain usable after rejecting an oversized body');

  console.log('ok - Session creation accepts metadata up to 64 KiB and returns a readable 413 above it');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
  await rm(testHome, { recursive: true, force: true });
}

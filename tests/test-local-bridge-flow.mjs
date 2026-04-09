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
  return 37000 + Math.floor(Math.random() * 3000);
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
    const headers = {
      ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    };
    if (!Object.prototype.hasOwnProperty.call(extraHeaders, 'Cookie')) {
      headers.Cookie = cookie;
    } else if (headers.Cookie === undefined) {
      delete headers.Cookie;
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-local-bridge-'));
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
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-local-bridge-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'local bridge ready' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 50);
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
      REMOTELAB_REPLY_SELF_CHECK: 'off',
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
    name: 'Local bridge session',
  });
  assert.equal(res.status, 201, 'session should be created');
  return res.json.session;
}

function runNodeCliAsync(args, env = {}) {
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
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const promise = new Promise((resolve) => {
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  return { child, promise };
}

function buildDeviceHeaders(token, extra = {}) {
  return {
    Cookie: undefined,
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await startServer({ home, port });

  try {
    const session = await createSession(port);

    const pairCodeCli = await runNodeCliAsync([
      'cli.js',
      'local-bridge',
      'pair-code',
      'create',
      '--session',
      session.id,
      '--base-url',
      baseUrl,
      '--json',
    ], { HOME: home }).promise;
    assert.equal(pairCodeCli.code, 0, `pair-code create should succeed: ${pairCodeCli.stderr}`);
    const pairCodeJson = JSON.parse(pairCodeCli.stdout);
    const pairCode = pairCodeJson?.pairing?.code;
    assert.ok(pairCode, 'pair-code create should return a code');

    const projectRoot = join(home, 'projects');
    mkdirSync(projectRoot, { recursive: true });
    const notePath = join(projectRoot, 'scope.txt');
    const stagedPath = join(projectRoot, 'main.rvt');
    writeFileSync(notePath, 'tower scope\n', 'utf8');
    writeFileSync(stagedPath, Buffer.from('fake-rvt-binary'));

    const pairRes = await request(port, 'POST', '/api/local-bridge/pair', {
      code: pairCode,
      platform: 'darwin',
      deviceName: 'Mac Test Helper',
      helperVersion: '0.1.0-test',
      allowedRoots: {
        projects: projectRoot,
      },
    }, { Cookie: undefined });
    assert.equal(pairRes.status, 200, 'pair should succeed');
    assert.ok(pairRes.json?.device?.id, 'pair should return a device id');
    const deviceId = pairRes.json.device.id;
    const deviceToken = pairRes.json.device.token;

    const heartbeatRes = await request(
      port,
      'POST',
      `/api/local-bridge/devices/${deviceId}/heartbeat`,
      { platform: 'darwin', allowedRoots: { projects: projectRoot } },
      buildDeviceHeaders(deviceToken),
    );
    assert.equal(heartbeatRes.status, 200, 'heartbeat should succeed');

    const statusCli = await runNodeCliAsync([
      'cli.js',
      'local-bridge',
      'status',
      '--session',
      session.id,
      '--base-url',
      baseUrl,
      '--json',
    ], { HOME: home }).promise;
    assert.equal(statusCli.code, 0, `status should succeed: ${statusCli.stderr}`);
    const statusJson = JSON.parse(statusCli.stdout);
    assert.equal(statusJson.localBridge.state, 'online', 'session status should show the helper online');
    assert.equal(statusJson.localBridge.allowedRoots[0].alias, 'projects', 'session status should surface allowed roots');

    const listCli = runNodeCliAsync([
      'cli.js',
      'local-bridge',
      'list',
      '--session',
      session.id,
      '--base-url',
      baseUrl,
      '--root',
      'projects',
      '--path',
      '.',
      '--json',
    ], { HOME: home });

    const listCommand = await waitFor(async () => {
      const res = await request(
        port,
        'GET',
        `/api/local-bridge/devices/${deviceId}/commands/next?timeoutMs=100`,
        null,
        buildDeviceHeaders(deviceToken),
      );
      if (res.status !== 200 || !res.json?.command?.id) return false;
      return res.json.command;
    }, 'list command');
    assert.equal(listCommand.name, 'list', 'helper should receive a list command');
    assert.equal(listCommand.args.rootAlias, 'projects', 'list command should preserve the root alias');

    const listResultRes = await request(
      port,
      'POST',
      `/api/local-bridge/devices/${deviceId}/commands/${listCommand.id}/result`,
      {
        result: {
          entries: [
            { name: 'scope.txt', relPath: 'scope.txt', kind: 'file', size: 12 },
            { name: 'main.rvt', relPath: 'main.rvt', kind: 'file', size: 15 },
          ],
        },
      },
      buildDeviceHeaders(deviceToken),
    );
    assert.equal(listResultRes.status, 200, 'helper should be able to post list results');

    const listCliResult = await listCli.promise;
    assert.equal(listCliResult.code, 0, `list CLI should exit cleanly: ${listCliResult.stderr}`);
    const listCliJson = JSON.parse(listCliResult.stdout);
    assert.equal(listCliJson.command.name, 'list', 'CLI should return the completed list command');
    assert.equal(listCliJson.command.result.entries.length, 2, 'CLI should include helper-provided list entries');

    const stageCli = runNodeCliAsync([
      'cli.js',
      'local-bridge',
      'stage',
      '--session',
      session.id,
      '--base-url',
      baseUrl,
      '--root',
      'projects',
      '--path',
      'main.rvt',
      '--json',
    ], { HOME: home });

    const stageCommand = await waitFor(async () => {
      const res = await request(
        port,
        'GET',
        `/api/local-bridge/devices/${deviceId}/commands/next?timeoutMs=100`,
        null,
        buildDeviceHeaders(deviceToken),
      );
      if (res.status !== 200 || !res.json?.command?.id) return false;
      return res.json.command;
    }, 'stage command');
    assert.equal(stageCommand.name, 'stage', 'helper should receive a stage command');
    assert.equal(stageCommand.args.relPath, 'main.rvt', 'stage command should preserve the relative path');

    const uploadRes = await request(
      port,
      'PUT',
      `/api/local-bridge/devices/${deviceId}/commands/${stageCommand.id}/upload`,
      Buffer.from('fake-rvt-binary'),
      buildDeviceHeaders(deviceToken, { 'Content-Type': 'application/octet-stream' }),
    );
    assert.equal(uploadRes.status, 200, 'helper should be able to upload staged file bytes');

    const finalizeRes = await request(
      port,
      'POST',
      `/api/local-bridge/devices/${deviceId}/commands/${stageCommand.id}/upload/finalize`,
      { sizeBytes: Buffer.byteLength('fake-rvt-binary') },
      buildDeviceHeaders(deviceToken),
    );
    assert.equal(finalizeRes.status, 200, 'helper should be able to finalize the staged upload');

    const stageResultRes = await request(
      port,
      'POST',
      `/api/local-bridge/devices/${deviceId}/commands/${stageCommand.id}/result`,
      { result: { sha256: 'test-sha256' } },
      buildDeviceHeaders(deviceToken),
    );
    assert.equal(stageResultRes.status, 200, 'helper should be able to complete the stage command');

    const stageCliResult = await stageCli.promise;
    assert.equal(stageCliResult.code, 0, `stage CLI should exit cleanly: ${stageCliResult.stderr}`);
    const stageCliJson = JSON.parse(stageCliResult.stdout);
    assert.equal(stageCliJson.command.name, 'stage', 'CLI should return the completed stage command');
    assert.equal(stageCliJson.command.result.asset.originalName, 'main.rvt', 'stage should return the uploaded asset metadata');

    const stagedAssistantEvent = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/sessions/${session.id}/events?filter=all`);
      if (res.status !== 200) return false;
      return (res.json?.events || []).find((event) => event.type === 'message' && event.role === 'assistant' && event.source === 'local_bridge_stage') || false;
    }, 'assistant staged attachment event');
    assert.equal(stagedAssistantEvent.images?.length, 1, 'stage completion should append one assistant attachment');
    assert.equal(stagedAssistantEvent.images[0].assetId, stageCliJson.command.result.asset.id, 'assistant attachment should reference the staged asset');

    const downloadPath = stageCliJson.command.result.asset.downloadUrl;
    assert.ok(downloadPath, 'stage result should expose a stable download route');
    const downloadRes = await request(port, 'GET', downloadPath);
    assert.equal(downloadRes.status, 200, 'staged asset should be downloadable from the session');
    assert.equal(downloadRes.buffer.toString('utf8'), 'fake-rvt-binary', 'downloaded staged asset should match uploaded bytes');

    console.log('test-local-bridge-flow: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

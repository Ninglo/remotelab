#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 39500 + Math.floor(Math.random() * 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 25000, intervalMs = 100) {
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-local-helper-update-'));
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
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-local-helper-auto-update-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'local helper auto update ready' }
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
    name: 'Local helper auto-update diagnostics session',
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

function buildVersionedHelperBinary({ home, version }) {
  const sourceDir = join(home, `local-helper-src-${version.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  cpSync(join(repoRoot, 'local-helper'), sourceDir, { recursive: true });
  const mainPath = join(sourceDir, 'cmd', 'remotelab-helper', 'main.go');
  const source = readFileSync(mainPath, 'utf8');
  const currentVersion = '0.2.1';
  assert.ok(source.includes(`const helperVersion = "${currentVersion}"`), 'helper source should contain the current version constant');
  writeFileSync(
    mainPath,
    source.replace(`const helperVersion = "${currentVersion}"`, `const helperVersion = "${version}"`),
    'utf8',
  );

  const binaryPath = join(home, `remotelab-helper-${version}`);
  const build = spawnSync('go', ['build', '-o', binaryPath, './cmd/remotelab-helper'], {
    cwd: sourceDir,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `helper build should succeed: ${build.stderr}`);
  return binaryPath;
}

function helperArch() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function readStatusVersion(status) {
  return status?.json?.localBridge?.device?.helperVersion || status?.json?.localBridge?.helperVersion || '';
}

async function fetchOnlineStatus(port, sessionId, expectedVersion = '') {
  return waitFor(async () => {
    try {
      const res = await request(port, 'GET', `/api/sessions/${sessionId}/local-bridge/status`);
      if (res.status !== 200) return null;
      const bridge = res.json?.localBridge;
      if (bridge?.state !== 'online') return null;
      if (expectedVersion && readStatusVersion(res) !== expectedVersion) return null;
      return res;
    } catch {
      return null;
    }
  }, expectedVersion ? `helper online status ${expectedVersion}` : 'helper online status');
}

async function stopChild(child, description) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, `${description} shutdown`);
}

async function main() {
  const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (goVersion.status !== 0) {
    console.log('Skipping local helper auto-update diagnostics test because `go` is not installed.');
    return;
  }

  const { home } = setupTempHome();
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await startServer({ home, port });
  let staleHelperStdout = '';
  let staleHelperStderr = '';
  let managedHelperStdout = '';
  let managedHelperStderr = '';
  let staleHelper = null;
  let managedHelper = null;

  try {
    const session = await createSession(port);

    const bootstrapCli = await runNodeCliAsync([
      'cli.js',
      'local-bridge',
      'bootstrap',
      'create',
      '--session',
      session.id,
      '--base-url',
      baseUrl,
      '--json',
    ], { HOME: home }).promise;
    assert.equal(bootstrapCli.code, 0, `bootstrap create should succeed: ${bootstrapCli.stderr}`);
    const bootstrapToken = JSON.parse(bootstrapCli.stdout)?.bootstrap?.token;
    assert.ok(bootstrapToken, 'bootstrap create should return a token');

    const releaseManifest = await request(
      port,
      'GET',
      `/api/local-bridge/helper/releases/latest?platform=${encodeURIComponent(process.platform)}&arch=${encodeURIComponent(helperArch())}`,
      null,
      { Cookie: undefined },
    );
    assert.equal(releaseManifest.status, 200, 'latest helper release should resolve before stale helper launch');
    assert.equal(releaseManifest.json?.release?.version, '0.2.1', 'release manifest should expose the current helper release');

    const helperConfigDir = join(home, '.config', 'RemoteLabHelper');
    mkdirSync(helperConfigDir, { recursive: true });
    const bootstrapFilePath = join(helperConfigDir, 'bootstrap.json');
    writeFileSync(bootstrapFilePath, JSON.stringify({
      serverUrl: baseUrl,
      token: bootstrapToken,
    }, null, 2), 'utf8');

    const staleBinaryPath = buildVersionedHelperBinary({ home, version: '0.2.0' });
    staleHelper = spawn(staleBinaryPath, ['run'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    staleHelper.stdout.on('data', (chunk) => { staleHelperStdout += chunk.toString(); });
    staleHelper.stderr.on('data', (chunk) => { staleHelperStderr += chunk.toString(); });

    const staleStatus = await fetchOnlineStatus(port, session.id, '0.2.0');
    const deviceId = staleStatus.json?.localBridge?.device?.id || staleStatus.json?.localBridge?.deviceId;
    assert.ok(deviceId, 'status should expose the linked device');
    assert.equal(existsSync(bootstrapFilePath), false, 'bootstrap file should be consumed on first launch');

    await waitFor(
      () => staleHelperStderr.includes('auto update installed managed helper at'),
      'unmanaged auto-update diagnostic',
      60000,
    );
    assert.match(staleHelperStderr, /updated helper to 0\.2\.1/, 'stale helper should report the downloaded release version');
    assert.match(
      staleHelperStderr,
      /auto update installed managed helper at .* but current executable is .*; restart using the managed helper path to apply 0\.2\.1/,
      'stale helper should explain why it remained on the old executable',
    );

    const managedBinaryPath = join(helperConfigDir, 'bin', `remotelab-helper-${process.platform}-${helperArch()}`);
    assert.equal(existsSync(managedBinaryPath), true, 'auto update should write the managed helper binary');

    const statusAfterUpdate = await fetchOnlineStatus(port, session.id, '0.2.0');
    assert.equal(
      readStatusVersion(statusAfterUpdate),
      '0.2.0',
      'session should still report the stale version while the unmanaged helper keeps running',
    );

    await stopChild(staleHelper, 'stale helper');

    managedHelper = spawn(managedBinaryPath, ['serve'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    managedHelper.stdout.on('data', (chunk) => { managedHelperStdout += chunk.toString(); });
    managedHelper.stderr.on('data', (chunk) => { managedHelperStderr += chunk.toString(); });

    const managedStatus = await fetchOnlineStatus(port, session.id, '0.2.1');
    assert.equal(readStatusVersion(managedStatus), '0.2.1', 'managed helper launch should surface the updated version');
    assert.equal(managedHelperStderr.includes('auto update installed managed helper at'), false, 'managed launch should not repeat the unmanaged-path diagnostic');
    assert.equal(managedHelperStderr.includes('heartbeat failed'), false, 'managed helper should connect cleanly');
    assert.match(staleHelperStdout, /bootstrapped device /, 'stale helper should still finish bootstrap before entering serve');
  } finally {
    await stopChild(staleHelper, 'stale helper');
    await stopChild(managedHelper, 'managed helper');
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error);
  process.exit(1);
});

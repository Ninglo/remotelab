#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 39000 + Math.floor(Math.random() * 3000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 100) {
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-local-bridge-bootstrap-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  mkdirSync(join(home, 'Documents'), { recursive: true });
  mkdirSync(join(home, 'Downloads'), { recursive: true });

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
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-local-bridge-bootstrap-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'local bridge bootstrap ready' }
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

  child._remotelabStdout = () => stdout;
  child._remotelabStderr = () => stderr;
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
    name: 'Local bridge bootstrap session',
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

function buildHelperBinary(home) {
  const binaryPath = join(home, 'remotelab-helper');
  const build = spawnSync('go', ['build', '-o', binaryPath, './cmd/remotelab-helper'], {
    cwd: join(repoRoot, 'local-helper'),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `helper build should succeed: ${build.stderr}`);
  return binaryPath;
}

async function main() {
  const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (goVersion.status !== 0) {
    console.log('Skipping local bridge bootstrap flow test because `go` is not installed.');
    return;
  }

  const { home } = setupTempHome();
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let helperStdout = '';
  let helperStderr = '';
  const server = await startServer({ home, port });

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
    const bootstrapJson = JSON.parse(bootstrapCli.stdout);
    const bootstrapToken = bootstrapJson?.bootstrap?.token;
    assert.ok(bootstrapToken, 'bootstrap create should return a token');

    const releaseManifest = await request(port, 'GET', '/api/local-bridge/helper/releases/latest?platform=linux&arch=amd64', null, { Cookie: undefined });
    assert.equal(releaseManifest.status, 200, 'latest helper release should resolve');
    assert.equal(releaseManifest.json?.release?.platform, 'linux', 'release manifest should reflect the requested platform');
    assert.equal(releaseManifest.json?.release?.arch, 'amd64', 'release manifest should reflect the requested arch');
    assert.ok(releaseManifest.json?.release?.sha256, 'release manifest should include a checksum');
    assert.ok(releaseManifest.json?.release?.downloadPath, 'release manifest should include a download path');

    const releaseDownload = await request(port, 'GET', releaseManifest.json.release.downloadPath, null, { Cookie: undefined });
    assert.equal(releaseDownload.status, 200, 'helper release binary should download');
    assert.ok(releaseDownload.buffer.length > 1024 * 1024, 'downloaded helper binary should be non-trivial');

    const helperConfigDir = join(home, '.config', 'RemoteLabHelper');
    mkdirSync(helperConfigDir, { recursive: true });
    const bootstrapFilePath = join(helperConfigDir, 'bootstrap.json');
    writeFileSync(bootstrapFilePath, JSON.stringify({
      serverUrl: baseUrl,
      token: bootstrapToken,
    }, null, 2), 'utf8');

    const helperBinary = buildHelperBinary(home);
    const helper = spawn(helperBinary, ['run'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    helper.stdout.on('data', (chunk) => { helperStdout += chunk.toString(); });
    helper.stderr.on('data', (chunk) => { helperStderr += chunk.toString(); });

    const onlineStatus = await waitFor(async () => {
      try {
        const res = await request(port, 'GET', `/api/sessions/${session.id}/local-bridge/status`);
        if (res.status !== 200) return null;
        return res.json?.localBridge?.state === 'online' ? res.json.localBridge : null;
      } catch {
        return null;
      }
    }, 'helper online status');

    assert.ok(onlineStatus.deviceId, 'status should include a linked device id');
    assert.equal(onlineStatus.state, 'online', 'helper should come online after bootstrap run');
    assert.equal(existsSync(bootstrapFilePath), false, 'bootstrap file should be consumed on first launch');

    const helperConfigPath = join(helperConfigDir, 'config.json');
    const helperConfig = JSON.parse(readFileSync(helperConfigPath, 'utf8'));
    assert.equal(helperConfig.serverUrl, baseUrl, 'config should store the server URL from bootstrap');
    assert.ok(helperConfig.deviceId, 'config should store a paired device id');
    assert.ok(helperConfig.deviceToken, 'config should store a device token');
    assert.equal(helperConfig.allowedRoots.root, '/', 'bootstrap should expose the filesystem root by default');
    assert.equal(helperConfig.allowedRoots.home, home, 'bootstrap should expose the current user home by default');
    assert.equal(Object.prototype.hasOwnProperty.call(helperConfig.allowedRoots, 'desktop'), false, 'bootstrap should no longer default to Desktop-only roots');

    const redeemAgain = await request(port, 'POST', '/api/local-bridge/bootstrap/redeem', {
      token: bootstrapToken,
    }, { Cookie: undefined });
    assert.equal(redeemAgain.status, 400, 'bootstrap token should be single use');

    helper.kill('SIGTERM');
    await waitFor(() => helper.exitCode !== null || helper.signalCode !== null, 'helper shutdown');

    assert.match(helperStdout, /bootstrapped device /, 'helper should report bootstrapping on first launch');
    assert.equal(helperStderr.includes('heartbeat failed'), false, 'helper should not fail heartbeats during bootstrap flow');
  } finally {
    if (process.env.DEBUG_LOCAL_BRIDGE_BOOTSTRAP_TEST === '1') {
      console.error('server stdout:\n', server._remotelabStdout?.() || '');
      console.error('server stderr:\n', server._remotelabStderr?.() || '');
      console.error('helper stdout:\n', helperStdout);
      console.error('helper stderr:\n', helperStderr);
    }
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error);
  process.exit(1);
});

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

function randomPort() {
  return 39500 + Math.floor(Math.random() * 3000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-local-bridge-installers-'));
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
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-local-bridge-installers-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'local bridge installers ready' }
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
    name: 'Local bridge installer session',
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
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return { child, promise };
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = await startServer({ home, port });

  try {
    const session = await createSession(port);

    const cli = await runNodeCliAsync([
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
    assert.equal(cli.code, 0, `bootstrap create should succeed: ${cli.stderr}`);
    const cliJson = JSON.parse(cli.stdout);
    assert.ok(cliJson?.bootstrap?.token, 'CLI should return a bootstrap token');
    assert.equal(typeof cliJson?.installers?.mac?.downloadUrl, 'string', 'CLI should surface a mac installer download URL');
    assert.equal(typeof cliJson?.installers?.linux?.downloadUrl, 'string', 'CLI should surface a linux installer download URL');
    assert.equal(typeof cliJson?.installers?.windows?.downloadUrl, 'string', 'CLI should surface a windows cmd installer download URL');
    assert.equal(typeof cliJson?.commands?.mac, 'string', 'CLI should surface a mac shell command');
    assert.equal(typeof cliJson?.commands?.windows_cmd, 'string', 'CLI should surface a windows cmd command');

    const token = cliJson.bootstrap.token;

    const macScript = await request(
      port,
      'GET',
      `/api/local-bridge/bootstrap/installers/download?bootstrapToken=${encodeURIComponent(token)}&platform=darwin&format=command`,
      null,
      { Cookie: undefined },
    );
    assert.equal(macScript.status, 200, 'mac installer script should download');
    assert.match(String(macScript.headers['content-disposition'] || ''), /Install-RemoteLab-Helper\.command/, 'mac download should advertise the .command filename');
    assert.match(macScript.text, /RemoteLab Helper started in the background/, 'mac script should start the helper in the background');
    assert.match(macScript.text, new RegExp(token), 'mac script should embed the bootstrap token');
    assert.match(macScript.text, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'mac script should embed the server base URL');
    assert.match(macScript.text, /platform=darwin&arch=\$ARCH/, 'mac script should download the helper binary for the detected arch');

    const linuxScript = await request(
      port,
      'GET',
      `/api/local-bridge/bootstrap/installers/download?bootstrapToken=${encodeURIComponent(token)}&platform=linux&format=sh`,
      null,
      { Cookie: undefined },
    );
    assert.equal(linuxScript.status, 200, 'linux installer script should download');
    assert.match(String(linuxScript.headers['content-disposition'] || ''), /install-remotelab-helper\.sh/, 'linux download should advertise the .sh filename');
    assert.match(linuxScript.text, /platform=linux&arch=\$ARCH/, 'linux script should download the helper binary for the detected arch');
    assert.match(linuxScript.text, /nohup "\$HELPER_PATH" run --server "\$BASE_URL" --token "\$BOOTSTRAP_TOKEN"/, 'linux script should run the helper in the background');

    const windowsCmd = await request(
      port,
      'GET',
      `/api/local-bridge/bootstrap/installers/download?bootstrapToken=${encodeURIComponent(token)}&platform=windows&format=cmd`,
      null,
      { Cookie: undefined },
    );
    assert.equal(windowsCmd.status, 200, 'windows cmd installer should download');
    assert.match(String(windowsCmd.headers['content-disposition'] || ''), /Install-RemoteLab-Helper\.cmd/, 'windows cmd download should advertise the .cmd filename');
    assert.match(windowsCmd.text, /Start-Process -FilePath '%HELPER_PATH%'/, 'windows cmd script should start the helper process');

    const prefixedBootstrap = await request(port, 'POST', `/api/sessions/${encodeURIComponent(session.id)}/local-bridge/bootstrap`, {}, {
      'x-forwarded-prefix': '/trial16',
    });
    assert.equal(prefixedBootstrap.status, 201, 'prefixed bootstrap create should succeed');
    assert.match(
      prefixedBootstrap.json?.installers?.mac?.downloadUrl || '',
      /^http:\/\/127\.0\.0\.1:\d+\/trial16\/api\/local-bridge\/bootstrap\/installers\/download\?/,
      'prefixed bootstrap URLs should stay inside the forwarded product prefix',
    );
    assert.match(
      prefixedBootstrap.json?.commands?.mac || '',
      /\/trial16\/api\/local-bridge\/bootstrap\/installers\/download\?/,
      'prefixed command hints should keep installer URLs inside the forwarded product prefix',
    );

    const prefixedToken = prefixedBootstrap.json?.bootstrap?.token;
    assert.ok(prefixedToken, 'prefixed bootstrap should return a token');
    const prefixedScript = await request(
      port,
      'GET',
      `/api/local-bridge/bootstrap/installers/download?bootstrapToken=${encodeURIComponent(prefixedToken)}&platform=linux&format=sh`,
      null,
      {
        Cookie: undefined,
        'x-forwarded-prefix': '/trial16',
      },
    );
    assert.equal(prefixedScript.status, 200, 'prefixed installer script should download');
    assert.match(
      prefixedScript.text,
      /BASE_URL='http:\/\/127\.0\.0\.1:\d+\/trial16'/,
      'installer script should embed the forwarded product prefix in the callback base URL',
    );
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

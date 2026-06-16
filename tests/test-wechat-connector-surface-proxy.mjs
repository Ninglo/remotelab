#!/usr/bin/env node
import assert from 'assert/strict';
import { spawn } from 'child_process';
import http from 'http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-session';

function randomPort(base = 41000) {
  return base + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(buffer, chunk, limit = 8000) {
  const next = `${buffer}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function formatStartupOutput(stdout, stderr) {
  const sections = [];
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  return sections.join('\n\n');
}

async function waitFor(predicate, description, timeoutMs = 12000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path, { method = 'GET', cookie = ownerCookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(headers && typeof headers === 'object' ? headers : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: body.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function setupTempHome(upstreamPort, chatPort) {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-wechat-surface-proxy-'));
  const configDir = join(home, '.config', 'remotelab');
  const connectorDir = join(configDir, 'wechat-connector');
  mkdirSync(connectorDir, { recursive: true });

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
    join(connectorDir, 'config.json'),
    JSON.stringify({
      storageDir: connectorDir,
      chatBaseUrl: `http://127.0.0.1:${chatPort}`,
      login: {
        qrBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        statusPollIntervalMs: 20,
        statusTimeoutMs: 200,
        waitTimeoutMs: 60_000,
      },
      surface: {
        enabled: true,
        port: 0,
        entryPath: '/login',
      },
    }, null, 2),
    'utf8',
  );

  return {
    home,
    configDir,
    connectorDir,
    configPath: join(connectorDir, 'config.json'),
  };
}

async function startChatServer({ home, configDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        const output = formatStartupOutput(stdout, stderr);
        throw new Error(
          output
            ? `chat-server exited during startup with ${exitLabel}\n\n${output}`
            : `chat-server exited during startup with ${exitLabel}`,
        );
      }
      try {
        const res = await request(port, '/login', { cookie: '' });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'chat server startup');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) throw error;
    throw new Error(`${error.message}\n\n${output}`);
  }

  return { child };
}

async function startConnectorProcess({ home, configDir, configPath }) {
  const child = spawn(process.execPath, ['scripts/wechat-connector.mjs', '--config', configPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      REMOTELAB_CONFIG_DIR: configDir,
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        const output = formatStartupOutput(stdout, stderr);
        throw new Error(
          output
            ? `wechat connector exited during startup with ${exitLabel}\n\n${output}`
            : `wechat connector exited during startup with ${exitLabel}`,
        );
      }
      const manifestPath = join(configDir, 'connector-surfaces', 'wechat.json');
      return existsSync(manifestPath);
    }, 'wechat connector surface registration');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) throw error;
    throw new Error(`${error.message}\n\n${output}`);
  }

  return { child };
}

async function stopChild(server, label) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, `${label} shutdown`);
}

async function startUpstreamServer(port) {
  let qrFetchCount = 0;
  let statusPollCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/ilink/bot/get_bot_qrcode') {
      qrFetchCount += 1;
      const qrId = qrFetchCount >= 2 ? 'qr_test_2' : 'qr_test_1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        qrcode: qrId,
        qrcode_img_content: `http://127.0.0.1:${port}/qr/${qrId}.png`,
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ilink/bot/get_qrcode_status') {
      statusPollCount += 1;
      const qrCode = url.searchParams.get('qrcode');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (qrCode === 'qr_test_1') {
        res.end(JSON.stringify({ status: 'expired' }));
        return;
      }
      res.end(JSON.stringify({ status: 'wait' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/qr/qr_test_1.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('qr-one'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/qr/qr_test_2.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('qr-two'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    getMetrics() {
      return { qrFetchCount, statusPollCount };
    },
  };
}

async function stopUpstreamServer(handle) {
  if (!handle?.server) return;
  await new Promise((resolve) => handle.server.close(resolve));
}

async function killDetachedLoginWorker(connectorDir) {
  const pidPath = join(connectorDir, 'login.pid');
  if (!existsSync(pidPath)) return;
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

async function main() {
  const upstreamPort = randomPort(52000);
  const chatPort = randomPort(44000);
  const qrTwoUrl = `http://127.0.0.1:${upstreamPort}/qr/qr_test_2.png`;
  const upstream = await startUpstreamServer(upstreamPort);
  const { home, configDir, connectorDir, configPath } = setupTempHome(upstreamPort, chatPort);
  let chatServer = null;
  let connector = null;

  try {
    chatServer = await startChatServer({ home, configDir, port: chatPort });
    connector = await startConnectorProcess({ home, configDir, configPath });

    const surfaceInfo = await waitFor(async () => {
      const res = await request(chatPort, '/api/connectors/wechat/surface');
      if (res.status !== 200) return false;
      const payload = JSON.parse(res.text);
      return payload.entryUrl === '/connectors/wechat/login' ? payload : false;
    }, 'proxied connector surface info');
    assert.equal(surfaceInfo.allowEmbed, true);
    assert.equal(surfaceInfo.surfaceType, 'login');
    assert.equal(surfaceInfo.embed?.mode, 'iframe');
    assert.equal(surfaceInfo.surface?.requiresUserAction?.href, '/connectors/wechat/login');

    const surfaceList = await request(chatPort, '/api/connectors/surfaces');
    assert.equal(surfaceList.status, 200, 'surface list should expose connector-owned surfaces');
    const surfaceListPayload = JSON.parse(surfaceList.text);
    const listedWechat = Array.isArray(surfaceListPayload?.surfaces)
      ? surfaceListPayload.surfaces.find((item) => item?.connectorId === 'wechat')
      : null;
    assert.equal(listedWechat?.entryUrl, '/connectors/wechat/login');

    const page = await request(chatPort, '/connectors/wechat/login');
    assert.equal(page.status, 200, 'proxied connector page should render');
    assert.match(page.text, /Connect This Workspace/);

    const prefixedSurfaceInfo = await request(chatPort, '/api/connectors/wechat/surface', {
      headers: { 'x-forwarded-prefix': '/owner' },
    });
    assert.equal(prefixedSurfaceInfo.status, 200, 'prefixed connector surface info should resolve');
    const prefixedSurfacePayload = JSON.parse(prefixedSurfaceInfo.text);
    assert.equal(
      prefixedSurfacePayload.surface?.requiresUserAction?.href,
      '/owner/connectors/wechat/login',
      'prefixed connector surface info should advertise public-prefixed login href',
    );

    const prefixedPage = await request(chatPort, '/connectors/wechat/login', {
      headers: { 'x-forwarded-prefix': '/owner' },
    });
    assert.equal(prefixedPage.status, 200, 'prefixed proxied connector page should render');
    assert.match(
      prefixedPage.text,
      /var statusEndpoint = '\/owner\/connectors\/wechat\/login\/status';/,
      'prefixed proxied connector page should keep status requests on the public-prefixed path',
    );
    assert.match(
      prefixedPage.text,
      /var qrEndpoint = '\/owner\/connectors\/wechat\/login\/qr';/,
      'prefixed proxied connector page should keep QR requests on the public-prefixed path',
    );

    const surfaceState = await waitFor(async () => {
      const res = await request(chatPort, '/connectors/wechat/login/status');
      if (res.status !== 200) return false;
      const payload = JSON.parse(res.text);
      return payload.qrcodeVersion ? payload : false;
    }, 'proxied connector status should expose refreshed QR');
    assert.equal(surfaceState.capabilityState, 'authorization_required');
    const signedLoginLink = new URL(surfaceState.loginLinkPath, 'http://127.0.0.1');
    assert.equal(signedLoginLink.pathname, '/connectors/wechat/login/open');
    assert.ok(signedLoginLink.searchParams.get('lid'));
    assert.match(String(signedLoginLink.searchParams.get('sig') || ''), /^[a-f0-9]{32}$/);

    const qrImage = await request(chatPort, `/connectors/wechat/login/qr?v=${surfaceState.qrcodeVersion}`);
    assert.equal(qrImage.status, 200, 'proxied connector QR path should serve current image');
    assert.match(String(qrImage.headers['content-type'] || ''), /^image\/png/);
    assert.deepEqual(qrImage.body.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const unsignedOpenLink = await request(chatPort, '/connectors/wechat/login/open', { cookie: '' });
    assert.equal(unsignedOpenLink.status, 302, 'bare proxied login link should stay behind the normal login gate');
    assert.equal(unsignedOpenLink.headers.location, '/login');

    const openLink = await request(chatPort, surfaceState.loginLinkPath, { cookie: '' });
    assert.equal(openLink.status, 302, 'proxied stable login link should redirect to the current upstream login URL');
    assert.equal(openLink.headers.location, qrTwoUrl);

    const metrics = upstream.getMetrics();
    assert.ok(metrics.qrFetchCount >= 2, 'connector-owned login flow should refresh expired QR');
    assert.ok(metrics.statusPollCount >= 1, 'connector-owned login flow should poll upstream status');
  } finally {
    await stopChild(connector, 'wechat connector');
    await stopChild(chatServer, 'chat server');
    await killDetachedLoginWorker(connectorDir);
    await stopUpstreamServer(upstream);
    rmSync(home, { recursive: true, force: true });
  }
}

await main();

console.log('ok - connector surface info is exposed through the main instance');
console.log('ok - connector-owned login page is proxied through /connectors/:id');
console.log('ok - connector-owned QR refresh survives expiry behind the same proxied mount');

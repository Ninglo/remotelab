#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-owner-session';

function randomPort() {
  return 41000 + Math.floor(Math.random() * 10000);
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

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-mobile-install-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-owner-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
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
            ? `Server exited during startup with ${exitLabel}\n\n${output}`
            : `Server exited during startup with ${exitLabel}`,
        );
      }
      try {
        const res = await request(port, 'GET', '/login');
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) throw error;
    throw new Error(`${error.message}\n\n${output}`);
  }

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const unauthenticatedInstall = await request(port, 'GET', '/m/install');
    assert.equal(unauthenticatedInstall.status, 302, 'mobile install page should require auth or an install handoff');
    assert.equal(unauthenticatedInstall.headers.location, '/login');

    const authenticatedInstall = await request(port, 'GET', '/m/install?source=auto', {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(authenticatedInstall.status, 302, 'owner install entry should mint a handoff and redirect');
    assert.match(authenticatedInstall.headers.location || '', /^\/m\/install\?h=ih_[a-f0-9]{48}&source=auto$/);
    const redirectedUrl = new URL(authenticatedInstall.headers.location, `http://127.0.0.1:${port}`);
    const handoffToken = redirectedUrl.searchParams.get('h') || '';

    const installPage = await request(port, 'GET', redirectedUrl.pathname + redirectedUrl.search);
    assert.equal(installPage.status, 200, 'install page should render with a handoff token');
    assert.match(installPage.text, /window\.__REMOTELAB_BOOTSTRAP__ = /, 'install page should inline bootstrap data');
    assert.match(
      installPage.text,
      new RegExp(`manifest\\.install\\.json\\?h=${handoffToken}`),
      'install page should point installable browsers at the handoff-aware manifest',
    );
    assert.match(
      installPage.text,
      /resolveProductPath\(`\/m\/continue\?h=\$\{encodeURIComponent\(handoffToken\)\}`\)/,
      'install page should continue through the handoff-aware bridge',
    );
    assert.match(
      installPage.text,
      /resolveProductPath\(`\/sw\.js\?v=\$\{encodeURIComponent\(buildInfo\.assetVersion \|\| 'dev'\)\}`\)/,
      'install page should register the service worker through the shared product-path resolver',
    );
    assert.match(
      installPage.text,
      /chat\/product-paths\.js\?v=/,
      'install page should load the shared product-path helper before runtime redirects',
    );

    const prefixedInstallPage = await request(port, 'GET', redirectedUrl.pathname + redirectedUrl.search, {
      headers: {
        'x-forwarded-prefix': '/owner',
      },
    });
    assert.equal(prefixedInstallPage.status, 200, 'install page should still render behind a forwarded product prefix');
    assert.match(prefixedInstallPage.text, /<base href="\/owner\/">/, 'install page should advertise the forwarded product prefix through base href');
    assert.match(prefixedInstallPage.text, /<link rel="manifest" href="manifest\.install\.json\?h=/, 'install page should keep the install manifest link relative inside a prefixed surface');
    assert.match(prefixedInstallPage.text, /<script src="chat\/product-paths\.js\?v=/, 'install page should keep shared product-path helpers inside the forwarded product scope');

    const installManifest = await request(port, 'GET', `/manifest.install.json?h=${encodeURIComponent(handoffToken)}`);
    assert.equal(installManifest.status, 200, 'handoff install manifest should render');
    const installManifestJson = JSON.parse(installManifest.text);
    assert.equal(
      installManifestJson.start_url,
      `m/install?h=${handoffToken}`,
      'install manifest should boot back into the install bridge with the handoff token',
    );

    const redeem = await request(port, 'POST', '/api/install/handoff/redeem', {
      body: { token: handoffToken },
    });
    assert.equal(redeem.status, 200, 'install handoff should redeem once');
    assert.match(String(redeem.headers['set-cookie'] || ''), /session_token=/, 'redeem should set a fresh owner session cookie');
    assert.match(String(redeem.headers['set-cookie'] || ''), /SameSite=Lax/i, 'redeemed owner session should use PWA-friendly SameSite');

    const redeemedBody = JSON.parse(redeem.text);
    assert.equal(redeemedBody.ok, true);
    assert.equal(redeemedBody.redirect, '/');

    const redeemAgain = await request(port, 'POST', '/api/install/handoff/redeem', {
      body: { token: handoffToken },
    });
    assert.equal(redeemAgain.status, 200, 'install handoff should be reusable within TTL');

    const continueInstall = await request(port, 'GET', '/m/install?source=auto', {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(continueInstall.status, 302, 'browser continue should start from a fresh install handoff');
    const continueUrl = new URL(continueInstall.headers.location || '', `http://127.0.0.1:${port}`);
    const continueHandoffToken = continueUrl.searchParams.get('h') || '';

    const continueBridge = await request(port, 'GET', `/m/continue?h=${encodeURIComponent(continueHandoffToken)}`);
    assert.equal(continueBridge.status, 302, 'browser continue bridge should redirect into the main app');
    assert.equal(continueBridge.headers.location, '/?skipInstall=1');
    assert.match(
      String(continueBridge.headers['set-cookie'] || ''),
      /session_token=/,
      'browser continue bridge should set a fresh owner session cookie',
    );

    const continueBridgeAgain = await request(port, 'GET', `/m/continue?h=${encodeURIComponent(continueHandoffToken)}`);
    assert.equal(continueBridgeAgain.status, 302, 'browser continue handoffs should be reusable within TTL');
    assert.equal(continueBridgeAgain.headers.location, '/?skipInstall=1');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

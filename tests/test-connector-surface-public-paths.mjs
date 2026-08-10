#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-connector-public-paths-'));
const tempConfigDir = join(tempHome, '.config', 'remotelab');

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = tempConfigDir;
process.env.SECURE_COOKIES = '0';

await mkdir(tempConfigDir, { recursive: true });
await writeFile(join(tempConfigDir, 'auth.json'), JSON.stringify({ token: 'owner_token_1' }, null, 2));

const {
  registerConnectorSurface,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-surface-registry.mjs')).href);
const {
  requireAuth,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'middleware.mjs')).href);
const {
  handleConnectorSurfaceRoutes,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'router-connector-routes.mjs')).href);

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(payload = '') {
      this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      path: req.url,
      forwardedPrefix: req.headers['x-forwarded-prefix'] || '',
      transferEncoding: req.headers['transfer-encoding'] || '',
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
});

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

try {
  const port = upstream.address().port;
  await registerConnectorSurface({
    connectorId: 'public-demo',
    title: 'Public Demo',
    baseUrl: `http://127.0.0.1:${port}`,
    entryPath: '/',
    publicPaths: ['/webhook'],
  });

  const publicReq = {
    method: 'GET',
    url: '/connectors/public-demo/webhook?ping=1',
    headers: {},
    socket: {},
  };
  const publicAuthRes = createMockResponse();
  assert.equal(
    await requireAuth(publicReq, publicAuthRes),
    true,
    'public connector paths should bypass auth middleware',
  );

  const publicProxyRes = createMockResponse();
  const publicHandled = await handleConnectorSurfaceRoutes({
    req: publicReq,
    res: publicProxyRes,
    pathname: '/connectors/public-demo/webhook',
    authSession: null,
    writeJson,
    buildHeaders: (headers) => headers,
    nonce: 'nonce',
  });
  assert.equal(publicHandled, true, 'public connector path should be proxied');
  assert.equal(publicProxyRes.statusCode, 200);
  assert.deepEqual(JSON.parse(publicProxyRes.body.toString('utf8')), {
    ok: true,
    path: '/webhook?ping=1',
    forwardedPrefix: '/connectors/public-demo',
    transferEncoding: '',
    body: '',
  });

  const chunkedPostReq = Object.assign(Readable.from(['{"ping":true}']), {
    method: 'POST',
    url: '/connectors/public-demo/webhook',
    headers: {
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
    },
    socket: {},
  });
  const chunkedPostRes = createMockResponse();
  const chunkedPostHandled = await handleConnectorSurfaceRoutes({
    req: chunkedPostReq,
    res: chunkedPostRes,
    pathname: '/connectors/public-demo/webhook',
    authSession: null,
    writeJson,
    buildHeaders: (headers) => headers,
    nonce: 'nonce',
  });
  assert.equal(chunkedPostHandled, true, 'chunked public connector POST should be proxied');
  assert.equal(chunkedPostRes.statusCode, 200);
  assert.deepEqual(JSON.parse(chunkedPostRes.body.toString('utf8')), {
    ok: true,
    path: '/webhook',
    forwardedPrefix: '/connectors/public-demo',
    transferEncoding: '',
    body: '{"ping":true}',
  });

  const privateReq = {
    method: 'GET',
    url: '/connectors/public-demo/private',
    headers: {},
    socket: {},
  };
  const privateAuthRes = createMockResponse();
  assert.equal(
    await requireAuth(privateReq, privateAuthRes),
    false,
    'private connector paths should still require auth',
  );
  assert.equal(privateAuthRes.statusCode, 302);
  assert.equal(privateAuthRes.headers.Location, '/login');

  const privateProxyRes = createMockResponse();
  const privateHandled = await handleConnectorSurfaceRoutes({
    req: privateReq,
    res: privateProxyRes,
    pathname: '/connectors/public-demo/private',
    authSession: null,
    writeJson,
    buildHeaders: (headers) => headers,
    nonce: 'nonce',
  });
  assert.equal(privateHandled, true, 'private connector path should still be handled by proxy routes');
  assert.equal(privateProxyRes.statusCode, 403);
  assert.match(privateProxyRes.body.toString('utf8'), /Owner access required/);

  const gmailCallbackReq = {
    method: 'GET',
    url: '/api/connectors/gmail/google/callback?code=test-code&state=test-state',
    headers: {},
    socket: {},
  };
  const gmailCallbackAuthRes = createMockResponse();
  assert.equal(
    await requireAuth(gmailCallbackReq, gmailCallbackAuthRes),
    true,
    'gmail oauth callback should bypass auth middleware',
  );

  const calendarCallbackReq = {
    method: 'GET',
    url: '/api/connectors/calendar/google/callback?code=test-code&state=test-state',
    headers: {},
    socket: {},
  };
  const calendarCallbackAuthRes = createMockResponse();
  assert.equal(
    await requireAuth(calendarCallbackReq, calendarCallbackAuthRes),
    true,
    'calendar oauth callback should bypass auth middleware',
  );

  console.log('test-connector-surface-public-paths: ok');
} finally {
  upstream.close();
  await rm(tempHome, { recursive: true, force: true });
}

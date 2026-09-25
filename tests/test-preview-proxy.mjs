import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'remotelab-preview-proxy-'));
process.env.REMOTELAB_CONFIG_DIR = root;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://instance.example.test';
const { runPreviewCommand } = await import('../lib/preview-command.mjs');
const { handlePreviewProxy, PREVIEW_ROUTES_FILE } = await import('../chat/preview-proxy.mjs');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}
function request(port, path, method = 'GET', authorization = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: authorization ? { Authorization: authorization } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const unprotected = http.createServer((_req, res) => res.end('open'));
const bearerOnly = http.createServer((_req, res) => {
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="preview"' });
  res.end();
});
const privateService = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Basic dGVzdDp0ZXN0') {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="preview"' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(req.url);
});
const publicPort = await listen(unprotected);
const bearerPort = await listen(bearerOnly);
const privatePort = await listen(privateService);
const proxy = http.createServer(async (req, res) => {
  if (!await handlePreviewProxy(req, res, new URL(req.url, 'http://localhost').pathname)) {
    res.writeHead(404); res.end();
  }
});
const proxyPort = await listen(proxy);

try {
  await assert.rejects(
    runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(publicPort)]),
    /must require HTTP Basic authentication/,
  );
  await assert.rejects(
    runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(bearerPort)]),
    /must require HTTP Basic authentication/,
  );
  assert.equal(await request(proxyPort, '/preview/task-center/').then((x) => x.status), 404);

  await runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(privatePort), '--json']);
  assert.equal(JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'))['task-center'].port, privatePort);
  const unauthorized = await request(proxyPort, '/preview/task-center/');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers['www-authenticate'], /^Basic /);
  const authorized = await request(proxyPort, '/preview/task-center/data.json?fresh=1', 'GET', 'Basic dGVzdDp0ZXN0');
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body, '/data.json?fresh=1');
  assert.equal(authorized.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal((await request(proxyPort, '/preview/task-center/', 'POST')).status, 405);
  assert.equal((await request(proxyPort, '/preview/unknown/')).status, 404);
  await runPreviewCommand(['unexpose', '--slug', 'task-center', '--json']);
  assert.equal((await request(proxyPort, '/preview/task-center/')).status, 404);
  console.log('test-preview-proxy: ok');
} finally {
  await Promise.all([close(proxy), close(privateService), close(bearerOnly), close(unprotected)]);
  await rm(root, { recursive: true, force: true });
}

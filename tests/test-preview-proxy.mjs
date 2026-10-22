import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseUrl } from 'node:url';

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
function request(port, path, method = 'GET', authorization = '', headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...headers, ...(authorization ? { Authorization: authorization } : {}) } }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
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
  if (req.url === '/video.mp4') {
    assert.equal(req.headers.range, 'bytes=2-4');
    assert.equal(req.headers['if-range'], '"video-v1"');
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 2-4/10', 'Accept-Ranges': 'bytes', ETag: '"video-v1"' });
    res.end(req.method === 'HEAD' ? undefined : '234');
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ body, headers: req.headers, path: req.url }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(req.url);
});
const publicPort = await listen(unprotected);
const bearerPort = await listen(bearerOnly);
const privatePort = await listen(privateService);
const proxy = http.createServer(async (req, res) => {
  if (!await handlePreviewProxy(req, res, parseUrl(req.url).pathname)) {
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
  const rangeHeaders = { Range: 'bytes=2-4', 'If-Range': '"video-v1"' };
  const range = await request(proxyPort, '/preview/task-center/video.mp4', 'GET', 'Basic dGVzdDp0ZXN0', rangeHeaders);
  assert.equal(range.status, 206);
  assert.equal(range.body, '234');
  assert.equal(range.headers['content-range'], 'bytes 2-4/10');
  assert.equal(range.headers['content-length'], '3');
  assert.equal(range.headers['accept-ranges'], 'bytes');
  assert.equal(range.headers.etag, '"video-v1"');
  const head = await request(proxyPort, '/preview/task-center/video.mp4', 'HEAD', 'Basic dGVzdDp0ZXN0', rangeHeaders);
  assert.equal(head.status, 206);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '3');

  for (const invalidPath of ['/api/../admin', '/api/review?x=1', '/api/%72eview', '//api/review', 'api/review']) {
    await assert.rejects(runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(privatePort), '--replace', '--post-path', invalidPath]), /Invalid preview POST path/);
  }
  for (const invalidHeader of ['cookie', 'host', 'x-forwarded-host', 'x-real-ip', 'X-Review-Action']) {
    await assert.rejects(runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(privatePort), '--replace', '--forward-header', invalidHeader]), /Invalid preview request header/);
  }
  await runPreviewCommand(['expose', '--slug', 'read-only', '--port', String(privatePort)]);
  await runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(privatePort), '--replace', '--post-path', '/api/review', '--forward-header', 'x-review-action']);
  const configured = JSON.parse(await readFile(PREVIEW_ROUTES_FILE, 'utf8'))['task-center'];
  assert.deepEqual(configured, { port: privatePort, postPaths: ['/api/review'], requestHeaders: ['x-review-action'] });
  assert.equal((await request(proxyPort, '/preview/task-center/api/review', 'POST')).status, 401);
  const body = JSON.stringify({ note: '切分评审', version: 1 });
  const save = await request(proxyPort, '/preview/task-center/api/review?fresh=1', 'POST', 'Basic dGVzdDp0ZXN0', {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    'X-Review-Action': 'save', Cookie: 'main-session=private', 'X-Unregistered': 'private',
    Origin: 'https://instance.example.test', 'Sec-Fetch-Site': 'same-origin',
  }, body);
  assert.equal(save.status, 200);
  const echoed = JSON.parse(save.body);
  assert.equal(echoed.path, '/api/review?fresh=1');
  assert.equal(echoed.body, body);
  assert.equal(echoed.headers['x-review-action'], 'save');
  assert.equal(echoed.headers['content-type'], 'application/json');
  assert.equal(echoed.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(echoed.headers.origin, 'https://instance.example.test');
  assert.equal(echoed.headers['sec-fetch-site'], 'same-origin');
  assert.equal(echoed.headers.cookie, undefined);
  assert.equal(echoed.headers['x-unregistered'], undefined);
  for (const path of ['/api/other', '/api/review/child', '/api/review/', '/api/%72eview', '/api/../api/review']) {
    assert.equal((await request(proxyPort, `/preview/task-center${path}`, 'POST', 'Basic dGVzdDp0ZXN0')).status, 405);
  }
  assert.equal((await request(proxyPort, '/preview/task-center/api/review', 'DELETE', 'Basic dGVzdDp0ZXN0')).status, 405);
  assert.equal((await request(proxyPort, '/preview/read-only/api/review', 'POST', 'Basic dGVzdDp0ZXN0')).status, 405);
  await runPreviewCommand(['expose', '--slug', 'task-center', '--port', String(privatePort), '--replace']);
  assert.equal((await request(proxyPort, '/preview/task-center/api/review', 'POST', 'Basic dGVzdDp0ZXN0')).status, 405);
  await runPreviewCommand(['unexpose', '--slug', 'task-center', '--json']);
  assert.equal((await request(proxyPort, '/preview/task-center/')).status, 404);
  console.log('test-preview-proxy: ok');
} finally {
  await Promise.all([close(proxy), close(privateService), close(bearerOnly), close(unprotected)]);
  await rm(root, { recursive: true, force: true });
}

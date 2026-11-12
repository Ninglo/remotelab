import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const root = await mkdtemp(join(tmpdir(), 'employee-host-'));
setIsolatedTestHome(root); process.env.REMOTELAB_CONFIG_DIR = root;
const { createEmployeeHostHandler, loadEmployeeHosts } = await import('../chat/employee-host-proxy.mjs');
const { siteIdentityCsp, injectSiteIdentityHtml } = await import('../chat/site-identity-html.mjs');
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const listen = async s => { await new Promise(r => s.listen(0, '127.0.0.1', r)); return s.address().port; };
let identity = { id: 'fixture-a', name: '测试甲', auth_kind: 'feishu' }, fail = false;
const html = '<!doctype html><html><head><title>Fixture</title></head><body><header>Application</header><main>Fixture content</main><iframe src="/frame"></iframe></body></html>';
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/video')) { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-4/10', 'Content-Length': 3 }); res.end(req.method === 'HEAD' ? undefined : '234'); return; }
  if (req.url === '/page' || req.url === '/frame') { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'" }); res.end(gzipSync(req.url === '/frame' ? '<html><head></head><body>Frame</body></html>' : html)); return; }
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', ['lab_access=native; HttpOnly', 'employee_site_session=evil']);
  let body = ''; req.on('data', c => body += c); req.on('end', () => res.end(JSON.stringify({ path: req.url, headers: req.headers, body })));
});
const port = await listen(upstream);
let hosts = { 'fixture.test': { port, readPaths: ['^/(?:page|frame|echo|video|healthz)$'], postPaths: ['/review'], publicHealthPaths: ['/healthz'], forwardCookies: ['lab_access'] } };
const gate = async (req, res) => {
  if (identity && req.headers.cookie?.includes('fixture=valid')) return identity;
  const nav = /text\/html/.test(req.headers.accept || ''); res.writeHead(nav ? 302 : 401, nav ? { Location: '/site-login?returnTo=' + encodeURIComponent(req.url) } : {}); res.end(); return null;
};
const handler = createEmployeeHostHandler({ routes: async () => hosts, requirePerson: gate, login: async (req, res) => {
  res.writeHead(fail ? 503 : identity && req.headers.cookie?.includes('fixture=valid') ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ person: identity }));
} });
const server = http.createServer(async (req, res) => { if (await handlePreviewProxy(req, res, new URL(req.url, 'http://local').pathname)) return; if (!await handler(req, res)) { res.writeHead(418); res.end(); } });
const proxyPort = await listen(server), base = `http://127.0.0.1:${proxyPort}`;
const get = (path, opts = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + path, { method: opts.method || 'GET', headers: { Host: 'fixture.test', ...opts.headers } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
      const body = Buffer.concat(chunks).toString(); const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
      resolve({ status: res.statusCode, headers, text: async () => body, json: async () => JSON.parse(body) });
    });
  }); req.on('error', reject); req.end(opts.body);
});
const good = { Cookie: 'fixture=valid; lab_access=original; employee_site_session=private', 'x-remotelab-person-id': 'forged', Authorization: 'Bearer secret' };
try {
  assert.equal((await get('/page', { headers: { Accept: 'text/html' } })).status, 302);
  assert.equal((await get('/echo', { headers: { 'x-remotelab-person-id': 'forged' } })).status, 401);
  assert.equal((await get('/api/sessions', { headers: good })).status, 404);
  assert.equal((await get('/echo', { headers: { ...good, 'x-forwarded-host': 'evil.test' } })).status, 200);
  const echo = await get('/echo?run=exact', { headers: good }); const data = await echo.json();
  assert.equal(data.path, '/echo?run=exact'); assert.equal(data.headers['x-remotelab-person-id'], 'fixture-a');
  assert.equal(data.headers.cookie, 'lab_access=original'); assert.equal(data.headers.authorization, undefined);
  assert.deepEqual(echo.headers.getSetCookie(), ['lab_access=native; HttpOnly']);
  const page = await get('/page', { headers: good }); assert.equal((await page.text()).match(/src="\/site-identity.js"/g).length, 1);
  assert.equal(page.headers.get('content-encoding'), null); assert.equal(page.headers.get('content-length'), null);
  const range = await get('/video', { headers: { ...good, Range: 'bytes=2-4' } }); assert.equal(range.status, 206); assert.equal(await range.text(), '234');
  assert.equal((await get('/video', { method: 'HEAD', headers: good })).headers.get('content-length'), '3');
  assert.equal((await get('/healthz')).status, 200);
  assert.equal((await get('/review', { method: 'POST', headers: { ...good, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await get('/review', { method: 'POST', headers: { ...good, Origin: 'http://fixture.test' }, body: 'original' })).status, 200);
  const csp = siteIdentityCsp("default-src 'none'; script-src 'nonce-abc'; style-src 'none'", 'https://fixture.test');
  assert.match(csp, /https:\/\/fixture.test\/site-identity.js/); assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(injectSiteIdentityHtml(Buffer.from('<head><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;"></head>'), '', 'https://fixture.test').toString(), /https:\/\/fixture.test\/api\/site-login\/me/);
  await writeFile(join(root, 'employee-site-hosts.json'), JSON.stringify({ version: 1, hosts })); assert.equal((await loadEmployeeHosts(root))['fixture.test'].port, port);
  await writeFile(join(root, 'device-token'), 'fixture-device-token');
  await writeFile(join(root, 'preview-routes.json'), JSON.stringify({ device: { port, access: 'employee', postPaths: ['/push'], machinePaths: [{ method: 'POST', path: '/push', bearerTokenFile: join(root, 'device-token') }, { method: 'GET', path: '/demand', bearerTokenFile: join(root, 'device-token') }] } }));
  assert.equal((await get('/preview/device/push', { method: 'POST' })).status, 401);
  assert.equal((await get('/preview/device/push', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await get('/preview/device/push', { method: 'POST', headers: { Authorization: 'Bearer fixture-device-token' }, body: 'fixture' })).status, 200);
  assert.equal((await get('/preview/device/demand', { headers: { Authorization: 'Bearer fixture-device-token' } })).status, 200);
  assert.equal((await get('/preview/device/echo', { headers: { Authorization: 'Bearer fixture-device-token' } })).status, 401);
  if (process.env.EMPLOYEE_TEST_PLAYWRIGHT && process.env.EMPLOYEE_TEST_CHROME) {
    hosts['127.0.0.1'] = hosts['fixture.test'];
    const { chromium } = await import(pathToFileURL(process.env.EMPLOYEE_TEST_PLAYWRIGHT));
    const browser = await chromium.launch({ executablePath: process.env.EMPLOYEE_TEST_CHROME, args: ['--no-sandbox'] });
    try {
      const context = await browser.newContext(); await context.addCookies([{ name: 'fixture', value: 'valid', url: base }]);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 }); await page.goto(base + '/page');
        await page.locator('#remotelab-site-identity').filter({ hasText: '飞书认证：测试甲' }).waitFor();
        assert.equal(await page.locator('#remotelab-site-identity').count(), 1);
        assert.equal(await page.frameLocator('iframe').locator('#remotelab-site-identity').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok((await page.locator('header').boundingBox()).y >= 44);
      }
      identity = { id: 'fixture-b', name: '<img src=x onerror=alert(1)>', auth_kind: 'feishu' };
      await page.evaluate(() => window.RemoteLabSiteIdentity.refresh());
      assert.equal(await page.locator('#remotelab-site-identity img').count(), 0);
      assert.match(await page.locator('#remotelab-site-identity').textContent(), /飞书认证：<img/);
      identity = null; await page.evaluate(() => window.RemoteLabSiteIdentity.refresh());
      assert.match(await page.locator('#remotelab-site-identity').textContent(), /已失效/);
      fail = true; await page.evaluate(() => window.RemoteLabSiteIdentity.refresh());
      assert.match(await page.locator('#remotelab-site-identity').textContent(), /暂未核验/); assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
  console.log('Employee hosts: authentication, host isolation, cookies, CSRF, compressed HTML, Range, device-only routes, single badge and identity expiry PASS');
} finally { server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); await rm(root, { recursive: true, force: true }); }

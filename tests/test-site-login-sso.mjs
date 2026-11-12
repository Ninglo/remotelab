import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'site-sso-'));
setIsolatedTestHome(root); process.env.REMOTELAB_CONFIG_DIR = root;
const { createEmployeeSiteIdentity } = await import('../lib/employee-site-identity.mjs');
const { createSiteLoginHandler } = await import('../chat/router-site-login.mjs');
const { createEmployeeSiteAccess } = await import('../chat/employee-site-auth.mjs');
const { createEmployeeHostHandler } = await import('../chat/employee-host-proxy.mjs');
const { validateSiteSsoSettings, siteLoginConfigured } = await import('../lib/site-publication-policy.mjs');
const issuer = 'https://index.sso.test', first = 'https://results.sso.test', second = 'https://supervision.sso.test';
const person = { id: 'fixture-person', name: 'SSO测试员工', identities: [{ kind: 'feishu', realm: 'fixture', subjectId: 'fixture-open' }] };
let now = Date.now(), providerCalls = 0, tenant = 'fixture-company';
const cfg = { realm: 'fixture', tenantKey: tenant, feishuConfigPath: join(root, 'app.json'), sso: { issuerOrigin: issuer } };
await writeFile(cfg.feishuConfigPath, '{"appId":"fixture","appSecret":"fixture-only"}');
await writeFile(join(root, 'site-login.json'), JSON.stringify(cfg));
const makeIdentity = () => createEmployeeSiteIdentity({ configDir: root, now: () => now, authDocument: async () => ({ people: [person] }), registerIdentity: async () => person,
  fetchImpl: async url => {
    providerCalls++;
    const data = url.includes('device_authorization') ? { device_code: 'fixture', verification_uri_complete: 'https://accounts.feishu.cn/fixture', interval: 5, expires_in: 600 }
      : url.includes('/oauth/token') ? { access_token: 'fixture-token' } : { code: 0, data: { open_id: 'fixture-open', name: person.name, tenant_key: tenant } };
    return { ok: true, json: async () => data };
  } });
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };
const upstream = http.createServer((req, res) => {
  if (req.url === '/video') { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-2/3' }); res.end('abc'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><head><title>SSO fixture</title></head><body><h1>Internal fixture</h1></body>');
});
const upstreamPort = await listen(upstream);
let hosts = Object.fromEntries([first, second].map(origin => [new URL(origin).host, { port: upstreamPort, readPaths: ['^/(?:ui|video|healthz)$'], publicHealthPaths: ['/healthz'] }]));
let identity, personFor, login, host;
function restart() {
  identity = makeIdentity(); personFor = createEmployeeSiteAccess(identity, async () => null);
  login = createSiteLoginHandler({ identity, personFor, ssoOptions: { configDir: root, now: () => now, loadHosts: async () => hosts } });
  host = createEmployeeHostHandler({ routes: async () => hosts, login, requirePerson: async (req, res) => {
    const value = await personFor(req, res);
    if (!value) { res.writeHead(/text\/html/.test(req.headers.accept || '') ? 302 : 401, { Location: '/site-login?returnTo=' + encodeURIComponent(req.url) }); res.end(); }
    return value;
  } });
}
restart();
const serve = async (req, res) => {
  try {
    if (await host(req, res)) return;
    const path = new URL(req.url, issuer).pathname;
    if (await login(req, res, path)) return;
    if (path === '/site-login.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('../static/site-login.js', import.meta.url))); return; }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(error.message); }
};
const server = http.createServer(serve);
const port = await listen(server);
const request = (origin, path, { headers = {}, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...headers, host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'https' } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
      const output = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : [value]) output.append(name, item);
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: output }));
    });
  }); req.on('error', reject); req.end(body);
});
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; ');
const next = response => new URL(response.headers.get('location'), issuer);
async function authorizeDevice() {
  const pending = await request(issuer, '/api/site-login/start', { method: 'POST', headers: { Origin: issuer } });
  assert.equal(pending.status, 200, await pending.clone().text());
  now += 5000;
  const result = await request(issuer, '/api/site-login/poll', { headers: { Cookie: cookie(pending) } });
  assert.equal((await result.clone().json()).state, 'connected');
  return cookie(result);
}
async function start(origin = first, target = '/ui#platform?run=historical') {
  const response = await request(origin, '/api/site-login/sso/start?returnTo=' + encodeURIComponent(target));
  assert.equal(response.status, 303); return { response, binding: cookie(response), url: next(response) };
}
async function grant(flow, session) {
  const response = await request(issuer, flow.url.pathname + flow.url.search, { headers: { Cookie: session } });
  assert.equal(response.status, 303); return next(response);
}
async function callback(url, binding) { return request(url.origin, url.pathname + url.search, { headers: { Cookie: binding } }); }
try {
  assert.equal(await siteLoginConfigured(root), true);
  assert.throws(() => validateSiteSsoSettings({ ...cfg, sso: { issuerOrigin: 'https://issuer.test/unsafe' } }));
  assert.throws(() => validateSiteSsoSettings({ ...cfg, sso: { issuerOrigin: 'http://issuer.test' } }));
  assert.equal(await identity.sessionForTransfer({ headers: {} }, { id: person.id, auth_kind: 'feishu' }), null, 'a supplied Person object is not a verified session');
  const session = await authorizeDevice(), baseline = providerCalls;
  const flow = await start();
  assert.match(flow.binding, /^__Host-employee_sso_/);
  assert.match(flow.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const anonymous = await request(issuer, flow.url.pathname + flow.url.search);
  assert.equal(anonymous.status, 303); assert.match(anonymous.headers.get('location'), /^\/site-login\?returnTo=/);
  const code = await grant(flow, session);
  assert.equal(code.origin, first); assert.ok(!code.href.includes(session.split('=')[1]));
  assert.equal((await callback(code, '')).status, 400, 'a code cannot log a different browser in');
  assert.equal((await callback(new URL(code.pathname + code.search, second), flow.binding)).status, 400, 'code is bound to exact audience');
  restart();
  const done = await callback(code, flow.binding);
  assert.equal(done.status, 303); assert.equal(done.headers.get('location'), '/ui#platform?run=historical');
  assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(cookie(done), session, 'independent host cookies reference the same revocable employee session');
  assert.equal((await callback(code, flow.binding)).status, 400, 'code is one-use across controller restarts');
  assert.equal((await request(first, '/ui', { headers: { Cookie: cookie(done) } })).status, 200);
  assert.equal((await request(first, '/video', { headers: { Cookie: cookie(done), Range: 'bytes=0-2' } })).status, 206);
  assert.equal((await request(first, '/api/sessions', { headers: { Cookie: cookie(done) } })).status, 404);
  assert.equal((await request(first, '/video')).status, 401);
  assert.equal((await request(first, '/healthz')).status, 200);
  assert.equal((await request('https://unregistered.sso.test', '/api/site-login/sso/config')).status, 400);
  for (const target of ['https://evil.test', '//evil.test', '/\\evil.test', '/api/site-login/sso/callback', '/site-login']) {
    assert.equal((await request(first, '/api/site-login/sso/start?returnTo=' + encodeURIComponent(target))).status, 400);
  }
  assert.equal((await request(first, '/api/site-login/sso/start', { method: 'POST' })).status, 405);
  const parallel = await Promise.all([start(), start()]);
  assert.notEqual(parallel[0].binding, parallel[1].binding);
  for (const pending of parallel) assert.equal((await callback(await grant(pending, session), pending.binding)).status, 303);
  const race = await start(), raceCode = await grant(race, session);
  assert.deepEqual((await Promise.all([callback(raceCode, race.binding), callback(raceCode, race.binding)])).map(r => r.status).sort(), [303, 400]);
  const expired = await start(), expiredCode = await grant(expired, session); now += 61000;
  assert.equal((await callback(expiredCode, expired.binding)).status, 400);
  const oldRequest = await start(); now += 601000;
  assert.equal((await request(issuer, oldRequest.url.pathname + oldRequest.url.search, { headers: { Cookie: session } })).status, 400);
  const future = 'https://new.sso.test'; hosts[new URL(future).host] = hosts[new URL(first).host];
  const futureFlow = await start(future);
  assert.equal((await callback(await grant(futureFlow, session), futureFlow.binding)).status, 303, 'new registered host joins without another client list');
  assert.equal(providerCalls, baseline, 'cross-domain transfers never repeat Feishu authorization');
  const revoked = await start(), revokedCode = await grant(revoked, session);
  assert.equal((await request(second, '/api/site-login/logout', { method: 'POST', headers: { Origin: second, Cookie: session } })).status, 200);
  assert.equal((await callback(revokedCode, revoked.binding)).status, 400, 'logout invalidates an outstanding grant');
  for (const origin of [issuer, first, second]) assert.equal((await request(origin, '/api/site-login/me', { headers: { Cookie: session } })).status, 401);

  if (process.env.EMPLOYEE_TEST_PLAYWRIGHT && process.env.EMPLOYEE_TEST_CHROME) {
    const { chromium } = await import(pathToFileURL(process.env.EMPLOYEE_TEST_PLAYWRIGHT));
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt'), '-days', '1', '-subj', '/CN=fixture.sso.test']);
    const tls = https.createServer({ key: await readFile(join(root, 'tls.key')), cert: await readFile(join(root, 'tls.crt')) }, serve);
    const tlsPort = await listen(tls);
    const browser = await chromium.launch({ executablePath: process.env.EMPLOYEE_TEST_CHROME, args: ['--no-sandbox', '--no-proxy-server', `--host-resolver-rules=MAP *.sso.test 127.0.0.1:${tlsPort}`] });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
      // Real HTTPS and browser cookie/redirect behavior. Only the external
      // Feishu provider is fixture-backed; no production credentials are used.
      const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(first + '/ui#platform?run=deep-original');
      await page.locator('#authorize').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).origin, issuer);
      now += 5000;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForURL(first + '/ui#platform?run=deep-original');
      await page.locator('#remotelab-site-identity').filter({ hasText: '飞书认证：SSO测试员工' }).waitFor();
      const afterFirst = providerCalls;
      for (const origin of [second, future, first]) {
        await page.setViewportSize({ width: origin === future ? 1440 : 390, height: 844 });
        await page.goto(origin + '/ui#platform?run=another');
        await page.waitForURL(origin + '/ui#platform?run=another');
        await page.locator('#remotelab-site-identity').filter({ hasText: '飞书认证：SSO测试员工' }).waitFor();
        assert.equal(await page.locator('#remotelab-site-identity').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      assert.equal(providerCalls, afterFirst);
      const cookies = (await context.cookies()).filter(c => c.name === 'employee_site_session');
      assert.equal(cookies.length, 4); assert.equal(new Set(cookies.map(c => c.value)).size, 1);
      assert.ok(cookies.every(c => !c.domain.startsWith('.') && c.httpOnly && c.secure));
      const page2 = await context.newPage(); await page2.goto(second + '/ui');
      await page.evaluate(() => fetch('/api/site-login/logout', { method: 'POST' }));
      await page2.evaluate(() => window.RemoteLabSiteIdentity.refresh());
      await page2.locator('#remotelab-site-identity').filter({ hasText: '飞书认证已失效' }).waitFor();
      assert.deepEqual(errors, []);
      console.log('Browser SSO: first Feishu fixture, four distinct origins, deep fragments, one identity, mobile layout and cross-site logout PASS');
    } finally { await browser.close(); await new Promise(r => tls.close(r)); }
  }
  console.log('Site SSO: origin/browser binding, replay race, expiry, restart, future host, original ingress restrictions, shared revocation and provider-call count PASS');
} finally {
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
  await rm(root, { recursive: true, force: true });
}

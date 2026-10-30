import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'employee-site-login-'));
setIsolatedTestHome(root);
delete process.env.REMOTELAB_SESSION_ID;
delete process.env.REMOTELAB_REQUEST_ID;
process.env.REMOTELAB_CONFIG_DIR = root;
process.env.REMOTELAB_PUBLIC_PAGES_DIR = join(root, 'pages');
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://sites.example.test';
process.env.REMOTELAB_PUBLIC_PAGES_BASE_URL = 'https://sites.example.test/public-pages';
const config = { realm: 'fixture-app', tenantKey: 'fixture-company', personIds: [], feishuConfigPath: join(root, 'app.json') };
await writeFile(join(root, 'site-login.json'), JSON.stringify(config));
await writeFile(config.feishuConfigPath, JSON.stringify({ appId: 'fixture-app', appSecret: 'fixture-secret' }));
const people = [{ id: 'person_fixture_a', name: '测试员工甲', identities: [{ id: 'identity_fixture_a', kind: 'feishu', realm: config.realm, subjectId: 'fixture-open-a' }], credentials: [] },
  { id: 'person_fixture_b', name: '测试员工乙', identities: [{ id: 'identity_fixture_b', kind: 'feishu', realm: config.realm, subjectId: 'fixture-open-b' }], credentials: [] }];
const auth = await import('../lib/auth-config.mjs');
await auth.updateAuthDocument(d => { d.people.push(...people); });
const { createEmployeeSiteIdentity } = await import('../lib/employee-site-identity.mjs');
const { createEmployeeSiteAccess } = await import('../chat/employee-site-auth.mjs');
const { createSiteLoginHandler } = await import('../chat/router-site-login.mjs');
const { checkEmployeeStaticAccess } = await import('../chat/employee-static-access.mjs');
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const { publishStaticSource } = await import('../lib/static-publish-command.mjs');
const { runPreviewCommand } = await import('../lib/preview-command.mjs');
const { isAuthenticated } = await import('../lib/auth.mjs');
let now = Date.now(), calls = 0, tenant = config.tenantKey, tokenResponse;
const makeIdentity = () => createEmployeeSiteIdentity({ configDir: root, now: () => now,
  authDocument: () => auth.loadAuthDocument({ persistMigration: false }), registerIdentity: async () => people[0],
  fetchImpl: async url => {
    calls++;
    const value = url.includes('device_authorization') ? { device_code: 'fixture-device', verification_uri_complete: 'https://accounts.feishu.cn/fixture', expires_in: 600, interval: 5 }
      : url.includes('/oauth/token') ? tokenResponse || { access_token: 'fixture-token' }
        : { code: 0, data: { open_id: 'fixture-open-a', tenant_key: tenant, name: people[0].name } };
    return { ok: !value.error, json: async () => value };
  } });
let identity = makeIdentity();
let login = createSiteLoginHandler({ identity, personFor: createEmployeeSiteAccess(identity, async () => null) });
const source = join(root, 'source'); await mkdir(source);
await writeFile(join(source, 'index.html'), '<!doctype html><title>员工站点测试</title><h1>隔离测试内容</h1>');
await writeFile(join(source, 'data.json'), '{"fixture":"private"}');
const one = await publishStaticSource({ source, slug: 'one', ownerPersonId: people[0].id, verify: false });
const two = await publishStaticSource({ source, slug: 'two', ownerPersonId: people[1].id, verify: false });
assert.equal(one.access, 'employee'); assert.equal(one.ownerPersonId, people[0].id); assert.deepEqual(one.adminPersonIds, []);
assert.equal((await publishStaticSource({ source, slug: 'one', ownerPersonId: people[1].id, replace: true, verify: false })).ownerPersonId, people[0].id);
await assert.rejects(publishStaticSource({ source, slug: 'no-owner', verify: false }), /Cannot identify site creator/);
await assert.rejects(publishStaticSource({ source, slug: 'bad-ingress', ownerPersonId: people[0].id, publicBaseUrl: 'https://other.test/public-pages', verify: false }), /managed instance/);
await writeFile(join(root, 'site-login.json'), JSON.stringify({ ...config, enabled: false }));
await assert.rejects(publishStaticSource({ source, slug: 'disabled', ownerPersonId: people[0].id, verify: false }), /disabled/);
await writeFile(join(root, 'site-login.json'), JSON.stringify({ realm: config.realm }));
await assert.rejects(publishStaticSource({ source, slug: 'incomplete', ownerPersonId: people[0].id, verify: false }), /Incomplete employee login/);
await writeFile(join(root, 'site-login.json'), JSON.stringify(config));
const { requests } = await import('../chat/requests.mjs');
process.env.REMOTELAB_SESSION_ID = 'fixture-current-session'; process.env.REMOTELAB_REQUEST_ID = 'fixture-current-request';
await requests.accept({ sessionId: process.env.REMOTELAB_SESSION_ID, requestId: process.env.REMOTELAB_REQUEST_ID, text: 'Fixture creation request', options: { viewPersonId: people[1].id, initiatedByIdentityId: people[1].identities[0].id } });
assert.equal((await publishStaticSource({ source, slug: 'attributed', verify: false })).ownerPersonId, people[1].id, 'new site owner follows the current accepted input');
delete process.env.REMOTELAB_SESSION_ID; delete process.env.REMOTELAB_REQUEST_ID;
await publishStaticSource({ source, slug: 'public', access: 'public', verify: false });
const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
await runPreviewCommand(['expose', '--slug', 'dynamic', '--port', String(upstream.address().port), '--owner', people[0].id, '--post-path', '/save']);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (await login(req, res, pathname)) return;
    if (await checkEmployeeStaticAccess(req, res, pathname)) return;
    if (await handlePreviewProxy(req, res, pathname)) return;
    if (pathname === '/api/auth/me') { res.writeHead(await isAuthenticated(req) ? 200 : 401); res.end(); return; }
    if (pathname === '/api/qianyan/internal/auth/me') {
      const person = await identity.member(req, null);
      if (person) { const renewed = await identity.renew(req, person); if (renewed) res.setHeader('Set-Cookie', renewed); }
      res.writeHead(person ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ person })); return;
    }
    if (pathname === '/site-login.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('../static/site-login.js', import.meta.url))); return;
    }
    if (pathname.startsWith('/public-pages/')) {
      res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json');
      res.end(await readFile(join(process.env.REMOTELAB_PUBLIC_PAGES_DIR, pathname.slice('/public-pages/'.length)))); return;
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(e.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
let cookie;
try {
  assert.equal((await request('/public-pages/one/data.json')).status, 401);
  const redirect = await request('/public-pages/one/index.html', { headers: { Accept: 'text/html' } });
  assert.equal(redirect.status, 302); assert.match(redirect.headers.get('location'), /^\/site-login/);
  assert.equal((await request('/public-pages/public/index.html')).status, 200);
  assert.equal((await request('/api/site-login/start', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
  const start = await request('/api/site-login/start', { method: 'POST', headers: { Origin: base } });
  cookie = start.headers.getSetCookie()[0].split(';')[0];
  assert.equal(calls, 1);
  await request('/api/site-login/start', { method: 'POST', headers: { Origin: base, Cookie: cookie } });
  assert.equal(calls, 1, 'refresh reuses pending authorization');
  assert.equal((await (await request('/api/site-login/poll', { headers: { Cookie: cookie } })).json()).state, 'pending');
  now += 5000;
  tokenResponse = { error: 'authorization_pending', error_description: 'The authorization request is still pending. Please retry later.', code: 20094 };
  const waiting = await request('/api/site-login/poll', { headers: { Cookie: cookie } });
  assert.equal(waiting.status, 200, 'real Feishu HTTP 400 / code 20094 is a waiting state, not a server failure');
  assert.equal((await waiting.json()).state, 'pending');
  const waitingCalls = calls;
  await request('/api/site-login/poll', { headers: { Cookie: cookie } });
  assert.equal(calls, waitingCalls, 'pending response keeps provider polling interval');
  now += 5000; tokenResponse = undefined;
  const connected = await request('/api/site-login/poll', { headers: { Cookie: cookie } });
  assert.equal((await connected.json()).state, 'connected');
  cookie = connected.headers.getSetCookie()[0].split(';')[0];
  const count = calls;
  for (const path of ['/public-pages/one/index.html', '/public-pages/two/data.json', '/preview/dynamic/']) {
    assert.equal((await request(path, { headers: { Cookie: cookie } })).status, 200);
  }
  assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401, 'site cookie cannot enter control plane');
  const forwarded = await (await request('/preview/dynamic/', { headers: { Cookie: cookie, Authorization: 'Bearer fixture-forged', 'X-Remotelab-Person-Id': 'forged' } })).json();
  assert.equal(forwarded['x-remotelab-person-id'], people[0].id); assert.equal(forwarded.cookie, undefined); assert.equal(forwarded.authorization, undefined);
  assert.equal((await request('/preview/dynamic/save', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/preview/dynamic/save', { method: 'POST', headers: { Cookie: cookie, Origin: base } })).status, 200);
  identity = makeIdentity(); login = createSiteLoginHandler({ identity, personFor: createEmployeeSiteAccess(identity, async () => null) });
  assert.equal((await request('/api/site-login/me', { headers: { Cookie: cookie } })).status, 200, 'durable login survives identity-service restart');
  const legacy = cookie.replace('employee_site_session=', 'qianyan_session=');
  const upgraded = await request('/api/qianyan/internal/auth/me', { headers: { Cookie: legacy } });
  assert.match(upgraded.headers.get('set-cookie'), /employee_site_session=.*Path=\/;/);
  assert.equal(calls, count, 'cross-site access, restart and migration do not call Feishu again');

  if (process.env.EMPLOYEE_TEST_PLAYWRIGHT && process.env.EMPLOYEE_TEST_CHROME) {
    const { chromium } = await import(pathToFileURL(process.env.EMPLOYEE_TEST_PLAYWRIGHT));
    const browser = await chromium.launch({ executablePath: process.env.EMPLOYEE_TEST_CHROME, headless: true, args: ['--no-sandbox'] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const errors = []; const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await context.addCookies([{ name: 'qianyan_session', value: legacy.split('=')[1], domain: '127.0.0.1', path: '/api/qianyan/internal', httpOnly: true }]);
      await page.goto(base + '/public-pages/one/index.html');
      await page.waitForURL('**/public-pages/one/index.html');
      await page.locator('h1').filter({ hasText: '隔离测试内容' }).waitFor();
      await page.goto(base + '/public-pages/two/index.html');
      assert.equal(await page.locator('h1').textContent(), '隔离测试内容');
      assert.equal(calls, count, 'browser upgrades old scoped cookie and opens second site without reauthorization');
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const first = await fresh.newPage(); first.on('pageerror', e => errors.push(e.message));
      await first.goto(base + '/public-pages/one/index.html');
      await first.locator('#authorize').waitFor({ state: 'visible' });
      assert.equal(await first.locator('h1').textContent(), '员工登录');
      assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await first.setViewportSize({ width: 390, height: 844 });
      assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await first.clock.install(); now += 5000; await first.clock.fastForward(5500);
      await first.waitForURL('**/public-pages/one/index.html');
      assert.equal(await first.locator('h1').textContent(), '隔离测试内容');
      assert.deepEqual(errors, []);
      console.log('Browser: desktop/mobile login, first confirmation fixture, legacy-cookie upgrade, two-site reuse PASS');
    } finally { await browser.close(); }
  }
  await request('/api/site-login/logout', { method: 'POST', headers: { Origin: base, Cookie: cookie } });
  assert.equal((await request('/public-pages/one/data.json', { headers: { Cookie: cookie } })).status, 401);
  tenant = 'foreign-company';
  const foreign = await request('/api/site-login/start', { method: 'POST', headers: { Origin: base } });
  const pending = foreign.headers.getSetCookie()[0].split(';')[0]; now += 5000;
  assert.equal((await (await request('/api/site-login/poll', { headers: { Cookie: pending } })).json()).state, 'wrong_company');
  console.log('Employee sites: creator attribution, preserved owner, reserved admins, static and proxy gates, cross-site login reuse, restart, legacy migration, CSRF, foreign tenant, control-plane separation and logout PASS');
} finally {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await rm(root, { recursive: true, force: true });
}

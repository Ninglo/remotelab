import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'preview-guests-'));
setIsolatedTestHome(root); process.env.REMOTELAB_CONFIG_DIR = root;
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const { createSiteDirectoryHandler } = await import('../chat/router-site-directory.mjs');
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const { createPreviewGuestStore } = await import('../lib/preview-guest-store.mjs');
const { requireEmployeeSite } = await import('../chat/employee-site-auth.mjs');
const hash = v => createHash('sha256').update(v).digest('hex');
const identities = ['owner_fixture', 'staff_fixture'];
const employee = x => ({ Cookie: `employee_site_session=session_${x}` });
await updateAuthDocument(d => d.people.push(...identities.map(x => ({ id: `person_${x}`, name: x, credentials: [], identities: [{ id: `identity_${x}`, kind: 'feishu', realm: 'fixture', subjectId: `open_${x}` }] }))));
await writeFile(join(root, 'site-login.json'), JSON.stringify({ realm: 'fixture', tenantKey: 'fixture', feishuConfigPath: join(root, 'unused.json') }));
await writeFile(join(root, 'qianyan-identity.json'), JSON.stringify({ pending: {}, sessions: Object.fromEntries(identities.map(x => [hash(`session_${x}`), { personId: `person_${x}`, openId: `open_${x}`, realm: 'fixture', tenantKey: 'fixture', expiresAt: Date.now() + 86_400_000 }])) }));
const start = async handler => {
  const s = http.createServer(handler); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); return s;
};
let upstreamCalls = 0;
const upstream = await start((req, res) => {
  upstreamCalls++;
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>打印台测试环境</title><h1>打印台</h1>');
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ who: req.headers['x-remotelab-person-id'], method: req.method, cookie: req.headers.cookie || null }));
});
const port = upstream.address().port, staff = employee(identities[1]), owner = employee(identities[0]);
const route = { port, access: 'employee', ownerPersonId: 'person_owner_fixture', postPaths: ['/api/upload', '/api/request', '/api/decision', '/api/bind', '/api/availability', '/api/model'] };
const directory = createSiteDirectoryHandler({ directory: { listing: async () => ({ entries: [{ kind: 'preview', slug: 'shared-print', access: 'employee', ownerPersonId: route.ownerPersonId, deployment: { loopbackPort: port } }] }) } });
const server = await start(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  try {
    if (await directory(req, res, path) || await handlePreviewProxy(req, res, path)) return;
    if (!await requireEmployeeSite(req, res)) return;
    res.writeHead(404); res.end();
  } catch (error) { console.error(error); res.writeHead(500); res.end(); }
});
const origin = `http://127.0.0.1:${server.address().port}`, base = '/preview/shared-print';
const api = '/_invite/api/';
const policies = Object.fromEntries(['shared-print', 'other'].map(slug => [slug, { port, ownerPersonId: route.ownerPersonId, origin, title: '共享打印台 <test>' }]));
const policyFile = join(root, 'preview-guest-invites.json');
await writeFile(policyFile, JSON.stringify(policies));
await writeFile(join(root, 'preview-routes.json'), JSON.stringify({ 'shared-print': route, other: route, unset: route }));
const get = (path, headers = {}) => fetch(origin + path, { headers, redirect: 'manual' });
const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const issue = async label => {
  const r = await post(base + api + 'grants', { label }, owner); assert.equal(r.status, 201); return r.json();
};
let browser;
try {
  assert.equal((await get(`${base}/`, { Accept: 'text/html' })).status, 302);
  assert.equal((await get(`${base}/api/desk`)).status, 401);
  assert.equal((await get(`${base}/_invite/manage`, { Accept: 'text/html' })).status, 302);
  assert.equal((await get(`${base}/_invite/manage`, staff)).status, 403);
  assert.equal((await post(base + api + 'grants', { label: 'visitor' }, staff)).status, 403);
  assert.equal((await post(base + api + 'grants', { label: 'visitor' }, { ...owner, Origin: 'https://not-this-site.test' })).status, 403);
  assert.equal((await get(`${base}/_invite/manage`, owner)).status, 200);
  assert.equal((await get('/preview/unset/_invite/accept')).status, 401);
  assert.equal((await (await get('/api/sites', staff)).json()).entries[0].guestManagementPath, undefined);
  assert.equal((await (await get('/api/sites', owner)).json()).entries[0].guestManagementPath, `${base}/_invite/manage`);
  assert.equal((await (await get('/api/sites/export', owner)).json()).entries[0].guestManagementPath, undefined);
  const a = await issue('<img src=x>'); const b = await issue('visitor B');
  assert.notEqual(a.link, b.link);
  const url = new URL(a.link), secret = url.hash.slice(1);
  assert.equal(url.search, '');
  const prefetch = await get(url.pathname, { 'Sec-Purpose': 'prefetch' });
  assert.equal(prefetch.status, 200); assert.equal(prefetch.headers.get('referrer-policy'), 'no-referrer');
  assert(await prefetch.text().then(html => html.includes('&lt;test&gt;') && !html.includes(secret)));
  assert.equal((await post(`/preview/other${api}redeem`, { secret })).status, 410);
  assert.equal((await post(`${base}${api}redeem`, { secret }, { Origin: 'https://not-this-site.test' })).status, 403);
  const contenders = await Promise.all(Array.from({ length: 8 }, () => post(base + api + 'redeem', { secret })));
  assert.deepEqual(contenders.map(r => r.status).sort(), [200, 410, 410, 410, 410, 410, 410, 410]);
  const setCookie = contenders.find(r => r.ok).headers.get('set-cookie');
  assert.match(setCookie, /Path=\/preview\/shared-print; HttpOnly; Secure; SameSite=Lax; Max-Age=/);
  const visitor = { Cookie: setCookie.split(';')[0] };
  const person = (await (await get(`${base}/api/desk`, visitor)).json()).who;
  assert.match(person, /^person_guest_[a-f0-9]{32}$/);
  for (const signedIn of [visitor, staff]) {
    assert.equal((await post(base + api + 'redeem', { secret: new URL(b.link).hash.slice(1) }, signedIn)).status, 409);
  }
  for (const path of ['api/desk', 'file', 'image']) {
    assert.deepEqual(await (await get(`${base}/${path}`, visitor)).json(), { who: person, method: 'GET', cookie: null });
  }
  for (const path of route.postPaths) {
    assert.equal((await (await post(base + path, {}, visitor)).json()).who, person);
    assert.equal((await (await post(base + path, {}, staff)).json()).who, 'person_staff_fixture');
  }
  assert.equal((await (await get(`${base}/api/desk`, { Cookie: `${visitor.Cookie}; ${staff.Cookie}` })).json()).who, 'person_staff_fixture');
  const beforeDenies = upstreamCalls;
  assert.equal((await post(`${base}/api/other`, {}, visitor)).status, 405);
  assert.equal((await post(`${base}/api/request`, {}, { ...visitor, Origin: 'https://not-this-site.test' })).status, 403);
  assert.equal((await get(`/preview/other/api/desk`, visitor)).status, 401);
  assert.equal((await get('/api/sites', visitor)).status, 401);
  assert.equal((await get('/api/workbench-control', visitor)).status, 401);
  assert.equal((await get(`${base}${api}grants`, visitor)).status, 401);
  assert.equal(upstreamCalls, beforeDenies);
  const listing = await (await get(base + api + 'grants', owner)).text();
  assert(!listing.includes(secret) && !listing.includes(visitor.Cookie.split('=')[1]));
  assert.equal(JSON.parse(listing).current.length, 2);
  const scope = JSON.stringify([origin, 'shared-print', port, route.ownerPersonId]);
  const visitorSecret = visitor.Cookie.split('=')[1];
  const durable = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createPreviewGuestStore } from './lib/preview-guest-store.mjs';
    const [root,scope,secret] = process.argv.slice(1);
    const member = await createPreviewGuestStore(root, () => Date.now()+500*86400000).member(scope,secret);
    process.stdout.write(member?.id || '');
  `, root, scope, visitorSecret], { encoding: 'utf8' });
  assert.equal(durable.status, 0, durable.stderr); assert.equal(durable.stdout, person, 'a new process preserves the long-lived grant');
  for (const name of (await readdir(root)).filter(n => n.startsWith('preview-guest-grants.json.sqlite'))) {
    assert.equal((await stat(join(root, name))).mode & 0o077, 0, `private SQLite files: ${name}`);
  }
  let now = Date.now(); const store = createPreviewGuestStore(root, () => now);
  const exp = await store.issue('expiry-scope', 'expiry', route.ownerPersonId);
  now += 86_400_000; assert.equal(await store.redeem('expiry-scope', exp.secret), null);
  await writeFile(policyFile, JSON.stringify({ ...policies, 'shared-print': { ...policies['shared-print'], port: port === 65535 ? 65534 : port + 1 } }));
  assert.equal((await get(`${base}/api/desk`, visitor)).status, 401, 'a different target port cannot inherit guest grants');
  await writeFile(policyFile, JSON.stringify(policies));
  assert.equal((await post(base + api + 'revoke', { id: a.grant.id }, owner)).status, 200);
  assert.equal((await get(`${base}/api/desk`, visitor)).status, 401, 'revocation applies to an already open browser');
  assert.equal((await post(base + api + 'revoke', { id: b.grant.id }, owner)).status, 200);
  assert.equal((await post(base + api + 'redeem', { secret: new URL(b.link).hash.slice(1) })).status, 410);

  if (process.env.SITE_TEST_PLAYWRIGHT && process.env.SITE_TEST_CHROME) {
    const { chromium } = await import(pathToFileURL(process.env.SITE_TEST_PLAYWRIGHT).href);
    browser = await chromium.launch({ executablePath: process.env.SITE_TEST_CHROME, args: ['--no-sandbox'] });
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await adminContext.addCookies([{ name: 'employee_site_session', value: 'session_owner_fixture', url: origin }]);
    const admin = await adminContext.newPage();
    const errors = []; admin.on('pageerror', e => errors.push(e.message));
    await admin.goto(origin + base + '/_invite/manage');
    await admin.locator('#label').fill('Browser test'); await admin.getByRole('button', { name: '生成邀请链接' }).click();
    await admin.locator('#result').waitFor(); const link = await admin.locator('#link').inputValue();
    await admin.getByText('Browser test', { exact: true }).waitFor();
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, colorScheme: 'dark' });
    const guest = await guestContext.newPage(); guest.on('pageerror', e => errors.push(e.message));
    await guest.goto(link); await guest.reload();
    assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await guest.getByRole('heading', { name: '接受网站邀请' }).count(), 1);
    await guest.getByRole('button', { name: '接受邀请' }).click();
    await guest.waitForURL(origin + base + '/');
    await guest.getByRole('heading', { name: '打印台' }).waitFor({ timeout: 3000 }).catch(async error => {
      error.message += `; path ${new URL(guest.url()).pathname}; page ${await guest.locator('body').innerText()}; cookies ${(await guestContext.cookies()).map(c => c.name)}`;
      throw error;
    });
    const reload = await guest.reload();
    await guest.getByRole('heading', { name: '打印台' }).waitFor({ timeout: 3000 }).catch(async error => {
      console.error('Reload:', reload?.status(), new URL(guest.url()).pathname, await guest.locator('body').innerText().catch(() => ''), (await guestContext.cookies()).map(c => c.name));
      throw error;
    });
    assert.equal((await guestContext.cookies()).some(c => c.name === '__Secure-remotelab-preview-guest' && c.httpOnly && c.path === base), true);
    await admin.reload(); await admin.getByText(/已接受 ·/).waitFor();
    admin.once('dialog', dialog => dialog.accept());
    await admin.getByRole('listitem').filter({ hasText: 'Browser test' }).getByRole('button', { name: '撤销' }).click();
    await admin.getByText('已撤销。', { exact: true }).waitFor();
    assert.equal((await guestContext.request.get(origin + base + '/api/desk')).status(), 401);
    assert.deepEqual(errors, []);
    console.log('Guest browser PASS: owner creates and revokes, narrow guest confirms, keeps cookie after reload');
  }
  console.log('Preview guest PASS: owner-only, one-use race, expiry, restart durability, parity, route and origin isolation, revocation');
} finally {
  await browser?.close();
  await Promise.all([server, upstream].map(s => new Promise(resolve => s.close(resolve))));
  await rm(root, { recursive: true, force: true });
}

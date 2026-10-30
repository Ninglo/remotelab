// Isolated browser acceptance: real employee cookies and workbench admission,
// with Feishu responses supplied by a fixture. No production auth or events.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'workbench-login-browser-'));
setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR = root;
const config = { realm: 'fixture-app', tenantKey: 'fixture-company', feishuConfigPath: join(root, 'app.json') };
await writeFile(join(root, 'site-login.json'), JSON.stringify(config));
await writeFile(config.feishuConfigPath, JSON.stringify({ appId: config.realm, appSecret: 'fixture-secret' }));
const authConfig = await import('../lib/auth-config.mjs');
const auth = await import('../lib/auth.mjs');
const { createEmployeeSiteIdentity } = await import('../lib/employee-site-identity.mjs');
const { createEmployeeSiteAccess } = await import('../chat/employee-site-auth.mjs');
const { createSiteLoginHandler } = await import('../chat/router-site-login.mjs');
const { createWorkbenchSiteLogin } = await import('../chat/workbench-site-login.mjs');
const { escapeHtml } = await import('../lib/utils.mjs');
const person = { id: 'person_fixture_browser', name: 'Browser fixture', handle: 'browser-fixture',
  credentials: [{ id: 'credential_fixture_browser', type: 'token', token: 'fixture-browser-secret' }],
  identities: [{ id: 'identity_fixture_feishu', kind: 'feishu', realm: config.realm, subjectId: 'fixture-open' },
    { id: 'identity_fixture_web', kind: 'web', realm: 'remotelab', subjectId: 'browser-fixture' }] };
await authConfig.updateAuthDocument(d => { d.people.push(person); });
let now = Date.now(), approved = false, providerCalls = 0, completionCalls = 0;
const identity = createEmployeeSiteIdentity({ configDir: root, now: () => now,
  authDocument: () => authConfig.loadAuthDocument({ persistMigration: false }),
  registerIdentity: async () => person,
  fetchImpl: async url => {
    providerCalls++;
    const value = url.includes('device_authorization')
      ? { device_code: 'fixture-device', verification_uri_complete: 'https://accounts.feishu.cn/fixture', expires_in: 600, interval: 5 }
      : url.includes('/oauth/token') ? approved ? { access_token: 'fixture-token' } : { error: 'authorization_pending', code: 20094 }
        : { code: 0, data: { open_id: 'fixture-open', tenant_key: config.tenantKey, name: person.name } };
    return { ok: !value.error, json: async () => value };
  } });
const personFor = createEmployeeSiteAccess(identity, async req => auth.getAuthSession(req));
const sites = createSiteLoginHandler({ identity, personFor });
const workbench = createWorkbenchSiteLogin({ personFor });
const template = await readFile(new URL('../templates/login.html', import.meta.url), 'utf8');
const navigations = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/auth/feishu/complete') completionCalls++;
    if (await workbench(req, res, url.pathname, Object.fromEntries(url.searchParams))) return;
    if (await sites(req, res, url.pathname)) return;
    if (url.pathname === '/login') {
      const vars = { PRODUCT_BASE_HREF: '/', NONCE: 'fixture', BUILD_TITLE: 'fixture', BUILD_LABEL: 'Isolated test',
        ASSET_VERSION: 'fixture', ERROR_CLASS: 'hidden', MODE: 'pw', NEXT_PATH: escapeHtml(url.searchParams.get('next') || '/destination'), FEISHU_LOGIN_ENABLED: 'yes' };
      res.setHeader('Content-Type', 'text/html');
      res.end(template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '')); return;
    }
    if (['/site-login.js', '/chat/i18n.js'].includes(url.pathname)) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('../static' + url.pathname, import.meta.url))); return;
    }
    if (url.pathname === '/destination') {
      const session = auth.getAuthSession(req);
      res.writeHead(session ? 200 : 401, { 'Content-Type': 'text/html' });
      res.end(session ? '<h1>Signed in</h1>' : '<h1>Unauthorized</h1>'); return;
    }
    res.writeHead(404); res.end();
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  assert.ok(process.env.EMPLOYEE_TEST_PLAYWRIGHT && process.env.EMPLOYEE_TEST_CHROME, 'Provide isolated browser tool paths');
  const { chromium } = await import(pathToFileURL(process.env.EMPLOYEE_TEST_PLAYWRIGHT));
  browser = await chromium.launch({ executablePath: process.env.EMPLOYEE_TEST_CHROME, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://accounts.feishu.cn/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Feishu authorization fixture</h1>' }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await page.goto(base + '/login?next=' + encodeURIComponent('/destination?session=kept#draft'));
  await page.locator('#feishu-signin').waitFor({ state: 'visible' });
  const aligned = await page.evaluate(() => {
    const button = document.getElementById('feishu-signin').getBoundingClientRect();
    const input = document.getElementById('username-input').getBoundingClientRect();
    return Math.abs(button.x - input.x) < 1 && Math.abs(button.width - input.width) < 1 && button.height >= 40;
  });
  assert.ok(aligned, 'Feishu action aligns with the account form and has a full-size hit target');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile overflow');
      assert.ok(await page.locator('#feishu-signin').isVisible());
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.LOGIN_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.LOGIN_SCREENSHOT_DIR, 'feishu-login-after.png'), fullPage: true });
  await page.locator('#username-input').fill('draft username');
  await page.clock.install();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#feishu-signin').click();
  const popup = await popupPromise;
  await popup.waitForURL('https://accounts.feishu.cn/fixture');
  await page.locator('#feishu-authorize').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#username-input').inputValue(), 'draft username', 'pending login keeps typed input');
  assert.equal(new URL(page.url()).pathname, '/login', 'authorization stays on the original card');
  assert.equal(completionCalls, 0);
  approved = true; now += 5000;
  await page.clock.fastForward(5500);
  await page.waitForURL(base + '/destination?session=kept#draft');
  assert.equal(await page.locator('h1').textContent(), 'Signed in');
  assert.equal(completionCalls, 1, 'one direct workbench completion after Feishu confirmation');
  assert.ok(!navigations.some(url => new URL(url).pathname === '/site-login'), 'no second login page');
  assert.ok(popup.isClosed(), 'the authorization tab is closed after completion');
  const cookies = await context.cookies();
  assert.ok(cookies.some(c => c.name === 'employee_site_session'));
  assert.ok(cookies.some(c => c.name === 'session_token'));

  // A prior explicit logout pauses automatic workbench entry. Clicking Feishu
  // reuses the existing employee identity without another provider request.
  const reused = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await reused.addCookies(cookies.filter(c => c.name === 'employee_site_session'));
  await reused.addCookies([{ name: 'workbench_sso_paused', value: '1', url: base }]);
  const reusedPage = await reused.newPage(); reusedPage.on('pageerror', error => errors.push(error.message));
  await reusedPage.goto(base + '/login?next=/destination');
  assert.equal(new URL(reusedPage.url()).pathname, '/login');
  const before = providerCalls;
  await reusedPage.locator('#feishu-signin').click();
  await reusedPage.waitForURL(base + '/destination');
  assert.equal(providerCalls, before, 'verified employee is not asked to authorize again');

  // Popup blocking and a credential removed after employee verification leave
  // the original forms and typed content usable, with an inline error.
  const denied = await browser.newContext();
  await denied.addInitScript(() => { window.open = () => null; });
  const deniedPage = await denied.newPage(); deniedPage.on('pageerror', error => errors.push(error.message));
  await deniedPage.goto(base + '/login?next=/destination');
  await deniedPage.locator('#username-input').fill('kept username');
  await deniedPage.locator('#feishu-signin').click();
  await deniedPage.locator('#feishu-authorize').waitFor({ state: 'visible' });
  assert.equal(await deniedPage.locator('#feishu-authorize').getAttribute('href'), 'https://accounts.feishu.cn/fixture');
  await authConfig.updateAuthDocument(d => { d.people.find(p => p.id === person.id).credentials = []; });
  now += 5000;
  await deniedPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await deniedPage.locator('#feishu-retry').waitFor({ state: 'visible' });
  assert.match(await deniedPage.locator('#feishu-status').textContent(), /尚未开通/);
  assert.equal(new URL(deniedPage.url()).pathname, '/login');
  assert.equal(await deniedPage.locator('#username-input').inputValue(), 'kept username');
  assert.ok(await deniedPage.locator('#feishu-signin').isEnabled());
  await deniedPage.locator('#toggle-link').click();
  assert.ok(await deniedPage.locator('#token-input').isVisible(), 'original Token login remains available');
  assert.deepEqual(errors, []);
  console.log('Workbench browser: aligned desktop/mobile light/dark card, fresh Feishu → direct target, no second page, closed popup, verified reuse, logout pause, blocked-popup fallback and inline denial PASS');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

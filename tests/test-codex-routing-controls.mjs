import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'codex-routing-controls-'));
setIsolatedTestHome(home);
process.env.SECURE_COOKIES = '0';
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
const people = ['admin', 'member'].map((id, i) => ({ id, name: id, handle: id,
  credentials: [{ id: `credential-${id}`, type: 'token', token: String(i + 1).repeat(64) }],
  identities: [{ id: `web-${id}`, kind: 'web', realm: 'remotelab', subjectId: id }] }));
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'admin',
  administratorPersonIds: ['admin'], people, serviceToken: 'f'.repeat(64) }));
const { codexAccounts: pool } = await import('../lib/codex-accounts.mjs');
const backup = await pool.add('Backup');
for (const account of (await pool.read()).accounts) {
  await mkdir(account.home, { recursive: true });
  await writeFile(join(account.home, 'auth.json'), '{"tokens":{}}');
}
await pool.mutate(data => {
  data.autoSwitch = true; data.balanceSessions = true;
  for (const account of data.accounts) {
    account.label ||= 'Default'; account.account = { type: 'chatgpt', planType: 'pro' };
    account.usage = { status: 'ready', checkedAt: new Date().toISOString(), buckets: [
      { id: 'codex', primary: { remainingPercent: 90, resetsAt: new Date(Date.now() + 3600000).toISOString() } },
    ] };
  }
});
// Status checks are local fixtures; never invoke a provider or consume quota.
pool.refresh = async id => pool.account(id);
const { handleRequest } = await import('../chat/router.mjs');
const server = http.createServer((req, res) => void handleRequest(req, res).catch(error => {
  console.error(error); if (!res.headersSent) res.writeHead(500); res.end();
}));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const route = '/api/codex-auth/accounts/routing';
async function call(who, path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    ...(who ? { Authorization: `Bearer ${people.find(p => p.id === who).credentials[0].token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  for (const who of ['member', null]) {
    const expected = who ? 403 : 401;
    assert.equal((await call(who, '/api/codex-auth/accounts')).status, expected);
    assert.equal((await call(who, route, { accountId: 'default', enabled: false })).status, expected);
    assert.equal((await call(who, '/api/codex-auth/accounts/remove', { accountId: 'default' })).status, expected);
  }
  assert.equal((await call('admin', route, { accountId: 'default', enabled: 'false' })).status, 400);
  const stopped = await call('admin', route, { accountId: 'default', enabled: false });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.accountList.accounts.find(a => a.id === 'default').routingEnabled, false);
  assert.equal(stopped.data.accountList.activeId, backup.id);
  assert.equal((await call('admin', route, { accountId: 'default', enabled: true })).status, 200);
  assert.equal((await pool.read()).autoSwitch, true);
  assert.equal((await pool.read()).balanceSessions, true);

  if (process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.REMOTELAB_TEST_CHROMIUM_PATH ? { executablePath: process.env.REMOTELAB_TEST_CHROMIUM_PATH } : {}) });
    try {
      for (const who of ['admin', 'member']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
        const page = await context.newPage();
        await page.goto(base + '/login'); await page.click('#toggle-link');
        await page.fill('#token-input', people.find(p => p.id === who).credentials[0].token);
        await Promise.all([page.waitForURL(base + '/'), page.click('#token-form button')]);
        await page.goto(base + '/?tab=settings#settings-connections');
        if (who === 'member') {
          assert.equal(await page.locator('#settingsCodexAuthSection').count(), 0);
          assert.equal(await page.evaluate(async path => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: 'default', enabled: false }) })).status, route), 403);
        } else {
          const button = page.locator('[data-codex-routing-account="default"][data-codex-account-action="disable"]');
          const enable = page.locator('[data-codex-routing-account="default"][data-codex-account-action="enable"]');
          await button.waitFor({ state: 'visible' });
          await button.click();
          await page.waitForFunction(() => {
            const b = document.querySelector('[data-codex-routing-account="default"][data-codex-account-action="enable"]');
            return b && !b.disabled;
          });
          assert.equal((await pool.list()).accounts.find(a => a.id === 'default').routingEnabled, false);
          await page.reload();
          await button.waitFor({ state: 'visible' });
          assert.equal(await enable.isEnabled(), true);
          await enable.click();
          await page.waitForFunction(() => {
            const b = document.querySelector('[data-codex-routing-account="default"][data-codex-account-action="disable"]');
            return b && !b.disabled;
          });
          await page.setViewportSize({ width: 1440, height: 1000 });
          assert.equal(await page.locator('[data-codex-routing-account]').count(), 6);
          const overflow = await page.locator('#settingsCodexAuthSection').evaluate(el => el.scrollWidth > el.clientWidth);
          assert.equal(overflow, false);
          assert.equal((await pool.list()).accounts.find(a => a.id === 'default').routingEnabled, true);
          await button.click();
          const last = page.locator(`[data-codex-routing-account="${backup.id}"][data-codex-account-action="disable"]`);
          await page.waitForFunction(() => !document.querySelector('[data-codex-routing-account="default"][data-codex-account-action="enable"]').disabled);
          page.once('dialog', dialog => dialog.dismiss());
          await last.click();
          assert.equal((await pool.list()).accounts.find(a => a.id === backup.id).routingEnabled, true);
          page.once('dialog', dialog => dialog.accept());
          await last.click();
          await page.waitForFunction(() => {
            const note = document.getElementById('settingsCodexRoutingNote');
            return note && !note.hidden && /暂无|No shared/.test(note.textContent);
          });
          assert.deepEqual((await pool.read()).routingAccountIds, []);
          await page.waitForFunction(() => !document.querySelector('[data-codex-routing-account="default"][data-codex-account-action="enable"]').disabled);
          await enable.click();
          await page.waitForFunction(() => {
            const b = document.querySelector('[data-codex-routing-account="default"][data-codex-account-action="disable"]');
            return b && !b.disabled;
          });
          page.once('dialog', dialog => dialog.accept());
          await page.locator(`[data-codex-routing-account="${backup.id}"][data-codex-account-action="remove"]`).click();
          await page.waitForFunction(id => !document.querySelector(`[data-codex-routing-account="${id}"]`), backup.id);
          assert.equal((await pool.list()).accounts.some(a => a.id === backup.id), false);
          await page.reload();
          await button.waitFor({ state: 'visible' });
          assert.equal(await page.locator(`[data-codex-routing-account="${backup.id}"]`).count(), 0);
        }
        await context.close();
      }
      console.log('Browser: administrator enable/disable, reload persistence, desktop/mobile controls and member isolation passed');
    } finally { await browser.close(); }
  }
  console.log('HTTP: administrator-only routing writes, validation, persistence and unchanged routing policies passed');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
// The production router owns persistent frontend file watchers.
process.exit(0);

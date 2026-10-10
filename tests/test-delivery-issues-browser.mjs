// Optional real browser/API gate: node scripts/run-with-clean-instance-env.mjs
// node tests/test-delivery-issues-browser.mjs <playwright module> <artifact dir> [browser executable]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const output = resolve(process.argv[3]);
const home = await mkdtemp(join(tmpdir(), 'delivery-issues-browser-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'fixture-token' }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ fixture: { role: 'owner', expiry: Date.now() + 3600000 } }));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env,
  CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, SECURE_COOKIES: '0',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
let browser;
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
    Cookie: 'session_token=fixture', 'Content-Type': 'application/json',
  }, body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${path}: ${await (response.ok ? Promise.resolve('') : response.text())}`);
  return response.json();
};
try {
  await new Promise((resolveReady, reject) => {
    if (logs.includes('Chat server listening')) { resolveReady(); return; }
    const deadline = setTimeout(() => reject(new Error('Server startup timed out: ' + logs)), 15000);
    const ready = () => {
      if (!logs.includes('Chat server listening')) return;
      clearTimeout(deadline);
      child.stdout.off('data', ready);
      resolveReady();
    };
    child.stdout.on('data', ready);
    child.once('exit', () => { clearTimeout(deadline); reject(new Error(logs)); });
  });
  const { session } = await api('/api/sessions', { folder: home, tool: 'codex', name: 'Delivery issue visibility' });
  const { delivery } = await api('/api/source-deliveries', { sessionId: session.id, responseId: 'visible',
    text: 'saved result', sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'chat' } } });
  const { claim } = await api('/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'fixture' });
  await api(`/api/source-deliveries/${delivery.id}/fail`, { leaseId: claim.leaseId,
    error: 'Feishu 230055: <img src=x onerror=alert(1)>', definiteFailure: true });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.argv[4] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'en-US' });
  await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?session=${session.id}&tab=sessions`);
  const panel = page.locator('#deliveryIssues');
  const notifications = page.locator('#notificationPanel');
  const rows = page.locator('.notification-delivery');
  await panel.waitFor({ state: 'visible' });
  await page.locator('#notificationBadge').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#notificationBadge').textContent(), '1');
  assert.doesNotMatch(await panel.textContent(), /230055/, 'conversation keeps only a compact entry to the shared notification');
  await panel.getByRole('button', { name: 'View in notifications' }).focus();
  await page.keyboard.press('Enter');
  await notifications.waitFor({ state: 'visible' });
  await rows.first().waitFor({ state: 'visible' });
  assert.match(await rows.first().textContent(), /230055/);
  assert.equal(await rows.locator('img').count(), 0, 'remote error text must never render as HTML');
  assert.equal(await rows.count(), 1, 'one durable issue produces one bell entry');
  assert.equal(await page.locator('#notificationBadge').isVisible(), false, 'viewing marks the notice read');
  assert(await panel.isVisible(), 'viewing is distinct from ignoring a delivery failure');
  await page.locator('#notificationShowAll').click();
  assert.equal(await page.locator('#notificationClear').isEnabled(), false, 'clear history must not dismiss durable delivery warnings');
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'mobile.png') });
  assert(await panel.isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  const peer = await context.newPage();
  await peer.goto(`${base}/?session=${session.id}&tab=sessions`);
  await peer.locator('#deliveryIssues').waitFor({ state: 'visible' });
  await page.locator('#notificationClose').click();
  await page.reload();
  await panel.waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#notificationBadge').isVisible(), false, 'read versions survive reload without hiding the failure');
  await panel.getByRole('button', { name: 'View in notifications' }).click();
  const dismiss = rows.getByRole('button', { name: 'Read, dismiss' });
  await page.route(`**/api/source-deliveries/${delivery.id}/dismiss`, route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture unavailable' }),
  }));
  await dismiss.click();
  await notifications.getByRole('alert').waitFor({ state: 'visible' });
  assert(await dismiss.isEnabled(), 'failed dismissal can be retried and must retain the warning');
  assert(await panel.isVisible());
  await page.unroute(`**/api/source-deliveries/${delivery.id}/dismiss`);
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await panel.waitFor({ state: 'hidden' });
  await peer.locator('#deliveryIssues').waitFor({ state: 'hidden' });
  await rows.waitFor({ state: 'hidden' });
  await page.locator('.delivery-issue-badge').waitFor({ state: 'hidden' });
  await peer.close();
  const retained = (await api('/api/source-deliveries?sessionId=' + session.id)).deliveries.find(item => item.id === delivery.id);
  assert.equal(retained.state, 'delivery_failed', 'UI acknowledgment retains actual delivery status');
  assert.match(retained.lastError, /230055/);
  assert(retained.dismissedIssue.at, 'UI acknowledgment is durable');
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(await panel.isVisible(), false, 'dismissed warning stays cleared on reload');
  const { session: other } = await api('/api/sessions', { folder: home, tool: 'codex', name: 'Another conversation' });
  const { delivery: mobile } = await api('/api/source-deliveries', { sessionId: other.id, responseId: 'mobile',
    text: 'mobile saved result', sourceDelivery: { connector: 'feishu', sourceRouteId: 'mobile', target: { chatId: 'chat' } } });
  const { claim: mobileClaim } = await api('/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'mobile' });
  await api(`/api/source-deliveries/${mobile.id}/fail`, { leaseId: mobileClaim.leaseId,
    error: 'mobile failure', definiteFailure: true });
  await page.locator('#notificationBadge').waitFor({ state: 'visible' });
  assert.equal(await panel.isVisible(), false, 'another conversation failure belongs in the bell, not this composer');
  await page.locator('#notificationToggle').click();
  await rows.filter({ hasText: 'mobile failure' }).waitFor({ state: 'visible' });
  assert.match(await rows.first().textContent(), /Another conversation/);
  const activeIssues = (await api('/api/source-delivery-issues')).issues;
  assert.equal(activeIssues.length, 1);
  assert.equal(activeIssues[0].id, mobile.id);
  assert.equal(activeIssues[0].issueVersion, (await api('/api/sessions/' + other.id)).session.deliveryIssues[0].issueVersion,
    'bell and conversation must expose the same durable issue and version');
  await page.route('**/api/source-delivery-issues', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture unavailable' }),
  }));
  await page.evaluate(() => RemoteLabNotifications.refreshDeliveryIssues());
  await notifications.getByRole('alert').waitFor({ state: 'visible' });
  assert.match(await rows.first().textContent(), /mobile failure/, 'refresh failure retains the warning');
  await page.unroute('**/api/source-delivery-issues');
  await page.evaluate(() => RemoteLabNotifications.refreshDeliveryIssues());
  await rows.getByRole('button', { name: 'Open session' }).click();
  await panel.waitFor({ state: 'visible' });
  await page.evaluate(() => localStorage.setItem('remotelab.uiLanguage', 'zh-CN'));
  await page.reload();
  await panel.getByRole('button', { name: '在通知中查看' }).waitFor({ state: 'visible' });
  await panel.getByRole('button', { name: '在通知中查看' }).click();
  await rows.getByRole('button', { name: '已读，忽略' }).click();
  await panel.waitFor({ state: 'hidden' });
  await rows.waitFor({ state: 'hidden' });
  assert.equal((await api('/api/source-delivery-issues')).issues.length, 0);
  assert.equal((await api('/api/source-deliveries?sessionId=' + other.id)).deliveries.find(item => item.id === mobile.id).state,
    'delivery_failed', 'ignoring from the bell does not resolve the send');
  const unauthenticated = await fetch(`${base}/api/source-deliveries/${mobile.id}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual',
  });
  assert([302, 401].includes(unauthenticated.status), 'dismissal requires authentication');
  assert.deepEqual(errors, []);
  console.log('delivery issues browser: shared IDs/versions, cross-session bell, cross-tab dismissal, persistent read state, failed refresh/dismiss, mobile/keyboard, Chinese/English, safe error text and unchanged send results passed');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  await writeFile(join(output, 'server.log'), logs);
  await rm(home, { recursive: true, force: true });
}

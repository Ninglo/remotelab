// Optional real browser/API gate: node scripts/run-with-clean-instance-env.mjs
// node tests/test-delivery-issues-browser.mjs <playwright module> <artifact dir>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
const port = 44000 + Math.floor(Math.random() * 10000);
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
  let ready = false;
  for (let n = 0; n < 100; n++) {
    ready = await fetch(base + '/login').then(r => r.ok, () => false);
    if (ready) break;
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  const { session } = await api('/api/sessions', { folder: home, tool: 'codex', name: 'Delivery issue visibility' });
  const { delivery } = await api('/api/source-deliveries', { sessionId: session.id, responseId: 'visible',
    text: 'saved result', sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'chat' } } });
  const { claim } = await api('/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'fixture' });
  await api(`/api/source-deliveries/${delivery.id}/fail`, { leaseId: claim.leaseId,
    error: 'Feishu 230055: <img src=x onerror=alert(1)>', definiteFailure: true });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'en-US' });
  await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?session=${session.id}&tab=sessions`);
  const panel = page.locator('#deliveryIssues');
  await panel.waitFor({ state: 'visible' });
  await panel.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.match(await panel.textContent(), /230055/);
  assert.equal(await panel.locator('img').count(), 0, 'remote error text must never render as HTML');
  assert.equal(await page.locator('.delivery-issue-badge').count(), 1);
  await page.screenshot({ path: join(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'mobile.png') });
  assert(await panel.isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const dismiss = panel.getByRole('button', { name: 'Read, dismiss' });
  await page.route(`**/api/source-deliveries/${delivery.id}/dismiss`, route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture unavailable' }),
  }));
  await dismiss.click();
  await panel.getByRole('alert').waitFor({ state: 'visible' });
  assert(await dismiss.isEnabled(), 'failed dismissal can be retried and must retain the warning');
  await page.unroute(`**/api/source-deliveries/${delivery.id}/dismiss`);
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await panel.waitFor({ state: 'hidden' });
  await page.locator('.delivery-issue-badge').waitFor({ state: 'hidden' });
  const retained = (await api('/api/source-deliveries?sessionId=' + session.id)).deliveries.find(item => item.id === delivery.id);
  assert.equal(retained.state, 'delivery_failed', 'UI acknowledgment retains actual delivery status');
  assert.match(retained.lastError, /230055/);
  assert(retained.dismissedIssue.at, 'UI acknowledgment is durable');
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(await panel.isVisible(), false, 'dismissed warning stays cleared on reload');
  const { delivery: mobile } = await api('/api/source-deliveries', { sessionId: session.id, responseId: 'mobile',
    text: 'mobile saved result', sourceDelivery: { connector: 'feishu', sourceRouteId: 'mobile', target: { chatId: 'chat' } } });
  const { claim: mobileClaim } = await api('/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'mobile' });
  await api(`/api/source-deliveries/${mobile.id}/fail`, { leaseId: mobileClaim.leaseId,
    error: 'mobile failure', definiteFailure: true });
  await panel.waitFor({ state: 'visible' });
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: 'Read, dismiss' }).click();
  await panel.waitFor({ state: 'hidden' });
  const unauthenticated = await fetch(`${base}/api/source-deliveries/${mobile.id}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual',
  });
  assert([302, 401].includes(unauthenticated.status), 'dismissal requires authentication');
  assert.deepEqual(errors, []);
  console.log('delivery issues browser: real dismiss API, sidebar badge, mobile/keyboard, failed request, literal error text, authentication and reload passed');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  await writeFile(join(output, 'server.log'), logs);
  await rm(home, { recursive: true, force: true });
}

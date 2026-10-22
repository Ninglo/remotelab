// Optional browser gate: node scripts/run-with-clean-instance-env.mjs node
// tests/test-delivery-self-review-browser.mjs <playwright module> <evidence dir> [chromium executable]
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
const output = resolve(process.argv[3]), home = await mkdtemp(join(tmpdir(), 'self-review-browser-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'); await mkdir(config, { recursive: true }); await mkdir(output, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: ['a','b'].map(n => ({
  id: `person_${n}`, name: n, handle: n, credentials: [], identities: [{ id: `web_${n}`, kind: 'web', subjectId: n }],
})) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify(Object.fromEntries(['a','b'].map(n => [n, {
  expiry: Date.now() + 3600000, personId: `person_${n}`, identityId: `web_${n}`, authKind: 'web', role: 'owner',
}]))));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env, CHAT_PORT: String(port), SECURE_COOKIES: '0',
  REMOTELAB_MEMORY_WRITEBACK: 'off', REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1' }, stdio: ['ignore','pipe','pipe'] });
let logs = ''; child.stdout.on('data', c => { logs += c; }); child.stderr.on('data', c => { logs += c; });
let browser;
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 15000);
    child.stdout.on('data', () => { if (logs.includes('Chat server listening')) { clearTimeout(timer); resolveReady(); } });
    child.once('exit', () => { clearTimeout(timer); reject(Error(logs)); });
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.argv[4] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addCookies([{ name: 'session_token', value: 'a', url: base }]);
  const page = await context.newPage();
  await page.goto(base + '/?tab=settings');
  const toggle = page.locator('#replySelfReview');
  await toggle.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('replySettingsCurrent').textContent.includes('读取'));
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await page.locator('#replyActivate').click();
  await page.waitForFunction(() => document.getElementById('replySettingsCurrent').textContent.includes('自检开启')
    || document.getElementById('replySettingsCurrent').textContent.includes('self-review on'));
  await page.reload(); await toggle.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('replySelfReview').checked);
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'desktop-enabled.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'mobile-enabled.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await toggle.uncheck(); await page.locator('#replyActivate').click();
  await page.waitForFunction(() => document.getElementById('replySettingsCurrent').textContent.includes('自检关闭')
    || document.getElementById('replySettingsCurrent').textContent.includes('self-review off'));
  const other = await browser.newContext(); await other.addCookies([{ name: 'session_token', value: 'b', url: base }]);
  const otherPage = await other.newPage(); await otherPage.goto(base + '/?tab=settings');
  await otherPage.locator('#replySelfReview').waitFor({ state: 'visible' });
  assert.equal(await otherPage.locator('#replySelfReview').isChecked(), false);
  const b = await otherPage.evaluate(async () => (await (await fetch('/api/message-reply-settings')).json()).settings);
  assert.equal(b.revision, 0); assert.equal(b.active, null);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, checks: ['default off','save on','reload on','desktop/mobile no overflow','save off','other Person unchanged'] }, null, 2));
  console.log('PASS browser: default off, real settings API on/reload/off, personal isolation, desktop and mobile');
} finally {
  await browser?.close(); const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; await rm(home, { recursive: true, force: true });
}

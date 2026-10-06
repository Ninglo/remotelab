// Optional browser gate: node scripts/run-with-clean-instance-env.mjs node
// tests/test-chat-amber-pet-browser.mjs <playwright module> <artifact directory> [browser executable]
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
const home = await mkdtemp(join(tmpdir(), 'amber-pet-browser-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'fixture-token' }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ fixture: { role: 'owner', expiry: Date.now() + 3600000 } }));
const port = 44000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['chat-server.mjs'], {
  env: { ...process.env, CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, SECURE_COOKIES: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
let browser;
const ready = new Promise((resolveReady, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Server startup deadline: ${logs}`)), 15000);
  child.stdout.on('data', chunk => {
    logs += chunk;
    if (logs.includes('Chat server listening')) { clearTimeout(timeout); resolveReady(); }
  });
  child.stderr.on('data', chunk => { logs += chunk; });
  child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${logs}`)); });
});
try {
  await ready;
  const auth = await fetch(`${base}/api/auth/me`, { headers: { Cookie: 'session_token=fixture' } }).then(r => r.json());
  const preferencesResponse = await fetch(`${base}/api/people/${auth.person.id}`, { method: 'PATCH', headers: {
    Cookie: 'session_token=fixture', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ quickLinks: [{ label: '个人文档', url: 'https://example.com/documents' }] }) });
  assert(preferencesResponse.ok, 'isolated personal document fixture is saved');
  const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: {
    Cookie: 'session_token=fixture', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ folder: home, tool: 'codex', name: 'Pet interaction fixture' }) });
  assert(response.ok, 'isolated session creation succeeds');
  const { session } = await response.json();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.argv[4] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'zh-CN', hasTouch: true });
  await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
  await context.addInitScript(() => {
    localStorage.setItem('remotelab.theme', 'amber');
    localStorage.setItem('remotelab.locale', 'zh-CN');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Quota samples and personal tasks are isolated fixtures; no real task writes.
  await page.route('**/api/codex-auth/status', route => route.fulfill({ json: { codexAuth: { loggedIn: true, accountRevision: 'fixture' } } }));
  await page.route('**/api/codex-auth/rate-limits', route => route.fulfill({ json: { codexUsage: {
    status: 'ready', accountRevision: 'fixture', checkedAt: new Date().toISOString(),
    buckets: [{ id: 'codex', primary: { remainingPercent: 67, windowDurationMins: 10080 } }],
  } } }));
  await page.route('**/api/display/todos', route => route.fulfill({ json: { items: [
    { id: 'todo_fixture', title: 'A task with enough text to check wrapping on a small screen', status: 'in_progress' },
  ] } }));
  const visit = () => page.goto(`${base}/?session=${session.id}&tab=sessions`);
  const pet = page.locator('.amber-pet-image');
  const toggle = page.locator('.amber-pet-toggle');
  const menu = page.locator('#amberPetMenu');
  const quota = page.locator('button.pet-quota-pilot-button:not(.amber-todos-toggle)');
  const todos = page.locator('.amber-todos-toggle');
  const documents = page.locator('.amber-quick-link');
  const drag = async (locator, dx, dy) => {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
  };
  const checkContained = async locator => {
    const box = await locator.boundingBox();
    const area = await page.locator('#sessionWorkspace').boundingBox();
    assert(box.x >= area.x - 1 && box.y >= area.y - 1, 'control remains within the workspace');
    assert(box.x + box.width <= area.x + area.width + 1 && box.y + box.height <= area.y + area.height + 1, 'control fits at the bottom and right');
  };
  await visit();
  await pet.waitFor({ state: 'visible' });
  assert.equal(await menu.isVisible(), false);
  assert.equal(await quota.isVisible(), false);
  assert.equal(await todos.isVisible(), false);
  assert.equal(await documents.isVisible(), false);
  assert.equal(await page.locator('.amber-pet').count(), 1);
  await pet.click();
  assert.equal(await menu.isVisible(), true, 'clicking the pet opens tools');
  await pet.click();
  assert.equal(await menu.isVisible(), false);
  await page.screenshot({ path: join(output, 'desktop-collapsed.png') });
  const original = await pet.boundingBox();
  await drag(pet, -200, 160);
  const moved = await pet.boundingBox();
  assert(Math.abs(moved.x - original.x + 200) < 2 && Math.abs(moved.y - original.y - 160) < 2);
  assert.equal(await menu.isVisible(), false, 'dragging does not accidentally open tools');
  await visit();
  await pet.waitFor({ state: 'visible' });
  assert(Math.abs((await pet.boundingBox()).x - moved.x) < 2, 'position survives refresh');
  await toggle.click();
  assert.equal(await documents.isVisible(), true, 'personal document links join the collapsed toolbox');
  assert.equal(await documents.getAttribute('href'), 'https://example.com/documents');
  assert.equal(await documents.getAttribute('target'), '_blank');
  await page.locator('.amber-pet-tool').nth(1).click();
  const larger = await pet.boundingBox();
  assert(larger.width > original.width);
  await page.locator('.amber-pet-tool').nth(0).click();
  assert.equal((await pet.boundingBox()).width, original.width);
  await quota.click();
  await page.locator('.pet-quota-pilot-details').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.pet-quota-pilot-button').textContent.includes('67%'));
  assert.match(await quota.textContent(), /67%/);
  await todos.click();
  await page.locator('.amber-todos-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pet-quota-pilot-details').isVisible(), false);
  await checkContained(menu);
  await page.screenshot({ path: join(output, 'desktop-expanded.png') });
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
  await pet.focus();
  await page.keyboard.press('+');
  assert((await pet.boundingBox()).width > original.width);
  await page.keyboard.press('ArrowLeft');
  await toggle.click();
  await page.locator('.amber-pet-tool').nth(2).click();
  await page.keyboard.press('Escape');
  await pet.hover();
  await drag(page.locator('.amber-pet-resize'), 30, 30);
  assert((await pet.boundingBox()).width > original.width, 'corner resizing works');
  await visit();
  await pet.waitFor({ state: 'visible' });
  assert((await pet.boundingBox()).width > original.width, 'size survives refresh');
  await pet.hover();
  const beforeWheel = (await pet.boundingBox()).width;
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(width => document.querySelector('.amber-pet-image').offsetWidth > width, beforeWheel);
  await drag(pet, 5000, 5000);
  await checkContained(page.locator('.amber-pet'));
  await toggle.click();
  await todos.click();
  await checkContained(menu);
  await page.screenshot({ path: join(output, 'desktop-bottom-edge.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await checkContained(page.locator('.amber-pet'));
  await toggle.tap();
  await page.locator('.amber-pet-tool').nth(1).tap();
  await todos.tap();
  await checkContained(menu);
  await page.screenshot({ path: join(output, 'mobile-expanded.png') });
  await page.keyboard.press('Escape');
  const touch = await context.newCDPSession(page);
  const mobilePet = await pet.boundingBox();
  const point = { x: mobilePet.x + mobilePet.width / 2, y: mobilePet.y + mobilePet.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - 100, y: point.y + 120 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const mobileMoved = await pet.boundingBox();
  assert(mobileMoved.x < mobilePet.x && mobileMoved.y > mobilePet.y, 'touch dragging works');
  assert.equal(await menu.isVisible(), false);
  const edgeStart = { x: mobileMoved.x + mobileMoved.width / 2, y: mobileMoved.y + mobileMoved.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [edgeStart] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 1, y: 843 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await toggle.tap();
  await todos.tap();
  await checkContained(menu);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(output, 'mobile-bottom-edge.png') });
  const savedMobile = await pet.boundingBox();
  await visit();
  await pet.waitFor({ state: 'visible' });
  const restoredMobile = await pet.boundingBox();
  assert.equal(restoredMobile.width, savedMobile.width, 'mobile size survives refresh');
  assert(Math.abs(restoredMobile.x - savedMobile.x) < 2 && Math.abs(restoredMobile.y - savedMobile.y) < 2, 'mobile position survives refresh');
  assert.equal(await menu.isVisible(), false, 'refresh always starts with collapsed tools');
  await pet.focus();
  await page.keyboard.press('Enter');
  assert.equal(await menu.isVisible(), true, 'keyboard activation opens tools');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); window.dispatchEvent(new Event('remotelab:themechange')); });
  assert.equal(await page.locator('.amber-pet').isVisible(), false);
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'amber'); window.dispatchEvent(new Event('remotelab:themechange')); });
  assert.equal(await menu.isVisible(), false);
  await checkContained(page.locator('.amber-pet'));
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'verification.json'), JSON.stringify({ passed: true, checks: [
    'collapsed by default', 'drag and resize', 'desktop persistence', 'mobile touch', 'keyboard',
    'quota, todo and personal document controls', 'exclusive detail panels', 'workspace edges', 'theme switching', 'no browser errors',
  ] }, null, 2));
  console.log('Amber pet browser: desktop/mobile interaction, persistence, controls, boundaries and theme switching passed');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  await writeFile(join(output, 'server.log'), logs);
  await rm(home, { recursive: true, force: true });
}

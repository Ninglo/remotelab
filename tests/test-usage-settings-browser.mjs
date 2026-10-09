import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const repo = process.cwd(), originalEnv = { ...process.env };
// Optional real-browser check; supply an installed Playwright module, Chromium and library path.
const [playwrightModule, browserExecutable, libraryPath = ''] = process.argv.slice(2);
if (!playwrightModule || !browserExecutable) throw Error('Usage: node tests/test-usage-settings-browser.mjs <playwright-module> <chromium> [library-path]');
const snapshot = { playwrightModule, browserExecutable, libraryPath };
const { chromium } = await import(pathToFileURL(snapshot.playwrightModule));
const home = await mkdtemp(join(tmpdir(), 'usage-settings-browser-'));
const { setIsolatedTestHome } = await import(pathToFileURL(join(repo, 'tests/isolate-test-environment.mjs')));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
const { createPerson } = await import(pathToFileURL(join(repo, 'lib/auth.mjs')));
const beta = await createPerson({ name: 'Second fixture', handle: 'second-fixture' });
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({
  alpha: { expiry: Date.now() + 3600000, role: 'owner' },
  beta: { expiry: Date.now() + 3600000, role: 'owner', personId: beta.personId },
}));
await writeFile(join(config, 'tools.json'), '[]');
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify([{ id: 'config-fixture', name: 'Configuration fixture', folder: home,
  conversation: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatType: 'group', chatId: 'oc_fixture' } } }]));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: repo, env: { ...process.env,
  CHAT_PORT: String(port), CHAT_BIND_HOST: '127.0.0.1', SECURE_COOKIES: '0', REMOTELAB_MEMORY_WRITEBACK: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error('Isolated server readiness deadline: ' + logs)), 30000);
  server.stdout.on('data', chunk => { logs += chunk; if (logs.includes('Chat server listening')) { clearTimeout(timeout); resolve(); } });
  server.stderr.on('data', chunk => { logs += chunk; });
  server.once('exit', () => { clearTimeout(timeout); reject(Error(logs)); });
});
try {
  await ready;
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: snapshot.browserExecutable, headless: true,
    args: ['--no-sandbox'], env: { ...originalEnv, LD_LIBRARY_PATH: snapshot.libraryPath } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'session_token', value: 'alpha', url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const settingResponse = (setting, value, operation) => page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/usage/settings' || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON();
    return (!setting || body.values[setting] === value) && (!operation || body.operation === operation);
  }, { timeout: 15000 }).then(response => { assert.equal(response.status(), 202); return response.json(); });
  const firstSnapshot = settingResponse(null, null, 'snapshot');
  await page.goto(base + '/?tab=tasks&monitor=usage', { waitUntil: 'domcontentloaded' });
  await firstSnapshot;
  const report = () => page.evaluate(async () => (await (await fetch('/api/usage/analysis?days=7&limit=1')).json()).report);
  const theme = x => x.settings.rows.find(row => row.setting === 'web.theme' && row.stage === 'applied');
  assert.equal(theme(await report()).changes, 0, 'initial defaults establish state, not adoption');
  async function choose(setting, value, setter) {
    const saved = settingResponse(setting, value, 'change');
    await page.evaluate(({ value, setter }) => window[setter](value, { reload: false }), { value, setter });
    await saved;
  }
  await choose('web.theme', 'amber', 'remotelabSetThemePreference');
  await choose('web.theme', 'amber', 'remotelabSetThemePreference');
  await choose('web.theme', 'system', 'remotelabSetThemePreference');
  let x = await report();
  assert.equal(theme(x).changes, 2); assert.equal(theme(x).restoredDefaults, 1); assert.equal(theme(x).returnsToEarlier, 1);
  await choose('web.thinking', 'expanded', 'remotelabSetThinkingBlockDisplayMode');
  await choose('web.language', 'zh-CN', 'remotelabSetUiLanguagePreference');
  let reload = settingResponse(null, null, 'snapshot'); await page.reload(); await reload;
  assert.equal(await page.evaluate(() => remotelabGetThinkingBlockDisplayMode()), 'expanded');
  assert.equal(await page.evaluate(() => remotelabGetUiLanguagePreference()), 'zh-CN');
  assert.equal(theme(await report()).changes, 2, 'refresh baseline is not another choice');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'remotelab.theme') throw Error('blocked storage'); return original.call(this, key, value); };
    try { remotelabSetThemePreference('dark'); } finally { Storage.prototype.setItem = original; }
  });
  reload = settingResponse(null, null, 'snapshot'); await page.reload(); await reload;
  assert.equal(await page.evaluate(() => remotelabGetThemePreference()), 'system');
  assert.equal(theme(await report()).changes, 2, 'failed local persistence never counts as an applied choice');
  async function request(method, path, body) {
    return page.evaluate(async ({ method, path, body }) => {
      const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, json: await response.json() };
    }, { method, path, body });
  }
  const personId = (await request('GET', '/api/auth/me')).json.person.id;
  assert.equal((await request('PATCH', '/api/settings', { sessionAutoArchive: { enabled: true } })).status, 200);
  assert.equal((await request('PATCH', '/api/voice-review/settings', { enabled: true, reviewMode: 'model' })).status, 200);
  assert.equal((await request('PATCH', '/api/people/' + personId, { mobileInputMode: 'voice' })).status, 200);
  let reply = (await request('GET', '/api/message-reply-settings')).json;
  const drafted = await request('POST', '/api/message-reply-settings', { action: 'draft', expectedRevision: reply.settings.revision,
    draft: { opening: false, checklist: false, progress: 'card_latest', groups: reply.groups.map(({ sourceRouteId, chatId }) => ({ sourceRouteId, chatId })) } });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.json)); reply = drafted.json;
  assert.equal((await report()).settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied').changes, 0);
  for (let i = 0; i < 2; i++) {
    const saved = await request('POST', '/api/message-reply-settings', { action: 'activate', expectedRevision: reply.settings.revision, confirm: true });
    assert.equal(saved.status, 200); reply = saved.json;
  }
  const applied = (await report()).settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied');
  assert.equal(applied.changes, 1); assert.equal(applied.configurations, 1);
  const restored = await request('POST', '/api/message-reply-settings', { action: 'legacy', expectedRevision: reply.settings.revision, confirm: true });
  assert.equal(restored.status, 200);
  x = await report();
  for (const setting of ['instance.auto_archive', 'voice.review', 'person.mobile_input'])
    assert.equal(x.settings.rows.find(row => row.setting === setting).changes, 1, 'successful HTTP save is observed: ' + setting);
  assert.equal(x.settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied').restoredDefaults, 1);
  await context.addCookies([{ name: 'session_token', value: 'beta', url: base }]);
  reload = settingResponse(null, null, 'snapshot'); await page.reload(); await reload;
  x = await report();
  assert.equal(theme(x).configurations, 2); assert.equal(theme(x).subjects, 2);
  assert.equal(theme(x).changes, 2, 'another verified Person starts a separate configuration baseline');
  await page.getByRole('heading', { name: '基础设置选了什么，哪些经常被改回' }).waitFor();
  await page.evaluate(() => RemoteLabUsageAnalysis.load());
  const section = page.locator('.monitoring-section').filter({ has: page.getByRole('heading', { name: '基础设置选了什么，哪些经常被改回' }) });
  assert.match(await section.textContent(), /2 \/ 1 \/ 1/);
  assert.match(await section.textContent(), /不受会话筛选/);
  await section.getByText('查看草案、预览与采集起点', { exact: true }).click();
  assert.match(await section.textContent(), /已有设置只记录现状/);
  assert.match(await section.textContent(), /已保存草案（尚未应用）/);
  await page.selectOption('#usageAnalysisSession', 'config-fixture');
  await page.waitForFunction(() => document.querySelector('#usageAnalysisRefresh').disabled === false);
  assert.match(await section.textContent(), /2 \/ 1 \/ 1/, 'configuration summary remains instance-wide with a Session filter');
  await page.selectOption('#usageAnalysisPeriod', '1');
  await page.waitForFunction(() => document.querySelector('#usageAnalysisRefresh').disabled === false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('/tmp/remotelab-settings-browser', { recursive: true });
  await section.screenshot({ path: '/tmp/remotelab-settings-browser/settings-mobile.png' });
  await choose('web.language', 'en', 'remotelabSetUiLanguagePreference');
  assert.equal(await page.getByRole('heading', { name: 'Setting choices and later reversals' }).count(), 1);
  await page.route('**/api/usage/analysis?*', async route => {
    const response = await route.fetch(), data = await response.json();
    data.report.settings.rows = []; data.report.settings.partial = true;
    await route.fulfill({ response, json: data });
  });
  await page.evaluate(() => RemoteLabUsageAnalysis.load());
  assert.equal(await page.getByText('No applied configurations are observed yet; this does not establish non-use.', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Setting observations are partial; distributions or change counts may be incomplete.', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', server: 'isolated', initialSnapshots: true, choicesAndReversals: true,
    repeatAndReloadDedup: true, failedLocalStorageExcluded: true, separatePeople: true,
    serverSettingHTTP: true, draftsAndActivation: true, unifiedUI: true, sessionFilterScope: true,
    localeAndEmptyPartial: true, mobileNoOverflow: true, noProductionWrites: true }));
} finally {
  await browser?.close();
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await rm(home, { recursive: true, force: true });
}

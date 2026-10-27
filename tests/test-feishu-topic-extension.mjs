import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, executablePath, extension, artifacts, version] = process.argv.slice(2);
if (!version) throw Error('Pass Playwright, Chrome, extension directory, artifacts and version');
const { chromium } = await import(pathToFileURL(modulePath));
const profile = await mkdtemp(join(tmpdir(), 'feishu-topic-extension-'));
await mkdir(artifacts, { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);
  await worker.evaluate(async () => {
    const original = fetch; globalThis.__topicControllers = []; globalThis.__requests = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('chrome-extension:')) return original(url, options);
      __requests.push(String(url));
      if (String(url).includes('/api/feishu-web-topics/stream')) {
        return new Response(new ReadableStream({ start(controller) {
          __topicControllers.push(controller); options.signal.addEventListener('abort', () => { try { controller.close(); } catch {} });
        } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ status: 'confirmed', version: chrome.runtime.getManifest().version }), { status: 200 });
    };
    const scope = 'https://fixture.feishu.cn:1000000000000000001';
    await chrome.storage.local.set({ ['feishuWebExplore.topicConnection.v1:' + encodeURIComponent(scope)]: {
      token: 'fwtops_' + 'a'.repeat(43), expiresAt: Date.now() + 60000 } });
  });
  await context.route('https://fixture.feishu.cn/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <script>globalThis.userId='1000000000000000001'</script><style>body{font:14px system-ui}.appNavbar{width:160px;height:100vh}.appNavbar-navbarMenu{width:160px}.feed-main-list{position:absolute;left:190px;top:40px;width:360px}</style>
    <aside class="appNavbar"><div class="appNavbar-navbarMenu">飞书</div><div class="navItem-userAuthList">账号</div></aside>
    <main class="feed-main-list"><div data-feed-id="topic" data-rlfe-unread-count="0"><div class="a11y_feed_card_main"><div class="_2b17aec6">原生标题</div><div class="_5d806a78">原生预览</div></div></div><textarea>原生草稿</textarea></main>` }));
  const page = await context.newPage(), errors = [], worlds = [];
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', e => worlds.push(e.context)); await cdp.send('Runtime.enable');
  await page.goto('https://fixture.feishu.cn/next/messenger/');
  await page.locator('#rlfe-host').waitFor();
  await page.evaluate(() => document.documentElement.dataset.rlfeAccountId = '1000000000000000001');
  const isolated = worlds.findLast(w => w.origin.startsWith('chrome-extension://'));
  assert(isolated, 'unpacked extension content-script world');
  // The promise resolves on the real extension's topic event after SSE, broker and render.
  const streamReady = await cdp.send('Runtime.evaluate', { contextId: isolated.id, awaitPromise: true, returnByValue: true,
    expression: `new Promise((resolve,reject)=>{const end=setTimeout(()=>reject(Error('stream connection timeout')),3000);const check=()=>{if(globalThis.__RLFE_SYNC_STATUS__?.state==='connecting'){clearTimeout(end);resolve(true);}else requestAnimationFrame(check);};check();})` });
  assert.equal(streamReady.result.value, true);
  const timings = [];
  for (const [status, label] of [['running', 'running'], ['waiting', 'waiting'], ['review', 'review'], ['idle', '']]) {
    const observed = cdp.send('Runtime.evaluate', { contextId: isolated.id, awaitPromise: true, returnByValue: true,
      expression: `new Promise((resolve,reject)=>{const end=setTimeout(()=>reject(Error('topic event timeout')),3000);window.addEventListener('rlfe:topics',event=>{clearTimeout(end);resolve({receivedAt:Date.now(),state:event.detail.entries[0].status});},{once:true});})` });
    const sentAt = await worker.evaluate(({ status, label }) => {
      const sentAt = Date.now(), entry = { sessionId: 'fixture', webThreadId: 'topic', name: '旧目标', displayName: 'RemoteLab UI 同步验证', status, label,
        rowStatus: label ? { key: status === 'review' ? 'unread' : status, label, className: 'status-' + (status === 'review' ? 'unread' : status) } : null };
      const message = new TextEncoder().encode('data: ' + JSON.stringify({ sourceConnected: true, entries: [entry] }) + '\n\n');
      __topicControllers.at(-1).enqueue(message); return sentAt;
    }, { status, label });
    const result = await observed; assert.equal(result.result.value.state, status);
    timings.push({ status, transportToRenderMs: result.result.value.receivedAt - sentAt });
    assert.equal(await page.locator('.rlfe-feed-name').textContent(), 'RemoteLab UI 同步验证');
    assert.equal(await page.locator('.rlfe-feed-status').textContent(), label);
    assert.equal(await page.locator('.rlfe-feed-status').evaluate(e => e.hidden), !label);
  }
  assert.equal(await page.locator('.feed-main-list textarea').inputValue(), '原生草稿');
  assert.deepEqual(errors, []);
  const report = { version, scope: 'real MV3 package and SSE transport in isolated browser with fixture source', timings, errors };
  await page.screenshot({ path: join(artifacts, 'extension.png') });
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildTopicLabels } from '../scripts/build-feishu-topic-labels.mjs';

const [modulePath, executablePath, artifacts] = process.argv.slice(2);
if (!artifacts) throw Error('Pass Playwright module path, Chromium executable and artifacts directory');
const { chromium } = await import(pathToFileURL(modulePath));
const [base, sidebar, state, surface] = await Promise.all(['chat-base.css', 'chat-sidebar.css', 'session-state-model.js', 'session-surface-ui.js'].map(name => readFile(new URL('../static/chat/' + name, import.meta.url), 'utf8')));
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
const errors = [], timings = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${base}\n${sidebar}\nbody{padding:32px;font-family:system-ui}section{width:360px;margin-bottom:30px}h2{font-size:14px}</style>
    <h2>RemoteLab UI</h2><section id="reference"></section><h2>飞书插件</h2>
    <section class="feed-main-list"><div data-feed-id="topic" data-rlfe-unread-count="0"><div class="a11y_feed_card_main"><div class="_2b17aec6">原生标题</div><div class="_5d806a78">原生预览</div></div></div></section><textarea>未发送草稿</textarea>`);
  await page.addScriptTag({ content: state });
  // Use the actual RemoteLab row renderer for the comparison, not a copied badge.
  const renderer = surface.slice(surface.indexOf('function renderSessionStatusIndicator('), surface.indexOf('function getSessionRowStatusInfo('));
  await page.addScriptTag({ content: 'function esc(s){const e=document.createElement("span");e.textContent=s;return e.innerHTML;}\n' + renderer });
  await page.addScriptTag({ content: await buildTopicLabels() });
  const measure = async (run, waiting = false, reviewed = false) => page.evaluate(({ run, waiting, reviewed }) => {
    const session = { id: 'fixture', name: 'RemoteLab 标题与状态同步', activity: { run: { state: run, waiting } },
      lastAssistantMessageAt: '2026-10-27T01:00:00Z', lastReviewedAt: reviewed ? '2026-10-27T01:00:00Z' : null };
    const model = RemoteLabSessionStateModel, rowStatus = model.getSessionRowStatusInfo(session), name = model.getSessionDisplayName(session);
    document.getElementById('reference').innerHTML = '<div class="session-item-title-row">' + renderSessionStatusIndicator(rowStatus) + '<div class="session-item-name">' + esc(name) + '</div></div>';
    const start = performance.now();
    __RLFE_SET_TOPICS__({ sourceConnected: true, entries: [{ sessionId: session.id, webThreadId: 'topic', name: '另一目标', displayName: name,
      status: rowStatus?.key === 'unread' ? 'review' : rowStatus?.key || 'idle', rowStatus, summary: '' }] });
    return performance.now() - start;
  }, { run, waiting, reviewed });
  const compare = async () => page.evaluate(() => {
    const properties = ['display', 'alignItems', 'gap', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'padding', 'borderRadius', 'whiteSpace'];
    const read = selector => { const e = document.querySelector(selector); if (!e || e.hidden) return null; const css = getComputedStyle(e); return { text: e.textContent, style: Object.fromEntries(properties.map(p => [p, css[p]])) }; };
    return { reference: read('#reference .session-row-status'), plugin: read('.rlfe-feed-status'),
      referenceTitle: read('#reference .session-item-name'), pluginTitle: read('.rlfe-feed-name'),
      referenceDot: document.querySelector('#reference .session-status-dot')?.getBoundingClientRect().width,
      pluginDot: document.querySelector('.rlfe-status-dot')?.getBoundingClientRect().width };
  });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [run, waiting, reviewed] of [['running', false, false], ['running', true, false], ['idle', false, false], ['idle', false, true]]) {
      timings.push(await measure(run, waiting, reviewed));
      const view = await compare();
      assert.deepEqual(view.pluginTitle, view.referenceTitle, 'title typography and content');
      assert.deepEqual(view.plugin, view.reference, `${scheme} ${run} waiting=${waiting} reviewed=${reviewed}`);
      if (view.reference) assert.equal(view.pluginDot, view.referenceDot);
      if (run === 'idle' && !reviewed) assert.equal(view.plugin.text, 'review', 'native unread=0 must not hide the RemoteLab review status');
    }
    await measure('running'); await page.screenshot({ path: join(artifacts, scheme + '.png') });
  }
  await page.evaluate(() => __RLFE_SET_TOPICS__({ sourceConnected: false, entries: [{ sessionId: 'fixture', webThreadId: 'topic', displayName: '标题', status: 'running', rowStatus: { key: 'running', label: 'running', className: 'status-running' } }] }));
  assert.equal(await page.locator('.rlfe-feed-status').textContent(), '未同步');
  assert.equal(await page.locator('.rlfe-feed-status.status-running').count(), 0);
  await page.evaluate(() => __RLFE_SET_TOPICS__({ sourceConnected: true, entries: [] }));
  assert.equal(await page.locator('.rlfe-feed-headline').count(), 0);
  assert.equal(await page.locator('[data-rlfe-original]').count(), 0);
  await measure('running');
  await page.locator('[data-feed-id]').evaluate(e => e.dataset.feedId = 'recycled');
  await page.waitForFunction(() => !document.querySelector('.rlfe-feed-headline'));
  assert.equal(await page.locator('textarea').inputValue(), '未发送草稿');
  await page.evaluate(() => __RLFE_TOPICS_CLEANUP__());
  assert.equal(await page.locator('#rlfe-sidebar-style').count(), 0); assert.deepEqual(errors, []);
  const report = { scope: 'isolated browser fixtures; not user-device/network latency', styles: 'actual RemoteLab row renderer and computed styles, light and dark', checks: 8,
    timingsMs: timings, maxRenderMs: Math.max(...timings), unreadOverrideRemoved: true, staleAndRecycledRows: true, errors };
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }

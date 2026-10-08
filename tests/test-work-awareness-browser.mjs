// Optional layout gate: node tests/test-work-awareness-browser.mjs <playwright module> <artifact dir> <browser executable>
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.argv[4] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const template = await readFile(resolve('templates/chat.html'), 'utf8');
  const workspace = template.match(/<main class="chat-area"[\s\S]*?<\/main>/)[0];
  await page.setContent('<html lang="zh" data-theme="amber"><body><div class="app-shell"><header class="header">RemoteLab</header><div class="app-container"><div class="sidebar-overlay"><aside class="sidebar"></aside></div><div class="app-workspace">' + workspace + '</div></div></div></body></html>');
  const font = await readFile(resolve('static/chat/fonts/SmileySans-Oblique.woff2'));
  const baseCss = await readFile(resolve('static/chat/chat-base.css'), 'utf8');
  await page.addStyleTag({ content: baseCss.replace("url('fonts/SmileySans-Oblique.woff2')", "url('data:font/woff2;base64," + font.toString('base64') + "')") });
  await page.addStyleTag({ path: resolve('static/chat/chat-sidebar.css') });
  await page.addStyleTag({ path: resolve('static/chat/chat-messages.css') });
  await page.addStyleTag({ path: resolve('static/chat/chat-input.css') });
  await page.addStyleTag({ path: resolve('static/chat/chat-responsive.css') });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    window.currentSessionId = 'a'; window.shareSnapshotMode = false;
    window.queuedPanel = document.getElementById('queuedPanel'); window.msgInput = document.getElementById('msgInput');
    window.msgInput.placeholder = '输入消息…'; window.msgInput.disabled = false;
    window.fixture = { related: [{ sessionId: 'b', sessionName: 'Session 开工功能上线', relation: 'reuse', status: 'completed',
      actor: { name: '来源请求者' }, reason: '昨天实现的检索逻辑和测试，是这次调整相关性判断的直接修改依据。',
      goal: '核对原有实现、来源、边界以及验收记录。'.repeat(30) + '<img src=x onerror=alert(1)>' }],
      candidates: [{ sessionId: 'unrelated', goal: '获取会议权限' }], suggestions: [] };
    window.fetch = async () => ({ ok: true, json: async () => window.fixture });
    window.sessionFixture = { id: 'a', workAwareness: { revision: 1, intents: [{ goal: '继续吧' }] } };
  });
  await page.addScriptTag({ path: resolve('static/chat/session-surface-ui.js') });
  await page.evaluate(() => renderWorkAwarenessPanel(sessionFixture));
  const panel = page.locator('#workAwarenessPanel');
  const checkComposerAlignment = async () => {
    const reference = await panel.boundingBox();
    const input = await page.locator('.input-wrapper').boundingBox();
    assert(Math.abs(reference.x - input.x) < 1, 'suggestions align with the input left edge');
    assert(Math.abs(reference.width - input.width) < 1, 'suggestions share the input column width');
    assert(reference.y + reference.height <= input.y, 'suggestions sit above the message input');
  };
  assert.equal(await panel.evaluate(node => node.open), false, 'default collapsed');
  await checkComposerAlignment();
  await panel.locator('> summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await panel.locator('.work-awareness-item').count(), 1);
  assert.equal(await panel.locator('a').textContent(), 'Session 开工功能上线');
  assert.equal(await panel.locator('img').count(), 0, 'raw source text remains literal');
  assert(!String(await panel.textContent()).includes('获取会议权限'), 'candidates do not leak into the panel');
  await checkComposerAlignment();
  await page.evaluate(() => document.activeElement.blur());
  await page.locator('main').screenshot({ path: resolve(output, 'related-work-desktop.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkComposerAlignment();
  for (const theme of ['amber', 'dark']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await panel.locator('.work-awareness-item details').evaluate(node => { node.open = true; });
    await checkComposerAlignment();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow screen has no horizontal overflow');
    assert(await panel.boundingBox().then(box => box.height < 310), 'long source cannot take over the composer');
    assert(await panel.locator('.work-awareness-body').evaluate(node => node.scrollHeight > node.clientHeight), 'long details scroll inside a bounded panel');
    await page.locator('main').screenshot({ path: resolve(output, 'related-work-mobile-' + theme + '.png') });
  }
  await page.evaluate(async () => { window.fixture = { related: [], candidates: [{ goal: 'unreviewed' }], suggestions: [] }; await renderWorkAwarenessPanel(sessionFixture); });
  assert.equal(await panel.count(), 0, 'empty recommendations remove the panel');
  assert.deepEqual(errors, []);
  console.log('WORK_BROWSER_VERIFIED: production input markup and responsive JS/CSS; desktop/mobile suggestions above and aligned with the input column; compact titles, collapsed default, keyboard, Amber/dark mobile, literal text, bounded details, no overflow, hidden candidates and empty state.');
} finally { await browser.close(); }

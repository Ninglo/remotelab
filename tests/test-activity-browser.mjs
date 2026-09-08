// Optional visual gate: node tests/test-activity-browser.mjs <playwright module> <artifact dir>
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html lang="zh"><body><main id="fixture" style="max-width:800px;margin:40px auto;padding:16px"><h2>执行过程</h2><p>已检查渲染逻辑，正在统一工具与文件变更的展示。</p><div id="activity"></div></main></body></html>');
  for (const file of ['chat-base.css', 'chat-messages.css', 'activity.css']) {
    await page.addStyleTag({ path: resolve('static/chat', file) });
  }
  await page.addScriptTag({ path: resolve('static/marked.min.js') });
  await page.addScriptTag({ path: resolve('static/chat/i18n.js') });
  await page.addScriptTag({ path: resolve('static/chat/ui.js') });
  await page.addScriptTag({ path: resolve('static/chat/activity-ui.js') });
  await page.evaluate(() => {
    window.remotelabT = (key) => ({
      'activity.done': '完成', 'activity.running': '运行中', 'activity.failed': '失败',
      'activity.input': '调用详情', 'activity.output': '输出', 'activity.reasoning': '思考过程',
      'activity.plan': '执行计划', 'activity.context': '上下文更新',
      'ui.fileChange.edit': '已修改',
      'activity.noDiff': '已记录文件变更，但运行时没有提供本次修改的 patch。',
    })[key] || key;
    window.hydrateLazyNodes = async () => {};
    window.formatDecodedDisplayText = text => text;
    window.enhanceCodeBlocks = () => {};
    window.enhanceRenderedContentLinks = () => {};
    const root = document.querySelector('#activity');
    renderReasoningInto(root, { content: '检查到重复来自调用的开始与完成事件。现在使用调用 ID 关联，并保留完整参数供展开查看。' });
    const use = { type: 'tool_use', toolName: 'bash', toolInput: 'npm test', toolCallId: 'test', runId: 'run1' };
    renderToolUseInto(root, use);
    renderToolUseInto(root, use);
    renderToolResultInto(root, { toolName: 'bash', toolCallId: 'test', runId: 'run1', output: 'PASS activity lifecycle\nPASS concurrent tool results\nPASS historical event rendering\n\nAll checks passed.', exitCode: 0 });
    renderFileChangeInto(root, { filePath: '/workspace/remotelab/static/chat/activity-ui.js', changeType: 'edit', diff: '@@ -12,3 +12,3 @@\n-  appendToolResult(event);\n+  updateToolActivity(event.toolCallId, event);\n   return activity;' });
    renderFileChangeInto(root, { filePath: '/workspace/remotelab/static/chat/activity.css', changeType: 'edit' });
    renderActivityNote(root, { content: '- [x] 关联调用与结果\n- [x] 统一活动展示\n- [ ] 检查移动端布局' }, 'plan');
    renderActivityToolUse(root, { toolName: 'web_search', toolInput: 'Browser accessibility guidelines', toolCallId: 'search' });
    root.querySelector('.activity-file').open = true;
  });
  assert.equal(await page.locator('.tool-card').count(), 2, 'duplicate lifecycle renders once');
  assert.equal(await page.locator('.tool-card summary').first().evaluate(n => n.getBoundingClientRect().height), 26, 'desktop tool rows are compact');
  assert.equal(await page.locator('.activity-file summary').first().evaluate(n => n.getBoundingClientRect().height), 26, 'desktop file rows share the compact rhythm');
  await page.locator('.tool-card').first().locator('summary').click();
  assert.equal(await page.locator('.activity-output').isVisible(), true);
  await page.getByRole('button', { name: '调用详情' }).click();
  assert.equal(await page.locator('.activity-input').first().isVisible(), true);
  assert.equal(await page.locator('.activity-output').isVisible(), false);
  await page.getByRole('button', { name: '输出', exact: true }).click();
  await page.mouse.move(0, 0);
  const quietSurface = await page.locator('.tool-card').first().evaluate(card => {
    const header = getComputedStyle(card.querySelector('summary'));
    const output = getComputedStyle(card.querySelector('.activity-output'));
    const tab = getComputedStyle(card.querySelector('[aria-pressed="true"]'));
    const usage = document.createElement('div');
    usage.className = 'usage-info';
    card.parentElement.append(usage);
    const alignment = getComputedStyle(usage).textAlign;
    usage.remove();
    return { header: header.backgroundColor, output: output.backgroundColor, border: output.borderTopWidth, tab: tab.backgroundColor, alignment };
  });
  assert.deepEqual(quietSurface, { header: 'rgba(0, 0, 0, 0)', output: 'rgba(0, 0, 0, 0)', border: '0px', tab: 'rgba(0, 0, 0, 0)', alignment: 'center' }, 'activity is typography-first, without stacked filled containers');
  await page.screenshot({ path: resolve(output, 'activity-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.tool-card summary').first().evaluate(n => n.getBoundingClientRect().height), 40, 'mobile touch targets remain unchanged');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal page overflow');
  await page.screenshot({ path: resolve(output, 'activity-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('activity browser: desktop/mobile, output/input switching, duplicate lifecycle and page errors passed');
} finally { await browser.close(); }

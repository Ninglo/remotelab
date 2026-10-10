import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [modulePath, executablePath, artifacts] = process.argv.slice(2);
if (!modulePath || !executablePath || !artifacts) throw Error('Pass Playwright module path, Chromium executable and artifacts directory');
const { chromium } = await import(pathToFileURL(modulePath));
await mkdir(artifacts, { recursive: true });
const source = await readFile(new URL('../static/feishu-personal-workspace.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
const requests = [], failures = [], a = 'a'.repeat(32), t = 'b'.repeat(32);
const fixture = { person: { id: 'person_alice', name: 'Alice' }, errors: {}, observedAt: '2026-10-10T05:00:00Z', report: { date: '2026-10-10', url: 'https://fixture.feishu.cn/docx/report' },
  todos: [{ id: 'todo_1111111111111111', title: '先核对当前工作', note: '输入内容中的 <script>window.bad=true</script> 只显示为文字。', status: 'todo', dueAt: '2026-10-11T02:00:00Z', progress: { current: 1, target: 3, unit: '项' }, url: 'todo:todo_1111111111111111' }],
  projects: [{ id: 'remotelab', name: 'RemoteLab', status: 'active', date: '2026-10-10', sourceTitle: '已有项目进展', excerpt: '**已完成代码**，真实体验仍待反馈。', url: 'https://fixture.feishu.cn/docx/report', association: { reason: '本人提出的已登记工作', sessionId: a } }] };
let mode = 'complete', stateReads = 0, delayed, releaseDelay, postCount = 0;
page.on('pageerror', error => failures.push(error.message));
await page.route('https://fixture.feishu.cn/next/messenger/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px system-ui}.appNavbar{position:fixed;width:180px;height:100vh;background:#f5f6f7}.appNavbar-navbarMenu{height:800px;padding:10px}#native{margin-left:180px}</style><aside class="appNavbar"><div class="appNavbar-navbarMenu"><button>原有导航</button><nav id="rlfe-resource-nav-host">具身前沿 · 每日日报</nav></div></aside><main id="native">原生飞书对话不改动</main>' }));
await page.route('https://index.jiujianian.dev/api/feishu-web-workspace/**', async route => {
  const req = route.request(), url = new URL(req.url()), operation = url.pathname.split('/').at(-1), body = req.postDataJSON();
  requests.push({ operation, method: req.method(), body });
  let data;
  if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': 'https://fixture.feishu.cn', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Feishu-Origin, X-Feishu-Account', 'Access-Control-Allow-Methods': 'GET, POST, DELETE' } }); return; }
  if (req.method() === 'POST') { postCount++; stateReads = 0; data = { accepted: true, sessionId: operation === 'index' ? a : t, requestId: body.requestId }; }
  else if (operation === 'context') data = fixture;
  else {
    if (mode === 'delay' && operation === 'thinking') { delayed?.(); await new Promise(r => { releaseDelay = r; }); }
    const final = '## 当前重点\n- 优先核验 [这条待办](todo:todo_1111111111111111)，因为它解锁当前工作。\n- 依据：[原日报](https://fixture.feishu.cn/docx/report)。\n## 接着推进\n1. 检查已有成果。\n2. 反馈实测结果。';
    data = { session: { id: operation === 'index' ? a : t, name: operation }, cursor: 2, messages: operation === 'index' ? [{ role: 'user', content: '我们继续讨论目标。' }, { role: 'assistant', content: 'Index 的持续对话。' }] : [],
      latest: { content: final }, activity: operation === 'thinking' ? { state: mode === 'failed' ? 'failed' : (mode === 'running' && stateReads++ === 0 ? 'running' : 'completed'), final, error: mode === 'failed' ? 'fixture execution failed' : '' } : null };
  }
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'https://fixture.feishu.cn' }, body: JSON.stringify(data) });
});
try {
  await page.goto('https://fixture.feishu.cn/next/messenger/');
  await page.evaluate(() => { globalThis.__RLFE_LIVE__ = true; globalThis.userId = '1000000000000000001'; globalThis.__RLFE_PREFS__ = { status: () => ({ accountBound: true }) };
    const scope = location.origin + ':' + userId; localStorage.setItem('feishuWebExplore.workspaceConnection.v1:' + encodeURIComponent(scope), JSON.stringify({ token: 'fwspace_' + 'a'.repeat(43), expiresAt: Date.now() + 60000, person: { id: 'person_alice', name: 'Alice' } })); });
  await page.addScriptTag({ content: source });
  const nav = page.locator('#rlfe-personal-nav'), host = page.locator('#rlfe-personal-workspace');
  assert.deepEqual(await nav.locator('button').allTextContents(), ['Index', 'thinking']);
  assert.equal(await page.locator('#rlfe-resource-nav-host').textContent(), '具身前沿 · 每日日报');
  await nav.getByText('Index', { exact: true }).click(); await host.getByText('Index 的持续对话。', { exact: true }).waitFor();
  const first = await page.evaluate(() => __RLFE_WORKSPACE__.status().sessionId);
  await host.getByText('返回飞书', { exact: true }).click(); await nav.getByText('Index', { exact: true }).click(); await host.getByText('Index 的持续对话。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => __RLFE_WORKSPACE__.status().sessionId), first); assert.equal(postCount, 0);
  await nav.getByText('thinking', { exact: true }).click(); await host.getByText('分析已完成', { exact: true }).waitFor();
  assert.equal(await host.locator('#nextBlock h2').textContent(), '接着推进'); assert.equal(await nav.getByText('接着推进', { exact: true }).count(), 0);
  assert((await host.locator('#analysis').textContent()).includes('优先核验')); assert((await host.locator('#next').textContent()).includes('反馈实测结果'));
  assert.equal(await page.evaluate(() => globalThis.bad), undefined);
  await host.getByText('与 Index 讨论', { exact: true }).click(); await host.locator('#indexDraft').waitFor(); assert((await host.locator('#indexDraft').inputValue()).includes('反馈实测结果')); assert.equal(postCount, 0, 'handoff is a draft until explicitly sent');
  await nav.getByText('thinking', { exact: true }).click(); await host.getByText('分析已完成', { exact: true }).waitFor();
  mode = 'running'; await host.getByText('开始分析', { exact: true }).click(); await page.waitForFunction(() => { const r = document.getElementById('rlfe-personal-workspace').shadowRoot; return !r.getElementById('analyze').disabled && r.getElementById('analysisState').textContent === '分析已完成'; }); assert.equal(postCount, 1); assert(requests.find(r => r.method === 'POST').body.requestId.length >= 16);
  await page.screenshot({ path: join(artifacts, 'desktop.png') });
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); await host.locator('#title').waitFor();
    const geometry = await host.evaluate(h => ({ width: h.getBoundingClientRect().width, scroll: h.shadowRoot.getElementById('content').scrollWidth, content: h.shadowRoot.getElementById('content').clientWidth }));
    assert.equal(Math.round(geometry.width), width); assert(geometry.scroll <= geometry.content + 1, JSON.stringify(geometry)); await page.screenshot({ path: join(artifacts, 'mobile-' + width + '.png') }); }
  await page.setViewportSize({ width: 1440, height: 1000 });
  mode = 'failed'; await host.getByText('刷新', { exact: true }).click(); await host.getByText('fixture execution failed', { exact: true }).waitFor();
  assert.equal(await host.getByText('开始分析', { exact: true }).isEnabled(), true);
  mode = 'delay'; const begun = new Promise(r => { delayed = r; }); await host.getByText('刷新', { exact: true }).click(); await begun;
  await page.evaluate(() => { userId = '1000000000000000002'; window.dispatchEvent(new CustomEvent('rlfe:preferences')); }); releaseDelay();
  await host.getByText('账号已切换，请连接当前本人的账号。', { exact: true }).waitFor();
  assert.equal(await host.locator('#analysis').textContent(), ''); assert.equal(await host.locator('#todos').textContent(), ''); assert.equal(await host.locator('#indexDraft').inputValue(), '');
  assert.equal(await host.getByText('连接我的账号', { exact: true }).isVisible(), true);
  await page.keyboard.press('Escape'); assert.equal(await host.isVisible(), false); assert.equal(failures.length, 0, failures.join('\n'));
  const report = { passed: true, checks: ['exactly two new entries', 'existing navigation preserved', 'Index reused', 'analysis and next actions together', 'source links', 'no automatic sends', 'request IDs', 'failure surfaced', 'stale account response discarded', 'desktop/390/320 layout', 'Escape return', 'safe content rendering'], backend: 'hermetic fixture, no live model or Feishu writes', requests: requests.length };
  await writeFile(join(artifacts, 'browser-verification.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await browser.close(); }

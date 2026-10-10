// Optional real browser gate with synthetic sources only.
// node scripts/run-with-clean-instance-env.mjs node tests/test-project-feedback-browser.mjs <playwright module> <artifact dir> <browser executable>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const output = resolve(process.argv[3]), home = await mkdtemp(join(tmpdir(), 'feedback-browser-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'); await mkdir(config, { recursive: true }); await mkdir(output, { recursive: true });
const json = (path, value) => writeFile(path, JSON.stringify(value));
await json(join(config, 'auth.json'), { token: 'fixture-token' });
await json(join(config, 'auth-sessions.json'), { fixture: { role: 'owner', expiry: Date.now() + 3600000 } });
const legacyFile = join(home, 'legacy.json'), reviewFile = join(home, 'review.json'), qianyanFile = join(home, 'qianyan.json');
await json(legacyFile, { records: [{ id: 'old_feedback', actor: { name: 'Fixture reviewer' }, observedText: '<img src=x onerror=alert(1)> Show today’s decision.',
  source: { quote: 'Yesterday’s progress', url: 'https://example.test/report' }, eventTime: 1791620000, state: 'reviewed',
  interpretation: { assessment: 'The report repeats old progress.' } }] });
await json(reviewFile, { created_at: '2026-10-10T12:00:00Z', subprojects: [
  { subproject_id: 'reports', name: 'Reports', suggested_directions: ['Show today’s decision.'] },
  { subproject_id: 'recording', name: 'Recording', suggested_directions: [] }],
  themes: [{ id: 'one', subproject_id: 'reports', title: 'Current status', suggested_direction: 'Show the decision first.' }],
  classifications: [{ source_record_id: 'old_feedback', primary_subproject_id: 'reports', bucket: 'assigned_feedback', theme_id: 'one' }] });
await json(qianyanFile, { stage_feedback: [], selection_feedback: [], analysis_feedback: [] });
const metadataFile = join(home, 'metadata.json');
await json(metadataFile, { groups: [{ id: 'collaboration', name: 'Collaboration' }, { id: 'devices', name: 'Devices' }], projects: {
  reports: { group_id: 'collaboration', phase: 'existing', usage_features: ['feedback'], usage_scope: 'Saved web feedback only' },
  recording: { group_id: 'devices', started_at: new Date().toISOString(), phase: 'existing', usage_features: ['recording'] },
} });
await json(join(config, 'feedback-board.json'), { legacyFile, reviewFile, qianyanFile, metadataFile });
const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port; await new Promise(r => reservation.close(r)); const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['chat-server.mjs'], { env: { ...process.env, CHAT_PORT: String(port), REMOTELAB_CONFIG_DIR: config, SECURE_COOKIES: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
let browser;
try {
  await new Promise((resolveReady, reject) => {
    const deadline = setTimeout(() => reject(new Error(logs)), 15000);
    const ready = () => { if (logs.includes('Chat server listening')) { clearTimeout(deadline); child.stdout.off('data', ready); resolveReady(); } };
    child.stdout.on('data', ready); child.once('exit', () => { clearTimeout(deadline); reject(new Error(logs)); }); ready();
  });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.argv[4] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await context.addCookies([{ name: 'session_token', value: 'fixture', url: base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?tab=tasks&monitor=feedback');
  await page.locator('[data-subproject="reports"]').waitFor();
  assert.equal(await page.locator('#monitoringFeedbackTab').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.feedback-group').count(), 2);
  assert.match(await page.locator('[data-subproject="recording"]').innerText(), /New project to observe/);
  await page.locator('[data-subproject="reports"] .feedback-usage-scope summary').click();
  assert.match(await page.locator('[data-subproject="reports"]').innerText(), /Sampling since/);
  await page.locator('[data-subproject="reports"] .feedback-usage-scope summary').click();
  assert(await page.locator('[data-subproject="reports"]').getByRole('button', { name: 'Give feedback', exact: true }).isVisible());
  assert(await page.evaluate(() => [...document.querySelectorAll('.feedback-group .monitoring-table-wrap')].every(n => n.scrollWidth <= n.clientWidth + 1)), 'desktop keeps the feedback action and directions in view');
  assert.match(await page.locator('[data-subproject="recording"]').innerText(), /Not covered in this sample/);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.locator('[data-feedback-id="old_feedback"] summary').click();
  assert.match(await page.locator('.feedback-detail').innerText(), /Yesterday’s progress/);
  assert.match(await page.locator('.feedback-detail').innerText(), /does not prove/);
  assert.equal(await page.locator('.feedback-detail img').count(), 0, 'raw text must not execute HTML');
  await page.getByRole('button', { name: 'Add feedback about this record' }).click();
  await page.locator('#feedbackComment').fill('The new first paragraph is clear.');
  await page.locator('#feedbackSignal').selectOption('useful');
  await page.locator('#feedbackSubmit').click();
  await page.waitForFunction(() => document.querySelector('#feedbackReceipt').textContent.includes('Saved at'));
  await page.waitForFunction(() => document.querySelector('[data-subproject="reports"] td:nth-child(2)').firstChild.textContent === '2');
  await page.reload(); await page.locator('[data-subproject="reports"]').waitFor({ state: "attached" });
  assert.match(await page.locator('[data-subproject="reports"] td:nth-child(2)').textContent(), /^2/);
  await page.locator('.feedback-record').first().locator('summary').click();
  assert.match(await page.locator('.feedback-detail').innerText(), /awaiting analysis/);
  assert.match(await page.locator('.feedback-detail').innerText(), /old_feedback/);
  await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page must not overflow');
  await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  await page.locator('#monitoringFeedbackTab').focus(); await page.keyboard.press('Home');
  assert.equal(await page.locator('#monitoringOverviewTab').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#monitoringFeedbackTab').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.feedback-group').count(), 2);
  assert.match(await page.locator('[data-subproject="recording"]').innerText(), /New project to observe/);
  assert.match(await page.locator('[data-subproject="reports"]').innerText(), /Observed in window|Sampling since/);
  assert.equal(await page.locator('#taskCenterCreateToggle').isVisible(), false);
  await page.evaluate(() => window.remotelabSetUiLanguagePreference("zh-CN"));
  await page.locator(".feedback-composer > summary").click();
  assert.equal(await page.locator("#feedbackSubmit").innerText(), "保存反馈");
  assert.equal(await page.locator("#monitoringFeedbackTab").innerText(), "反馈与改进");
  await page.getByRole("button", { name: "返回子项目列表" }).click();
  assert.match(await page.locator('[data-subproject="recording"]').innerText(), /本批未覆盖/);
  await page.screenshot({ path: join(output, "mobile-zh.png"), fullPage: true });
  await page.locator('[data-subproject="recording"]').getByRole("button", { name: "给反馈", exact: true }).click();
  await page.locator("#feedbackComment").fill("Fixture: the recording indicator should be visible.");
  let loseReceipt = true;
  await context.route("**/api/project-feedback", async route => {
    if (route.request().method() === "POST" && loseReceipt) {
      loseReceipt = false; await route.fetch(); await route.abort("failed");
    } else await route.continue();
  });
  await page.locator("#feedbackSubmit").click();
  await page.waitForFunction(() => document.querySelector("#feedbackReceipt").textContent.includes("内容已保留"));
  assert.equal(await page.locator("#feedbackComment").inputValue(), "Fixture: the recording indicator should be visible.");
  await page.locator("#feedbackSubmit").click();
  await page.waitForFunction(() => document.querySelector("#feedbackReceipt").textContent.includes("已保存"));
  await page.waitForFunction(() => document.querySelector('[data-subproject="recording"] td:nth-child(2)').firstChild.textContent === "1");
  await context.unroute("**/api/project-feedback");
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'verification.json'), JSON.stringify({ desktop: true, mobile: true, save_readback: true, reload: true, reference_preserved: true, keyboard_tabs: true, bilingual: true, uncertain_save_retry: true, no_html_execution: true, page_errors: errors }, null, 2));
  console.log('Project feedback browser: detail, context, submit/readback, reload, mobile, keyboard, XSS passed.');
} finally {
  await browser?.close(); child.kill('SIGTERM');
  await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else child.once('exit', resolveExit); });
  await writeFile(join(output, 'server.log'), logs); await rm(home, { recursive: true, force: true });
}

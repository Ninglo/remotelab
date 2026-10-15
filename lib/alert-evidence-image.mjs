import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from './config.mjs';
import { alertText, alertTime } from './alert-card-history.mjs';

// Render only frozen, recipient-safe evidence, never fetch another dashboard or
// collect fresh samples here. An image failure must not suppress a real alert.
export async function prepareAlertEvidenceImage(item, config) {
  if (item.evidenceImage?.imageKey || item.evidenceImageAttempted || !config.snapshot) return;
  item.evidenceImageAttempted = true;
  const source = { subject: item.subject || item.metric || '预警记录',
    at: item.triggerEvidenceAt || item.triggeredAt || item.createdAt || item.observedAt || null,
    reason: item.triggerReason || item.originalTrigger || item.trigger || '原记录未注明触发数值',
    evidence: (item.evidence || []).filter(x => typeof x === 'string').slice(0, 4) };
  const browserConfig = config.snapshot;
  const key = createHash('sha256').update(JSON.stringify([config.profile, config.configDir, source])).digest('hex');
  const directory = join(CONFIG_DIR, 'alert-evidence-images');
  const receiptPath = join(directory, `${key}.receipt.json`);
  try {
    try { const saved = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (/^img_[\w-]+$/.test(saved.imageKey)) { item.evidenceImage = saved; return; } } catch {}
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { chromium } = await import(browserConfig.playwrightModule ? pathToFileURL(browserConfig.playwrightModule).href : 'playwright');
    const browser = await chromium.launch({ headless: true, timeout: 15000,
      ...(browserConfig.browserExecutable ? { executablePath: browserConfig.browserExecutable } : {}),
      args: browserConfig.noSandbox ? ['--no-sandbox'] : [],
      env: { ...process.env, ...(browserConfig.libraryPath ? { LD_LIBRARY_PATH: browserConfig.libraryPath } : {}) } });
    const imagePath = join(directory, `${key}.png`);
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1.5 });
      await page.route('**/*', route => route.abort());
      await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#fff;color:#202020;font:22px sans-serif}main{padding:32px}h1{font-size:28px;margin:0 0 18px}p{line-height:1.6;overflow-wrap:anywhere}.note{color:#666;font-size:18px}</style><main><h1>${alertText(source.subject)} · 监测记录</h1><p class="note">${alertTime(source.at)}（北京时间）</p><p>${alertText(source.reason)}</p>${source.evidence.map(e => `<p>${alertText(e.slice(0, 500))}</p>`).join('')}<p class="note">监测记录节选 · 数据时间见上方，非当前实时读数</p></main></html>`);
      await page.locator('main').screenshot({ path: imagePath, timeout: 10000 });
    } finally { await browser.close(); }
    await writeFile(join(directory, `${key}.json`), JSON.stringify(source), { mode: 0o600 });
    const { stdout } = await promisify(execFile)('lark-cli', ['--profile', config.profile, 'im', 'images', 'create', '--as', 'bot',
      '--data', '{"image_type":"message"}', '--file', `image=./${key}.png`], { cwd: directory, timeout: 25000, maxBuffer: 100000,
      env: { ...process.env, ...(config.configDir ? { LARKSUITE_CLI_CONFIG_DIR: config.configDir } : {}) } });
    const response = JSON.parse(stdout), imageKey = response.data?.image_key || response.image_key;
    if (!/^img_[\w-]+$/.test(imageKey || '')) throw new Error('MISSING_IMAGE_RECEIPT');
    item.evidenceImage = { imageKey, caption: '预警依据的监测数据记录（含记录时间）', sourceAt: source.at };
    await writeFile(receiptPath, JSON.stringify(item.evidenceImage), { mode: 0o600 });
  } catch (error) { item.evidenceImageError = error.code || 'IMAGE_UNAVAILABLE'; }
}

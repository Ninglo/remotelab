import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const writeJson = async (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path);
};

// This optional browser workflow captures the shipped UI. It neither invokes a
// model nor sends a message; the existing daily reply owns recipient and delivery.
export async function captureMonitoringSnapshot({ baseUrl, output, days = 1, configDir, upload = false }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || ![1, 7, 30].includes(days)) {
    throw new Error('Provide an HTTP instance URL and days 1, 7 or 30');
  }
  const config = JSON.parse(await readFile(join(configDir, 'monitoring.json'), 'utf8'));
  const browserConfig = config.snapshot || {};
  const { serviceToken } = JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8'));
  if (!serviceToken) throw new Error('Instance authentication is unavailable');
  const apiUrl = new URL(`/api/monitoring/overview?days=${days}`, base);
  const response = await fetch(apiUrl, { headers: { Authorization: `Bearer ${serviceToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Monitoring read failed (${response.status})`);
  const snapshot = await response.json();
  if (!snapshot.generatedAt || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.attention)) throw new Error('Invalid monitoring source');
  const prefix = resolve(output); await mkdir(dirname(prefix), { recursive: true });
  const { chromium } = await import(browserConfig.playwrightModule ? pathToFileURL(resolve(browserConfig.playwrightModule)).href : 'playwright');
  const browser = await chromium.launch({ headless: true,
    ...(browserConfig.browserExecutable ? { executablePath: browserConfig.browserExecutable } : {}),
    args: browserConfig.noSandbox ? ['--no-sandbox'] : [],
    env: { ...process.env, ...(browserConfig.libraryPath ? { LD_LIBRARY_PATH: browserConfig.libraryPath } : {}) },
  });
  let dimensions;
  try {
    const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), headers = { ...request.headers() };
      delete headers.authorization;
      if (url.origin === base.origin) {
        if (url.pathname === '/api/monitoring/overview') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }); return;
        }
        headers.authorization = `Bearer ${serviceToken}`;
      }
      await route.continue({ headers });
    });
    const page = await context.newPage();
    await page.goto(new URL('/?tab=tasks&monitor=overview', base).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const element = page.locator('#monitoringSnapshot'); await element.waitFor({ timeout: 30_000 });
    // Remove the app's nested scroll clipping in this private browser only.
    // The exact rendered snapshot keeps its styles and source timestamp.
    await element.evaluate(root => {
      root.classList.add('monitoring-snapshot-export');
      document.body.classList.add('monitoring-snapshot-page');
      document.body.replaceChildren(root);
    });
    await page.evaluate(() => document.fonts.ready);
    dimensions = await element.boundingBox();
    if (!dimensions || dimensions.width * 2 > 12000 || dimensions.height * 2 > 12000) throw new Error('Snapshot exceeds image dimensions');
    await element.screenshot({ path: `${prefix}.png`, animations: 'disabled' }); await chmod(`${prefix}.png`, 0o600);
  } finally { await browser.close(); }
  const png = await readFile(`${prefix}.png`);
  if (!png.length || png.length > 10 * 1024 * 1024) throw new Error('Snapshot exceeds image size');
  await writeJson(`${prefix}.json`, snapshot);
  const receipt = { generatedAt: snapshot.generatedAt, capturedAt: new Date().toISOString(),
    image: `${prefix}.png`, source: `${prefix}.json`, sha256: createHash('sha256').update(png).digest('hex'),
    width: Math.round(dimensions.width * 2), height: Math.round(dimensions.height * 2),
    accountCount: snapshot.accounts.length, attentionCount: snapshot.attention.length, uploaded: false, sent: false };
  if (upload) {
    if (!browserConfig.profile || !browserConfig.cliConfigDir) throw new Error('Snapshot upload needs an explicit Bot profile and CLI configuration');
    const { stdout } = await promisify(execFile)('lark-cli', ['--profile', browserConfig.profile, 'im', 'images', 'create', '--as', 'bot',
      '--data', JSON.stringify({ image_type: 'message' }), '--file', `image=./${basename(prefix)}.png`], {
      cwd: dirname(prefix), timeout: 30_000, maxBuffer: 100_000,
      env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: browserConfig.cliConfigDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    });
    const uploaded = JSON.parse(stdout), key = uploaded.data?.image_key || uploaded.image_key;
    if (!/^img_[\w-]+$/.test(key || '')) throw new Error('Snapshot upload has no image receipt');
    receipt.uploaded = true; receipt.imageKey = key; receipt.profile = browserConfig.profile;
    receipt.markdown = `${prefix}.md`;
    const timestamp = new Date(snapshot.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const overviewUrl = browserConfig.overviewUrl || config.alertDelivery?.overviewUrl || new URL('/?tab=tasks&monitor=overview', base).href;
    await writeFile(receipt.markdown, `本轮监管快照：${timestamp}（北京时间）。\n\n![紧急事项与账号余量](${key})\n\n[查看实时监管总览](${overviewUrl})\n`, { mode: 0o600 });
  }
  await writeJson(`${prefix}.receipt.json`, receipt);
  return receipt;
}

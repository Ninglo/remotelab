import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, readJson, writeJson, sealImages, stateRoot } from './publisher.mjs';

const run = promisify(execFile);
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function cardHtml(title, body, index, total, fontData = '') {
  return `<!doctype html><meta charset="utf-8"><style>
  ${fontData ? `@font-face{font-family:CardCN;src:url(data:font/ttf;base64,${fontData})}` : ''}
  *{box-sizing:border-box}html,body{margin:0;width:1080px;height:1440px;background:#f8f8fa;color:#1c1c1e;font-family:CardCN,"Noto Sans CJK SC",sans-serif}
  main{padding:90px 80px;height:1440px;display:flex;flex-direction:column}h1{font-size:64px;line-height:1.3;margin:0 0 56px;font-weight:700;overflow-wrap:anywhere}
  article{font-size:42px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:auto;padding-top:32px;border-top:2px solid #e5e5ea;color:#636366;font-size:26px}
  </style><main><h1>${escape(title)}</h1><article>${escape(body)}</article><footer>${index + 1} / ${total}</footer></main>`;
}
export function cardPages(text) {
  const pages = []; let page = '', col = 0, lines = 1;
  for (const char of Array.from(text)) {
    const nextLine = char === '\n' || col >= 21;
    if (nextLine && lines >= 12) { pages.push(page); page = ''; col = 0; lines = 1; }
    else if (nextLine) { lines++; col = 0; }
    page += char;
    if (char !== '\n') col++;
  }
  if (page) pages.push(page);
  return pages;
}
export async function renderCards(manifestFile, chrome, fontFile = process.env.SOCIAL_PUBLISH_FONT_FILE) {
  const runtime = await readJson(join(stateRoot, 'runtime.json'), {});
  chrome ||= runtime.chrome; fontFile ||= runtime.fontFile;
  if (!chrome) throw new Error('需要独立 Chrome 可执行文件路径');
  const m = await readJson(manifestFile), p = m.platforms?.xiaohongshu;
  if (!p) throw new Error('manifest 没有小红书内容');
  if (p.images.length) return { images: p.images, existing: true };
  const pages = cardPages(p.content);
  if (!pages.length || pages.length > 9) throw new Error('文字卡页数超出 1–9，请先适配内容');
  const dir = join(dirname(manifestFile), m.jobId + '-cards'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const fontData = fontFile ? (await readFile(fontFile)).toString('base64') : '';
  const profile = await mkdtemp(join(tmpdir(), 'social-card-chrome-'));
  try {
    for (let i = 0; i < pages.length; i++) {
      const html = join(dir, `card-${i + 1}.html`), png = join(dir, `card-${i + 1}.png`);
      await writeFile(html, cardHtml(p.title, pages[i], i, pages.length, fontData), { mode: 0o600 });
      await run(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-pdf-header-footer', `--user-data-dir=${profile}`, '--window-size=1080,1440', `--screenshot=${png}`, pathToFileURL(html).href], { timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, ...(runtime.libraryPath ? { LD_LIBRARY_PATH: runtime.libraryPath } : {}), ...(runtime.fontConfig ? { FONTCONFIG_FILE: runtime.fontConfig } : {}) } });
      p.images.push(png);
    }
  } finally { await rm(profile, { recursive: true, force: true }); }
  await writeJson(manifestFile, await sealImages(m));
  return { images: p.images, generated: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = args(process.argv.slice(2));
  renderCards(resolve(a.file), a.chrome || process.env.SOCIAL_PUBLISH_CHROME, a.font || process.env.SOCIAL_PUBLISH_FONT_FILE)
    .then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; });
}

import { mkdir, readFile, readdir, open, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_DIR, PUBLIC_PAGES_DIR, PUBLIC_BASE_URL } from './config.mjs';

const slugPattern = /^[a-z0-9][a-z0-9._-]*$/;
const editable = { title: 200, project: 100, description: 600, contact: 200, sourceLocation: 1000, repository: 1000, notes: 3000, status: 24 };
const fail = (status, message) => Object.assign(new Error(message), { status });
const atomic = async (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
};
async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function sourceFile(configDir, id) { return join(configDir, 'site-origins', createHash('sha256').update(id).digest('hex') + '.json'); }
export async function recordSiteOrigin({ kind, slug, sourcePath = '', workingDirectory = process.cwd(), runtimeDirectory, sessionId = process.env.REMOTELAB_SESSION_ID || '', requestId = process.env.REMOTELAB_REQUEST_ID || '', configDir = CONFIG_DIR }) {
  if (!['static', 'preview'].includes(kind) || !slugPattern.test(slug) || slug === '..') throw Error('Invalid website origin');
  await mkdir(join(configDir, 'site-origins'), { recursive: true });
  const id = `${kind}:${slug}`, path = sourceFile(configDir, id);
  const prior = await jsonFile(path, {});
  await atomic(path, { ...prior, id, sourcePath, workingDirectory, runtimeDirectory: runtimeDirectory || '', sessionId, requestId, recordedAt: new Date().toISOString() });
}
function safeUrl(value) {
  if (typeof value !== 'string') throw fail(400, '网站链接无效');
  let url;
  try { url = new URL(value); } catch { throw fail(400, '请输入完整的 http 或 https 网站链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2048
    || [...url.searchParams.keys()].some(k => /^(?:.*token|.*secret|password|passwd|api[_-]?key|access[_-]?key|code|signature)$/i.test(k))) throw fail(400, '网站链接不能包含登录凭据或临时授权参数');
  return url.href;
}
function cleanValues(input, external = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '登记内容无效');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'url' && external) { result.url = safeUrl(value); continue; }
    if (!Object.hasOwn(editable, key) || typeof value !== 'string' || value.length > editable[key]) throw fail(400, '登记字段或长度无效');
    result[key] = value.trim();
  }
  if (Object.hasOwn(result, 'title') && !result.title) throw fail(400, '请填写网站名称');
  if (Object.hasOwn(result, 'status') && !['active', 'planned', 'archived', 'unreviewed'].includes(result.status)) throw fail(400, '登记状态无效');
  if (result.repository) result.repository = safeUrl(result.repository);
  return result;
}
async function pageTitle(root, entry) {
  if (!/\.html?$/i.test(entry)) return '';
  const path = resolve(root, entry);
  if (relative(root, path).startsWith('..')) return '';
  let handle;
  try {
    if (relative(await realpath(root), await realpath(path)).startsWith('..')) return '';
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(65536); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(buffer.subarray(0, bytesRead).toString('utf8'));
    return (match?.[1] || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch { return ''; } finally { await handle?.close(); }
}

export function createSiteDirectory({ configDir = CONFIG_DIR, pagesDir = PUBLIC_PAGES_DIR, baseUrl = PUBLIC_BASE_URL, people = async () => [] } = {}) {
  const path = join(configDir, 'site-directory.json');
  let queue = Promise.resolve();
  async function document() { return jsonFile(path, { schemaVersion: 1, records: {}, history: [] }); }
  async function listing() {
    const d = await document(), errors = [], entries = [], names = new Map((await people()).map(p => [p.id, p.name]));
    let directories = [];
    try { directories = await readdir(pagesDir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const staticEntries = await Promise.all(directories.filter(e => e.isDirectory() && slugPattern.test(e.name) && !e.name.startsWith('.')).map(async dir => {
      const root = join(pagesDir, dir.name); let m = {};
      try { m = await jsonFile(join(root, '_remote_publish.json'), {}); } catch { errors.push(`静态记录 ${dir.name} 的发布信息无法读取`); }
      const entry = typeof m.entry === 'string' && !m.entry.startsWith('/') && !m.entry.split('/').includes('..') ? m.entry : 'index.html';
      let entryPresent = false;
      try { entryPresent = (await stat(join(root, entry))).isFile() && !relative(await realpath(root), await realpath(join(root, entry))).startsWith('..'); } catch {}
      return { id: `static:${dir.name}`, kind: entryPresent && /\.html?$/i.test(entry) ? 'static' : 'asset', slug: dir.name,
        title: await pageTitle(root, entry) || dir.name, url: entryPresent ? `${baseUrl}/public-pages/${encodeURIComponent(dir.name)}/${entry.split('/').map(encodeURIComponent).join('/')}` : '', entryPresent,
        originalUrl: typeof m.publicUrl === 'string' ? m.publicUrl : '', ownerPersonId: m.ownerPersonId || '', access: m.access || 'public',
        publishedAt: m.publishedAt || '', files: m.files ?? null, bytes: m.bytes ?? null, metadataMissing: !m.schemaVersion,
        deployment: { directory: root, entry } };
    }));
    entries.push(...staticEntries);
    const previews = await jsonFile(join(configDir, 'preview-routes.json'), {});
    for (const [slug, route] of Object.entries(previews)) {
      if (!slugPattern.test(slug) || !Number.isInteger(route.port)) { errors.push('存在无效动态入口记录'); continue; }
      entries.push({ id: `preview:${slug}`, kind: 'preview', slug, title: slug, url: `${baseUrl}/preview/${slug}/`,
        ownerPersonId: route.ownerPersonId || '', access: route.access || 'basic', deployment: { loopbackPort: route.port }, publishedAt: '' });
    }
    for (const [id, record] of Object.entries(d.records)) {
      if (id.startsWith('external:')) entries.push({ id, kind: 'external', title: record.values.title, url: record.values.url,
        ownerPersonId: record.createdBy, access: 'external', publishedAt: record.createdAt, deployment: {} });
    }
    const present = new Set(entries.map(e => e.id));
    for (const [id, record] of Object.entries(d.records)) {
      if (!present.has(id)) entries.push({ id, kind: 'missing', title: record.values.title || id, url: '', ownerPersonId: '', access: 'unknown', deployment: {}, publishedAt: '', missing: true });
    }
    const results = await Promise.all(entries.map(async entry => {
      const record = d.records[entry.id], v = record?.values || {};
      let origin = {};
      try { origin = await jsonFile(sourceFile(configDir, entry.id), {}); } catch { errors.push(`来源记录 ${entry.id} 无法读取`); }
      const values = { title: entry.title, project: '', description: '', contact: '', sourceLocation: '', repository: '', notes: '', status: 'unreviewed', ...v };
      const ownerName = names.get(entry.ownerPersonId) || '';
      return { ...entry, ...values, ownerName, origin, revision: record?.revision || 0,
        updatedAt: record?.updatedAt || entry.publishedAt, updatedBy: names.get(record?.updatedBy) || '',
        gaps: [!ownerName && !values.contact && '负责人', !values.project && '项目', !values.sourceLocation && !origin.sourcePath && !origin.runtimeDirectory && '源码或部署位置', entry.entryPresent === false && '入口文件'].filter(Boolean) };
    }));
    results.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title, 'zh-CN'));
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: '当前实例的静态发布、动态入口，以及人工登记的外部网站；登记存在不代表服务在线。', entries: results, errors,
      totals: { all: results.length, static: staticEntries.length, preview: entries.filter(e => e.kind === 'preview').length,
        external: entries.filter(e => e.kind === 'external').length, needsReview: results.filter(e => e.gaps.length || e.status === 'unreviewed').length } };
  }
  function save({ id, revision, values }, actor) {
    const task = queue.then(async () => {
      if (!actor?.id) throw fail(401, '请先登录');
      if (id !== undefined && typeof id !== 'string' || !Number.isInteger(revision) || revision < 0) throw fail(400, '登记版本无效');
      const d = await document(), isNew = !id;
      if (isNew) id = `external:${randomUUID()}`;
      const external = id.startsWith('external:'), clean = cleanValues(values, external);
      if (isNew && (!clean.title || !clean.url)) throw fail(400, '请填写网站名称和链接');
      const current = d.records[id];
      if ((current?.revision || 0) !== revision) throw fail(409, '这条记录刚被更新，请刷新后再修改');
      if (!isNew && !(await listing()).entries.some(e => e.id === id)) throw fail(404, '网站记录不存在');
      const combined = { ...(current?.values || {}), ...clean };
      if (external) {
        const existing = (await listing()).entries.find(e => e.id !== id && e.url === combined.url);
        if (existing) throw fail(409, `该链接已登记为「${existing.title}」`);
      }
      const now = new Date().toISOString();
      d.records[id] = { ...current, values: combined, revision: (current?.revision || 0) + 1,
        createdBy: current?.createdBy || actor.id, createdAt: current?.createdAt || now, updatedBy: actor.id, updatedAt: now };
      d.history.push({ id, revision: d.records[id].revision, at: now, by: actor.id, before: current?.values || null, after: combined });
      await mkdir(configDir, { recursive: true }); await atomic(path, d);
      return { id, revision: d.records[id].revision };
    });
    queue = task.catch(() => {}); return task;
  }
  return { listing, save };
}

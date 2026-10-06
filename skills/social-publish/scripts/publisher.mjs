import { readFile, writeFile, mkdir, rename, unlink, open, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const stateRoot = process.env.SOCIAL_PUBLISH_STATE_ROOT || join(homedir(), '.config/social-publish');
export const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const requireThat = (ok, text) => { if (!ok) throw new Error(text); };
export function personDir(person, root = stateRoot) {
  requireThat(/^person_[a-zA-Z0-9_-]{1,80}$/.test(person || ''), '需要当前已核 personId');
  return join(root, person);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(file, data) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}
export async function settings(person, root = stateRoot) {
  return readJson(join(personDir(person, root), 'settings.json'), { version: 1, personId: person });
}
export async function withPersonLock(person, root, fn) {
  const dir = personDir(person, root); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'operation.lock'); let lock;
  try { lock = await open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = await readJson(file, {});
    requireThat(Number.isInteger(owner.pid), '已有操作锁，需先核对持有者');
    try { process.kill(owner.pid, 0); throw new Error('该账号已有操作进行中'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
    await unlink(file); lock = await open(file, 'wx', 0o600);
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() })); return await fn(); }
  finally { await lock.close(); await unlink(file); }
}
export async function saveSettings(person, next, root = stateRoot) {
  return withPersonLock(person, root, async () => {
    const old = await settings(person, root);
    await writeJson(join(personDir(person, root), 'settings.json'), { ...old, ...next, personId: person, updatedAt: now() });
  });
}
export function xWeight(text) {
  // Conservative: non-ASCII may be overcounted; never underestimate CJK or emoji.
  return Array.from(text.replace(/https?:\/\/[^\s]+/g, 'x'.repeat(23))).reduce((n, c) => n + (c.codePointAt(0) <= 0x7f ? 1 : 2), 0);
}
export function splitX(text) {
  requireThat(typeof text === 'string' && text.trim(), 'X 内容为空');
  const parts = []; let part = '';
  // Keep URLs intact; other tokens are code points, so surrogate pairs survive.
  for (const token of text.match(/https?:\/\/[^\s]+|[\s\S]/gu) || []) {
    if (xWeight(part + token) > 270) { parts.push(part); part = ''; }
    part += token;
  }
  if (part) parts.push(part);
  return parts;
}
function validateManifest(m) {
  personDir(m.personId);
  requireThat(m.source?.sessionId && (m.source?.messageId || m.source?.requestId), '缺少原请求引用');
  requireThat(m.platforms && Object.keys(m.platforms).length > 0, '需要明确目标平台');
  requireThat(Object.keys(m.platforms).every(k => ['x', 'xiaohongshu'].includes(k)), '本版本支持 X 和小红书，知乎尚未接入');
  if (m.publishAt) {
    requireThat(/(Z|[+-]\d\d:\d\d)$/.test(m.publishAt) && Number.isFinite(Date.parse(m.publishAt)), '发布时间需要明确时区');
  }
  if (m.platforms.x) {
    const p = m.platforms.x;
    requireThat(Array.isArray(p.thread) && p.thread.length >= 1 && p.thread.length <= 25, 'X 需要 1–25 段串文');
    requireThat(p.thread.every(t => typeof t === 'string' && t.trim() && xWeight(t) <= 280), 'X 单段超过限制或为空');
    requireThat((p.images || []).length <= 4 && (p.images || []).every(u => typeof u === 'string' && /^https:\/\//.test(u)), 'X 最多 4 张图片，需要 HTTPS 公共图片地址');
  }
  if (m.platforms.xiaohongshu) {
    const p = m.platforms.xiaohongshu;
    requireThat(typeof p.title === 'string' && p.title.trim() && Array.from(p.title).length <= 20, '小红书标题需为 1–20 字');
    requireThat(typeof p.content === 'string' && p.content.trim(), '小红书正文为空');
    requireThat(Array.isArray(p.tags) && p.tags.every(t => typeof t === 'string' && t && !/[#\s]/.test(t)), '标签应是不带井号的文字');
    requireThat(Array.from(p.content + p.tags.map(t => ` #${t}`).join('')).length <= 1000, '小红书正文与标签超过 1000 字，需要适配');
    requireThat(Array.isArray(p.images) && p.images.length <= 9, '小红书图片最多 9 张');
    requireThat(p.images.every(f => typeof f === 'string' && isAbsolute(f)), '小红书图片使用本地绝对路径');
    requireThat(['公开可见', '仅自己可见', '仅互关好友可见'].includes(p.visibility), '小红书可见范围无效');
  }
  return m;
}
export function prepare(input) {
  const m = structuredClone(input); m.version = 1;
  if (m.platforms?.x) {
    m.platforms.x.thread ||= splitX(m.platforms.x.text);
    delete m.platforms.x.text;
  }
  if (m.platforms?.xiaohongshu) {
    const p = m.platforms.xiaohongshu; p.tags ||= []; p.images ||= []; p.visibility ||= '公开可见';
  }
  m.jobId = hash(JSON.stringify([m.personId, m.source?.sessionId, m.source?.messageId || m.source?.requestId])).slice(0, 24);
  return validateManifest(m);
}
export async function sealImages(m) {
  for (const p of Object.values(m.platforms)) {
    p.imageHashes = {};
    for (const f of p.images || []) if (isAbsolute(f)) p.imageHashes[f] = hash(await readFile(f));
  }
  return m;
}
export class ProviderError extends Error {
  constructor(message, rejected = false) { super(message); this.rejected = rejected; }
}
export async function requestJson(url, { fetchImpl = fetch, method = 'GET', body, token, timeout = 30000 } = {}) {
  let r;
  try { r = await fetchImpl(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) }); }
  catch { throw new ProviderError('接口连接失败或超时，写入结果需回读'); }
  if (!r.ok) throw new ProviderError(`接口返回 HTTP ${r.status}`, r.status >= 400 && r.status < 500);
  let data; try { data = await r.json(); } catch { throw new ProviderError('接口响应格式异常，结果需回读'); }
  return data;
}
export async function bufferQuery(config, query, variables = {}, fetchImpl = fetch) {
  const r = await requestJson('https://api.buffer.com', { method: 'POST', token: config.apiKey, body: { query, variables }, fetchImpl });
  if (r.errors?.length) throw new ProviderError('Buffer 响应含协议错误；写入结果需回读，不能直接重发', !/^\s*mutation\b/.test(query));
  requireThat(r.data, 'Buffer 响应缺少 data'); return r.data;
}
export async function discoverBuffer(apiKey, fetchImpl = fetch) {
  requireThat(typeof apiKey === 'string' && apiKey.length >= 10 && apiKey.length <= 4096 && !/[\r\n]/.test(apiKey), '密钥格式无效');
  const c = { apiKey }; const d = await bufferQuery(c, '{ account { organizations { id name } } }', {}, fetchImpl);
  const found = [];
  for (const org of d.account.organizations) {
    const x = await bufferQuery(c, 'query Channels($org: OrganizationId!) { channels(input:{organizationId:$org}) {id name service} }', { org: org.id }, fetchImpl);
    for (const channel of x.channels) if (['twitter', 'x'].includes(channel.service?.toLowerCase())) found.push({ ...channel, organizationId: org.id, organizationName: org.name });
  }
  return found;
}
export async function xhsQuery(c, path, body, fetchImpl = fetch) {
  requireThat(/^http:\/\/127\.0\.0\.1:\d+$/.test(c.baseUrl || ''), '小红书后台须使用独立 loopback 地址');
  const d = await requestJson(c.baseUrl + '/api/v1' + path, { token: c.token, method: body ? 'POST' : 'GET', body, timeout: 120000, fetchImpl });
  if (!d.success) throw new ProviderError('小红书后台未确认操作结果'); return d.data;
}
const POST_FIELDS = 'id text status externalLink sentAt dueAt';
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
export async function preflight(m, cfg, targets, fetchImpl = fetch) {
  const proofs = {};
  if (targets.includes('x')) {
    requireThat(cfg.x?.apiKey && cfg.x?.channelId && cfg.x?.organizationId, 'X 尚未绑定，请在绑定页选择账号');
    const channels = await discoverBuffer(cfg.x.apiKey, fetchImpl);
    requireThat(channels.some(c => c.id === cfg.x.channelId && c.organizationId === cfg.x.organizationId), '绑定的 X 账号已不存在或授权失效');
    proofs.x = { channelId: cfg.x.channelId };
  }
  if (targets.includes('xiaohongshu')) {
    const c = cfg.xiaohongshu;
    requireThat(c?.accountId, '小红书尚未绑定并确认账号');
    const login = await xhsQuery(c, '/login/status', undefined, fetchImpl);
    requireThat(login.is_logged_in && login.user_id === c.accountId, '小红书登录失效或当前账号与绑定不同');
    const me = await xhsQuery(c, '/user/me', undefined, fetchImpl);
    proofs.xiaohongshu = { accountId: c.accountId, beforeNoteIds: (me.feeds || []).map(f => f.id) };
    requireThat(m.platforms.xiaohongshu.images.length > 0, '小红书需要配图，请先生成文字卡');
    for (const f of m.platforms.xiaohongshu.images) {
      requireThat((await stat(f)).isFile(), '小红书配图不存在');
      requireThat(m.platforms.xiaohongshu.imageHashes?.[f] === hash(await readFile(f)), '配图发生变化，请重新准备并核对');
    }
  }
  if (m.publishAt) {
    const delta = Date.parse(m.publishAt) - Date.now();
    requireThat(delta > 0, '预定时间已过，请按原意安排或改为立即发布');
    if (targets.includes('xiaohongshu')) requireThat(delta >= 3600000 && delta <= 14 * 86400000, '小红书原生定时范围是 1 小时到 14 天，请改用 RemoteLab Trigger');
  }
  return proofs;
}
export async function sendX(m, c, fetchImpl) {
  const p = m.platforms.x;
  const assets = (p.images || []).map(url => ({ image: { url } }));
  const input = { text: p.thread[0], channelId: c.channelId, schedulingType: 'automatic', mode: m.publishAt ? 'customScheduled' : 'shareNow', assets, needsApproval: false, aiAssisted: true, ...(m.publishAt ? { dueAt: m.publishAt } : {}) };
  if (p.thread.length > 1) input.metadata = { twitter: { thread: p.thread.map((text, i) => ({ text, assets: i === 0 ? assets : [] })) } };
  const d = await bufferQuery(c, `mutation Publish($input:CreatePostInput!) { createPost(input:$input) { ... on PostActionSuccess {post {${POST_FIELDS}}} ... on MutationError {message} } }`, { input }, fetchImpl);
  if (!d.createPost?.post?.id) throw new ProviderError('Buffer 未创建帖子，请核对账号发布权限或内容限制', !!d.createPost?.message);
  return { providerId: d.createPost.post.id, status: 'submitted' };
}
export async function checkX(entry, m, c, fetchImpl) {
  requireThat(c?.channelId === entry.channelId, 'X 回读账号与原发送账号不同');
  let post;
  if (entry.providerId) {
    const d = await bufferQuery(c, `query GetPost($input:PostInput!) {post(input:$input) {${POST_FIELDS}}}`, { input: { id: entry.providerId } }, fetchImpl); post = d.post;
  }
  // No ID after a timeout: keep uncertain rather than matching an arbitrary repeated text.
  if (!post || post.text !== m.platforms.x.thread[0]) return entry;
  const status = String(post.status).toLowerCase();
  if (status === 'sent' && post.externalLink) return { ...entry, status: 'sent', url: post.externalLink, verifiedAt: now() };
  if (status === 'error') return { ...entry, status: 'provider-error', reason: 'Buffer 报告平台发布失败；先核对串文是否有部分已发布' };
  if (m.publishAt && ['buffer', 'scheduled'].includes(status) && Date.parse(post.dueAt) === Date.parse(m.publishAt)) return { ...entry, status: 'scheduled', publishAt: m.publishAt, verifiedAt: now() };
  return { ...entry, providerStatus: status };
}
export async function checkXhs(entry, m, c, fetchImpl) {
  const login = await xhsQuery(c, '/login/status', undefined, fetchImpl);
  requireThat(login.is_logged_in && login.user_id === entry.accountId && c.accountId === entry.accountId, '小红书回读账号与原发送账号不同');
  const me = await xhsQuery(c, '/user/me', undefined, fetchImpl); const p = m.platforms.xiaohongshu;
  for (const f of me.feeds || []) {
    if ((entry.beforeNoteIds || []).includes(f.id) || norm(f.noteCard?.displayTitle) !== norm(p.title)) continue;
    const detail = await xhsQuery(c, '/feeds/detail', { feed_id: f.id, xsec_token: f.xsecToken, load_all_comments: false }, fetchImpl);
    const n = detail.note || {};
    const variants = [p.content, p.content + ' ' + p.tags.map(t => `#${t}`).join(' '), p.content + ' ' + p.tags.map(t => `#${t}[话题]#`).join(' ')].map(norm);
    if (n.user?.userId !== entry.accountId || norm(n.title) !== norm(p.title) || !variants.includes(norm(n.desc))) continue;
    if (n.time && n.time < Date.parse(entry.startedAt) - 60000) continue;
    return { ...entry, status: 'sent', providerId: f.id, url: `https://www.xiaohongshu.com/explore/${f.id}`, verifiedAt: now(), visibility: p.visibility };
  }
  return entry;
}
async function reconcileEntries(receipt, m, cfg, fetchImpl) {
  for (const [platform, e] of Object.entries(receipt.platforms)) {
    if (!['sending', 'uncertain', 'submitted', 'scheduled'].includes(e.status)) continue;
    try {
      receipt.platforms[platform] = platform === 'x' ? await checkX(e, m, cfg.x, fetchImpl) : await checkXhs(e, m, cfg.xiaohongshu, fetchImpl);
    } catch (err) { receipt.platforms[platform].readbackError = err.message; }
  }
}
export async function publish(m, { root = stateRoot, fetchImpl = fetch, retryRejected = false, readOnly = false } = {}) {
  validateManifest(m);
  requireThat(m.jobId === prepare(m).jobId, 'jobId 与原请求不符');
  if (!readOnly) requireThat(m.authorization === 'publish', '缺少用户明确发布授权，保留草稿');
  return withPersonLock(m.personId, root, async () => {
    const cfg = await settings(m.personId, root), dir = join(personDir(m.personId, root), 'receipts');
    requireThat(cfg.personId === m.personId, '配置 Person 与当前请求不符');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, m.jobId + '.json'), fingerprint = hash(JSON.stringify(m));
    let receipt = await readJson(file, { jobId: m.jobId, personId: m.personId, fingerprint, source: m.source, createdAt: now(), manifest: m, revisions: [], platforms: {} });
    if (receipt.fingerprint !== fingerprint) {
      const old = receipt.manifest;
      requireThat(old && JSON.stringify(old.source) === JSON.stringify(m.source) && old.personId === m.personId && old.authorization === m.authorization, '原请求或授权已变，不能覆盖已有记录');
      requireThat(JSON.stringify(Object.keys(old.platforms).sort()) === JSON.stringify(Object.keys(m.platforms).sort()), '不能在已有请求中变更目标平台');
      const changed = Object.keys(m.platforms).filter(p => JSON.stringify([old.publishAt, old.platforms[p]]) !== JSON.stringify([m.publishAt, m.platforms[p]]));
      requireThat(changed.every(p => !receipt.platforms[p] || (!readOnly && retryRejected && receipt.platforms[p].status === 'rejected')), '已有发送记录的内容已变；仅未发送或明确 rejected 的平台可在原授权内修复');
      receipt.revisions ||= [];
      receipt.revisions.push({ at: now(), reason: 'repair-rejected-or-unsent', previousManifest: old, previousFingerprint: receipt.fingerprint, changedPlatforms: changed });
      receipt.manifest = m; receipt.fingerprint = fingerprint;
    }
    if (readOnly) {
      await reconcileEntries(receipt, m, cfg, fetchImpl); receipt.updatedAt = now(); await writeJson(file, receipt); return receipt;
    }
    const targets = Object.keys(m.platforms).filter(p => !receipt.platforms[p] || (retryRejected && receipt.platforms[p].status === 'rejected'));
    if (targets.length) {
      const proofs = await preflight(m, cfg, targets, fetchImpl);
      for (const p of targets) {
        receipt.platforms[p] = { status: 'sending', startedAt: now(), ...proofs[p] };
        await writeJson(file, receipt); // Persist BEFORE any external write; a crash cannot permit a resend.
        try {
          if (p === 'x') Object.assign(receipt.platforms[p], await sendX(m, cfg.x, fetchImpl));
          else {
            const d = m.platforms.xiaohongshu;
            await xhsQuery(cfg.xiaohongshu, '/publish', { title: d.title, content: d.content, tags: d.tags, images: d.images, visibility: d.visibility, ...(m.publishAt ? { schedule_at: m.publishAt } : {}) }, fetchImpl);
            receipt.platforms[p].status = 'submitted';
            if (m.publishAt) receipt.platforms[p].publishAt = m.publishAt;
          }
        } catch (e) { receipt.platforms[p].status = e.rejected ? 'rejected' : 'uncertain'; receipt.platforms[p].reason = e.message; }
        await writeJson(file, receipt);
      }
    }
    await reconcileEntries(receipt, m, cfg, fetchImpl); receipt.updatedAt = now();
    await writeJson(file, receipt); return receipt;
  });
}
export async function status(person, { root = stateRoot, fetchImpl = fetch } = {}) {
  const c = await settings(person, root); const result = { personId: person, x: { bound: !!c.x?.channelId }, xiaohongshu: { bound: !!c.xiaohongshu?.accountId }, zhihu: { supported: false } };
  if (c.x?.channelId) result.x.name = c.x.name;
  if (c.xiaohongshu?.baseUrl && c.xiaohongshu.accountId) {
    try { const s = await xhsQuery(c.xiaohongshu, '/login/status', undefined, fetchImpl); Object.assign(result.xiaohongshu, { loggedIn: s.is_logged_in, name: s.username, matchesBinding: s.user_id === c.xiaohongshu.accountId }); }
    catch (e) { result.xiaohongshu.error = e.message; }
  }
  else if (c.xiaohongshu?.baseUrl) {
    try { const h = await requestJson(c.xiaohongshu.baseUrl + '/health', { fetchImpl, timeout: 5000 }); result.xiaohongshu.backendReady = !!h; }
    catch (e) { result.xiaohongshu.error = e.message; }
  }
  return result;
}
export function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) result[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return result;
}
async function main() {
  const command = process.argv[2], a = args(process.argv.slice(3)); let result;
  if (command === 'status') result = await status(a.person);
  else if (command === 'prepare') { result = await sealImages(prepare(await readJson(resolve(a.file)))); await writeJson(resolve(a.out), result); result = { jobId: result.jobId, manifest: resolve(a.out), platforms: Object.keys(result.platforms) }; }
  else if (['publish', 'reconcile'].includes(command)) result = await publish(await readJson(resolve(a.file)), { readOnly: command === 'reconcile', retryRejected: !!a['retry-rejected'] });
  else throw new Error('用法: publisher.mjs status --person ID | prepare --file input.json --out manifest.json | publish --file manifest.json [--retry-rejected] | reconcile --file manifest.json');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; });

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readBody } from '../lib/utils.mjs';
import { createPreviewGuestStore, validGuestGrant } from '../lib/preview-guest-store.mjs';
import { employeeSitePerson, requireEmployeeSite } from './employee-site-auth.mjs';

export const GUEST_POLICY_FILE = join(CONFIG_DIR, 'preview-guest-invites.json');
const COOKIE = '__Secure-remotelab-preview-guest';
const COOKIE_AGE = 400 * 86_400;
const store = createPreviewGuestStore(CONFIG_DIR);
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const assets = {
  '/_invite/app.js': ['../static/preview-guests.js', 'text/javascript'],
  '/_invite/style.css': ['../static/preview-guests.css', 'text/css'],
};

export async function loadPreviewGuestPolicies() {
  try { return JSON.parse(await readFile(GUEST_POLICY_FILE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Cannot read preview guest policy:', error.code || error.name); return null; }
}

export function previewGuestPolicy(policies, slug, route, req) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug || '') || !policies || !Object.hasOwn(policies, slug)) return null;
  const policy = policies[slug];
  if (route.access !== 'employee' || route.employeeLogin || !route.ownerPersonId || !policy || route.port !== policy.port || route.ownerPersonId !== policy.ownerPersonId) return null;
  let origin;
  try { origin = new URL(policy.origin); } catch { return null; }
  if (origin.origin !== policy.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  if (req.headers.host !== origin.host || `${proto}:` !== origin.protocol) return null;
  return { base: `/preview/${slug}`, origin: origin.origin, scope: JSON.stringify([origin.origin, slug, route.port, route.ownerPersonId]),
    owner: route.ownerPersonId, title: typeof policy.title === 'string' && policy.title.trim() ? policy.title.trim().slice(0, 80) : slug };
}

export const isPreviewInvitePath = suffix => suffix === '/_invite' || suffix.startsWith('/_invite/');
const guestSecret = req => String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
export const hasPreviewGuestCookie = req => Boolean(guestSecret(req));
const cookie = (policy, value) => `${COOKIE}=${value}; Path=${policy.base}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_AGE}`;

export async function previewGuestPerson(req, res, policy, suffix) {
  const secret = guestSecret(req);
  if (!secret) return null;
  try {
    const person = await store.member(policy.scope, secret);
    // Keep active browsers signed in without changing the indefinite server grant.
    if (person && req.method === 'GET' && suffix === '/') res.appendHeader('Set-Cookie', cookie(policy, secret));
    return person;
  } catch {
    // A guest state fault must not open access or affect verified employees.
    res.writeHead(503, { 'Cache-Control': 'private, no-store' }); res.end('访客服务暂不可用，请稍后重试。');
    return null;
  }
}

function page(policy, manage) {
  const title = escape(policy.title), base = policy.base, heading = manage ? '访客邀请' : '接受网站邀请';
  const body = manage ? `<p>每人生成一条链接，私聊发送。链接 24 小时内可用一次；对方接受后可长期访问，直到你撤销。</p>
      <form id="issue"><label for="label">访客备注</label><div class="row"><input id="label" required maxlength="80" placeholder="例如：访客姓名"><button type="submit">生成邀请链接</button></div></form>
      <section id="result" hidden><label for="link">邀请链接（只显示这一次）</label><div class="row"><input id="link" readonly><button id="copy" type="button">复制链接</button></div></section>
      <h2>有效邀请与访客</h2><ul id="current"></ul><details><summary>近期失效与撤销</summary><ul id="inactive"></ul></details>`
    : `<p>接受后，你可以在当前浏览器长期访问此网站，不用注册，也不会开通其他网站。建议在平时使用的浏览器里打开这条邀请。</p>
      <button type="button" id="accept">接受邀请</button>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} · ${title}</title>
    <link rel="stylesheet" href="${base}/_invite/style.css"><script src="${base}/_invite/app.js" defer></script></head>
    <body data-base="${base}"><main><p class="site">${title}</p><h1>${heading}</h1>${body}<p id="status" role="status"></p><a class="back" href="${base}/">返回网站</a></main></body></html>`;
}

export async function handlePreviewInvites(req, res, suffix, policy) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const send = (status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(req.method === 'HEAD' ? undefined : type === 'application/json' ? JSON.stringify(value) : value);
  };
  const missing = () => send(404, { error: '此站点没有访客邀请入口' });
  if (!policy) return missing();
  const method = req.method, get = method === 'GET' || method === 'HEAD';
  if (!get && (method !== 'POST' || req.headers.origin !== policy.origin)) return send(403, { error: '请在本站进行操作' });
  try {
    if (get && Object.hasOwn(assets, suffix)) {
      const [file, type] = assets[suffix];
      return send(200, await readFile(new URL(file, import.meta.url)), type);
    }
    if (get && suffix === '/_invite/accept') return send(200, page(policy, false), 'text/html');
    if (method === 'POST' && suffix === '/_invite/api/redeem') {
      const data = await jsonBody(req);
      if (await employeeSitePerson(req, res) || await store.member(policy.scope, guestSecret(req))) {
        return send(409, { error: '当前浏览器已经有访问权限，请返回网站。此邀请未被使用。' });
      }
      const redeemed = await store.redeem(policy.scope, data?.secret);
      if (!redeemed) return send(410, { error: '邀请链接已使用、已撤销或已过期，请联系发送人。' });
      res.appendHeader('Set-Cookie', cookie(policy, redeemed.session));
      return send(200, { ok: true });
    }
    const managePage = get && suffix === '/_invite/manage';
    if (!managePage && !((get || method === 'POST') && suffix === '/_invite/api/grants')
      && !(method === 'POST' && suffix === '/_invite/api/revoke')) return missing();
    const person = await employeeSitePerson(req, res);
    if (!person && managePage) {
      // Navigate through the existing employee login, never the guest cookie.
      return await requireEmployeeSite(req, res);
    }
    if (person?.id !== policy.owner) return send(person ? 403 : 401, { error: '只有原站点负责人可以管理邀请' });
    if (managePage) return send(200, page(policy, true), 'text/html');
    if (get) return send(200, await store.list(policy.scope));
    const data = await jsonBody(req);
    if (suffix.endsWith('/grants')) {
      const label = typeof data?.label === 'string' && data.label.trim();
      if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) return send(400, { error: '请输入 1–80 字的访客备注' });
      const { secret, ...grant } = await store.issue(policy.scope, label, person.id);
      // Fragment avoids putting the bearer in HTTP access logs or referrers.
      return send(201, { grant, link: `${policy.origin}${policy.base}/_invite/accept#${secret}` });
    }
    if (!validGuestGrant(data?.id)) return send(400, { error: '无效的访客授权' });
    if (!await store.revoke(policy.scope, data.id, person.id)) return send(404, { error: '授权不存在或已经撤销' });
    return send(200, { ok: true });
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'BAD_JSON') return send(400, { error: '需要 JSON 格式的请求' });
    if (error.code === 'BODY_TOO_LARGE') return send(413, { error: '请求过大' });
    console.error('Preview guest request failed:', error.code || error.name);
    return send(503, { error: '访客服务暂不可用，请刷新确认后再试。' });
  }
}

async function jsonBody(req) {
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Invalid content type'), { code: 'BAD_JSON' });
  return JSON.parse(await readBody(req, 2048));
}

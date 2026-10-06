import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, stateRoot, personDir, readJson, settings, saveSettings, status, discoverBuffer, xhsQuery, withPersonLock } from './publisher.mjs';

const scryptAsync = promisify(scrypt);
export async function authenticate(header, authFile, person) {
  if (!header?.startsWith('Basic ')) return false;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8'), colon = value.indexOf(':');
  if (colon < 0 || value.length > 4096) return false;
  const username = value.slice(0, colon), password = value.slice(colon + 1);
  const doc = await readJson(authFile), who = doc.people?.find(p => p.id === person);
  for (const c of who?.credentials || []) {
    if (c.type !== 'password' || c.username !== username) continue;
    const [type, N, r, p, salt, stored] = c.passwordHash.split('$');
    if (type !== 'scrypt' || !stored) return false;
    const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), Buffer.from(stored, 'hex').length, { N: +N, r: +r, p: +p });
    return timingSafeEqual(actual, Buffer.from(stored, 'hex'));
  }
  return false;
}
export async function createBindingServer({ person, authFile, root = stateRoot, publicOrigin, fetchImpl = fetch }) {
  personDir(person, root); if (!authFile) throw new Error('需要当前实例 auth-file');
  const csrf = randomBytes(24).toString('hex'), page = await readFile(new URL('../assets/binding.html', import.meta.url), 'utf8');
  const failed = new Map(); let cachedQr;
  const server = createServer(async (req, res) => {
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const key = req.socket.remoteAddress, record = failed.get(key) || { count: 0, until: 0 };
    try {
      if (record.until > Date.now()) return reply(429, { error: '登录失败过多，请稍后重试' });
      if (!await authenticate(req.headers.authorization, authFile, person)) {
        if (req.headers.authorization) { record.count++; if (record.count >= 5) record.until = Date.now() + 60000; failed.set(key, record); }
        res.setHeader('WWW-Authenticate', 'Basic realm="Social publish binding", charset="UTF-8"'); return reply(401, { error: '请使用本人的 RemoteLab 用户名和密码' });
      }
      failed.delete(key);
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/') {
        const nonce = randomBytes(16).toString('hex');
        res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page.replaceAll('{{NONCE}}', nonce).replaceAll('{{CSRF}}', csrf));
      }
      if (req.method === 'GET' && path === '/api/status') return reply(200, await status(person, { root, fetchImpl }));
      if (req.method !== 'POST') return reply(404, { error: '不存在的入口' });
      if (req.headers['x-csrf-token'] !== csrf) return reply(403, { error: '请从绑定页面执行操作' });
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin && origin !== `http://${req.headers.host}`) return reply(403, { error: '请求来源不符' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) return reply(413, { error: '请求过大' }); }
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/api/buffer/discover') return reply(200, { channels: await discoverBuffer(body.apiKey, fetchImpl) });
      if (path === '/api/buffer/bind') {
        const channels = await discoverBuffer(body.apiKey, fetchImpl);
        const c = channels.find(c => c.id === body.channelId && c.organizationId === body.organizationId);
        if (!c) return reply(400, { error: '所选账号没有出现在本人 Buffer 授权中' });
        await saveSettings(person, { x: { apiKey: body.apiKey, channelId: c.id, organizationId: c.organizationId, name: c.name, boundAt: new Date().toISOString() } }, root);
        return reply(200, { bound: true, name: c.name });
      }
      const cfg = await settings(person, root);
      if (path === '/api/xhs/qr') {
        if (cachedQr?.expires > Date.now()) return reply(200, cachedQr.data);
        const data = await withPersonLock(person, root, () => xhsQuery(cfg.xiaohongshu, '/login/qrcode', undefined, fetchImpl));
        if (data.img && !data.img.startsWith('data:image/')) return reply(502, { error: '后台二维码格式不符' });
        cachedQr = { expires: Date.now() + 230000, data }; return reply(200, data);
      }
      if (path === '/api/xhs/identity') return reply(200, await xhsQuery(cfg.xiaohongshu, '/login/status', undefined, fetchImpl));
      if (path === '/api/xhs/bind') {
        const s = await xhsQuery(cfg.xiaohongshu, '/login/status', undefined, fetchImpl);
        if (!s.is_logged_in || !s.user_id || s.user_id !== body.accountId) return reply(400, { error: '账号身份未核对或已变化，请重新读回' });
        await saveSettings(person, { xiaohongshu: { ...cfg.xiaohongshu, accountId: s.user_id, name: s.username, boundAt: new Date().toISOString() } }, root);
        return reply(200, { bound: true, name: s.username });
      }
      return reply(404, { error: '不存在的入口' });
    } catch (e) { return reply(400, { error: e instanceof SyntaxError ? '请求格式不符' : e.message }); }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = args(process.argv.slice(2));
  createBindingServer({ person: a.person, authFile: a['auth-file'], publicOrigin: a['public-origin'] }).then(server => {
    server.listen(Number(a.port || 8814), '127.0.0.1', () => console.log('Private social publishing binding service listening on loopback'));
  }).catch(e => { console.error(e.message); process.exitCode = 1; });
}

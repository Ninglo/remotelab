import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const clean = (v) => typeof v === 'string' ? v.trim() : '';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const cookie = (req, name) => clean((req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1));

// Only this research site's session is issued by Feishu sign-in. It is not a
// RemoteLab control-plane credential and cannot authenticate arbitrary APIs.
export function createQianyanIdentity({ configDir, authDocument, registerIdentity, fetchImpl = fetch, now = Date.now }) {
  const path = join(configDir, 'qianyan-identity.json');
  let queue = Promise.resolve();
  async function document() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { pending: {}, sessions: {} }; throw e; }
  }
  async function save(value) {
    await mkdir(configDir, { recursive: true });
    const tmp = path + '.' + randomBytes(8).toString('hex');
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, path);
  }
  function serialized(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
  async function settings() {
    return JSON.parse(await readFile(join(configDir, 'qianyan-internal.json'), 'utf8'));
  }
  async function app(cfg) {
    return JSON.parse(await readFile(cfg.feishuConfigPath, 'utf8'));
  }
  async function request(url, values, credential) {
    const headers = {};
    if (values) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (credential?.appSecret) headers.Authorization = 'Basic ' + Buffer.from(credential.appId + ':' + credential.appSecret).toString('base64');
    else if (credential?.token) headers.Authorization = 'Bearer ' + credential.token;
    const res = await fetchImpl(url, { method: values ? 'POST' : 'GET', headers,
      body: values ? new URLSearchParams(values) : undefined, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if ((!res.ok && !data.error) || data.code && data.code !== 0) throw new Error('飞书身份服务暂时不可用');
    return data;
  }
  function sessionCookie(name, token, maxAge, req) {
    const secure = req.socket?.encrypted || String(req.headers['x-forwarded-proto']).split(',')[0] === 'https';
    return `${name}=${token}; Path=/api/qianyan/internal; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  async function member(req, remoteSession) {
    let cfg; try { cfg = await settings(); } catch { return null; }
    const people = (await authDocument()).people || [];
    if (remoteSession?.personId && cfg.personIds?.includes(remoteSession.personId)) {
      const p = people.find(p => p.id === remoteSession.personId);
      if (p) return remoteSession.authKind === 'service'
        ? { id: 'agent:rowan', name: 'Rowan', auth_kind: 'service' }
        : { id: p.id, name: p.name, auth_kind: 'remotelab' };
    }
    const token = cookie(req, 'qianyan_session'); if (!token) return null;
    const d = await document(), entry = d.sessions[hash(token)];
    if (!entry || entry.expiresAt <= now() || entry.tenantKey !== cfg.tenantKey || entry.realm !== cfg.realm) return null;
    const p = people.find(p => p.id === entry.personId);
    if (!p?.identities?.some(i => i.kind === 'feishu' && i.realm === cfg.realm && i.subjectId === entry.openId)) return null;
    return { id: p.id, name: p.name, auth_kind: 'feishu' };
  }
  async function begin(req) {
    return serialized(async () => {
      const cfg = await settings(), credential = await app(cfg), d = await document();
      for (const [id, p] of Object.entries(d.pending)) if (p.expiresAt <= now()) delete d.pending[id];
      for (const [id, s] of Object.entries(d.sessions)) if (s.expiresAt <= now()) delete d.sessions[id];
      const old = d.pending[hash(cookie(req, 'qianyan_pending'))];
      if (old?.expiresAt > now()) return { verification_url: old.url, expires_at: old.expiresAt, interval: old.interval / 1000 };
      if (Object.keys(d.pending).length >= 100) throw new Error('登录请求较多，请稍后重试');
      const data = await request('https://accounts.feishu.cn/oauth/v1/device_authorization', { client_id: credential.appId }, credential);
      const url = data.verification_uri_complete || data.verification_uri;
      if (!data.device_code || new URL(url).origin !== 'https://accounts.feishu.cn') throw new Error('飞书授权入口无效');
      const token = randomBytes(32).toString('hex'), interval = Math.max(5, +data.interval || 5) * 1000;
      d.pending[hash(token)] = { deviceCode: data.device_code, realm: cfg.realm, url, expiresAt: now() + Math.min(600, +data.expires_in || 600) * 1000, nextPollAt: now() + interval, interval };
      await save(d);
      return { verification_url: url, interval: interval / 1000, expires_at: d.pending[hash(token)].expiresAt,
        cookie: sessionCookie('qianyan_pending', token, 600, req) };
    });
  }
  async function poll(req) {
    return serialized(async () => {
      const cfg = await settings(), d = await document(), key = hash(cookie(req, 'qianyan_pending')), p = d.pending[key];
      if (!p || p.expiresAt <= now() || p.realm !== cfg.realm) return { state: 'expired' };
      if (p.nextPollAt > now()) return { state: 'pending', interval: Math.ceil((p.nextPollAt - now()) / 1000) };
      const a = await app(cfg);
      const data = await request('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode, client_id: a.appId, client_secret: a.appSecret });
      if (['authorization_pending', 'slow_down'].includes(data.error)) {
        if (data.error === 'slow_down') p.interval = Math.min(60000, p.interval + 5000);
        p.nextPollAt = now() + p.interval; await save(d); return { state: 'pending', interval: p.interval / 1000 };
      }
      if (!data.access_token) { delete d.pending[key]; await save(d); return { state: 'denied' }; }
      const response = await request('https://open.feishu.cn/open-apis/authen/v1/user_info', null, { token: data.access_token });
      const user = response.data;
      if (!user?.open_id || user.tenant_key !== cfg.tenantKey) {
        delete d.pending[key]; await save(d); return { state: 'wrong_company' };
      }
      const person = await registerIdentity({ realm: cfg.realm, openId: user.open_id, name: user.name });
      const token = randomBytes(32).toString('hex');
      d.sessions[hash(token)] = { personId: person.id, openId: user.open_id, realm: cfg.realm, tenantKey: user.tenant_key, expiresAt: now() + 30 * 86400000 };
      delete d.pending[key]; await save(d);
      return { state: 'connected', person: { id: person.id, name: person.name, auth_kind: 'feishu' },
        cookies: [sessionCookie('qianyan_session', token, 30 * 86400, req), sessionCookie('qianyan_pending', '', 0, req)] };
    });
  }
  return { member, begin, poll };
}

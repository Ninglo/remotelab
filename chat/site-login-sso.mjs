import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { loadEmployeeSiteSettings, validateSiteSsoSettings } from '../lib/site-publication-policy.mjs';
import { sqliteState } from '../lib/sqlite-state.mjs';

const prefix = '/api/site-login/sso/';
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
const identifier = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cookieValue = (req, name) => String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
const originFor = req => `${req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;


function destination(raw, origin) {
  if (!raw || raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(raw)) throw Error('Invalid return path');
  const target = new URL(raw, origin);
  if (target.origin !== origin || target.pathname.startsWith(prefix) || target.pathname === '/site-login') throw Error('Invalid return path');
  return target.pathname + target.search + target.hash;
}

// All participants terminate at this instance. Only a one-use, browser-bound
// code crosses origins; the employee session never appears in a URL or HTML.
export function createSiteSsoHandler({ identity, personFor, configDir = CONFIG_DIR, now = Date.now,
  loadSettings = () => loadEmployeeSiteSettings(configDir),
  loadHosts = async () => (await import('./employee-host-proxy.mjs')).loadEmployeeHosts(configDir) }) {
  const pathname = join(configDir, 'employee-site-sso.json');
  let initialized;
  async function state(operation, args) {
    initialized ||= sqliteState(pathname, 'initialize', { indexes: [['expiresAt']] }).catch(error => { initialized = null; throw error; });
    await initialized;
    return sqliteState(pathname, operation, args);
  }
  const put = (key, value) => state('merge', { key, value });
  const get = key => state('get', { key });
  const take = (key, extra = '', params = []) => state('find', {
    sql: `DELETE FROM records WHERE key=? AND json_extract(value,'$.expiresAt')>? ${extra} RETURNING value`, params: [key, now(), ...params],
  });
  async function settings(req) {
    let configured;
    try { configured = await loadSettings(); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    const cfg = validateSiteSsoSettings(configured);
    if (!cfg) return null;
    const origin = originFor(req);
    const url = new URL(origin);
    const hosts = await loadHosts();
    if (origin !== cfg.issuerOrigin && !(url.protocol === 'https:' && !url.port && Object.hasOwn(hosts, url.hostname))) throw Error('Unregistered SSO origin');
    return { ...cfg, origin, issuer: origin === cfg.issuerOrigin };
  }
  return async (req, res, path) => {
    if (!path.startsWith(prefix)) return false;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const redirect = url => { res.writeHead(303, { Location: url }); res.end(); };
    try {
      if (req.method !== 'GET') { send(405, { error: 'Method not allowed' }); return true; }
      const cfg = await settings(req), action = path.slice(prefix.length);
      if (action === 'config') { send(200, { enabled: !!cfg, issuer: cfg?.issuer === true }); return true; }
      if (!cfg) { send(404, { error: 'Cross-site login is not configured' }); return true; }
      const url = new URL(req.url, cfg.origin);
      if (action === 'start') {
        const target = destination(url.searchParams.get('returnTo') || '/', cfg.origin);
        if (cfg.issuer) { redirect('/site-login?returnTo=' + encodeURIComponent(target)); return true; }
        await state('find', { sql: "DELETE FROM records WHERE trim(coalesce(json_extract(value,'$.expiresAt'),''))<=? RETURNING value", params: [String(now())] });
        const id = random(), secret = random();
        await put('request:' + digest(id), { origin: cfg.origin, issuer: cfg.issuerOrigin, target, binding: digest(secret), expiresAt: now() + 600000 });
        res.setHeader('Set-Cookie', `__Host-employee_sso_${id}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
        redirect(cfg.issuerOrigin + prefix + 'authorize?request=' + id); return true;
      }
      if (action === 'authorize') {
        const id = url.searchParams.get('request');
        if (!cfg.issuer || !identifier(id)) throw Error('Invalid login request');
        const key = 'request:' + digest(id), pending = await get(key);
        if (!pending || pending.expiresAt <= now() || pending.issuer !== cfg.issuerOrigin
          || !Object.hasOwn(await loadHosts(), new URL(pending.origin).hostname)) throw Error('Expired login request');
        const person = await personFor(req, res);
        if (!person) {
          redirect('/site-login?returnTo=' + encodeURIComponent(prefix + 'authorize?request=' + id)); return true;
        }
        const token = await identity.sessionForTransfer(req, person);
        if (!token) throw Error('A verified Feishu session is required');
        if (!await take(key)) throw Error('Login request already used');
        const code = random();
        await put('code:' + digest(code), { ...pending, token, request: id, expiresAt: now() + 60000 });
        redirect(pending.origin + prefix + 'callback?code=' + code + '&state=' + id); return true;
      }
      if (action === 'callback') {
        const code = url.searchParams.get('code'), id = url.searchParams.get('state');
        if (cfg.issuer || !identifier(code) || !identifier(id)) throw Error('Invalid login callback');
        const name = '__Host-employee_sso_' + id, secret = cookieValue(req, name);
        if (!identifier(secret)) throw Error('Login browser does not match');
        const granted = await take('code:' + digest(code),
          "AND json_extract(value,'$.origin')=? AND json_extract(value,'$.issuer')=? AND json_extract(value,'$.request')=? AND json_extract(value,'$.binding')=?",
          [cfg.origin, cfg.issuerOrigin, id, digest(secret)]);
        if (!granted) throw Error('Login callback expired or already used');
        const session = await identity.cookieForTransfer(req, granted.token);
        if (!session) throw Error('Login session has expired');
        res.setHeader('Set-Cookie', [session, `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]);
        redirect(destination(granted.target, cfg.origin)); return true;
      }
      send(404, { error: 'Unknown login endpoint' });
    } catch {
      send(400, { error: '跨站登录未完成或已过期，请返回原网站重新登录。' });
    }
    return true;
  };
}

import { readFile } from 'node:fs/promises';
import { generateNonce, setSecurityHeaders } from './middleware.mjs';
import { employeeSiteIdentity, employeeSitePerson, sameSiteOrigin } from './employee-site-auth.mjs';

export function createSiteLoginHandler({ identity = employeeSiteIdentity, personFor = employeeSitePerson } = {}) {
  return async (req, res, pathname) => {
    if (pathname !== '/site-login' && !pathname.startsWith('/api/site-login/')) return false;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const gateway = await identity.gatewaySettings?.(req);
      if (gateway) {
        if (gateway.enabled === false) { send(503, { error: '员工登录已停用' }); return true; }
        const person = await personFor(req, res);
        if (pathname === '/site-login' && req.method === 'GET') {
          if (!person) { send(503, { error: '公司统一登录入口尚未接通，请联系网站负责人' }); return true; }
          const raw = new URL(req.url, gateway.publicOrigin).searchParams.get('returnTo') || '';
          const target = new URL(raw || '/site-login', gateway.publicOrigin);
          if (raw.startsWith('/') && target.origin === gateway.publicOrigin && target.pathname !== '/site-login') {
            res.writeHead(303, { Location: target.pathname + target.search + target.hash }); res.end(); return true;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('已通过公司统一登录，请打开目标网站。'); return true;
        }
        const action = pathname.slice('/api/site-login/'.length);
        const method = { me: 'GET', start: 'POST', poll: 'GET', logout: 'POST' }[action];
        if (!method || req.method !== method) { send(405, { error: 'Method not allowed' }); return true; }
        if (method === 'POST' && !sameSiteOrigin(req)) { send(403, { error: '请从本站提交' }); return true; }
        if (!person) { send(401, { error: '请通过公司统一登录访问', login: '/site-login' }); return true; }
        if (action === 'logout') {
          send(200, { state: 'redirect', redirect_url: `${gateway.issuer}/sso/logout/start?app=${encodeURIComponent(gateway.appId)}` }); return true;
        }
        send(200, { state: 'connected', person, provider: 'muka-sso' }); return true;
      }
      if (pathname === '/site-login' && req.method === 'GET') {
        const nonce = generateNonce(); setSecurityHeaders(res, nonce);
        const page = await readFile(new URL('../templates/site-login.html', import.meta.url), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page.replaceAll('{{NONCE}}', nonce)); return true;
      }
      const action = pathname.slice('/api/site-login/'.length);
      const method = { me: 'GET', start: 'POST', poll: 'GET', logout: 'POST' }[action];
      if (!method || req.method !== method) { send(405, { error: 'Method not allowed' }); return true; }
      if (method === 'POST' && !sameSiteOrigin(req)) { send(403, { error: '请从登录页面提交' }); return true; }
      if (action === 'logout') {
        res.setHeader('Set-Cookie', await identity.logout(req)); send(200, { state: 'signed_out' }); return true;
      }
      const person = await personFor(req, res);
      if (person) { send(200, { state: 'connected', person }); return true; }
      if (action === 'me') { send(401, { error: '请使用飞书员工身份登录' }); return true; }
      const value = action === 'start' ? await identity.begin(req) : await identity.poll(req);
      if (value.cookies || value.cookie) res.setHeader('Set-Cookie', value.cookies || value.cookie);
      const { cookies, cookie, ...publicValue } = value;
      send(200, publicValue);
    } catch { send(503, { error: '登录服务暂时不可用，请稍后重试' }); }
    return true;
  };
}
export const handleSiteLogin = createSiteLoginHandler();

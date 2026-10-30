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

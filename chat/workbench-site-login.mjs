import { employeeSitePerson, sameSiteOrigin } from './employee-site-auth.mjs';
import { readBody } from '../lib/utils.mjs';
import { loadAuthDocument, getWebIdentity } from '../lib/auth-config.mjs';
import { getAuthSession, getOrCreateAuthenticatedSessionToken, saveAuthSessionsAsync, setCookie, parseCookies } from '../lib/auth.mjs';

export function workbenchAutoLoginCookie(req, paused) {
  const secure = req.socket?.encrypted || String(req.headers['x-forwarded-proto']).split(',')[0] === 'https';
  return `workbench_sso_paused=${paused ? '1' : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${paused ? 30 * 86400 : 0}${secure ? '; Secure' : ''}`;
}

export function safeWorkbenchNext(value) {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith('/')
    && !value.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(value)
    && !/^\/login(?:[/?#]|$)/.test(value) ? value : '/';
}

// Website identity proves who the browser is. Existing personal credentials
// establish workbench admission; discovering an employee never grants it.
export function createWorkbenchSiteLogin({ personFor = employeeSitePerson,
  document = () => loadAuthDocument({ persistMigration: false }), current = getAuthSession,
  mint = getOrCreateAuthenticatedSessionToken, persist = () => saveAuthSessionsAsync({ strict: true }),
  cookieFor = setCookie } = {}) {
  return async (req, res, pathname, query = {}) => {
    const completion = pathname === '/api/auth/feishu/complete';
    if (!completion && (req.method !== 'GET' || !['/login', '/login/feishu'].includes(pathname))) return false;
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
      res.end(JSON.stringify(value)); return true;
    };
    if (completion && req.method !== 'POST') return send(405, { error: 'Method not allowed' });
    if (completion && !sameSiteOrigin(req)) return send(403, { error: '请从本站登录页面提交' });
    let next = safeWorkbenchNext(query.next);
    if (completion) {
      try { next = safeWorkbenchNext(JSON.parse(await readBody(req, 4096)).next); }
      catch (error) { return send(error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: '登录请求无效' }); }
    }
    const explicit = completion || pathname === '/login/feishu';
    const redirect = (location, cookie) => {
      const prior = res.getHeader('Set-Cookie');
      if (cookie) res.setHeader('Set-Cookie', [...(Array.isArray(prior) ? prior : prior ? [prior] : []), ...(Array.isArray(cookie) ? cookie : [cookie])]);
      if (completion) return send(200, { state: 'connected', redirect: location });
      res.writeHead(303, { Location: location, 'Cache-Control': 'private, no-store' }); res.end(); return true;
    };
    try {
      const existing = current(req);
      // Never switch an already authenticated browser to a second Person.
      if (existing && existing.authKind !== 'service') return redirect(next);
      if (!explicit && parseCookies(req.headers.cookie || '').workbench_sso_paused === '1') return false;
      const employee = await personFor(req, res);
      if (!employee && completion) return send(401, { error: '请先完成飞书身份确认' });
      if (!employee) return explicit
        ? redirect('/site-login?returnTo=' + encodeURIComponent('/login/feishu?next=' + encodeURIComponent(next))) : false;
      const auth = await document();
      const person = auth.people.find(p => p.id === employee.id);
      const credential = person?.credentials?.find(c => c.type === 'password' || c.type === 'token');
      const web = person && getWebIdentity(person);
      if (!credential || !web) {
        if (!explicit) return false;
        if (completion) return send(403, { error: '飞书身份已核验；此账号尚未开通 RemoteLab 控制台。可以继续使用下方的原账号登录。' });
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
        res.end('飞书身份已核验；此账号尚未开通 RemoteLab 控制台。已有其他账号可返回登录页使用原凭据。'); return true;
      }
      const issued = mint({ personId: person.id, personName: person.name, credentialId: credential.id });
      await persist();
      return redirect(next, [cookieFor(issued.token), workbenchAutoLoginCookie(req, false)]);
    } catch {
      // An optional identity bridge must not break the original password form.
      if (!explicit) return false;
      if (completion) return send(503, { error: '飞书登录暂时不可用，可以继续使用下方的原账号登录。' });
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end('飞书登录暂时不可用，请返回登录页使用原账号。'); return true;
    }
  };
}
export const handleWorkbenchSiteLogin = createWorkbenchSiteLogin();

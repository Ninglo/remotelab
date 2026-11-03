import { employeeSitePerson, sameSiteOrigin } from './employee-site-auth.mjs';
import { readBody } from '../lib/utils.mjs';
import { loadAuthDocument, getWebIdentity, updateAuthDocument } from '../lib/auth-config.mjs';
import { loadEmployeeSiteSettings } from '../lib/site-publication-policy.mjs';
import { randomUUID } from 'node:crypto';
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

const registrationError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const configuredFeishuIdentity = (person, settings) => person?.identities?.find(i => i.kind === 'feishu' && i.realm === settings.realm);
function workbenchCredential(person) {
  return person?.credentials?.find(c => c.type === 'password' || c.type === 'token'
    || (c.type === 'feishu' && person.identities.some(i => i.id === c.identityId && i.kind === 'feishu')));
}
async function registerWorkbenchPerson(employee, settings) {
  if (employee.auth_kind !== 'feishu') throw registrationError(403, '请先完成飞书身份确认');
  const saved = await updateAuthDocument(d => {
    const person = d.people.find(p => p.id === employee.id);
    const identity = configuredFeishuIdentity(person, settings);
    if (!person || !identity) throw registrationError(403, '飞书身份已变化，请重新登录');
    if (workbenchCredential(person)) return person.id; // A retry never renames an enrolled account.
    if (d.administratorPersonIds.includes(person.id)) throw registrationError(403, '管理员账号恢复须使用专门的维护程序');
    person.discovered = false;
    person.updatedAt = new Date().toISOString();
    person.credentials.push({ id: 'credential_' + randomUUID(), type: 'feishu', identityId: identity.id,
      createdAt: person.updatedAt });
    return person.id;
  });
  return saved.document.people.find(p => p.id === saved.result);
}

// Employee website authentication alone grants no console access. Explicit
// Feishu sign-in, with registration enabled per instance, enrolls that exact
// verified Person without asking the employee to choose another username.
export function createWorkbenchSiteLogin({ personFor = employeeSitePerson,
  document = () => loadAuthDocument({ persistMigration: false }), current = getAuthSession,
  mint = getOrCreateAuthenticatedSessionToken, persist = () => saveAuthSessionsAsync({ strict: true }),
  cookieFor = setCookie, settings = loadEmployeeSiteSettings } = {}) {
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
      let person = auth.people.find(p => p.id === employee.id);
      let credential = workbenchCredential(person);
      let web = person && getWebIdentity(person);
      if (!credential || !web) {
        if (!explicit) return false;
        let cfg;
        try { cfg = await settings(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const permitted = cfg?.workbenchRegistration === true && cfg.enabled !== false
          && (!cfg.provider || cfg.provider === 'feishu-device') && employee.auth_kind === 'feishu'
          && configuredFeishuIdentity(person, cfg) && !auth.administratorPersonIds.includes(person.id);
        if (!permitted) {
          if (completion) return send(403, { error: '飞书身份已核验；此账号尚未开通 RemoteLab 控制台。可以继续使用下方的原账号登录。' });
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
          res.end('飞书身份已核验；此账号尚未开通 RemoteLab 控制台。已有其他账号可返回登录页使用原凭据。'); return true;
        }
        person = await registerWorkbenchPerson(employee, cfg);
        credential = workbenchCredential(person); web = getWebIdentity(person);
      }
      const issued = mint({ personId: person.id, personName: person.name, credentialId: credential.id });
      await persist();
      return redirect(next, [cookieFor(issued.token), workbenchAutoLoginCookie(req, false)]);
    } catch (error) {
      // An optional identity bridge must not break the original password form.
      if (!explicit) return false;
      if (completion && error.statusCode) return send(error.statusCode, { error: error.message });
      if (completion) return send(503, { error: '飞书登录暂时不可用，可以继续使用下方的原账号登录。' });
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end('飞书登录暂时不可用，请返回登录页使用原账号。'); return true;
    }
  };
}
export const handleWorkbenchSiteLogin = createWorkbenchSiteLogin();

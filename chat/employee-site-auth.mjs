import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';
import { getAuthSession, authenticateBearerToken } from '../lib/auth.mjs';
import { getCachedAuthDocument, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';
import { createEmployeeSiteIdentity } from '../lib/employee-site-identity.mjs';

async function registerIdentity({ realm, openId, name }) {
  const result = await updateAuthDocument(document => {
    let person = document.people.find(p => p.identities.some(i => i.kind === 'feishu' && i.realm === realm && i.subjectId === openId));
    if (!person) {
      person = { id: 'person_' + randomUUID().replaceAll('-', '').slice(0, 24), name: name || '飞书员工', discovered: true,
        credentials: [], identities: [{ id: 'identity_' + randomUUID(), kind: 'feishu', realm, subjectId: openId, displayName: name }], preferences: {} };
      document.people.push(person);
    }
    return { id: person.id, name: person.name };
  });
  return result.result;
}

export const employeeSiteIdentity = createEmployeeSiteIdentity({ configDir: CONFIG_DIR,
  authDocument: async () => getCachedAuthDocument() || await loadAuthDocument(), registerIdentity });

export function sameSiteOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  return req.headers.origin === `${proto}://${host}`;
}

export function createEmployeeSiteAccess(identity = employeeSiteIdentity, remoteSession = async req => {
  await authenticateBearerToken(req); return getAuthSession(req);
}) {
  const resolved = new WeakMap();
  return async (req, res) => {
    if (!resolved.has(req)) resolved.set(req, (async () => {
      const remote = await remoteSession(req);
      // A server credential is not an employee browser login.
      const person = await identity.member(req, remote?.authKind === 'service' ? null : remote);
      if (person) {
        const renewed = await identity.renew(req, person);
        if (renewed) res.setHeader('Set-Cookie', renewed);
      }
      return person;
    })());
    return resolved.get(req);
  };
}
export const employeeSitePerson = createEmployeeSiteAccess();

export async function requireEmployeeSite(req, res) {
  const person = await employeeSitePerson(req, res);
  if (person) return person;
  const login = `/site-login?returnTo=${encodeURIComponent(req.url)}`;
  const navigate = ['GET', 'HEAD'].includes(req.method) && (req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(req.headers.accept || ''));
  res.writeHead(navigate ? 302 : 401, { 'Cache-Control': 'private, no-store', Vary: 'Cookie',
    ...(navigate ? { Location: login } : { 'Content-Type': 'application/json; charset=utf-8' }) });
  res.end(navigate ? undefined : JSON.stringify({ error: '请使用飞书员工身份登录', login }));
  return null;
}

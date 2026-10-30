import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { getAuthSession, authenticateBearerToken } from '../lib/auth.mjs';
import { getCachedAuthDocument, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';
import { createManagedSiteIdentity } from '../lib/managed-site-identity.mjs';
import { createEmployeeSiteIdentity } from '../lib/employee-site-identity.mjs';
import { loadEmployeeSiteSettings } from '../lib/site-publication-policy.mjs';

export async function registerEmployeeIdentity({ kind = 'feishu', realm, openId, name }) {
  const matches = p => p.identities.some(i => i.kind === kind && i.realm === realm && i.subjectId === openId);
  const existing = (getCachedAuthDocument() || await loadAuthDocument()).people.find(matches);
  if (existing) return { id: existing.id, name: existing.name };
  const result = await updateAuthDocument(document => {
    let person = document.people.find(matches);
    if (!person) {
      person = { id: 'person_' + randomUUID().replaceAll('-', '').slice(0, 24), name: name || '飞书员工', discovered: true,
        credentials: [], identities: [{ id: 'identity_' + randomUUID(), kind, realm, subjectId: openId, displayName: name }], preferences: {} };
      document.people.push(person);
    }
    return { id: person.id, name: person.name };
  });
  return result.result;
}

// The separate research API is not part of the managed-website migration.
export const researchSiteIdentity = createEmployeeSiteIdentity({ configDir: CONFIG_DIR,
  authDocument: async () => getCachedAuthDocument() || await loadAuthDocument(), registerIdentity: registerEmployeeIdentity,
  loadSettings: async () => {
    const cfg = await loadEmployeeSiteSettings(CONFIG_DIR);
    return cfg.provider === 'muka-sso-gateway'
      ? JSON.parse(await readFile(join(CONFIG_DIR, 'qianyan-internal.json'), 'utf8')) : cfg;
  } });

export const employeeSiteIdentity = createManagedSiteIdentity({ configDir: CONFIG_DIR,
  legacyIdentity: researchSiteIdentity,
  authDocument: async () => getCachedAuthDocument() || await loadAuthDocument(), registerIdentity: registerEmployeeIdentity });

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
        try {
          const renewed = await identity.renew(req, person);
          if (renewed) res.setHeader('Set-Cookie', renewed);
        } catch { console.error('Employee login renewal failed; retaining this request’s verified identity'); }
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

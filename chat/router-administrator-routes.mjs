import { readFile } from 'node:fs/promises';
import { readBody } from '../lib/utils.mjs';
import { getSessionToken } from '../lib/auth.mjs';
import { loadAuthDocument, changeAdministratorMembership } from '../lib/auth-config.mjs';
import { isSessionAdministrator } from './session-access.mjs';
import { getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts } from './middleware.mjs';
import { broadcastAll } from './ws-clients.mjs';

export async function handleAdministratorRoutes({ req, res, pathname, authSession, nonce, writeJson }) {
  if (!['/admin/session-administrators', '/api/admin/session-administrators'].includes(pathname)) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (authSession?.authKind === 'service' || req.headers.authorization || !getSessionToken(req)
      || !isSessionAdministrator(authSession)) {
    writeJson(res, 403, { error: 'Use an existing administrator personal browser login; chat/service credentials cannot manage administrators' }); return true;
  }
  if (pathname === '/admin/session-administrators' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end((await readFile(new URL('../templates/session-administrators.html', import.meta.url), 'utf8')).replaceAll('{{NONCE}}', nonce));
    return true;
  }
  if (pathname === '/api/admin/session-administrators' && req.method === 'GET') {
    const document = await loadAuthDocument({ persistMigration: false });
    writeJson(res, 200, { actorPersonId: authSession.personId, people: document.people
      .filter(p => p.credentials.length && p.identities.some(i => i.kind === 'web'))
      .map(p => ({ id: p.id, name: p.name, handle: p.handle, administrator: document.administratorPersonIds.includes(p.id) })) });
    return true;
  }
  if (pathname !== '/api/admin/session-administrators' || req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
  const ip = getClientIp(req);
  if (isRateLimited(ip)) { writeJson(res, 429, { error: 'Too many failed password attempts; retry later' }); return true; }
  try {
    if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
      writeJson(res, 403, { error: 'Open the administrator page on this site to confirm' }); return true;
    }
    const body = JSON.parse(await readBody(req, 8192));
    if (!body || Object.keys(body).some(k => !['targetPersonId', 'action', 'reason', 'password', 'confirmation'].includes(k))) {
      writeJson(res, 400, { error: 'Invalid administrator change' }); return true;
    }
    const result = await changeAdministratorMembership(authSession, body);
    clearFailedAttempts(ip);
    broadcastAll({ type: 'people_updated' }); broadcastAll({ type: 'sessions_invalidated' });
    writeJson(res, 200, result);
  } catch (error) {
    if (error.code === 'INVALID_ADMINISTRATOR_PASSWORD') recordFailedAttempt(ip);
    writeJson(res, error.statusCode || 503, { error: error.statusCode ? error.message : 'Change outcome could not be confirmed; reload the administrator list before retrying', code: error.code || 'ADMINISTRATOR_CHANGE_UNAVAILABLE' });
  }
  return true;
}

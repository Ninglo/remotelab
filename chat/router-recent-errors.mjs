import { getSessionToken } from '../lib/auth.mjs';
import { recentErrors, recentErrorsEnabled } from '../lib/recent-errors.mjs';
import { readBody } from '../lib/utils.mjs';
import { canAccessSession, isSessionAdministrator, hrBrowserRestricted } from './session-access.mjs';

const endpoint = '/api/monitoring/recent-errors';
const fingerprint = /^[a-f0-9]{64}$/;

export async function handleRecentErrors({ req, res, pathname, authSession, writeJson, monitor = recentErrors,
  enabled = recentErrorsEnabled, canRead = canAccessSession }) {
  if (pathname !== endpoint && pathname !== `${endpoint}/repair`) return false;
  const reply = (status, body) => { writeJson(res, status, body); return true; };
  if (!isSessionAdministrator(authSession) || hrBrowserRestricted(authSession)) return reply(403, { error: 'Administrator access required' });
  try {
    if (!await enabled()) return reply(404, { error: 'Recent errors is not enabled' });
    if (req.method === 'GET' && pathname === endpoint) {
      const query = new URL(req.url, 'http://local').searchParams;
      const cluster = query.get('cluster');
      const before = query.get('before') || 0;
      if (cluster === null) return reply(200, await monitor.list({ before }));
      if (!fingerprint.test(cluster)) return reply(400, { error: 'Invalid error cluster' });
      const detail = await monitor.detail(cluster, { before });
      if (!detail) return reply(404, { error: 'Unknown error cluster' });
      await Promise.all(detail.events.map(async event => {
        if (event.sessionId && !await canRead(authSession, event.sessionId)) delete event.sessionId;
      }));
      return reply(200, detail);
    }
    if (req.method === 'POST' && pathname.endsWith('/repair')) {
      if (authSession.authKind === 'service' || !authSession.personId || !getSessionToken(req)
        || req.headers['sec-fetch-site'] !== 'same-origin') return reply(403, { error: 'Same-origin administrator browser session required' });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415, { error: 'JSON required' });
      let body;
      try { body = JSON.parse(await readBody(req, 4096)); } catch { return reply(400, { error: 'Invalid repair receipt' }); }
      const { cluster, version, commit, verification } = body || {};
      if (!fingerprint.test(cluster || '') || !Number.isSafeInteger(version) || version <= 0 || !/^[a-f0-9]{40}$/.test(commit || '')
        || typeof verification !== 'string' || !verification.trim() || verification.trim().length > 600) {
        return reply(400, { error: 'Original cluster version, full repair commit and verification result required' });
      }
      const result = await monitor.fix(cluster, { version, commit, verification: verification.trim(), personId: authSession.personId });
      if (result.status === 200) return reply(200, { status: 'fixed' });
      return reply(result.status, { error: result.status === 409 ? 'Error changed; refresh detail before closing' : 'Unknown error cluster' });
    }
    return reply(405, { error: 'Method not allowed' });
  } catch {
    return reply(503, { error: 'Recent-error records are temporarily unavailable' });
  }
}

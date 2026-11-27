import { getSessionToken } from '../lib/auth.mjs';
import { recentErrors, recentErrorsEnabled, recentErrorExcerpt } from '../lib/recent-errors.mjs';
import { getRun } from './runs.mjs';
import { canAccessSession, isSessionAdministrator, hrBrowserRestricted } from './session-access.mjs';

const endpoint = '/api/monitoring/recent-errors';
const fingerprint = /^[a-f0-9]{64}$/;

export async function handleRecentErrors({ req, res, pathname, authSession, writeJson, monitor = recentErrors,
  enabled = recentErrorsEnabled, canRead = canAccessSession, loadRun = getRun }) {
  if (pathname !== endpoint && pathname !== `${endpoint}/repair`) return false;
  const reply = (status, body) => { writeJson(res, status, body); return true; };
  if (!isSessionAdministrator(authSession) || hrBrowserRestricted(authSession)) return reply(403, { error: 'Administrator access required' });
  try {
    if (!await enabled()) return reply(404, { error: 'Recent errors is not enabled' });
    if (req.method === 'GET' && pathname === endpoint) {
      const query = new URL(req.url, 'http://local').searchParams;
      const cluster = query.get('cluster');
      const before = query.get('before') || 0;
      const personalBrowser = Boolean(authSession.personId && authSession.authKind !== 'service' && !req._bearerAuthSession && getSessionToken(req));
      const prepare = (events, source, legacy = false) => Promise.all(events.map(async event => {
        const visible = !event.sessionId || await canRead(authSession, event.sessionId);
        if (!visible) { delete event.sessionId; delete event.reference; }
        if (!personalBrowser || !visible) { delete event.excerpt; return; }
        if (legacy && !event.excerpt && source === 'run-result' && event.sessionId && /^run_[a-f0-9]{24}$/.test(event.reference || '')) {
          // A legacy terminal record may point at an intact original result.
          // A retry or ambiguous reference must not borrow another error line.
          const run = await loadRun(event.reference).catch(() => null);
          const endedAt = run?.completedAt || run?.result?.completedAt;
          if (run?.state === 'failed' && run.sessionId === event.sessionId && Date.parse(endedAt) === Date.parse(event.at)) {
            event.excerpt = recentErrorExcerpt(run.failureReason || run.result?.error);
          }
        }
      }));
      if (cluster === null) {
        const view = await monitor.list({ before, samples: personalBrowser && query.get('samples') === '1' });
        await Promise.all(view.rows.filter(row => row.events).map(row => prepare(row.events,row.source)));
        return reply(200, view);
      }
      if (!fingerprint.test(cluster)) return reply(400, { error: 'Invalid error cluster' });
      const detail = await monitor.detail(cluster, { before });
      if (!detail) return reply(404, { error: 'Unknown error cluster' });
      await prepare(detail.events, detail.cluster.source, true);
      return reply(200, detail);
    }
    if (pathname.endsWith('/repair')) return reply(410, { error: 'Recent errors is read-only; repair workflow retired' });
    return reply(405, { error: 'Method not allowed' });
  } catch {
    return reply(503, { error: 'Recent-error records are temporarily unavailable' });
  }
}

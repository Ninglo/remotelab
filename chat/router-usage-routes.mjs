import { readBody } from '../lib/utils.mjs';
import { CLIENT_USAGE_EVENTS, normalizeUsageEvent, usageEvents } from './usage-events.mjs';

export async function handleUsageRoutes({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (pathname === '/api/usage/events' && req.method === 'POST') {
    if (!authSession?.personId || authSession.authKind === 'service') {
      writeJson(res, 403, { error: 'An authenticated Person browser session is required' }); return true;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      writeJson(res, 403, { error: 'Same-site collection is required' }); return true;
    }
    try {
      const body = JSON.parse(await readBody(req, 32 * 1024));
      if (!Array.isArray(body.events) || body.events.length > 50 || body.events.some(event => !CLIENT_USAGE_EVENTS.has(event?.event)
          || !normalizeUsageEvent(event, { client: true }))) {
        writeJson(res, 400, { error: 'Expected up to 50 basic browser actions' }); return true;
      }
      const recorded = await usageEvents.record(body.events, { personId: authSession.personId, client: true });
      writeJson(res, recorded ? 202 : 503, { recorded });
    } catch { writeJson(res, 400, { error: 'Invalid usage event batch' }); }
    return true;
  }
  if (pathname === '/api/usage/analysis' && req.method === 'GET') {
    const query = parsedUrl.query || {};
    try { writeJson(res, 200, await usageEvents.query({ days: query.days, sessionId: query.sessionId || '', limit: query.limit })); }
    catch { writeJson(res, 503, { error: 'Usage analysis is temporarily unavailable' }); }
    return true;
  }
  return false;
}

import { readBody } from '../lib/utils.mjs';
import { CLIENT_USAGE_EVENTS, normalizeUsageEvent, usageEvents } from './usage-events.mjs';
import { collectSettingBaseline } from './usage-setting-baseline.mjs';
import { settingRows, settingActor, observeSettingRows } from './usage-settings.mjs';
import { settingHash } from '../lib/usage-setting-store.mjs';
import { USAGE_SETTINGS, validUsageSetting } from '../lib/usage-setting-schema.mjs';

export async function handleUsageRoutes({ req, res, pathname, parsedUrl, authSession, writeJson }) {
  if (pathname === '/api/usage/settings' && req.method === 'GET') {
    const subjectHash = parsedUrl.query?.subjectHash || '';
    if (subjectHash && !/^[a-f0-9]{64}$/.test(subjectHash)) {
      writeJson(res, 400, { error: 'Invalid subject hash' }); return true;
    }
    try {
      const snapshot = await collectSettingBaseline();
      writeJson(res, 200, { scope: 'instance', startedAt: snapshot.startedAt,
        incomplete: Boolean(snapshot.incomplete || snapshot.writerFailed),
        settings: Object.values(snapshot.rows || {}).filter(row => !subjectHash || row.subjectHash === subjectHash) });
    } catch { writeJson(res, 503, { error: 'Setting observations are temporarily unavailable' }); }
    return true;
  }
  if (pathname === '/api/usage/settings' && req.method === 'POST') {
    if (!authSession?.personId || authSession.authKind === 'service' || req.headers['sec-fetch-site'] === 'cross-site') {
      writeJson(res, 403, { error: 'An authenticated same-site Person browser session is required' }); return true;
    }
    try {
      const input = JSON.parse(await readBody(req, 4096)), timestamp = Number(input.timestamp);
      const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
      if (!uuid(input.browserId) || !uuid(input.observationId) || !['snapshot', 'change'].includes(input.operation)
          || !Number.isFinite(timestamp) || timestamp < Date.now() - 86_400_000 || timestamp > Date.now() + 60_000
          || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)
          || !Object.keys(input.values).length || Object.keys(input.values).length > 3
          || Object.entries(input.values).some(([setting, value]) => USAGE_SETTINGS[setting]?.scope !== 'browser' || !validUsageSetting(setting, value))) {
        writeJson(res, 400, { error: 'Expected supported browser setting choices' }); return true;
      }
      const scopeId = `${authSession.personId}:${input.browserId}`;
      const recorded = await observeSettingRows(settingRows(input.values, { scope: 'browser', scopeId,
        authority: 'browser', subjectPersonId: authSession.personId }), { ...settingActor(authSession), operation: input.operation,
        observedAt: timestamp, operationId: settingHash(`browser:${scopeId}:${input.observationId}`) });
      writeJson(res, recorded ? 202 : 503, { recorded });
    } catch { writeJson(res, 400, { error: 'Invalid browser setting observation' }); }
    return true;
  }
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
    try { writeJson(res, 200, await usageEvents.query({ days: query.days, sessionId: query.sessionId || '', limit: query.limit,
      settingSnapshot: await collectSettingBaseline() })); }
    catch { writeJson(res, 503, { error: 'Usage analysis is temporarily unavailable' }); }
    return true;
  }
  return false;
}

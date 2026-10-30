import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, PUBLIC_PAGES_DIR } from '../lib/config.mjs';
import { readBody } from '../lib/utils.mjs';
import { employeeSitePerson, sameSiteOrigin } from './employee-site-auth.mjs';
import { createUsageEventStore, usageKey, validUsageSiteId as validSite } from './usage-events.mjs';
import { reverseLedgerLines } from './context-query-ledger-reader.mjs';
import { legacySiteLogin, previewIdentityPolicy } from '../lib/legacy-site-login.mjs';

const DAY = 86_400_000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const actions = new Set(['open', 'download', 'preview']);
const states = new Set(['foreground', 'background', 'leave']);
function validAction(event) {
  return event?.event === 'page_enter'
    || event?.event === 'ui_action' && actions.has(event.action)
    || event?.event === 'page_visibility' && states.has(event.state);
}

// A browser supplies no site ID. Its same-origin Referer is matched to the
// current employee publication/preview registry, never fetched as a URL.
export async function resolveSiteUsageSite(req, { publicPagesDir = PUBLIC_PAGES_DIR, configDir = CONFIG_DIR, personId = '' } = {}) {
  let page;
  try { page = new URL(req.headers.referer); } catch { return null; }
  if (page.origin !== req.headers.origin || page.username || page.password) return null;
  if (page.pathname === '/sites' || page.pathname === '/sites/') return 'directory';
  const match = /^\/(public-pages|preview)\/([^/]+)(?:\/|$)/.exec(page.pathname);
  if (!match) return null;
  const [, kind, slug] = match, site = `${kind === 'public-pages' ? 'static' : 'preview'}:${slug}`;
  if (!validSite(site)) return null;
  try {
    if (kind === 'public-pages') {
      const policy = JSON.parse(await readFile(join(publicPagesDir, slug, '_remote_publish.json'), 'utf8'));
      return policy.access === 'employee' ? site : null;
    }
    const routes = JSON.parse(await readFile(join(configDir, 'preview-routes.json'), 'utf8'));
    let route = routes?.[slug];
    if (!Number.isInteger(route?.port) || route.port < 1 || route.port > 65535) return null;
    route = { ...route, ...await previewIdentityPolicy(slug, route.port, configDir) };
    if (route.access === 'employee' || route.recognizeIdentity === true) return site;
    return route.reuseIdentity === true && personId && await legacySiteLogin.lookup(slug, personId, route.port) ? site : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error; // Invalid/unreadable policy is unavailable, never public.
  }
}

// Reuse schema v1 and its private, serialized writer in a separate directory.
// siteId is server-resolved; no Session or workbench feature is set.
export function createSiteUsageStore({ directory = join(CONFIG_DIR, 'site-usage-events'), maxPending,
  maxScanned = 200_000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const store = createUsageEventStore({ directory, maxPending });
  let recordFailures = 0;
  async function record(events, personId, site) {
    const now = Date.now();
    try {
      const recorded = await store.record(events.map(input => ({
        event: input.event, eventId: usageKey(`site-event:${personId}:${site}:${input.eventId.toLowerCase()}`),
        visitId: usageKey(`site-visit:${personId}:${site}:${input.visitId.toLowerCase()}`),
        timestamp: now,
        ...(input.event === 'ui_action' ? { action: input.action } : {}),
        ...(input.event === 'page_visibility' ? { state: input.state } : {}),
      })), { client: true, personId, verifiedSiteId: site });
      if (!recorded) recordFailures++;
      return recorded;
    } catch { recordFailures++; return false; }
  }
  async function query({ days = 7, site = '' } = {}) {
    await store.idle();
    const now = Date.now(), start = now - days * DAY;
    const coverage = { incomplete: recordFailures > 0, scanned: 0, recordFailures, gaps: [] };
    let names = [], collectionStartedAt = null;
    try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (names.length) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8'));
        if (!Number.isFinite(Date.parse(metadata.startedAt))) throw new Error('Invalid collection start');
        collectionStartedAt = metadata.startedAt;
        coverage.gaps.push(...(Array.isArray(metadata.gaps) ? metadata.gaps : []));
      } catch { coverage.incomplete = true; }
    }
    for (const name of names.filter(name => /^health-[a-f0-9-]+\.json$/.test(name))) {
      try { coverage.gaps.push(JSON.parse(await readFile(join(directory, name), 'utf8'))); }
      catch { coverage.incomplete = true; }
    }
    coverage.gaps = coverage.gaps.filter(gap => {
      if (!Number.isFinite(gap?.start) || !Number.isFinite(gap?.end)) { coverage.incomplete = true; return false; }
      return gap.end >= start && gap.start <= now;
    }).map(({ start, end }) => ({ start, end }));
    if (coverage.gaps.length) coverage.incomplete = true;
    const ids = new Set(), total = accumulator(), sites = new Map(), daily = new Map();
    const budget = { remaining: maxBytes, incomplete: false };
    const files = names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
      && name.slice(0, 10) >= new Date(start).toISOString().slice(0, 10)).sort().reverse();
    for (const file of files) {
      if (budget.remaining <= 0 || coverage.scanned >= maxScanned) { coverage.incomplete = true; break; }
      try {
        for await (const line of reverseLedgerLines(join(directory, file), budget)) {
          if (++coverage.scanned > maxScanned) { coverage.incomplete = true; break; }
          let event;
          try { event = JSON.parse(line); } catch { coverage.incomplete = true; continue; }
          const eventSite = event?.siteId;
          if (line.length > 4096 || event?.schemaVersion !== 1 || !hash(event.eventId) || !hash(event.personHash)
              || !hash(event.visitId) || !validSite(eventSite)
              || !Number.isFinite(event.timestamp) || !validAction(event)
              || event.actorKind !== 'human' || event.surface !== 'web') { coverage.incomplete = true; continue; }
          if (ids.has(event.eventId)) continue;
          ids.add(event.eventId);
          if (event.timestamp < Math.max(start, Date.parse(collectionStartedAt) || start) || event.timestamp > now
              || site && eventSite !== site) continue;
          const day = new Date(event.timestamp).toISOString().slice(0, 10);
          if (!sites.has(eventSite)) sites.set(eventSite, accumulator());
          if (!daily.has(day)) daily.set(day, accumulator());
          for (const row of [total, sites.get(eventSite), daily.get(day)]) count(row, event);
        }
      } catch { coverage.incomplete = true; }
    }
    coverage.incomplete ||= budget.incomplete;
    return { generatedAt: new Date(now).toISOString(), collectionStartedAt,
      window: { days, start: new Date(start).toISOString(), end: new Date(now).toISOString() },
      scope: 'employee-websites', ...serialize(total),
      sites: [...sites].sort(([a], [b]) => a.localeCompare(b)).map(([site, row]) => ({ site, ...serialize(row) })),
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({ day, ...serialize(row) })), coverage };
  }
  return { record, query, idle: store.idle };
}
function accumulator() {
  return { events: 0, pageViews: 0, people: new Set(), visits: new Set(),
    actions: { open: 0, download: 0, preview: 0 }, visibility: { foreground: 0, background: 0, leave: 0 } };
}
function count(row, event) {
  row.events++; row.people.add(event.personHash); row.visits.add(event.visitId);
  if (event.event === 'page_enter') row.pageViews++;
  if (event.event === 'ui_action') row.actions[event.action]++;
  if (event.event === 'page_visibility') row.visibility[event.state]++;
}
function serialize(row) { return { ...row, people: row.people.size, visits: row.visits.size }; }

export function createSiteUsageHandler({ store = createSiteUsageStore(), personFor = employeeSitePerson,
  resolveSite = resolveSiteUsageSite } = {}) {
  return async ({ req, res, pathname, authSession }) => {
    if (!['/api/site-usage/events', '/api/site-usage/summary'].includes(pathname)) return false;
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const summary = pathname.endsWith('/summary');
    if (req.method !== (summary ? 'GET' : 'POST')) {
      res.setHeader('Allow', summary ? 'GET' : 'POST'); send(405, { error: 'Method not allowed' }); return true;
    }
    try {
      if (summary) {
        // authSession must come from the existing requireAuth/getAuthSession
        // control-plane gate. Employee cookies/roles are not console credentials.
        if (!authSession?.personId && authSession?.authKind !== 'service') {
          send(403, { error: 'RemoteLab control-console authentication required' }); return true;
        }
        const query = new URL(req.url, 'http://localhost').searchParams;
        const rawDays = query.get('days'), days = rawDays === null ? 7 : Number(rawDays), site = query.get('site') || '';
        if (!Number.isInteger(days) || days < 1 || days > 30 || site && !validSite(site)) {
          send(400, { error: 'Expected days=1..30 and an optional registered site ID' }); return true;
        }
        send(200, await store.query({ days, site })); return true;
      }
      if (!sameSiteOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') {
        send(403, { error: 'Same-origin website collection required' }); return true;
      }
      const person = await personFor(req, res);
      if (!person?.id || person.auth_kind === 'service') { send(401, { error: 'Employee browser identity required' }); return true; }
      const site = await resolveSite(req, { personId: person.id });
      if (!site) { send(403, { error: 'A registered employee website Referer is required' }); return true; }
      let body;
      try { body = JSON.parse(await readBody(req, 32 * 1024)); }
      catch (error) { send(error.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid website event batch' }); return true; }
      if (!Array.isArray(body?.events) || !body.events.length || body.events.length > 50
          || body.events.some(event => !validAction(event) || !uuid(event.eventId) || !uuid(event.visitId))) {
        send(400, { error: 'Expected 1..50 website page, visibility or explicit action events with UUIDs' }); return true;
      }
      const recorded = await store.record(body.events, person.id, site);
      send(recorded ? 202 : 503, { recorded });
    } catch { send(503, { error: 'Website usage is temporarily unavailable' }); }
    return true;
  };
}
export const handleSiteUsageRoutes = createSiteUsageHandler();

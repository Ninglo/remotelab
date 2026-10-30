import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

// Isolate BEFORE importing modules with default config/auth/usage singletons.
const root = await mkdtemp(join(tmpdir(), 'site-usage-test-'));
setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR = root;
process.env.REMOTELAB_PUBLIC_PAGES_DIR = join(root, 'pages');
after(() => rm(root, { recursive: true, force: true }));
const { createSiteUsageHandler, createSiteUsageStore } = await import('../chat/router-site-usage.mjs');
const { normalizeUsageEvent, usageKey, CLIENT_USAGE_EVENTS } = await import('../chat/usage-events.mjs');
const auth = await import('../lib/auth.mjs');
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const event = (extra = {}) => ({ event: 'page_enter', eventId: randomUUID(), visitId: randomUUID(), ...extra });
async function rawEvents(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl'));
  return (await Promise.all(names.map(name => readFile(join(directory, name), 'utf8')))).join('')
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('site scope comes only from verified context; original browser whitelist and workbench fields remain intact', () => {
  const input = { ...event(), siteId: 'static:forged', verifiedSiteId: 'static:forged', personId: 'forged',
    personHash: 'forged', page: 'sessions', action: 'open', feature: 'workbench', content: 'secret', timestamp: 1000 };
  const baseline = normalizeUsageEvent(input, { client: true, personId: 'verified', now: 1000 });
  assert.equal(baseline.siteId, undefined);
  assert.equal(baseline.personHash, usageKey('person:verified'));
  assert.equal(baseline.page, 'sessions'); assert.equal(baseline.feature, 'workbench');
  assert.deepEqual(normalizeUsageEvent(input, { client: true, personId: 'verified', verifiedSiteId: 'static:real', now: 1000 }),
    { ...baseline, siteId: 'static:real' });
  assert.equal(normalizeUsageEvent(input, { client: true, verifiedSiteId: 'static:real' }).siteId, undefined);
  assert.equal(normalizeUsageEvent(input, { client: true, personId: 'verified', verifiedSiteId: '../escape' }).siteId, undefined);
  assert.equal(normalizeUsageEvent({ ...input, event: 'site_enter' }, { client: true }), null);
  assert.deepEqual([...CLIENT_USAGE_EVENTS], ['page_enter', 'session_open', 'page_visibility', 'ui_action', 'content_presented', 'artifact_open']);
});

test('real employee cookies collect only registered sites; console authentication alone controls summary', async () => {
  const people = ['a', 'b'].map(suffix => ({ id: `person_site_${suffix}`, name: `员工${suffix}`, credentials: [],
    identities: [{ id: `identity_${suffix}`, kind: 'feishu', realm: 'fixture-realm', subjectId: `open_${suffix}` }], preferences: {} }));
  await updateAuthDocument(doc => { doc.people.push(...people); });
  await writeFile(join(root, 'site-login.json'), JSON.stringify({ realm: 'fixture-realm', tenantKey: 'fixture-company',
    feishuConfigPath: join(root, 'unused-app.json'), personIds: [people[0].id] }));
  const digest = token => createHash('sha256').update(token).digest('hex');
  await writeFile(join(root, 'qianyan-identity.json'), JSON.stringify({ pending: {}, sessions: Object.fromEntries(
    [['employee-a', people[0], Date.now() + 30 * 86400000], ['employee-b', people[1], Date.now() + 30 * 86400000],
      ['employee-expired', people[0], Date.now() - 1000]].map(([token, person, expiresAt]) => [digest(token), {
      personId: person.id, openId: person.identities[0].subjectId, realm: 'fixture-realm', tenantKey: 'fixture-company', expiresAt }])) }));
  for (const [slug, access] of [['one', 'employee'], ['two', 'employee'], ['public', 'public']]) {
    await mkdir(join(root, 'pages', slug), { recursive: true });
    await writeFile(join(root, 'pages', slug, '_remote_publish.json'), JSON.stringify({ access }));
  }
  await writeFile(join(root, 'preview-routes.json'), JSON.stringify({ dynamic: { access: 'employee', port: 12345 }, basic: { access: 'basic', port: 12346 } }));
  const directory = join(root, 'http-ledger'), store = createSiteUsageStore({ directory });
  let handler = createSiteUsageHandler({ store });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    // Mirrors the proposed integration: events before the control-plane gate,
    // summary after that same existing gate. No employee-to-console promotion.
    if (pathname === '/api/site-usage/events' && await handler({ req, res, pathname })) return;
    await auth.authenticateBearerToken(req);
    if (!auth.isAuthenticated(req)) { res.writeHead(401); res.end(); return; }
    if (await handler({ req, res, pathname, authSession: auth.getAuthSession(req) })) return;
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const consoleToken = auth.getOrCreateAuthenticatedSessionToken({ personId: people[0].id }).token;
  const serviceToken = auth.getOrCreateAuthenticatedSessionToken({ personId: people[0].id, authKind: 'service' }).token;
  const headers = (overrides = {}) => ({ Origin: base, Referer: base + '/public-pages/one/index.html?private-query=secret',
    Cookie: 'employee_site_session=employee-a', 'Content-Type': 'application/json', ...overrides });
  const post = (events, overrides = {}) => fetch(base + '/api/site-usage/events', {
    method: 'POST', headers: headers(overrides), body: JSON.stringify({ events }) });
  const summary = async (query = '') => {
    const response = await fetch(base + '/api/site-usage/summary' + query, { headers: { Cookie: `session_token=${consoleToken}` } });
    return { status: response.status, json: await response.json(), response };
  };
  try {
    assert.equal((await summary()).json.collectionStartedAt, null);
    await assert.rejects(readdir(directory), { code: 'ENOENT' }, 'reading summary does not initialize or write a ledger');
    assert.equal((await post([event()], { Cookie: '' })).status, 401);
    assert.equal((await post([event()], { Cookie: 'employee_site_session=employee-expired' })).status, 401);
    assert.equal((await post([event()], { Cookie: `session_token=${serviceToken}` })).status, 401);
    assert.equal((await post([event()], { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await post([event()], { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    for (const referer of ['', 'https://attacker.test/public-pages/one/', base + '/public-pages/public/', base + '/preview/basic/',
      base + '/public-pages/unknown/', base + '/public-pages/%2e%2e/', base + '/?tab=sessions']) {
      assert.equal((await post([event()], { Referer: referer })).status, 403, referer);
    }
    for (const bad of [[], Array.from({ length: 51 }, () => event()), [event({ event: 'session_open' })],
      [event({ eventId: 'bad' })], [event({ event: 'ui_action', action: 'send' })], [event({ event: 'page_visibility', state: 'secret' })],
      [event(), event({ event: 'run_state' })]]) assert.equal((await post(bad)).status, 400);
    assert.equal((await fetch(base + '/api/site-usage/events', { method: 'POST', headers: headers(), body: '{' })).status, 400);
    assert.equal((await fetch(base + '/api/site-usage/events', { method: 'POST', headers: headers(), body: 'x'.repeat(32769) })).status, 413);
    assert.equal((await fetch(base + '/api/site-usage/events', { headers: headers() })).status, 405);
    await assert.rejects(readdir(directory), { code: 'ENOENT' }, 'all rejected inputs leave storage untouched');

    const first = event({ personId: 'forged-person', personHash: 'forged-person', actorKind: 'agent', surface: 'feishu',
      siteId: 'static:forged', verifiedSiteId: 'static:forged', objectId: 'forged-object', sessionId: 'forged-session',
      timestamp: 1, url: 'https://secret-url.test/', title: 'secret-title', content: 'secret-content', props: { token: 'secret-token' } });
    const firstResponse = await post([first]);
    assert.equal(firstResponse.status, 202); assert.deepEqual(await firstResponse.json(), { recorded: true });
    assert.match(firstResponse.headers.get('cache-control'), /no-store/);
    assert.equal((await post([first])).status, 202);
    const second = event();
    assert.equal((await post([second], { Cookie: 'employee_site_session=employee-b' })).status, 202);
    assert.equal((await post([event({ visitId: first.visitId, event: 'ui_action', action: 'download' }),
      event({ visitId: first.visitId, event: 'page_visibility', state: 'background' })])).status, 202);
    assert.equal((await post([first], { Referer: base + '/public-pages/two/' })).status, 202, 'same UUID in another site has a separate scope');
    assert.equal((await post([first], { Cookie: 'employee_site_session=employee-b' })).status, 202, 'another employee cannot suppress events by reusing UUIDs');
    assert.equal((await post([event()], { Referer: base + '/preview/dynamic/' })).status, 202);
    assert.equal((await post([event()], { Referer: base + '/sites' })).status, 202);
    assert.equal((await post([event()], { Cookie: `session_token=${consoleToken}` })).status, 202, 'already verified eligible console Person is reused');
    let report = await summary();
    assert.equal(report.status, 200); assert.equal(report.json.pageViews, 7); assert.equal(report.json.events, 9);
    assert.equal(report.json.people, 2); assert.equal(report.json.visits, 7); assert.equal(report.json.actions.download, 1);
    assert.equal(report.json.visibility.background, 1); assert.equal(report.json.sites.length, 4);
    assert.equal(report.json.daily.length, 1); assert.equal(report.json.coverage.incomplete, false);
    assert.equal((await summary('?site=static:two')).json.pageViews, 1);
    for (const query of ['?days=0', '?days=31', '?days=abc', '?days=1.5', '?site=../escape']) assert.equal((await summary(query)).status, 400);
    const employeeOnly = await fetch(base + '/api/site-usage/summary', { headers: headers() });
    assert.equal(employeeOnly.status, 401);
    assert.equal((await fetch(base + '/api/site-usage/summary', { headers: { Cookie: `session_token=${serviceToken}` } })).status, 200,
      'existing service read permission is retained');
    const denied = { headers: {}, setHeader() {}, writeHead(code) { this.code = code; }, end() {} };
    await handler({ req: { method: 'GET', url: '/api/site-usage/summary' }, res: denied, pathname: '/api/site-usage/summary' });
    assert.equal(denied.code, 403, 'handler also rejects a summary call without a verified console session');

    const raw = await rawEvents(directory);
    assert.equal(raw.length, 9); assert.equal(raw[0].siteId, 'static:one');
    assert.equal(raw[0].personHash, usageKey(`person:${people[0].id}`));
    assert.ok(raw[0].timestamp > 1);
    for (const privateText of ['forged', 'secret', 'private-query', 'employee-a', 'person_site_', '员工', 'open_a', base]) {
      assert.equal(JSON.stringify(raw).includes(privateText), false, `ledger excludes ${privateText}`);
      assert.equal(JSON.stringify(report.json).includes(privateText), false, `summary excludes ${privateText}`);
    }
    assert.equal(JSON.stringify(report.json).includes('personHash'), false);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const log = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
    assert.equal((await stat(join(directory, log))).mode & 0o777, 0o600);
    await assert.rejects(readdir(join(root, 'usage-events')), { code: 'ENOENT' }, 'workbench ledger receives no website events');
    handler = createSiteUsageHandler({ store: createSiteUsageStore({ directory }) });
    assert.equal((await post([first])).status, 202);
    assert.equal((await summary()).json.pageViews, 7, 'restart and retry do not inflate aggregation');
    await writeFile(join(root, 'pages', 'one', '_remote_publish.json'), '{');
    assert.equal((await post([event()])).status, 503, 'invalid site policy is unavailable');
    await writeFile(join(root, 'pages', 'one', '_remote_publish.json'), '{"access":"public"}');
    assert.equal((await post([event()])).status, 403, 'policy changes take effect on the next request');
    assert.equal((await summary()).json.pageViews, 7, 'historical website observations remain readable after policy changes');
    await writeFile(join(root, 'site-login.json'), '{"enabled":false}');
    assert.equal((await post([event()], { Referer: base + '/sites' })).status, 401);
    await rm(join(root, 'site-login.json'));
    assert.equal((await post([event()], { Referer: base + '/sites' })).status, 401, 'unconfigured login fails quietly without creating identity');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('bounded summary reports truncation, corrupt lines, storage gaps and write failures', async () => {
  const directory = join(root, 'bounded'), store = createSiteUsageStore({ directory });
  assert.equal(await store.record([event(), event(), event()], 'person', 'static:one'), true);
  assert.equal((await createSiteUsageStore({ directory, maxScanned: 1 }).query()).coverage.incomplete, true);
  assert.equal((await createSiteUsageStore({ directory, maxBytes: 10 }).query()).coverage.incomplete, true);
  const logfile = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
  await writeFile(join(directory, logfile), 'not-json\n{}\n', { flag: 'a' });
  const partial = await store.query();
  assert.equal(partial.pageViews, 3); assert.equal(partial.coverage.incomplete, true);
  await writeFile(join(directory, 'health-abc.json'), JSON.stringify({ start: Date.now() - 1000, end: Date.now() }));
  assert.equal((await createSiteUsageStore({ directory }).query()).coverage.gaps.length, 1);
  const blocked = join(root, 'blocked'); await writeFile(blocked, 'not a directory');
  const failed = createSiteUsageStore({ directory: blocked });
  assert.equal(await failed.record([event()], 'person', 'directory'), false);
  await rm(blocked);
  assert.equal((await failed.query()).coverage.recordFailures, 1);
  assert.equal((await failed.query()).coverage.incomplete, true);
  const capped = createSiteUsageStore({ directory: join(root, 'capped'), maxPending: 1 });
  assert.equal(await capped.record([event(), event()], 'person', 'directory'), false);
  assert.equal((await capped.query()).coverage.incomplete, true);
});

const script = await readFile(new URL('../static/site-usage.js', import.meta.url), 'utf8');
function browser({ pathname = '/public-pages/one/', visibility = 'visible', fetchImpl = async () => ({ status: 202 }), framed = false } = {}) {
  const listeners = {}, requests = [];
  const window = { addEventListener(name, callback) { listeners[name] = callback; } };
  window.self = window; window.top = framed ? {} : window;
  const document = { visibilityState: visibility, addEventListener(name, callback) { listeners[name] = callback; } };
  const context = vm.createContext({ window, document, location: { pathname }, crypto: { randomUUID },
    fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return fetchImpl(); } });
  vm.runInContext(script, context);
  return { window, document, requests, context, emit: (name, event = {}) => listeners[name]?.(event) };
}
test('browser observes visible entry, explicit actions and lifecycle without DOM content or persistent identity', async () => {
  const b = browser(); await b.window.RemoteLabSiteUsage.flush();
  assert.equal(b.requests.length, 1); assert.equal(b.requests[0].body.events[0].event, 'page_enter');
  vm.runInContext(script, b.context); assert.equal(b.requests.length, 1, 'duplicate script injection adds no listeners or views');
  b.emit('click', { isTrusted: true, target: { closest: () => ({ getAttribute: () => 'download' }) } });
  await b.window.RemoteLabSiteUsage.flush();
  b.emit('click', { isTrusted: false, target: { closest: () => ({ getAttribute: () => 'open' }) } });
  b.emit('click', { isTrusted: true, target: { closest: () => ({ getAttribute: () => 'private-action' }) } });
  assert.equal(b.requests.length, 2);
  b.document.visibilityState = 'hidden'; b.emit('visibilitychange'); await b.window.RemoteLabSiteUsage.flush();
  b.document.visibilityState = 'visible'; b.emit('visibilitychange'); await b.window.RemoteLabSiteUsage.flush();
  b.emit('pagehide'); await b.window.RemoteLabSiteUsage.flush();
  b.emit('pageshow', { persisted: true }); await b.window.RemoteLabSiteUsage.flush();
  const events = b.requests.flatMap(request => request.body.events);
  assert.deepEqual(events.map(input => input.event), ['page_enter', 'ui_action', 'page_visibility', 'page_visibility', 'page_visibility', 'page_enter']);
  assert.notEqual(events[0].visitId, events.at(-1).visitId);
  for (const request of b.requests) {
    assert.equal(request.url, '/api/site-usage/events'); assert.equal(request.keepalive, true);
    assert.equal(request.credentials, 'same-origin'); assert.equal(request.referrerPolicy, 'same-origin');
    for (const input of request.body.events) assert.ok(Object.keys(input).every(key => ['event', 'eventId', 'visitId', 'action', 'state'].includes(key)));
  }
  const hidden = browser({ visibility: 'hidden' }); assert.equal(hidden.requests.length, 0);
  hidden.document.visibilityState = 'visible'; hidden.emit('visibilitychange'); await hidden.window.RemoteLabSiteUsage.flush();
  assert.equal(hidden.requests[0].body.events[0].event, 'page_enter');
  assert.equal(browser({ pathname: '/' }).requests.length, 0);
  assert.equal(browser({ framed: true }).requests.length, 0);
});

test('browser is silent when login/endpoint is unavailable; retry IDs survive transient failure and leave is sent during an in-flight entry', async () => {
  for (const status of [401, 403, 404]) {
    const b = browser({ fetchImpl: async () => ({ status }) });
    await b.window.RemoteLabSiteUsage.flush();
    b.emit('pagehide'); await b.window.RemoteLabSiteUsage.flush();
    assert.equal(b.requests.length, 1);
  }
  let attempts = 0;
  const retry = browser({ fetchImpl: async () => { if (++attempts === 1) throw new Error('offline'); return { status: 202 }; } });
  await retry.window.RemoteLabSiteUsage.flush(); await retry.window.RemoteLabSiteUsage.flush();
  assert.equal(retry.requests.length, 2);
  assert.deepEqual(retry.requests[0].body, retry.requests[1].body);
  let resolveFirst;
  const leaving = browser({ fetchImpl: () => new Promise(resolve => { resolveFirst = resolve; }) });
  const resolveEntry = resolveFirst;
  leaving.emit('pagehide');
  assert.equal(leaving.requests.length, 2, 'leave uses its own keepalive even if entry has not returned');
  assert.equal(leaving.requests[1].body.events[0].state, 'leave');
  resolveFirst({ status: 202 }); resolveEntry({ status: 202 });
  await leaving.window.RemoteLabSiteUsage.flush();
});

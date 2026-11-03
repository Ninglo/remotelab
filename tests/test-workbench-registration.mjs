// Isolated HTTP fixtures; no real employee is registered by this test.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const root = await mkdtemp(join(tmpdir(), 'workbench-registration-'));
setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR = root;
const { createWorkbenchSiteLogin } = await import('../chat/workbench-site-login.mjs');
const config = await import('../lib/auth-config.mjs');
const auth = await import('../lib/auth.mjs');
const { canReadSession } = await import('../chat/session-access.mjs');
const settings = { realm: 'fixture-company', workbenchRegistration: true };
let employee = null, failPersistence = false;
const makePerson = n => ({ id: 'person_' + n, name: 'Employee fixture ' + n, handle: 'fixture-' + n,
  discovered: true, credentials: [], identities: [{ id: 'identity_feishu_' + n, kind: 'feishu',
    realm: settings.realm, subjectId: 'fixture-open-' + n }] });
await config.updateAuthDocument(d => { d.people.push(makePerson('a'), makePerson('b'), makePerson('c')); });
const administratorsBefore = (await config.loadAuthDocument()).administratorPersonIds;
const handler = createWorkbenchSiteLogin({ personFor: async () => employee, settings: async () => settings,
  persist: async () => { if (failPersistence) throw Error('fixture disk failure'); await auth.saveAuthSessionsAsync({ strict: true }); } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handler(req, res, url.pathname, Object.fromEntries(url.searchParams))) return;
  res.end('login form');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const post = (action, body = {}, headers = {}) => fetch(base + '/api/auth/feishu/' + action, {
  method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ next: '/?session=original&tab=sessions', ...body }), redirect: 'manual' });
const as = id => { employee = { id: 'person_' + id, auth_kind: 'feishu' }; };
try {
  assert.equal((await post('complete', { identityCode: 'employee-a', personId: 'person_a' })).status, 401);
  as('a');
  assert.equal((await post('complete', { identityCode: 'employee-a' }, { Origin: 'https://evil.test' })).status, 403);
  settings.workbenchRegistration = false;
  assert.equal((await post('complete', { identityCode: 'employee-a' })).status, 403);
  settings.workbenchRegistration = true;
  settings.realm = 'another-company';
  assert.equal((await post('complete', { identityCode: 'employee-a' })).status, 403);
  settings.realm = 'fixture-company';
  employee.auth_kind = 'remotelab';
  assert.equal((await post('complete', { identityCode: 'employee-a' })).status, 403);
  as('a');
  const beforeLogin = await fetch(base + '/login');
  assert.equal(await beforeLogin.text(), 'login form', 'passive discovery does not register employees');
  assert.equal((await config.loadAuthDocument()).people.find(p => p.id === employee.id).credentials.length, 0);
  let res;
  failPersistence = true;
  res = await post('complete', { identityCode: 'Employee-A', personId: 'person_b', administrator: true });
  assert.equal(res.status, 503); assert.equal(res.headers.get('set-cookie'), null);
  failPersistence = false;
  res = await post('complete', { identityCode: 'employee-a' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).redirect, '/?session=original&tab=sessions');
  const cookie = res.headers.getSetCookie().find(c => c.startsWith('session_token=')).split(';')[0];
  const actor = auth.getAuthSession({ headers: { cookie } });
  assert.equal(actor.personId, 'person_a');
  let document = await config.loadAuthDocument();
  let person = document.people.find(p => p.id === actor.personId);
  assert.equal(person.handle, 'fixture-a'); assert.equal(person.discovered, false);
  assert.equal(person.credentials.length, 1); assert.equal(person.credentials[0].type, 'feishu');
  assert.equal(person.credentials[0].identityId, 'identity_feishu_a');
  assert.equal(person.credentials[0].token, undefined, 'registration does not issue a bearer secret');
  assert.ok(config.getWebIdentity(person));
  assert.equal(canReadSession(actor, { creatorIdentityId: 'identity_feishu_a' }, document), true, 'own historical Feishu Session remains accessible');
  assert.equal(canReadSession(actor, { creatorIdentityId: 'identity_feishu_b' }, document), false, 'another employee stays isolated');
  assert.equal(canReadSession(actor, { creatorIdentityId: actor.identityId }, document), true, 'new Web Sessions use the same Person');
  assert.deepEqual(document.administratorPersonIds, administratorsBefore);
  assert.equal(document.people.find(p => p.id === 'person_b').credentials.length, 0, 'client Person claim is ignored');
  assert.ok(JSON.parse(await readFile(join(root, 'auth-sessions.json'), 'utf8'))[cookie.split('=')[1]], 'cookie is durable before issuance');
  res = await post('complete', { identityCode: 'renamed-on-retry' });
  assert.equal(res.status, 200);
  person = (await config.loadAuthDocument()).people.find(p => p.id === actor.personId);
  assert.equal(person.handle, 'fixture-a'); assert.equal(person.credentials.length, 1);
  res = await post('complete', { next: '//evil.test' });
  assert.equal((await res.json()).redirect, '/');
  // Simultaneous completion retries enroll the same verified Person once.
  as('c');
  const c = await Promise.all([post('complete'), post('complete')]);
  assert.deepEqual(c.map(r => r.status), [200, 200]);
  document = await config.loadAuthDocument();
  assert.equal(document.people.find(p => p.id === 'person_c').credentials.length, 1, 'parallel retry registers once');
  assert.deepEqual(document.administratorPersonIds, administratorsBefore);
  console.log('Registration HTTP PASS: employee proof, explicit opt-in, automatic identity registration, ignored client identity, retry/persistence, roles and Session isolation');
} finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }

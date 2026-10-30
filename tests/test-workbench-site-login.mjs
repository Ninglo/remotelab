import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'workbench-site-login-'));
setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR = root;
const { createWorkbenchSiteLogin, safeWorkbenchNext } = await import('../chat/workbench-site-login.mjs');
const authConfig = await import('../lib/auth-config.mjs');
const auth = await import('../lib/auth.mjs');
let employee = null, existing = null, providerCalls = 0, failPersistence = false;
const credential = { id: 'credential_fixture', type: 'token', token: 'fixture-personal-secret' };
const person = { id: 'person_fixture', name: 'Fixture person', handle: 'fixture', credentials: [credential],
  identities: [{ id: 'identity_fixture_web', kind: 'web', realm: 'remotelab', subjectId: 'fixture' }] };
await authConfig.updateAuthDocument(d => { d.people.push(person); });
const handler = createWorkbenchSiteLogin({
  current: () => existing,
  personFor: async () => { providerCalls++; return employee; },
  persist: async () => { if (failPersistence) throw Error('fixture disk failure'); await auth.saveAuthSessionsAsync({ strict: true }); },
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handler(req, res, url.pathname, Object.fromEntries(url.searchParams))) return;
  res.end('original login form');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const request = (path, options) => fetch(`http://127.0.0.1:${server.address().port}` + path, { redirect: 'manual', ...options });
try {
  assert.equal(await (await request('/login')).text(), 'original login form');
  let res = await request('/login/feishu?next=' + encodeURIComponent('/?session=kept'));
  assert.equal(res.status, 303); assert.match(res.headers.get('location'), /^\/site-login\?returnTo=/);
  existing = { personId: 'person_original', authKind: 'web' };
  const calls = providerCalls;
  employee = { id: person.id };
  res = await request('/login?next=%2F%3Fsession%3Dkept');
  assert.equal(res.headers.get('location'), '/?session=kept');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(providerCalls, calls, 'existing login wins without a new identity check or Person switch');
  existing = null;
  res = await request('/login?next=%2F%3Fsession%3Dkept');
  assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/?session=kept');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal(auth.getAuthSession({ headers: { cookie } }).personId, person.id);
  const persisted = JSON.parse(await readFile(join(root, 'auth-sessions.json'), 'utf8'));
  assert.equal(persisted[cookie.split('=')[1]].personId, person.id, 'exchange survives restart using the original account');
  assert.equal(persisted[cookie.split('=')[1]].credentialId, credential.id);
  assert.equal(await auth.authenticateTokenAsync(credential.token).then(x => x.personId), person.id, 'original credential still works');
  employee = { id: 'unknown_employee' };
  assert.equal((await request('/login/feishu')).status, 403);
  assert.equal(await (await request('/login')).text(), 'original login form');
  employee = { id: person.id };
  await authConfig.updateAuthDocument(d => { d.people.find(p => p.id === person.id).credentials = []; });
  assert.equal((await request('/login/feishu')).status, 403, 'employee identity without a current personal credential cannot enter');
  await authConfig.updateAuthDocument(d => { d.people.find(p => p.id === person.id).credentials = [credential]; });
  existing = { personId: person.id, authKind: 'service' }; employee = null;
  assert.equal(await (await request('/login')).text(), 'original login form', 'service identity cannot silently sign a human in');
  existing = null; employee = { id: person.id }; failPersistence = true;
  res = await request('/login/feishu');
  assert.equal(res.status, 503); assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(await (await request('/login')).text(), 'original login form', 'identity bridge failure preserves original sign-in');
  for (const unsafe of ['//evil.test', '/\\evil.test', '/login/feishu', '/login?next=/x', '/bad\r\nLocation: bad']) assert.equal(safeWorkbenchNext(unsafe), '/');
  assert.equal(safeWorkbenchNext('/?session=kept#draft'), '/?session=kept#draft');
  console.log('Workbench Feishu bridge: existing-session precedence, exact account, persistent exchange, original credential, admission, failures and return path PASS');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

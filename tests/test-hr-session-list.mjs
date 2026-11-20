import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'hr-session-list-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
const people = ['owner', 'peer', 'shared'].map((id, i) => ({ id, name: id,
  credentials: [{ id: 'credential-' + id, type: 'token', token: String(i + 1).repeat(64) }],
  identities: [{ id: id + '-web', kind: 'web', realm: 'remotelab', subjectId: id }] }));
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'shared',
  administratorPersonIds: ['shared'], people, serviceToken: 'f'.repeat(64) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify(Object.fromEntries(people.map(p =>
  ['fixture-' + p.id, { personId: p.id, identityId: p.id + '-web', expiry: Date.now() + 60000 }]))));
const policy = { schema: 1, version: 'v1', roles: { hr1: { 'hr.read': 'all' } },
  sharedWeb: [{ instance: 'hr', personId: 'shared', identityId: 'shared-web' }],
  subjects: ['owner', 'peer'].map(id => ({ id, active: true, roles: ['hr1'],
    bindings: [{ kind: 'web', instance: 'hr', personId: id, identityId: id + '-web' }] })) };
const policyFile = join(home, 'policy.json'), guard = join(home, 'guard.json');
await writeFile(policyFile, JSON.stringify(policy));
await writeFile(guard, JSON.stringify({ hrPolicyPath: policyFile, hrInstance: 'hr',
  hrRestrictedRuntime: true, hrEnforceAfter: '2026-01-01T00:00:00Z' }));
process.env.REMOTELAB_REQUEST_ACCESS_GUARD = guard;
const records = [
  ['1', 'owner', false, '2025-12-01'], ['2', 'owner', true, '2025-12-02'],
  ['3', 'peer', false, '2025-12-03'], ['4', 'shared', false, '2025-12-04'],
  ['5', 'shared', false, '2026-02-01'],
].map(([id, owner, archived, created]) => ({ id: id.repeat(32), name: owner + '-' + id,
  creatorIdentityId: owner + '-web', initiatedByIdentityId: owner + '-web',
  folder: home, tool: 'codex', sourceId: 'chat', created, archived }));
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(records));
const { handleRequest } = await import('../chat/router.mjs');
const server = http.createServer((req, res) => void handleRequest(req, res).catch(error => {
  console.error(error); if (!res.headersSent) res.writeHead(500); res.end();
}));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
async function call(who, path, headers = {}, bearer = false) {
  const token = who === 'service' ? 'f'.repeat(64) : people.find(p => p.id === who).credentials[0].token;
  const auth = bearer || who === 'service' ? { Authorization: 'Bearer ' + token } : { Cookie: 'session_token=fixture-' + who };
  const res = await fetch(base + path, { headers: { ...auth, ...headers } });
  const data = res.status === 304 ? null : await res.json();
  return { status: res.status, data, etag: res.headers.get('etag') };
}
const ids = response => (response.data.sessions || response.data.sessionRefs).map(s => s.id);
try {
  const own = await call('owner', '/api/sessions?view=refs');
  assert.equal(own.status, 200);
  assert.deepEqual(ids(own), ['1'.repeat(32)], 'HR browser identity must survive the list cache');
  assert.equal(own.data.archivedCount, 1);
  assert.deepEqual(ids(await call('owner', '/api/sessions/archived')), ['2'.repeat(32)]);
  assert.equal((await call('owner', '/api/sessions/' + '1'.repeat(32) + '?view=summary')).status, 200);
  assert.equal((await call('owner', '/api/sessions/' + '3'.repeat(32))).status, 403);
  assert.deepEqual(ids(await call('peer', '/api/sessions')), ['3'.repeat(32)]);
  assert.deepEqual(ids(await call('shared', '/api/sessions')), ['5'.repeat(32)], 'shared browser must retain its cutover limit');
  assert.equal((await call('shared', '/api/sessions/' + '4'.repeat(32))).status, 403);
  assert.equal(ids(await call('service', '/api/sessions')).length, 4);
  assert.equal((await call('owner', '/api/sessions?view=refs', { 'If-None-Match': own.etag })).status, 304);
  policy.version = 'v2'; policy.subjects[0].active = false;
  await writeFile(policyFile, JSON.stringify(policy));
  const revoked = await call('owner', '/api/sessions?view=refs', { 'If-None-Match': own.etag }, true);
  assert.equal(revoked.status, 200, 'policy change must not reuse a cached authorized response');
  assert.deepEqual(ids(revoked), []); assert.equal(revoked.data.archivedCount, 0);
  assert.deepEqual(ids(await call('owner', '/api/sessions/archived')), []);
  policy.version = 'v3'; policy.subjects[0].active = true;
  await writeFile(policyFile, JSON.stringify(policy));
  assert.deepEqual(ids(await call('owner', '/api/sessions')), ['1'.repeat(32)], 'restored identity must not reuse cached denial');
  assert.deepEqual(ids(await call('owner', '/api/sessions', {}, true)), ['1'.repeat(32)]);
  console.log('PASS: HR personal/shared/service lists, archive, direct links, cached refs, revocation and restoration');

  const credentialsPath = join(home, 'registry-credentials.json');
  await writeFile(credentialsPath, JSON.stringify({ apiKey: 'fixture', signingKey: 'fixture' }));
  const endpoint = 'https://fixture.invalid/policy';
  const remoteGuard = { version: 1, policyId: 'fixture-guard', hrInstance: 'hr', hrRestrictedRuntime: false,
    hrPolicyRegistry: { endpoint, credentialsPath }, allowPairs: [], rules: [{ category: 'protected', all: ['Vault', 'private'] }] };
  await writeFile(guard, JSON.stringify(remoteGuard));
  const fetchOriginal = globalThis.fetch;
  let reads = 0, unavailable = false;
  globalThis.fetch = (url, options) => {
    if (url !== endpoint) return fetchOriginal(url, options);
    assert.equal(JSON.parse(options.body).query.action, 'policy_read');
    reads++;
    return Promise.resolve(unavailable ? new Response(null, { status: 503 })
      : Response.json({ policyVersion: 1, policy }));
  };
  async function submit(id, token = 'f'.repeat(64)) {
    const res = await fetch(base + '/api/sessions/' + '1'.repeat(32) + '/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Vault private', requestId: id }),
    });
    return { status: res.status, body: await res.json() };
  }
  try {
    const { getRun } = await import('../chat/runs.mjs');
    for (const id of ['connector-admission-1', 'connector-admission-2']) {
      const before = reads;
      const result = await submit(id);
      assert.equal(result.status, 202);
      assert.equal(result.body.response.state, 'ready');
      assert.equal(await getRun(result.body.run.id), null, 'guard still refuses before creating a model Run');
      assert.equal(reads - before, 1, 'each service message loads current policy once, with no cross-request reuse');
    }
    const beforeUnauthenticated = reads;
    assert.equal((await submit('invalid', 'x'.repeat(64))).status, 401);
    assert.equal(reads, beforeUnauthenticated, 'an invalid credential cannot reach policy admission');
    assert.equal((await call('owner', '/api/sessions')).status, 200);
    assert.equal(reads - beforeUnauthenticated, 1, 'browser history/list refresh is unchanged');
    await writeFile(guard, JSON.stringify({ ...remoteGuard, hrRestrictedRuntime: true }));
    unavailable = true;
    assert.equal((await submit('restricted-registry-down')).status, 503);
    assert.equal(reads - beforeUnauthenticated, 2, 'restricted runtime still rejects at the authentication boundary');
  } finally { globalThis.fetch = fetchOriginal; }
  console.log('PASS: once per service message, no model on refusal, browser refresh, and restricted runtime failure gate');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
process.exit(0);

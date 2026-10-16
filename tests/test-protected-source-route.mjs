import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'source-read-route-'));
setIsolatedTestHome(home);
const { CONFIG_DIR } = await import('../lib/config.mjs');
const { requests } = await import('../chat/requests.mjs');
const { handleProtectedSourceRoutes } = await import('../chat/router-protected-sources.mjs');
const { digest } = await import('../lib/protected-source-read.mjs');
const record = { runId: 'run_a', requestId: 'req_a', sessionId: 'session_a', options: {
  viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a' } };
requests.byRunId = async runId => runId === 'run_a' ? record : null;
const source = join(home, 'synthetic.txt');
await writeFile(source, 'test content');
const policy = { version: 1, policyId: 'test', revision: 1,
  resources: [{ id: 'sample', path: source, size: 12, sha256: digest('test content') }],
  grants: [{ id: 'grant', resourceId: 'sample', personId: 'person_a', sessionId: 'session_a', start: 0, end: 12,
    expiresAt: new Date(Date.now() + 60000).toISOString(), purposes: ['query'], approvalRef: 'synthetic' }] };
const input = { runId: 'run_a', resourceId: 'sample', purpose: 'query', start: 0, end: 12, personId: 'forged_person' };
const call = async (body = input, authSession = { authKind: 'browser', personId: 'person_a' }) => {
  const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]); req.method = 'POST';
  let result; const headers = {};
  await handleProtectedSourceRoutes({ req, res: { setHeader: (k, v) => { headers[k] = v; } },
    pathname: '/api/protected-sources/read', authSession,
    writeJson: (_res, status, body) => { result = { status, body, headers }; } });
  return result;
};
try {
  await mkdir(CONFIG_DIR, { recursive: true });
  assert.equal((await call()).status, 503);
  await writeFile(join(CONFIG_DIR, 'protected-sources.json'), JSON.stringify(policy));
  const result = await call();
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(Buffer.from(result.body.content, 'base64').toString(), 'test content');
  assert.equal((await call(input, { authKind: 'browser', personId: 'person_b' })).status, 403);
  assert.equal((await call({ ...input, runId: 'unknown' })).status, 403);
  assert.equal((await call('{')).status, 400);
  assert.equal((await call(input, { authKind: 'service' })).status, 200);
  record.result = { state: 'completed' };
  assert.equal((await call()).status, 403);
  const logs = await Promise.all((await readdir(join(CONFIG_DIR, 'protected-source-audit'))).map(async name =>
    JSON.parse(JSON.parse(await readFile(join(CONFIG_DIR, 'protected-source-audit', name), 'utf8')).eventJson)));
  assert.ok(logs.some(e => e.caller?.attribution === 'service_referencing_accepted_request'));
  assert.ok(logs.some(e => e.authenticatedCaller?.personId === 'person_b' && e.phase === 'denied'));
  assert.ok(!JSON.stringify(logs).includes('forged_person'));
  assert.ok(!JSON.stringify(logs).includes('test content'));
  console.log('PASS: route policy loading, accepted request identity, forged identity rejection, service attribution, no-store, malformed and denied auditing');
} finally { await rm(home, { recursive: true, force: true }); }

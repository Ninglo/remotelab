import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAuditWriter, readProtectedSource, digest } from '../lib/protected-source-read.mjs';
import { checkHrSourceCaller } from '../lib/hr-access-authorization.mjs';

const root = await mkdtemp(join(tmpdir(), 'protected-read-'));
const sourcePath = join(root, 'synthetic.txt');
const content = Buffer.from('Synthetic PRIVATE transcript. Never a real user transcript.');
await writeFile(sourcePath, content);
const directory = join(root, 'audit');
const audit = createLocalAuditWriter(directory);
const caller = { personId: 'person_a', identityId: 'identity_a', sessionId: 'session_a', requestId: 'request_a', runId: 'run_a' };
const policy = { version: 1, policyId: 'pilot', revision: 1,
  resources: [{ id: 'sample', path: sourcePath, size: content.length, sha256: digest(content) }],
  grants: [{ id: 'grant_a', resourceId: 'sample', personId: 'person_a', sessionId: 'session_a', start: 0, end: content.length,
    expiresAt: new Date(Date.now() + 60000).toISOString(), purposes: ['query'], approvalRef: 'synthetic-test-only' }] };
const input = { resourceId: 'sample', purpose: 'query', start: 0, end: 9 };
const read = (changes = {}) => readProtectedSource({ policy, caller, input, audit, ...changes });
const events = async () => Promise.all((await readdir(directory)).map(async name => JSON.parse(JSON.parse(await readFile(join(directory, name), 'utf8')).eventJson)));
try {
  const result = await read();
  assert.equal(Buffer.from(result.content, 'base64').toString(), 'Synthetic');
  assert.equal(result.receipt.stored, true);
  let log = await events();
  assert.deepEqual(log.filter(e => e.readId === result.readId).map(e => e.phase).sort(), ['authorized_attempt', 'release_ready']);
  assert.ok(!JSON.stringify(log).includes('PRIVATE transcript'));
  assert.ok(!JSON.stringify(log).includes(sourcePath));
  // All reads including duplicates and concurrent calls get independent traces.
  const concurrent = await Promise.all([read(), read(), read()]);
  assert.equal(new Set(concurrent.map(r => r.readId)).size, 3);
  await assert.rejects(read({ caller: { ...caller, personId: 'person_b' } }), /read_not_granted/);
  await assert.rejects(read({ caller: { ...caller, sessionId: 'session_b' } }), /read_not_granted/);
  await assert.rejects(read({ input: { ...input, purpose: 'export' } }), /read_not_granted/);
  await assert.rejects(read({ input: { ...input, start: -1 } }), /invalid_read_range/);
  await assert.rejects(read({ input: { ...input, resourceId: '../../etc/passwd' } }), /invalid_read_range/);
  await assert.rejects(read({ caller: null }), /request_identity_required/);
  const expired = structuredClone(policy); expired.grants[0].expiresAt = '2000-01-01T00:00:00Z';
  await assert.rejects(read({ policy: expired }), /read_not_granted/);
  log = await events(); assert.equal(log.filter(e => e.phase === 'denied').length, 7);
  const hrPolicy = structuredClone(policy);
  hrPolicy.resources[0].classification = 'hr-confidential';
  hrPolicy.grants[0].identityId = caller.identityId;
  const guardPath = join(root, 'guard.json');
  await writeFile(guardPath, JSON.stringify({ version: 2, policyId: 'synthetic-hr',
    allowPairs: [[caller.personId, caller.identityId]], allowFeishu: [{ route: 'fixture', tenant: 'tenant', openId: 'ou_hr' }] }));
  const authorizeHr = value => checkHrSourceCaller(value, guardPath);
  const hrRead = changes => read({ policy: hrPolicy, authorizeHr, reloadPolicy: async () => hrPolicy, ...changes });
  assert.ok((await hrRead()).content);
  const forbidden = structuredClone(hrPolicy);
  forbidden.resources[0].path = join(root, 'never-opened.txt');
  forbidden.grants[0].identityId = 'shared-admin';
  await assert.rejects(hrRead({ policy: forbidden, caller: { ...caller, identityId: 'shared-admin' } }), /hr_identity_not_authorized/);
  const deniedRead = (await events()).filter(e => e.reason === 'hr_identity_not_authorized').at(-1).readId;
  assert.ok(!(await events()).some(e => e.readId === deniedRead && e.phase === 'authorized_attempt'), 'denied before opening the source');
  const feishuCaller = { ...caller, feishuConnectorAuthenticated: true, sourceContext: {
    connector: 'feishu', sourceRouteId: 'fixture', tenantKey: 'tenant', chatType: 'p2p', sender: { senderType: 'user', openId: 'ou_hr' } } };
  assert.equal(await authorizeHr(feishuCaller), true);
  assert.equal(await authorizeHr({ ...feishuCaller, sourceContext: { ...feishuCaller.sourceContext, tenantKey: 'forged' } }), false);
  assert.equal(await authorizeHr({ ...feishuCaller, sourceContext: { ...feishuCaller.sourceContext, chatType: 'group' } }), false);
  let revoked = false;
  await assert.rejects(hrRead({ reloadPolicy: async () => revoked ? { ...hrPolicy, grants: [] } : hrPolicy,
    audit: async event => { const receipt = await audit(event); if (event.phase === 'release_ready') revoked = true; return receipt; },
  }), /authorization_revoked/, 'revocation during output audit returns no bytes');
  let identityRevoked = false;
  await assert.rejects(hrRead({ authorizeHr: async () => !identityRevoked,
    audit: async event => { const receipt = await audit(event); if (event.phase === 'authorized_attempt') identityRevoked = true; return receipt; },
  }), /hr_identity_not_authorized/, 'HR eligibility is checked again after source I/O');
  await writeFile(sourcePath, Buffer.alloc(content.length, 65));
  await assert.rejects(read(), /source_unavailable_or_changed/);
  await writeFile(sourcePath, content);
  const linked = structuredClone(policy); linked.resources[0].path = join(root, 'link');
  await symlink(sourcePath, linked.resources[0].path);
  await assert.rejects(read({ policy: linked }), /source_unavailable_or_changed/);
  let attempts = 0;
  await assert.rejects(read({ audit: async e => {
    attempts++; if (e.phase === 'release_ready') throw new Error('audit_unavailable');
    return audit(e);
  } }), /audit_unavailable/);
  assert.equal(attempts, 2);
  // Duplicate delivery is idempotent; a conflicting event cannot overwrite.
  const packet = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8'));
  const event = JSON.parse(packet.eventJson);
  assert.equal((await audit(event)).stored, true);
  await assert.rejects(audit({ ...event, phase: 'changed' }), /audit_unavailable/);
  // Persistence failure returns no success receipt.
  await rm(directory, { recursive: true });
  await writeFile(directory, 'not a directory');
  await assert.rejects(read(), /audit_unavailable/);
  console.log('PASS: authorized/denied reads, ranges, expiry, immutable sources, concurrent records, durable receipts, collision rejection, disk fail-closed');
} finally {
  await rm(root, { recursive: true, force: true });
}

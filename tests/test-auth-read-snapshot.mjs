import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'auth-read-snapshot-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2,
  primaryPersonId: 'a', administratorPersonIds: ['a'], serviceToken: 'synthetic-test-service',
  people: [{ id: 'a', name: 'Before', credentials: [], identities: [] }],
}));
try {
  const { loadAuthDocument, getCachedAuthDocument, getAuthReadSnapshot, updateAuthDocument } = await import('../lib/auth-config.mjs');
  await loadAuthDocument();
  const before = getAuthReadSnapshot();
  for (let i = 0; i < 10_000; i++) assert.equal(getAuthReadSnapshot(), before);
  assert.throws(() => { before.people[0].name = 'tampered'; }, TypeError);
  assert.throws(() => { before.administratorPersonIds.push('intruder'); }, TypeError);
  const detached = getCachedAuthDocument();
  detached.people[0].name = 'caller-owned copy';
  assert.equal(getAuthReadSnapshot().people[0].name, 'Before');
  await updateAuthDocument(draft => { draft.people[0].name = 'After'; });
  const after = getAuthReadSnapshot();
  assert.notEqual(after, before);
  assert.equal(after.people[0].name, 'After');
  assert.equal(before.people[0].name, 'Before');
  assert(Object.isFrozen(after.people[0].preferences));
  const { resolveOrCreateExternalIdentity } = await import('../lib/auth-config.mjs');
  const input = { kind: 'feishu', realm: 'fixture', subjectId: 'ou_example', displayName: 'Sender' };
  const created = await resolveOrCreateExternalIdentity(input);
  const authFile = join(config, 'auth.json');
  const persisted = await readFile(authFile, 'utf8');
  let releaseWriter, writerEntered;
  const entered = new Promise(resolve => { writerEntered = resolve; });
  const held = new Promise(resolve => { releaseWriter = resolve; });
  const writer = updateAuthDocument(async () => { writerEntered(); await held; });
  await entered;
  try {
    assert.deepEqual(await Promise.race([resolveOrCreateExternalIdentity(input),
      new Promise((_, reject) => setTimeout(() => reject(new Error('known identity blocked behind unrelated writer')), 1000).unref())]), created);
    assert.equal(await readFile(authFile, 'utf8'), persisted, 'stable connector identity needs no write');
  } finally { releaseWriter(); await writer; }
  assert.deepEqual(await resolveOrCreateExternalIdentity({ ...input, displayName: 'Renamed' }), created);
  assert.equal(JSON.parse(await readFile(authFile, 'utf8')).people.find(p => p.id === created.personId).name, 'Renamed');
  console.log('PASS immutable auth snapshot, unchanged identity independent of writer, and durable real updates');
} finally { await rm(home, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  console.log('PASS immutable auth snapshot, detached copy and immediate committed update');
} finally { await rm(home, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-admin-bootstrap-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument, loadAuthDocument } = await import('../lib/auth-config.mjs');
  const before = await loadAuthDocument();
  const id = before.primaryPersonId;
  await updateAuthDocument(doc => doc.people[0].credentials.push({ id: 'first', type: 'token', token: 'a'.repeat(64) }));
  assert.equal((await loadAuthDocument()).people[0].credentials.length, 1, 'Fresh setup can set its first credential');
  await assert.rejects(updateAuthDocument(doc => { doc.people[0].credentials[0].token = 'b'.repeat(64); }), { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED' });
  await assert.rejects(updateAuthDocument(doc => { doc.people[0].credentials = []; }), { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED' });
  await assert.rejects(updateAuthDocument(doc => { doc.people[0].identities[0].id = 'replacement'; }), { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED' });
  await assert.rejects(updateAuthDocument(doc => { doc.administratorPersonIds = []; }), { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED' });
  assert.deepEqual((await loadAuthDocument()).administratorPersonIds, [id]);
  console.log('First credential bootstrap and subsequent administrator protection: passed');
} finally {
  await rm(home, { recursive: true, force: true });
}

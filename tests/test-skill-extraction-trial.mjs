import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'skill-trial-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { buildSkillExtractionTrial: build } = await import('../chat/skill-extraction-trial.mjs');
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  const { CONFIG_DIR } = await import('../lib/config.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['alice', 'bob'].map(name => ({ id: `person_${name}`, name, credentials: [],
      identities: [{ id: `web_${name}`, kind: 'web', realm: 'fixture', subjectId: name }] }));
    doc.primaryPersonId = 'person_alice';
  });
  const alice = { personId: 'person_alice', identityId: 'web_alice' };
  const file = join(CONFIG_DIR, 'skill-extraction-trial.json');
  assert.equal(await build(alice), '');
  const policy = { version: 1, revision: 1, personId: alice.personId, enabled: true };
  await writeFile(file, JSON.stringify(policy));
  const on = await build(alice);
  assert.match(on, /ON only/);
  assert.ok(on.length < 1100, 'ordinary input carries a short pointer, not the procedure');
  assert.equal(await build({ personId: 'person_bob', identityId: 'web_bob' }), '');
  assert.equal(await build({ ...alice, identityId: 'web_bob' }), '');
  assert.equal(await build({ ...alice, automated: true }), '');
  assert.equal(await build({ ...alice, sourceContext: { sender: { senderType: 'bot' } } }), '');
  const split = await buildTurnContextHook({}, { ...alice, separateProjectContext: true });
  assert.equal(split.skillExtraction, on);
  assert.ok(!split.text.includes(on), 'pointer is not injected twice');
  const foreign = await buildTurnContextHook({}, { personId: 'person_bob', identityId: 'web_bob', separateProjectContext: true });
  assert.equal(foreign.skillExtraction, '');
  assert.equal((await buildTurnContextHook({}, { ...alice, separateProjectContext: true,
    experimentInput: { automated: true } })).skillExtraction, '');
  await writeFile(file, JSON.stringify({ ...policy, revision: 2, enabled: false }));
  assert.match(await build(alice), /OFF/);
  await writeFile(file, '{bad');
  assert.equal(await build(alice), '');
  await writeFile(file, JSON.stringify({ ...policy, revision: 0 }));
  assert.equal(await build(alice), '');
  console.log('PASS: scoped opt-in, identity isolation, automated exclusion, pointer-only assembly, disable and invalid policy');
} finally { await rm(home, { recursive: true, force: true }); }

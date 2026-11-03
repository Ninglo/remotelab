import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'identity-dedup-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument, loadAuthDocument, resolveOrCreateExternalIdentity, findIdentity } = await import('../lib/auth-config.mjs');
  const subject = { kind: 'feishu', realm: 'bot', subjectId: 'ou_legacy' };
  await updateAuthDocument(doc => {
    doc.people = [{ id: 'legacy-person', name: 'Legacy', preferences: { retained: true }, credentials: [],
      identities: [{ ...subject, id: 'original-uuid' }] }];
    doc.primaryPersonId = 'legacy-person';
  });
  for (let i = 0; i < 3; i++) {
    const resolved = await resolveOrCreateExternalIdentity({ ...subject, displayName: 'Legacy' });
    assert.equal(resolved.identityId, 'original-uuid', 'resolve by provider identity, not the ID generation algorithm');
  }
  await updateAuthDocument(doc => doc.people[0].identities.push({ ...subject, id: 'duplicate-derived-id' }));
  const doc = await loadAuthDocument();
  assert.equal(doc.people[0].identities.length, 1);
  assert.deepEqual(doc.people[0].preferences.retained, true);
  assert.equal(findIdentity(doc, 'duplicate-derived-id').identity.id, 'original-uuid', 'historical actors retain their owner');
  assert.equal((await resolveOrCreateExternalIdentity(subject)).identityId, 'original-uuid');

  const { createPersonalSettingsController } = await import('../connectors/feishu/personal-settings-card.mjs');
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  let creates = 0, patches = 0;
  const runtime = { config: { sourceRouteId: 'bot', storageDir: home, personalSettings: { enabled: true } },
    appClient: { im: { v1: { message: {
      create: async () => ({ code: 0, data: { message_id: `om_${++creates}` } }),
      patch: async () => { patches++; return { code: 0 }; },
    } } } } };
  const controller = createPersonalSettingsController(runtime, { authorize: async () => true });
  const source = { chatType: 'p2p', chatId: 'private', tenantKey: 'tenant', sender: { openId: subject.subjectId } };
  const record = await controller.publish(source, { automatic: true });
  assert.equal(record.identityId, 'original-uuid');
  await createRecordStore(join(home, 'personal-settings')).mutate(record.key, r => ({ ...r, identityId: 'duplicate-derived-id' }));
  await controller.publish(source);
  assert.equal(patches, 1, 'a card bound to a retained alias remains usable by its original Person');
  await controller.publish(source, { automatic: true });
  assert.equal(creates, 1, 'repeated entry does not send another welcome card');

  await updateAuthDocument(d => d.people.push({ id: 'different-person', name: 'Different', credentials: [],
    identities: [{ ...subject, id: 'conflicting-owner' }] }));
  await assert.rejects(resolveOrCreateExternalIdentity(subject), /multiple people/, 'different owners are never merged by this repair');
  await assert.rejects(controller.publish(source), /身份/, 'ambiguous ownership remains blocked');
  console.log('External identity reuse, alias retention, settings recovery and ownership isolation: passed');
} finally {
  await rm(home, { recursive: true, force: true });
}

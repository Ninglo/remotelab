import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'personal-card-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { MEMORY_DIR } = await import('../lib/config.mjs');
  const { createPersonalSettingsController } = await import('../connectors/feishu/personal-settings-card.mjs');
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { loadPersonalMemorySettings } = await import('../chat/personal-memory-settings.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['one', 'two'].map(id => ({ id, name: id, credentials: [], identities: [{ id: `id_${id}`, kind: 'feishu', realm: 'bot', subjectId: `ou_${id}` }] }));
    doc.primaryPersonId = 'one';
  });
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(join(MEMORY_DIR, 'learning-policy.json'), JSON.stringify({ version: 1, enabled: true, profiles: true, personIds: ['one'] }));
  const actor = { personId: 'one', identityId: 'id_one', authKind: 'test' };
  let creates = 0, patches = 0, clock = 1_000_000, sent, fail = false;
  const runtime = { config: { sourceRouteId: 'bot', storageDir: home, personalSettings: { openIds: ['ou_one', 'ou_two'], webUrl: 'https://example.test' } }, appClient: { im: { v1: { message: {
    create: async p => { creates++; sent = JSON.parse(p.data.content); if (fail) throw Error('transport lost'); return { code: 0, data: { message_id: `om_${creates}` } }; },
    patch: async p => { patches++; sent = JSON.parse(p.data.content); return { code: 0 }; },
  } } } } };
  const opts = { authorize: async s => s.tenantKey === 'tenant', now: () => clock };
  let controller = createPersonalSettingsController(runtime, opts);
  const source = { chatId: 'chat', chatType: 'p2p', tenantKey: 'tenant', sender: { openId: 'ou_one' } };
  let record = await controller.publish(source, { automatic: true });
  assert.equal(creates, 1);
  assert.match(JSON.stringify(sent), /来和你一起把事情往前推/);
  assert.match(JSON.stringify(sent), /网页设置（备用）/);
  controller = createPersonalSettingsController(runtime, opts);
  await controller.publish(source, { automatic: true }); assert.equal(creates, 1, 'restart does not spam welcome');
  const event = (field, value, revision, extra = {}) => ({ header: { event_id: extra.eventId || 'event1' }, event: {
    operator: { open_id: extra.openId || 'ou_one', tenant_key: extra.tenant || 'tenant' },
    context: { open_chat_id: 'chat', open_message_id: extra.messageId || record.messageId },
    action: { value: { namespace: 'personal-settings', key: record.key, field, value, revision } },
  } });
  assert.equal((await controller.action(event('opening', false, 0, { openId: 'ou_two' }))).toast.type, 'error');
  assert.equal((await controller.action(event('opening', false, 0, { tenant: 'other' }))).toast.type, 'error');
  assert.equal((await loadPersonMessageReplies(actor)).revision, 0);
  let feedback = await controller.action(event('opening', false, 0));
  assert.equal(feedback.toast.type, 'success'); assert.equal(feedback.card.type, 'raw');
  assert.equal((await loadPersonMessageReplies(actor)).choices.opening, false);
  await changePersonMessageReplies({ action: 'apply', confirm: true, expectedRevision: 1, choices: { ...(await loadPersonMessageReplies(actor)).choices, opening: true } }, actor);
  await controller.action(event('opening', false, 0));
  assert.equal((await loadPersonMessageReplies(actor)).choices.opening, true, 'replayed event cannot undo newer choice');
  feedback = await controller.action(event('progress', 'none', 1, { eventId: 'stale' }));
  assert.equal(feedback.toast.type, 'error'); assert.ok(feedback.card, 'stale settings refresh in place');
  assert.equal((await controller.action(event('memory', true, 0, { eventId: 'memory' }))).toast.type, 'success');
  assert.equal((await loadPersonalMemorySettings(actor)).conversational, true);
  await controller.action(event('memory', false, 0, { eventId: 'old-memory' }));
  assert.equal((await loadPersonalMemorySettings(actor)).enabled, true, 'memory revision blocks stale switch');
  await controller.publish(source); assert.equal(patches, 1);
  clock += 14 * 86400000;
  record = await controller.publish(source); assert.equal(creates, 2, 'explicit command renews old card');
  assert.equal((await controller.action(event('opening', false, 2, { messageId: 'om_1' }))).toast.type, 'error');
  assert.equal(await controller.publish({ ...source, chatType: 'group' }), null);
  fail = true;
  const other = { ...source, chatId: 'otherchat', sender: { openId: 'ou_two' } };
  await assert.rejects(controller.publish(other), /transport lost/);
  controller = createPersonalSettingsController(runtime, opts);
  await assert.rejects(controller.publish(other), /仍待核对/);
  assert.equal(creates, 3, 'unknown transport failure never duplicates the welcome');
  await controller.idle();
  console.log('Personal cards: identity isolation, saved settings, replay/stale revisions, memory eligibility, restart and delivery fences passed');
} finally { await rm(home, { recursive: true, force: true }); }

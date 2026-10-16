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
  const { createRecordStore } = await import('../lib/durable-records.mjs');
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
  assert.match(JSON.stringify(sent), /你的 AI 同事/);
  assert.match(JSON.stringify(sent), /网页版备用入口（需另行登录）/);
  const settingsRegion = sent.body.elements.find(e => e.element_id === 'personal_settings_region');
  assert.equal(sent.body.elements.length, 3, 'first screen contains introduction, settings overview and collapsed help');
  assert.equal(settingsRegion.expanded, true);
  const rows = settingsRegion.elements.filter(e => e.tag === 'column_set');
  assert.equal(rows.length, 3);
  const tiles = rows.flatMap(row => row.columns);
  assert.ok(tiles.every(tile => tile.elements.some(e => e.tag === 'markdown' && e.text_size === 'notation' && e.content.length > 30)), 'every control keeps its explanation beside it');
  const controls = tiles.flatMap(tile => tile.elements).filter(e => e.tag === 'select_static');
  assert.equal(controls.length, 6);
  assert.ok(controls.every(c => c.options.some(o => o.value === c.initial_option)), 'all controls display their saved value');
  assert.equal(controls.reduce((n,c) => n + c.options.length, 0), 14);
  controller = createPersonalSettingsController(runtime, opts);
  await controller.publish(source, { automatic: true }); assert.equal(creates, 1, 'restart does not spam welcome');
  const guide = { version: 1, intro: '评测能力试用', sections: [{ title: '查询示例评测', body: '案例属于另一位同事，不改变本人身份。' }] };
  await createRecordStore(join(home, 'personal-settings')).mutate(record.key, r => ({ ...r, capabilityGuide: guide }));
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
  assert.equal(feedback.card.data.body.elements[0].content, guide.intro, 'guide survives a real settings callback');
  assert.equal(feedback.card.data.body.elements.find(e => e.element_id === 'personal_settings_region').expanded, true);
  assert.equal(feedback.card.data.body.elements.find(e => e.element_id === 'personal_settings_region').elements.filter(e => e.tag === 'column_set').length, 3, 'guide retains every settings row');
  assert.equal((await loadPersonMessageReplies({ personId: 'two', identityId: 'id_two', authKind: 'test' })).revision, 0, 'example guide never changes another person');
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
  fail = false;
  const beforeRenew = await loadPersonMessageReplies(actor);
  const previousMessageId = record.messageId;
  record = await controller.publish(source, { renew: true });
  assert.equal(creates, 4, 'explicit renewal sends the integrated card');
  assert.deepEqual(await loadPersonMessageReplies(actor), beforeRenew, 'renewal preserves the current owner settings');
  const panels = sent.body.elements.filter(e => e.tag === 'collapsible_panel');
  assert.ok(panels.every(e => e.element_id));
  assert.equal(panels.find(e => e.element_id === 'personal_help_region').expanded, false);
  assert.equal(new Set(panels.map(e => e.element_id)).size, panels.length);
  assert.equal((await controller.action(event('refresh', null, 2, { messageId: previousMessageId, eventId: 'old-card' }))).toast.type, 'error');
  const refreshed = await controller.action(event('refresh', null, 2, { eventId: 'new-card' }));
  assert.equal(refreshed.toast.type, 'success');
  assert.equal(refreshed.card.data.body.elements[0].content, guide.intro);
  assert.deepEqual(refreshed.card.data.body.elements.filter(e => e.tag === 'collapsible_panel').map(e => e.element_id), panels.map(e => e.element_id));
  const selectEvent = (field, option, revision, eventId) => {
    const raw = event(field, null, revision, { eventId });
    raw.event.action.value.input = 'select'; raw.event.action.option = option;
    return raw;
  };
  const beforeSelect = await loadPersonMessageReplies(actor);
  assert.equal((await controller.action(selectEvent('progress', 'messages', beforeSelect.revision, 'select-progress'))).toast.type, 'success');
  assert.equal((await loadPersonMessageReplies(actor)).choices.progress, 'messages');
  const currentRevision = (await loadPersonMessageReplies(actor)).revision;
  assert.equal((await controller.action(selectEvent('opening', 'false', currentRevision, 'select-opening'))).toast.type, 'success');
  assert.equal((await loadPersonMessageReplies(actor)).choices.opening, false);
  const beforeInvalid = await loadPersonMessageReplies(actor);
  assert.equal((await controller.action(selectEvent('opening', 'yes', beforeInvalid.revision, 'select-invalid'))).toast.type, 'error');
  assert.deepEqual(await loadPersonMessageReplies(actor), beforeInvalid);
  const memoryRevision = (await loadPersonalMemorySettings(actor)).revision;
  assert.equal((await controller.action(selectEvent('memory', 'false', memoryRevision, 'select-memory'))).toast.type, 'success');
  assert.equal((await loadPersonalMemorySettings(actor)).enabled, false);
  await controller.idle();
  console.log('Personal cards: identity isolation, saved settings, replay/stale revisions, memory eligibility, restart and delivery fences passed');
} finally { await rm(home, { recursive: true, force: true }); }

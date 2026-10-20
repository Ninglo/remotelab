import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'memory-cards-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_DIR = join(home, 'memory');
try {
  const { updateAuthDocument, loadAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(doc => {
    doc.people = [{ id: 'person_alice', name: 'Alice', credentials: [], preferences: { personalMemory: { version: 1, revision: 1, enabled: true, conversational: true } },
      identities: [{ id: 'identity_alice', kind: 'feishu', realm: 'fixture', subjectId: 'alice' }] }];
    doc.primaryPersonId = 'person_alice';
  });
  const memoryDir = process.env.REMOTELAB_MEMORY_DIR;
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'learning-policy.json'), JSON.stringify({ version: 1, enabled: true, profiles: true, personIds: ['person_alice'], reviewCardPersonIds: ['person_alice'] }));
  const m = await import('../chat/memory-learning.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { buildMemoryReviewCard, sendMemoryReviewCard, handleMemoryReviewCardAction } = await import('../connectors/feishu/memory-review-cards.mjs');
  const { buildPersonalMemoryConversationContext } = await import('../chat/personal-memory-conversation.mjs');
  const { listSourceDeliveries } = await import('../chat/source-deliveries.mjs');
  const actor = { personId: 'person_alice', identityId: 'identity_alice', authDocument: await loadAuthDocument({ persistMigration: false }) };
  const plan = { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'chat', tenantKey: 'tenant', chatType: 'group', messageId: 'original', threadId: 'thread', replyInThread: true } };
  const { record: original } = await requests.accept({ sessionId: 'session', requestId: 'human', text: '请用熟悉的例子解释',
    deliveryPlan: plan, options: { sourceDelivery: plan, viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId, feishuConnectorAuthenticated: true } });
  const originalState = JSON.stringify(await requests.byRunId(original.runId));
  const habit = { key: 'familiar-example', kind: 'habit', content: '解释时先用熟悉的例子。', conditions: '解释陌生概念时', exceptions: '', cues: ['解释'], evidence: [{ seq: 1, quote: '请用熟悉的例子解释' }] };
  const saved = await m.applyLearningUpdates({ ...actor, updates: [habit], sources: [{ sessionId: 'session', runId: original.runId, seq: 1, type: 'user', output: '请用熟悉的例子解释' }] });
  assert.equal(saved.promotedCount, 1);
  assert.deepEqual(saved.rejected, []);
  const deliveries = (await listSourceDeliveries({ sessionId: 'session' })).filter(d => d.memoryReview);
  assert.equal(deliveries.length, 1);
  const delivery = deliveries[0];
  let created = 0, patched = 0, rendered, patchFails = false;
  const app = { reply: async () => { created++; return { code: 0, data: { message_id: 'card', thread_id: 'thread' } }; },
    patch: async args => { patched++; if (patchFails) throw Error('provider unavailable'); rendered = JSON.parse(args.data.content); return { code: 0 }; }, get: async () => ({ code: 0, data: { items: [{ message_id: 'card', chat_id: 'chat', msg_type: 'interactive' }] } }) };
  const runtime = { config: { storageDir: join(home, 'connector'), sourceRouteId: 'fixture' }, appClient: { im: { v1: { message: app } } } };
  await sendMemoryReviewCard(runtime, delivery);
  await sendMemoryReviewCard(runtime, delivery);
  assert.equal(created, 1); assert.equal(patched, 1);
  const raw = (action, version, form = {}, open_id = 'alice') => ({ header: { event_id: 'event' }, event: {
    context: { open_message_id: 'card', open_chat_id: 'chat' }, operator: { open_id, tenant_key: 'tenant' },
    action: { value: { namespace: 'memory-review', key: delivery.memoryReview.key, action, version }, form_value: form } } });
  // Run callbacks through the same SDK normalization as the live connection.
  const { EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const dispatcher = new EventDispatcher({}).register({ 'card.action.trigger': data => handleMemoryReviewCardAction(runtime, data, { authorize: async () => true }) });
  const action = data => dispatcher.invoke({ ...data, schema: '2.0', header: { ...data.header, event_type: 'card.action.trigger' } }, { needCheck: false });
  const entry = async () => (await m.inspectLearning(actor)).profile.entries[0];
  let e = await entry();
  const rejected = await action(raw('keep', e.version, {}, 'bob'));
  assert.equal(rejected.toast.type, 'error'); assert.equal(rejected.card, undefined);
  assert.equal((await entry()).status, 'observed');
  const compact = buildMemoryReviewCard(delivery.memoryReview, e);
  assert.equal(compact.body.elements.filter(x => x.tag === 'markdown').length, 1);
  assert(!JSON.stringify(compact).includes('input'), 'default view has no hidden form or scope text');
  assert(!JSON.stringify(compact).includes(e.conditions));
  const opened = await action(raw('open_edit', e.version));
  assert.equal(opened.toast.type, 'success');
  assert.deepEqual(rendered, opened.card.data, 'message API persists the same visible card as the callback');
  const formView = rendered.body.elements.find(x => x.tag === 'form');
  assert(formView.elements.some(x => x.name === 'conditions' && x.default_value === e.conditions));
  assert(formView.elements.some(x => x.name === 'save_memory' && x.form_action_type === 'submit'));
  assert(formView.elements.every(x => x.tag !== 'collapsible_panel'), 'submit is directly inside the form');
  await action(raw('cancel_edit', e.version));
  assert.equal((await entry()).version, e.version, 'editing and cancelling do not mutate memory');
  assert(!JSON.stringify(rendered).includes('input'));
  const kept = raw('keep', e.version);
  assert.equal((await action(kept)).toast.type, 'success');
  e = await entry(); assert.equal(e.status, 'confirmed');
  assert.match(rendered.header.title.content, /已保留/);
  assert.equal((await action(kept)).toast.type, 'success'); assert.equal((await entry()).version, e.version);
  assert.equal((await action(raw('edit', 1, { content: '旧表单' }))).toast.type, 'error');
  assert.equal((await action(raw('edit', e.version, { content: '先解释术语，再给例子。', conditions: '学习新领域时', exceptions: '已有背景时直接展开' }))).toast.type, 'success');
  e = await entry(); assert.equal(e.content, '先解释术语，再给例子。'); assert.equal(e.conditions, '学习新领域时');
  assert.match(rendered.header.title.content, /已保存修改/);
  assert(!JSON.stringify(rendered).includes('input'), 'save returns to compact summary');
  await sendMemoryReviewCard(runtime, delivery);
  assert.match(rendered.header.title.content, /已保存修改/, 'delivery refresh preserves saved status');
  const retry = raw('edit', e.version, { content: e.content, conditions: e.conditions, exceptions: e.exceptions });
  patchFails = true;
  const failedRefresh = await action(retry);
  assert.match(failedRefresh.toast.content, /已保存.*刷新失败/);
  const savedVersion = (await entry()).version;
  patchFails = false;
  assert.equal((await action(retry)).toast.type, 'success');
  assert.equal((await entry()).version, savedVersion, 'refresh retry must not repeat the successful save');
  e = await entry();
  assert.equal((await action(raw('discard', e.version))).toast.type, 'success');
  assert.equal((await entry()).status, 'withdrawn');
  // Simulate a crash after the memory mutation but before the callback receipt.
  const receiptPath = join(runtime.config.storageDir, 'memory-review-cards', `${delivery.memoryReview.key}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const lastEvidence = (await entry()).evidence.at(-1);
  await writeFile(receiptPath, JSON.stringify({ ...receipt, applied: null, pending: { signature: receipt.applied, seq: lastEvidence.seq } }));
  assert.equal((await action(raw('discard', e.version))).toast.type, 'success');
  assert.equal((await entry()).version, e.version + 1, 'uncertain acknowledgement must not duplicate a mutation');
  const deferred = await m.applyLearningUpdates({ ...actor, updates: [{ ...habit, key: 'deferred-example', deferReview: true }], sources: [{ sessionId: 'session', runId: original.runId, seq: 1, type: 'user', output: '请用熟悉的例子解释' }] });
  assert.equal(deferred.promotedCount, 1);
  assert.equal((await listSourceDeliveries({ sessionId: 'session' })).filter(d => d.memoryReview).length, 1, 'deferred observations do not publish');
  const deferredEntry = (await m.inspectLearning(actor)).profile.entries.find(x => x.key === 'deferred-example');
  await m.applyLearningUpdates({ ...actor, updates: [{ key: deferredEntry.key, kind: 'habit', action: 'propose', expectedVersion: deferredEntry.version, question: '以后这样解释，可以吗？', evidence: habit.evidence }], sources: [{ sessionId: 'session', runId: original.runId, seq: 1, type: 'user', output: '请用熟悉的例子解释' }] });
  assert.equal((await listSourceDeliveries({ sessionId: 'session' })).filter(d => d.memoryReview).length, 2, 'explicit later proposal publishes the deferred memory');

  assert.equal(JSON.stringify(await requests.byRunId(original.runId)), originalState, 'card interaction must not change the original request, queue input, or await an answer');
  const prompt = await buildPersonalMemoryConversationContext({ ...actor, sourceContext: { connector: 'feishu' } });
  assert.match(prompt, /Review mode: existing independent memory outbox/); assert.doesNotMatch(prompt, /no separate private message, card/);
  await updateAuthDocument(doc => { doc.people[0].preferences.personalMemory.enabled = false; });
  assert.equal((await action(raw('keep', (await entry()).version))).toast.type, 'error', 'pause applies to old cards too');
  assert.equal((await sendMemoryReviewCard(runtime, delivery)).skipped, true, 'pause skips pending delivery without a new attention message');
  console.log('memory cards: independent outbox, readback, owner, keep/edit/discard, stale version and retries passed');
} finally { await rm(home, { recursive: true, force: true }); }

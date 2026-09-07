import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestStore } from '../chat/requests.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-requests-'));
try {
  let store = createRequestStore(root);
  const input = { sessionId: 'session_a', requestId: 'message_a', text: 'hello', options: {} };
  const first = await store.accept(input);
  assert.equal(first.duplicate, false);
  assert.equal((await store.accept(input)).record.key, first.record.key);
  await assert.rejects(store.accept({ ...input, text: 'different' }), /different content/);
  const second = await store.accept({ ...input, requestId: 'message_b' });
  assert.ok(second.record.sequence > first.record.sequence);

  // Simulate a new control plane: accepted requests must be discoverable without sessions/run history.
  store = createRequestStore(root);
  assert.deepEqual((await store.active()).map(x => x.requestId), ['message_a', 'message_b']);
  await store.settle(first.record.key, { state: 'completed', payload: { text: 'answer', attachments: [] } }, [{
    connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'chat_a' }, text: 'answer',
  }]);
  store = createRequestStore(root);
  const settled = await store.get(first.record.key);
  assert.equal(settled.result.payload.text, 'answer');
  assert.equal(settled.deliveries.length, 1, 'snapshot and delivery responsibility survive the same commit');
  assert.equal(settled.deliveries[0].state, 'pending');
  await store.settle(first.record.key, { state: 'completed', payload: { text: 'changed' } }, []);
  assert.equal((await store.get(first.record.key)).result.payload.text, 'answer', 'settlement is immutable');
  assert.equal((await store.byRunId(first.record.runId)).requestId, input.requestId);
  const imageOnly = await store.accept({ sessionId: 'session_a', requestId: 'image_only', text: '', images: [{ assetId: 'image-asset' }] });
  assert.equal(imageOnly.record.images[0].assetId, 'image-asset', 'attachment-only input is a valid durable request');
  console.log('durable requests: admission, conflict, ordering, restart and atomic settlement passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

const aliasesRoot = await mkdtemp(join(tmpdir(), 'remotelab-request-aliases-'));
try {
  let store = createRequestStore(aliasesRoot);
  const { record } = await store.accept({ sessionId: 'session', requestId: 'input', text: 'hello', options: { responseId: 'reply' } });
  await store.settle(record.key, { state: 'completed', payload: { text: 'done' } });
  await store.mutate(record.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: false }));
  await store.archiveFinished(record.key);
  store = createRequestStore(aliasesRoot);
  assert.equal((await store.byResponse('session', 'reply')).requestId, 'input', 'response lookup survives archive and restart');
  console.log('durable requests: response identity lookup survives archive');
} finally { await rm(aliasesRoot, { recursive: true, force: true }); }

const entryRoot = await mkdtemp(join(tmpdir(), 'remotelab-request-entry-'));
try {
  let store = createRequestStore(entryRoot);
  const entry = { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'test-chat' }, kind: 'session_entry', text: 'Open session' };
  const input = { sessionId: 'new-session', requestId: 'first', text: 'hello', initialDeliveries: [entry] };
  const [first, second] = await Promise.all([
    store.accept(input), store.accept({ ...input, requestId: 'second' }),
  ]);
  assert.equal(first.record.result, null);
  assert.equal(first.record.deliveries.length, 1, 'entry is durable before execution or a result exists');
  assert.equal(second.record.deliveries.length, 0, 'concurrent admission offers entry only once per session');
  const deliveryId = first.record.deliveries[0].id;
  await store.mutate(first.record.key, current => ({ ...current, deliveries: current.deliveries.map(d => ({ ...d, state: 'delivered', externalId: 'entry-receipt' })) }));
  store = createRequestStore(entryRoot);
  assert.equal((await store.accept(input)).duplicate, true);
  await store.settle(first.record.key, { state: 'completed', payload: { text: 'answer' } }, [{ ...entry, kind: 'content', text: 'answer' }]);
  const settled = await store.get(first.record.key);
  assert.equal(settled.deliveries.length, 2);
  assert.equal(settled.deliveries[0].id, deliveryId);
  assert.equal(settled.deliveries[0].externalId, 'entry-receipt', 'settling retains the early receipt');
  assert.notEqual(settled.deliveries[1].id, deliveryId);
  await store.mutate(first.record.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: false, deliveries: current.deliveries.map(d => ({ ...d, state: 'delivered' })) }));
  await store.archiveFinished(first.record.key);
  store = createRequestStore(entryRoot);
  assert.equal((await store.accept({ ...input, requestId: 'third' })).record.deliveries.length, 0, 'archive and restart do not reset first-session delivery');
  console.log('durable requests: early entry survives admission, concurrency, settlement, archive and restart');
} finally { await rm(entryRoot, { recursive: true, force: true }); }

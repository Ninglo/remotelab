import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-thread-continuation-'));
setIsolatedTestHome(home);
try {
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const { createRequestStore } = await import('../chat/requests.mjs');
  const { findActiveFeishuThreadExecution, rememberFeishuThreadSurface, validateFeishuThreadOrigin } = await import('../chat/feishu-thread-continuation.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const store = createRequestStore(join(home, 'requests'));
  const root = (await store.accept({ sessionId: 'main', requestId: 'root', text: 'task' })).record;
  const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: {
    tenantKey: 'tenant', chatId: 'chat', conversationKind: 'thread', threadId: 'provider-thread',
  } };
  const part = { ...conversation, kind: 'content', state: 'delivered', deliveredThreadId: 'provider-thread',
    target: { tenantKey: 'tenant', chatId: 'chat', conversationKind: 'thread', rootId: 'message-root', sourceKind: 'ambient_thread_open' } };
  await store.mutate(root.key, current => ({ ...current, deliveries: [part] }));
  let run = { id: root.runId, state: 'running' };
  const deps = { store, readRun: async () => run, readManifest: async () => ({ inputMode: 'native', options: { feishuThreadContinuationVersion: 1 } }) };
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, deps), { sessionId: 'main', continuationRunId: root.runId, threadOriginRunId: root.runId });
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, { ...deps, readManifest: async () => ({ inputMode: 'batch' }) }), { sessionId: 'main', threadOriginRunId: root.runId });
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, { ...deps, readManifest: async () => ({ inputMode: 'native' }) }), { sessionId: 'main', threadOriginRunId: root.runId }, 'pre-upgrade hosts queue a follow-up instead of steering');
  for (const [field, value] of [['chatId', 'other'], ['tenantKey', 'other'], ['threadId', 'other'], ['conversationKind', 'main']]) {
    assert.equal(await findActiveFeishuThreadExecution({ ...conversation, target: { ...conversation.target, [field]: value } }, deps), null);
  }
  assert.equal(await findActiveFeishuThreadExecution({ ...conversation, sourceRouteId: 'other-bot' }, deps), null);
  for (const state of ['cancelled', 'completed', 'failed']) {
    run = { id: root.runId, state };
    assert.deepEqual(await findActiveFeishuThreadExecution(conversation, deps), { sessionId: 'main', threadOriginRunId: root.runId });
  }
  run = { id: root.runId, state: 'running', cancelRequested: true };
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, deps), { sessionId: 'main', threadOriginRunId: root.runId });
  run = { id: root.runId, state: 'running' };
  await store.mutate(root.key, current => ({ ...current, result: { state: 'cancelled' } }));
  const other = (await store.accept({ sessionId: 'main', requestId: 'unrelated', text: 'new task' })).record;
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, deps), { sessionId: 'main', threadOriginRunId: root.runId }, 'a finished thread preserves provenance, not a later unrelated run');
  await rememberFeishuThreadSurface({ ...part, runId: root.runId });
  await store.mutate(root.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: false }));
  await store.archiveFinished(root.key);
  assert.equal(await validateFeishuThreadOrigin('main', root.runId, conversation, store), true);
  assert.equal((await findActiveFeishuThreadExecution(conversation, deps)).threadOriginRunId, root.runId, 'surface survives request archival');
  const upgradedRegistry = createRecordStore(join(home, 'upgraded-surfaces'));
  assert.equal((await findActiveFeishuThreadExecution(conversation, { ...deps, registry: upgradedRegistry })).threadOriginRunId,
    root.runId, 'pre-upgrade archived receipt is indexed on first lookup');
  const addition = { key: 'addition', options: { sourceContext: { feishuContinuationRunId: root.runId } } };
  assert.equal(canForwardNativeRequest(addition, root), true);
  assert.equal(canForwardNativeRequest(addition, other), false);
  const continued = { ...addition, options: { sourceContext: { feishuThreadOriginRunId: root.runId }, sourceDelivery: conversation } };
  assert.equal(canForwardNativeRequest(continued, other), false);
  assert.equal(canForwardNativeRequest(continued, { ...root, result: null }), true);
  const modern = { ...continued, options: { ...continued.options, sourceContext: { connector: 'feishu', feishuResponseProtocolVersion: 1 } } };
  const modernOther = { ...modern, key: 'other-topic', options: { ...modern.options,
    sourceDelivery: { ...conversation, target: { ...conversation.target, threadId: 'another-thread' } } } };
  assert.equal(canForwardNativeRequest(modern, modernOther), false, 'new protocol never merges unrelated topics');
  const steeredPart = { ...part, deliveredThreadId: 'steered-thread', target: { ...part.target, rootId: 'steered-root' } };
  const child = (await store.accept({ sessionId: 'main', requestId: 'steered-surface', text: 'supplement' })).record;
  await store.mutate(child.key, current => ({ ...current, nativeDispatchRunId: other.runId, deliveries: [steeredPart] }));
  const steeredConversation = { ...conversation, target: { ...conversation.target, threadId: 'steered-thread' } };
  assert.deepEqual(await findActiveFeishuThreadExecution(steeredConversation, { ...deps, readRun: async () => ({ state: 'running' }) }),
    { sessionId: 'main', threadOriginRunId: child.runId, continuationRunId: other.runId }, 'a surface published by a steered input resolves its actual executing Run');
  const clash = (await store.accept({ sessionId: 'other-owner', requestId: 'clash', text: 'other' })).record;
  await store.mutate(clash.key, current => ({ ...current, deliveries: [part] }));
  assert.equal(await findActiveFeishuThreadExecution(conversation, deps), null, 'conflicting delivery ownership is not guessed');
  console.log('Feishu thread continuation: exact delivered thread/run, stop, completion and unrelated-run isolation passed');
} finally { await rm(home, { recursive: true, force: true }); }

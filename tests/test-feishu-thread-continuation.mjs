import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-thread-continuation-'));
setIsolatedTestHome(home);
try {
  const { createRequestStore } = await import('../chat/requests.mjs');
  const { findActiveFeishuThreadExecution } = await import('../chat/feishu-thread-continuation.mjs');
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
  assert.deepEqual(await findActiveFeishuThreadExecution(conversation, deps), { sessionId: 'main', continuationRunId: root.runId });
  assert.equal(await findActiveFeishuThreadExecution(conversation, { ...deps, readManifest: async () => ({ inputMode: 'batch' }) }), null);
  assert.equal(await findActiveFeishuThreadExecution(conversation, { ...deps, readManifest: async () => ({ inputMode: 'native' }) }), null, 'pre-upgrade detached hosts cannot enforce continuation-only input');
  for (const [field, value] of [['chatId', 'other'], ['tenantKey', 'other'], ['threadId', 'other'], ['conversationKind', 'main']]) {
    assert.equal(await findActiveFeishuThreadExecution({ ...conversation, target: { ...conversation.target, [field]: value } }, deps), null);
  }
  assert.equal(await findActiveFeishuThreadExecution({ ...conversation, sourceRouteId: 'other-bot' }, deps), null);
  for (const state of ['cancelled', 'completed', 'failed']) {
    run = { id: root.runId, state };
    assert.equal(await findActiveFeishuThreadExecution(conversation, deps), null);
  }
  run = { id: root.runId, state: 'running', cancelRequested: true };
  assert.equal(await findActiveFeishuThreadExecution(conversation, deps), null);
  run = { id: root.runId, state: 'running' };
  await store.mutate(root.key, current => ({ ...current, result: { state: 'cancelled' } }));
  const other = (await store.accept({ sessionId: 'main', requestId: 'unrelated', text: 'new task' })).record;
  assert.equal(await findActiveFeishuThreadExecution(conversation, deps), null, 'a later run in the same Session cannot inherit the old thread');
  const addition = { key: 'addition', options: { sourceContext: { feishuContinuationRunId: root.runId } } };
  assert.equal(canForwardNativeRequest(addition, root), true);
  assert.equal(canForwardNativeRequest(addition, other), false);
  console.log('Feishu thread continuation: exact delivered thread/run, stop, completion and unrelated-run isolation passed');
} finally { await rm(home, { recursive: true, force: true }); }

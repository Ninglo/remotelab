import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestStore } from '../chat/requests.mjs';
import { createRequestRuntime } from '../chat/request-runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'request-queue-removal-'));
const store = createRequestStore(root);
let runtime;
let unblock;
try {
  const inputs = ['first', 'mistake', 'last'].map(requestId => ({ sessionId: 'session', requestId, text: requestId }));
  const records = [];
  for (const input of inputs) records.push((await store.accept(input)).record);
  const prepared = [];
  const makeRuntime = prepare => createRequestRuntime({ store, intervalMs: 60000,
    prepare, observe: () => {}, reconcile: async () => {}, onError: error => { throw error; },
  });
  runtime = makeRuntime(async record => { prepared.push(record.requestId); });
  await runtime.recover();
  assert.equal(typeof runtime.removeQueued, 'function', 'scheduler must support removing one queued request');
  await assert.rejects(runtime.removeQueued('session', 'first'), { code: 'REQUEST_NOT_QUEUED' });
  await assert.rejects(runtime.removeQueued('other-session', 'mistake'), { code: 'REQUEST_NOT_FOUND' });
  const [removed, retry] = await Promise.all([
    runtime.removeQueued('session', 'mistake'), runtime.removeQueued('session', 'mistake'),
  ]);
  assert.equal(removed.result.state, 'cancelled');
  assert.equal(retry.queueRemovedAt, removed.queueRemovedAt, 'repeated removal is idempotent');
  assert.equal(removed.postCompletionPending, false, 'removal must not schedule a completion agent');
  assert.deepEqual(removed.deliveries, [], 'removal must not publish an external reply');
  assert.deepEqual(runtime.active('session').map(r => r.requestId), ['first', 'last']);
  const duplicate = await runtime.accept(inputs[1]);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.result.state, 'cancelled', 'retried admission must never resurrect removed input');
  runtime.stop();
  await runtime.idle();
  await store.mutate(records[0].key, current => ({ ...current, releasedAt: 'done' }));
  runtime = makeRuntime(async record => { prepared.push(record.requestId); });
  await runtime.recover();
  assert.deepEqual(runtime.active('session').map(r => r.requestId), ['last']);
  assert.equal(prepared.includes('mistake'), false, 'restart must skip the removed request');
  assert.equal((await store.byRequest('session', 'mistake')).result.state, 'cancelled');
  runtime.stop();
  await runtime.idle();

  // Pause preparation while a stale browser tries to remove what is now the head.
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  runtime = makeRuntime(async () => { entered(); await blocked; });
  const recovering = runtime.recover();
  await started;
  let settled = false;
  const removal = runtime.removeQueued('session', 'last');
  const rejected = assert.rejects(removal, { code: 'REQUEST_NOT_QUEUED' }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'removal waits for in-flight scheduler preparation');
  unblock();
  await Promise.all([recovering, rejected]);
  assert.equal((await store.byRequest('session', 'last')).result, null, 'a stale click never cancels active work');
  console.log('request queue removal: durable, scoped, idempotent, FIFO, replay, restart and preparation race passed');
} finally {
  unblock?.();
  runtime?.stop();
  await runtime?.idle();
  await rm(root, { recursive: true, force: true });
}

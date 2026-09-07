import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestStore } from '../chat/requests.mjs';
import { createRequestRuntime } from '../chat/request-runtime.mjs';
const root = await mkdtemp(join(tmpdir(), 'request-runtime-'));
let runtime;
try {
  const store = createRequestStore(root);
  const { record } = await store.accept({ sessionId: 'session', requestId: 'first', text: 'first' });
  await store.settle(record.key, { state: 'completed', payload: { text: 'done' } });
  await store.mutate(record.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: true }));
  let resumed = 0;
  runtime = createRequestRuntime({ store, intervalMs: 10,
    prepare: async () => { throw new Error('completed execution must not restart'); },
    observe: () => {}, reconcile: async () => {}, onError: error => { throw error; },
    postCompletion: async current => {
      resumed++;
      await store.mutate(current.key, next => ({ ...next, postCompletionPending: false }));
      await store.archiveFinished(current.key);
    },
  });
  await runtime.recover();
  await new Promise(resolve => setTimeout(resolve, 50));
  await runtime.idle();
  assert.equal(resumed, 1, 'released execution still has durable completion responsibilities');
  assert.equal((await store.active()).length, 0);
  console.log('request runtime: restart resumes post-completion responsibilities without replaying execution');
} finally { runtime?.stop(); await rm(root, { recursive: true, force: true }); }

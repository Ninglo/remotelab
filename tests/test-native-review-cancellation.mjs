import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestStore } from '../chat/requests.mjs';
import { createNativeInputServer } from '../chat/native-input-transport.mjs';
import { createNativeRequestDispatcher } from '../chat/native-request-dispatch.mjs';

const directory = await mkdtemp(join(tmpdir(), 'native-review-cancel-'));
const store = createRequestStore(join(directory, 'requests'));
const selection = { tool: 'fake', model: 'test' };
const accept = async requestId => (await store.accept({ sessionId: 'session', requestId, text: requestId,
  options: {}, runtimeSelection: selection })).record;
const head = await accept('initial');
await store.mutate(head.key, current => ({ ...current, cancelRequestedAt: new Date().toISOString() }));
const fresh = await accept('new-task-after-stop');
let submissions = 0;
const server = await createNativeInputServer({ directory: join(directory, head.runId), isAccepting: () => true,
  submit: async input => { submissions++; return { accepted: true, id: input.id }; },
});
const errors = [];
const dispatcher = createNativeRequestDispatcher({ store,
  getRun: async () => ({ id: head.runId, state: 'running', cancelRequested: true }),
  getManifest: async () => ({ inputMode: 'native' }), runDirectory: id => join(directory, id),
  prepareInput: async record => record.text, recordInput: async () => {}, changed: async () => {},
  settle: async () => {}, onError: error => errors.push(error),
});
try {
  await dispatcher.forward(fresh, await store.get(head.key));
  await dispatcher.idle();
  assert.deepEqual(errors, []);
  assert.equal(submissions, 0, 'new input must not enter a root whose cancellation is already requested');
  assert.equal((await store.get(fresh.key)).nativeDispatchRunId || null, null, 'new task retains its independent execution after Stop');
  console.log('native cancellation: new input stays independent while the previous native run is cancelling');
} finally {
  await dispatcher.idle(); await server.close(); await rm(directory, { recursive: true, force: true });
}

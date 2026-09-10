import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequestStore } from '../chat/requests.mjs';
import { createNativeInputServer } from '../chat/native-input-transport.mjs';
import { createNativeRequestDispatcher } from '../chat/native-request-dispatch.mjs';

const root = await mkdtemp(join(tmpdir(), 'native-dispatch-test-'));
const store = createRequestStore(join(root, 'requests'));
const accepted = async id => (await store.accept({ sessionId: 'session', requestId: id, text: id, options: {}, runtimeSelection: { tool: 'fake', model: 'test' } })).record;
const head = await accepted('initial');
const second = await accepted('second');
const third = await accepted('third');
let unblock;
const blocked = new Promise(resolve => { unblock = resolve; });
const received = [];
const recorded = [];
let state = 'running';
const server = await createNativeInputServer({ directory: join(root, head.runId), isAccepting: () => true,
  submit: async input => { received.push(input.id); if (input.id === 'uncertain') throw Object.assign(new Error('lost native ack'), { code: 'NATIVE_UNCERTAIN' }); await blocked; return { accepted: true, id: input.id }; },
});
const waitFor = async predicate => { const until = Date.now() + 3000; while (!(await predicate())) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const dispatcher = createNativeRequestDispatcher({ store, getRun: async () => ({ id: head.runId, state }), getManifest: async () => ({ inputMode: 'native' }), runDirectory: id => join(root, id),
  prepareInput: async r => ({ text: r.text, context: `Context for ${r.requestId}` }),
  recordInput: async (r, manifest) => recorded.push([r.requestId, manifest.managerTurnContext]), changed: async () => {}, onError: error => { throw error; },
  settle: async r => { if (state === 'completed') { await store.settle(r.key, { state: 'completed', payload: { text: 'shared final' } }); await store.mutate(r.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: false })); } },
});
try {
  await dispatcher.forward(second, head);
  await waitFor(() => received.includes('second'));
  await dispatcher.forward(third, head);
  await waitFor(() => received.includes('third'));
  assert.deepEqual(received, ['second', 'third'], 'delayed native acknowledgements cannot block later input');
  assert.equal((await store.get(second.key)).nativeDispatchRunId, head.runId);
  state = 'completed'; unblock(); await dispatcher.idle();
  assert.equal((await store.get(third.key)).result.state, 'completed');
  assert.deepEqual(recorded.slice(0, 2), [['second', 'Context for second'], ['third', 'Context for third']]);
  const recovered = await accepted('recovered');
  const interruptedRecord = await store.mutate(recovered.key, current => ({ ...current, nativeDispatchRunId: head.runId,
    nativeInput: { id: 'recovered', text: 'recovered' }, nativeContext: 'Durable recovered context' }));
  state = 'running';
  await dispatcher.forward(interruptedRecord); await dispatcher.idle();
  assert.deepEqual(recorded.at(-1), ['recovered', 'Durable recovered context'], 'recovery records the saved input Context before handoff');
  state = 'running';
  const uncertain = await accepted('uncertain');
  await dispatcher.forward(uncertain, head); await dispatcher.idle();
  state = 'failed';
  await dispatcher.forward(await store.get(uncertain.key)); await dispatcher.idle();
  assert.match((await store.get(uncertain.key)).result.error, /acknowledgement was lost/);
  assert.equal(received.filter(id => id === 'uncertain').length, 1);
  console.log('native dispatch: overlapping input, durable run linkage, shared result, uncertain receipt without replay passed');
} finally { unblock(); await dispatcher.idle(); await server.close(); await rm(root, { force: true, recursive: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequestStore } from '../chat/requests.mjs';
import { createNativeInputServer } from '../chat/native-input-transport.mjs';
import { canForwardNativeRequest, createNativeRequestDispatcher } from '../chat/native-request-dispatch.mjs';

assert.equal(canForwardNativeRequest({ key: 'reply', options: { nativeQuestionId: 'question' } }, { key: 'head', options: { internalOperation: 'trigger_delivery' } }), true, 'explicit answers may return to a question raised during internal work');
assert.equal(canForwardNativeRequest({ key: 'reply', options: {} }, { key: 'head', options: { internalOperation: 'trigger_delivery' } }), false);
const oldFeishu = { key: 'old', options: { sourceContext: { connector: 'feishu', feishuParticipation: 'ambient' } } };
const newFeishu = { key: 'new', options: { sourceContext: { ...oldFeishu.options.sourceContext, feishuReplyPlacementVersion: 1 } } };
assert.equal(canForwardNativeRequest(newFeishu, oldFeishu), false, 'new placement protocol cannot rewrite a legacy running turn');
assert.equal(canForwardNativeRequest({ ...newFeishu, key: 'next' }, newFeishu), true);

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
let failRecording = true;
let state = 'running';
const server = await createNativeInputServer({ directory: join(root, head.runId), isAccepting: () => true,
  submit: async input => { received.push(input.id); if (input.id === 'known-ended') throw Object.assign(new Error('Original execution ended; continuation cannot start another turn'), { code: 'NATIVE_REJECTED' }); if (input.id === 'uncertain') throw Object.assign(new Error('lost native ack'), { code: 'NATIVE_UNCERTAIN' }); await blocked; return { accepted: true, id: input.id }; },
});
const waitFor = async predicate => { const until = Date.now() + 3000; while (!(await predicate())) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const makeDispatcher = () => createNativeRequestDispatcher({ store, getRun: async () => ({ id: head.runId, state }), getManifest: async () => ({ inputMode: 'native', forkBaseSeq: 42 }), runDirectory: id => join(root, id),
  prepareInput: async r => ({ text: r.text, context: `Context for ${r.requestId}` }),
  recordInput: async (r, manifest) => {
    if (r.requestId === 'recording-retry' && failRecording) { failRecording = false; throw new Error('History write interrupted'); }
    recorded.push([r.requestId, manifest.managerTurnContext]);
  }, changed: async () => {}, onError: error => { throw error; },
  settle: async r => { if (state === 'completed') { await store.settle(r.key, { state: 'completed', payload: { text: 'shared final' } }); await store.mutate(r.key, current => ({ ...current, releasedAt: 'now', postCompletionPending: false })); } },
});
const dispatcher = makeDispatcher();
try {
  await dispatcher.forward(second, head);
  await waitFor(() => received.includes('second'));
  await dispatcher.forward(third, head);
  await waitFor(() => received.includes('third'));
  assert.deepEqual(received, ['second', 'third'], 'delayed native acknowledgements cannot block later input');
  assert.equal((await store.get(second.key)).nativeDispatchRunId, head.runId);
  assert.equal((await store.get(second.key)).nativeInputBaseSeq, 42, 'recovery scans only the active execution history, retaining its original boundary after a declined handoff');
  assert.equal((await store.get(second.key)).nativeInput.supersedeQuestions, true, 'ordinary input can retire captured questions');
  state = 'completed'; unblock(); await dispatcher.idle();
  assert.equal((await store.get(third.key)).result.state, 'completed');
  assert.deepEqual(recorded.slice(0, 2), [['second', 'Context for second'], ['third', 'Context for third']]);
  const recovered = await accepted('recovered');
  const interruptedRecord = await store.mutate(recovered.key, current => ({ ...current, nativeDispatchRunId: head.runId,
    nativeInput: { id: 'recovered', text: 'recovered' }, nativeContext: 'Durable recovered context' }));
  state = 'running';
  await dispatcher.forward(interruptedRecord); await dispatcher.idle();
  assert.deepEqual(recorded.at(-1), ['recovered', 'Durable recovered context'], 'recovery records the saved input Context before handoff');
  const recordings = recorded.length;
  for (let i = 0; i < 5; i++) {
    await dispatcher.forward(await store.get(recovered.key)); await dispatcher.idle();
  }
  assert.equal(recorded.length, recordings, 'receipt polling must not rescan already recorded history');
  const restartedDispatcher = makeDispatcher();
  await restartedDispatcher.forward(await store.get(recovered.key)); await restartedDispatcher.idle();
  assert.equal(recorded.length, recordings, 'the history recording receipt survives control-plane restarts');
  const reassigned = await store.mutate(recovered.key, current => ({ ...current, nativeInputRecordedRunId: 'previous-run' }));
  await restartedDispatcher.forward(reassigned); await restartedDispatcher.idle();
  assert.equal(recorded.length, recordings + 1, 'a different dispatch must record its own context');
  const retry = await accepted('recording-retry');
  await assert.rejects(dispatcher.forward(retry, head), /History write interrupted/);
  assert.equal((await store.get(retry.key)).nativeInputRecordedRunId, undefined,
    'an interrupted history write must not publish its recording receipt');
  assert.ok(!received.includes('recording-retry'), 'input dispatch waits for durable history');
  await dispatcher.forward(await store.get(retry.key)); await dispatcher.idle();
  assert.equal(recorded.filter(([id]) => id === 'recording-retry').length, 1,
    'the next poll retries an interrupted recording');
  state = 'running';
  for (const [id, options] of [['reference', { workReference: { id: 'reference' } }],
    ['internal-message', { recordUserMessage: false }], ['explicit-answer', { nativeQuestionId: 'question-one' }]]) {
    const record = await accepted(id);
    const scoped = await store.mutate(record.key, current => ({ ...current, options }));
    await dispatcher.forward(scoped, head); await dispatcher.idle();
    assert.equal((await store.get(record.key)).nativeInput.supersedeQuestions, undefined,
      'references, internal messages and explicit answers must not retire unrelated questions');
  }
  const uncertain = await accepted('uncertain');
  await dispatcher.forward(uncertain, head); await dispatcher.idle();
  state = 'failed';
  await dispatcher.forward(await store.get(uncertain.key)); await dispatcher.idle();
  assert.match((await store.get(uncertain.key)).result.error, /acknowledgement was lost/);
  assert.equal(received.filter(id => id === 'uncertain').length, 1);
  const expired = await accepted('expired-question');
  const captured = await store.mutate(expired.key, current => ({ ...current, options: { nativeQuestionId: 'question-one' } }));
  state = 'completed';
  await dispatcher.forward(captured, head); await dispatcher.idle();
  assert.match((await store.get(expired.key)).result.error, /问题已结束/);
  assert.ok(!received.includes('expired-question'), 'a captured late answer cannot become an unrelated model turn after native host settlement');
  for (const anchored of [false, true]) {
    const record = await accepted(anchored ? 'thread-race' : 'cancelled-addition');
    const scoped = await store.mutate(record.key, current => ({ ...current,
      options: anchored ? { sourceContext: { feishuContinuationRunId: head.runId } } : {},
      nativeDispatchRunId: head.runId, nativeInput: { id: record.requestId, text: 'only a correction' },
    }));
    state = anchored ? 'completed' : 'cancelled';
    await dispatcher.forward(scoped); await dispatcher.idle();
    const after = await store.get(record.key);
    assert.equal(after.result.state, 'failed');
    assert.equal(after.nativeDispatchRunId, head.runId, 'expired/cancelled additions must never clear into a fresh run');
    assert.ok(!received.includes(record.requestId));
  }
  for (const scenario of ['complete-race', 'known-ended', 'cancelled-thread']) {
    const record = await accepted(scenario);
    const scoped = await store.mutate(record.key, current => ({ ...current,
      options: { sourceContext: { feishuThreadOriginRunId: head.runId, feishuContinuationRunId: head.runId } },
      nativeDispatchRunId: head.runId, nativeInput: { id: record.requestId, text: 'same topic supplement', continuationOnly: true },
    }));
    state = scenario === 'known-ended' ? 'running' : scenario === 'cancelled-thread' ? 'cancelled' : 'completed';
    await dispatcher.forward(scoped); await dispatcher.idle();
    const after = await store.get(record.key);
    if (scenario === 'cancelled-thread') { assert.equal(after.result.state, 'failed'); continue; }
    assert.equal(after.result, null, 'a definitely unaccepted supplement remains queued in the same Session');
    assert.equal(after.nativeDispatchRunId, null);
    assert.equal(after.sessionId, head.sessionId);
    assert.equal(after.options.sourceContext.feishuThreadOriginRunId, head.runId);
    assert.equal(canForwardNativeRequest(after, head), false, 'a declined native turn is never retried');
    assert.equal(canForwardNativeRequest(after, { ...head, runId: 'unrelated' }), false, 'unrelated work cannot absorb the queued topic');
  }
  console.log('native dispatch: overlapping input, durable run linkage, shared result, uncertain receipt without replay passed');
} finally { unblock(); await dispatcher.idle(); await server.close(); await rm(root, { force: true, recursive: true }); }

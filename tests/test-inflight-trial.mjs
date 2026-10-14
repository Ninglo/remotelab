import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'inflight-trial-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument, loadAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['alice', 'bob'].map(name => ({ id: `person_${name}`, name, credentials: [],
      preferences: { messageReplies: { preserved: name } },
      identities: [{ id: `feishu_${name}`, kind: 'feishu', realm: 'fixture', subjectId: name }] }));
    doc.primaryPersonId = 'person_alice';
  });
  const { captureInflightTrial, changeInflightTrial, loadInflightTrial, inflightTrialPrompt } = await import('../chat/inflight-trial.mjs');
  const { createRequestStore } = await import('../chat/requests.mjs');
  const { createInflightTrialTools } = await import('../chat/router-inflight-trial.mjs');
  const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
  const actor = { personId: 'person_alice', identityId: 'feishu_alice' };
  const bobActor = { personId: 'person_bob', identityId: 'feishu_bob' };
  const before = await loadAuthDocument({ persistMigration: false });
  const plan = { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'oc_fixture', chatType: 'group',
    conversationKind: 'thread', threadId: 'omt_fixture', messageId: 'om_fixture', replyInThread: true } };
  const opts = (name = 'alice') => ({ viewPersonId: `person_${name}`, initiatedByIdentityId: `feishu_${name}`,
    feishuConnectorAuthenticated: true, messageReplyPolicy: { version: 3 }, sourceDelivery: plan,
    sourceContext: { connector: 'feishu', sourceRouteId: 'fixture', chatType: 'group', chatId: 'oc_fixture',
      messageId: 'om_input', sender: { openId: name, senderType: 'user' } } });
  assert.equal(await captureInflightTrial(opts()), null);
  await changeInflightTrial({ enabled: true, confirm: true, expectedRevision: 0 }, actor);
  assert.equal((await loadInflightTrial(bobActor)).enabled, false);
  assert.deepEqual((await loadAuthDocument({ persistMigration: false })).people.map(p => p.preferences.messageReplies), before.people.map(p => p.preferences.messageReplies));
  await assert.rejects(changeInflightTrial({ enabled: true, confirm: true, expectedRevision: 0 }, actor), /已变化/);
  await assert.rejects(loadInflightTrial({ ...actor, identityId: 'feishu_bob' }), /身份/);
  for (const extra of [{ automationTitle: 'x' }, { feishuConnectorAuthenticated: false }, { recordUserMessage: false },
    { initiatedByIdentityId: 'feishu_bob' }, { sourceDelivery: { ...plan, sourceRouteId: 'another' } }]) {
    assert.equal(await captureInflightTrial({ ...opts(), ...extra }), null);
  }
  const aliceOptions = opts();
  aliceOptions.inflightTrial = await captureInflightTrial(aliceOptions);
  assert.match(inflightTrialPrompt(aliceOptions), /does not erase shared model history/);
  assert.equal(inflightTrialPrompt({ ...opts('bob'), inflightTrial: aliceOptions.inflightTrial }), '');
  const store = createRequestStore(join(home, 'requests'));
  const accept = async (id, options = aliceOptions) => (await store.accept({ sessionId: 'fixture-session', requestId: id, text: `input ${id}`, options, deliveryPlan: options.sourceDelivery })).record;
  const root = await accept('root'), a = await accept('a'), b = await accept('b'), bob = await accept('bob', opts('bob'));
  for (const r of [a,b,bob]) await store.mutate(r.key, c => ({ ...c, nativeDispatchRunId: root.runId, nativeReceipt: { accepted: true } }));
  const pending = await accept('pending');
  await store.mutate(pending.key, c => ({ ...c, nativeDispatchRunId: root.runId }));
  const events = [root,a,b,bob,pending].map(r => ({ type: 'message', role: 'user', requestId: r.requestId }));
  events.push({ runId: root.runId, questionId: 'q', questionState: 'pending', nativeQuestion: { prompt: 'unresolved requirement' } },
    { runId: root.runId, questionId: 'q', questionState: 'superseded' });
  let cancelCalls = 0, failMirror = false;
  const deps = { store, history: async () => events, append: async (_id,e) => {
    if (failMirror) { failMirror = false; throw new Error('simulated history interruption'); }
    events.push(e);
  }, cancel: async (id, opt) => { assert.equal(id, root.sessionId); assert.equal(opt.expectedRunId, root.runId); cancelCalls++; return { cancelRequested: true }; } };
  let tools = createInflightTrialTools(deps);
  const auth = { authKind: 'service' }, base = { runId: root.runId, sourceRequestId: 'a' };
  let result = await tools('inspect', base, auth);
  assert.deepEqual(result.inputs.map(r => r.requestId), ['root', 'a', 'b']);
  assert(result.inputs.every(r => !('text' in r)));
  assert.equal(result.unansweredQuestions[0].state, 'superseded');
  assert.equal(result.unansweredQuestions[0].question.prompt, 'unresolved requirement');
  assert.equal((await tools('inspect', { ...base, includeText: true }, auth)).inputs[1].text, 'input a');
  await assert.rejects(tools('inspect', base, bobActor), /仅限/);
  await assert.rejects(tools('inspect', { ...base, sourceRequestId: 'bob' }, auth), /仅限/);
  await assert.rejects(tools('inspect', { ...base, sourceRequestId: 'pending' }, auth), /仅限/);
  const packet = { ...base, replyId: 'answer1', requestIds: ['a','b'], text: 'Two answers, once.' };
  await assert.rejects(tools('reply', { ...packet, requestIds: ['a','bob'] }, auth), /不能合并/);
  failMirror = true;
  await assert.rejects(tools('reply', packet, auth), /history interruption/);
  assert.equal((await store.get(root.key)).deliveries.length, 1);
  tools = createInflightTrialTools(deps); // simulate API restart after durable outbox, before history mirror
  result = await tools('reply', packet, auth);
  assert.equal(result.duplicate, true);
  assert.equal(events.filter(e => e.inflightTrialReplyId).length, 1);
  await Promise.all([tools('reply', packet, auth), tools('reply', packet, auth)]);
  assert.equal((await store.get(root.key)).deliveries.length, 1);
  assert.equal(events.filter(e => e.inflightTrialReplyId).length, 1);
  await assert.rejects(tools('reply', { ...packet, text: 'different' }, auth), /不同内容/);
  await publishLiveAssistantReplies(await store.get(root.key), events, { store, plan, session: { id: root.sessionId } });
  assert.equal((await store.get(root.key)).deliveries.length, 1, 'native publisher must not repeat tool output');
  await assert.rejects(tools('stop', { ...base, expectedRunId: 'another' }, auth), /不一致/);
  await tools('stop', { ...base, expectedRunId: root.runId }, auth);
  assert.equal(cancelCalls, 1);
  await store.mutate(root.key, c => ({ ...c, cancelRequestedAt: 'now' }));
  await assert.rejects(tools('reply', { ...packet, replyId: 'late' }, auth), /停止/);
  assert.equal((await tools('reply', packet, auth)).duplicate, true, 'retry may read existing receipt after cancellation');
  await tools('stop', { ...base, expectedRunId: root.runId }, auth);
  assert.equal(cancelCalls, 1, 'stop must not fall through to a newer run');
  const mainPlan = { ...plan, target: { ...plan.target, conversationKind: 'main' } };
  delete mainPlan.target.threadId; delete mainPlan.target.replyInThread;
  const mainRoot = await accept('main-root', { ...aliceOptions, sourceDelivery: mainPlan });
  const stop = await accept('thread-stop', { ...aliceOptions,
    sourceContext: { ...aliceOptions.sourceContext, feishuContinuationRunId: mainRoot.runId } });
  await store.mutate(stop.key, current => ({ ...current, nativeDispatchRunId: mainRoot.runId, nativeReceipt: { accepted: true } }));
  let threadStops = 0;
  const threadTools = createInflightTrialTools({ ...deps, cancel: async (id, opt) => {
    assert.equal(id, mainRoot.sessionId); assert.equal(opt.expectedRunId, mainRoot.runId); threadStops++;
  } });
  const threadStop = { runId: mainRoot.runId, sourceRequestId: stop.requestId, expectedRunId: mainRoot.runId };
  await assert.rejects(threadTools('stop', threadStop, auth), /仅限/, 'a claimed continuation alone is insufficient');
  await store.mutate(mainRoot.key, current => ({ ...current, deliveries: [{ ...plan, kind: 'content', state: 'delivered',
    target: { ...plan.target, sourceKind: 'ambient_thread_open' } }] }));
  await threadTools('stop', threadStop, auth);
  assert.equal(threadStops, 1, 'the same opted-in author can stop from the delivered reply Thread');
  await store.mutate(stop.key, current => ({ ...current, deliveryPlan: { ...plan, sourceRouteId: 'other-bot' } }));
  await assert.rejects(threadTools('stop', threadStop, auth), /仅限/);
  await changeInflightTrial({ enabled: false, confirm: true, expectedRevision: 1 }, actor);
  await assert.rejects(tools('reply', packet, auth), /已关闭/);
  assert.equal(await captureInflightTrial(opts()), null);
  assert.equal((await loadInflightTrial(bobActor)).enabled, false);
  console.log('PASS personal in-flight trial: identity, opt-in, scope, retained questions, idempotent outbox, native dedup, stop and off');
} finally { await rm(home, { recursive: true, force: true }); }

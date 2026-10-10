import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'native-steering-replies-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { createRequestStore } = await import('../chat/requests.mjs');
const { publishLiveRunReplies, publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { collectReplyPublicationHistory } = await import('../chat/reply-publication.mjs');
const { CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { writeJsonAtomic } = await import('../chat/fs-utils.mjs');

const plan = id => ({ connector: 'feishu', sourceRouteId: 'bot', target: {
  chatId: 'chat', chatType: 'group', conversationKind: 'thread', threadId: id,
  rootId: id, messageId: `in-${id}`, replyInThread: true,
} });
const user = (seq, record) => ({ seq, type: 'message', role: 'user', runId: record.runId,
  requestId: record.requestId, responseId: record.responseId, content: record.text });
const message = (seq, record, content, extra = {}) => ({ seq, type: 'message', role: 'assistant',
  runId: record.runId, requestId: record.requestId, responseId: record.responseId,
  providerMessageId: `message-${seq}`, phase: 'commentary', content, ...extra });

async function scenario(name, { baseline = true, policy, quiet = false } = {}) {
  const session = { id: name, workboardPilot: true, conversation: plan('root'),
    ...(baseline ? { feishuGroupMessagingBaseline: '2026-10-07' } : {}),
    ...(quiet ? { feishuProgressMode: 'card' } : {}),
    feishuProgressCards: { 2: { mode: 'expanded', revision: 4 } } };
  await writeJsonAtomic(CHAT_SESSIONS_FILE, [session]);
  const store = createRequestStore(join(home, name));
  const accept = async (id, target = id, options = {}) => (await store.accept({
    sessionId: name, requestId: id, text: `request ${id}`, options: {
      ...(policy ? { messageReplyPolicy: policy } : {}), ...options,
    }, deliveryPlan: plan(target),
  })).record;
  const root = await accept('root');
  const run = { id: root.runId, responseId: root.responseId };
  const steer = async (id, options, patch) => {
    const record = await accept(id, id, options);
    return store.mutate(record.key, current => ({ ...current, nativeDispatchRunId: run.id,
      liveReplyPublicationVersion: 1, nativeReceipt: { accepted: true, mode: 'steer' }, ...patch }));
  };
  const publish = (history, running = true) => publishLiveRunReplies(root, history,
    { store, run, plan: root.deliveryPlan, session, running });
  const parts = async () => (await store.get(root.key)).deliveries;
  return { root, session, store, accept, steer, publish, parts };
}

test('a new ordinary request publishes its useful opening once', async () => {
  const s = await scenario('ordinary');
  const history = [user(1, s.root), message(2, s.root, '我先核对来源。')];
  await Promise.all([s.publish(history), s.publish(history)]);
  assert.equal((await s.parts()).length, 1);
  assert.equal((await s.parts())[0].publicationRequestId, 'root');
  assert.equal((await s.parts())[0].target.messageId, 'in-root');
});

test('steering resets the opening after an old opening and tools, keeps its target, and survives replay', async () => {
  const s = await scenario('steering', { quiet: true });
  const history = [user(1, s.root), message(2, s.root, '旧请求开工。'),
    { seq: 3, type: 'tool_use', role: 'assistant', runId: s.root.runId }];
  await s.publish(history);
  const next = await s.steer('supplement');
  history.push(user(4, next), { seq: 5, type: 'tool_result', runId: s.root.runId },
    message(6, s.root, '已提交并读回；实际并发仍未通过，我会继续核验。'),
    message(7, s.root, '内部过程文字'), message(8, s.root, '<progress>新进展。</progress>'));
  await publishLiveAssistantReplies(s.root, collectReplyPublicationHistory(history, { id: s.root.runId }), {
    store: s.store, plan: s.root.deliveryPlan, session: s.session, fullHistory: history,
  });
  assert.equal((await s.parts()).length, 1, 'the old root-only projection reproduces the missing first reply');
  await Promise.all([s.publish(history), s.publish(history)]);
  const deliveries = await s.parts();
  assert.deepEqual(deliveries.map(part => part.surfaceKind), ['opening', 'opening']);
  assert.equal(deliveries[1].publicationRequestId, next.requestId);
  assert.equal(deliveries[1].target.messageId, 'in-supplement');
  assert.equal(deliveries[1].target.threadId, 'supplement');
  assert.equal(deliveries[1].runId, s.root.runId, 'the shared execution retains its identity');
  assert.deepEqual(s.session.feishuProgressCards, { 2: { mode: 'expanded', revision: 4 } },
    'opening delivery never changes a human disclosure choice');
  history.push(user(9, next), { ...history[5], seq: 10 });
  await s.publish(history);
  assert.equal((await s.parts()).length, 2, 'duplicate input and provider events cannot repeat the first reply');
  const reopened = structuredClone(await s.store.get(s.root.key));
  await publishLiveRunReplies(reopened, history, { store: s.store, run: { id: s.root.runId },
    plan: reopened.deliveryPlan, session: s.session });
  assert.equal((await s.parts()).length, 2);
});

test('question answers do not acquire an opener; later ordinary steering does, questions and final stay single', async () => {
  const s = await scenario('question');
  const history = [user(1, s.root), message(2, s.root, '开工。'),
    message(3, s.root, '请选择输出形式。', { messageKind: 'user_question',
      questionId: 'q', questionState: 'pending', nativeQuestion: { options: ['a', 'b'] } })];
  await s.publish(history);
  const answer = await s.steer('answer', { nativeQuestionId: 'q' });
  history.push(user(4, answer), message(5, s.root, '收到选项，继续处理。'));
  await s.publish(history);
  assert.deepEqual((await s.parts()).map(part => part.surfaceKind), ['opening', 'question']);
  const next = await s.steer('after-answer');
  history.push(user(6, next), message(7, s.root, '我会把补充要求一并核对。'));
  await s.publish(history);
  assert.equal((await s.parts()).at(-1).publicationRequestId, 'after-answer');
  history.push(message(8, s.root, '已完成。', { phase: 'final_answer' }));
  await s.publish(history);
  assert.equal((await s.parts()).some(part => part.surfaceKind === 'final'), false, 'early finals wait for stop');
  await s.publish(history, false); await s.publish(history, false);
  assert.equal((await s.parts()).filter(part => part.surfaceKind === 'final').length, 1);
  assert.equal((await s.parts()).at(-1).target.messageId, 'in-root', 'terminal routing is unchanged');
});

test('late input acknowledgement revisits projected text without inventing a second run', async () => {
  const s = await scenario('late-ack');
  const next = await s.steer('next', {}, { nativeReceipt: null });
  const history = [user(1, s.root), message(2, s.root, '开工。'), user(3, next),
    message(4, s.root, '补充要求已收到，我先检查状态。')];
  await s.publish(history);
  assert.equal((await s.parts()).length, 1, 'unacknowledged inputs cannot steal the root reply destination');
  await s.store.mutate(next.key, current => ({ ...current, nativeReceipt: { accepted: true } }));
  await s.publish(history); await s.publish(history);
  assert.equal((await s.parts()).length, 2);
  assert.equal((await s.parts())[1].target.messageId, 'in-next');
});

test('old spool output projected after a new user message retains the old route', async () => {
  const s = await scenario('delayed-spool');
  const next = await s.steer('next');
  const history = [{ ...user(1, s.root), timestamp: 100 },
    { ...user(2, next), timestamp: 300 },
    { ...message(3, s.root, '旧请求的首答，已在输入前产生。'), timestamp: 200 },
    { ...message(4, s.root, '新补充的首答。'), timestamp: 400 }];
  await s.publish(history); await s.publish(history);
  assert.deepEqual((await s.parts()).map(part => part.target.messageId), ['in-root', 'in-next']);
  assert.match((await s.parts())[0].text, /旧请求/);
  assert.match((await s.parts())[1].text, /新补充/);
});

test('an outstanding input acknowledgement cannot hide the original native question', async () => {
  const s = await scenario('pending-question');
  const next = await s.steer('next', {}, { nativeReceipt: null });
  const history = [user(1, s.root), user(2, next), message(3, s.root, '请选择范围。', {
    messageKind: 'user_question', questionId: 'q', questionState: 'pending', nativeQuestion: { options: ['a', 'b'] },
  })];
  await s.publish(history); await s.publish(history);
  assert.deepEqual((await s.parts()).map(part => part.surfaceKind), ['question']);
  assert.equal((await s.parts())[0].runId, s.root.runId);
  assert.equal((await s.parts())[0].target.messageId, 'in-root');
});

test('queued, rejected, reference and pre-upgrade inputs cannot replay or retarget historical openings', async () => {
  const s = await scenario('ineligible');
  const history = [user(1, s.root), message(2, s.root, '开工。')];
  const old = await s.steer('old', {}, { liveReplyPublicationVersion: undefined });
  const queued = await s.accept('queued');
  const ref = await s.steer('reference', { workReference: 'ref' });
  const rejected = await s.steer('rejected', {}, { nativeReceipt: { accepted: false } });
  history.push(user(3, old), message(4, s.root, '旧时漏发的文字。'), user(5, queued),
    message(6, s.root, '普通过程文字。'), user(7, ref), message(8, s.root, '参考资料。'),
    user(9, rejected), message(10, s.root, '尚未确认输入归属。'));
  await s.publish(history);
  assert.equal((await s.parts()).length, 1);
});

test('the accepted opening/progress policy still controls each request', async () => {
  for (const opening of [true, false]) for (const progress of ['card', 'messages', 'none']) {
    const policy = { version: 3, opening, progress, final: true };
    const s = await scenario(`policy-${opening}-${progress}`, { baseline: false, policy });
    const next = await s.steer('next');
    const history = [user(1, s.root), message(2, s.root, '开工。'), user(3, next),
      message(4, s.root, '补充要求首答。'), message(5, s.root, '<progress>已核对。</progress>')];
    await s.publish(history); await s.publish(history);
    assert.equal((await s.parts()).filter(part => part.surfaceKind === 'opening').length, opening ? 2 : 0);
    assert.equal((await s.parts()).filter(part => part.surfaceKind === 'progress').length, progress === 'messages' ? 1 : 0);
  }
  const s = await scenario('default-private', { baseline: false });
  const next = await s.steer('next');
  const history = [user(1, s.root), message(2, s.root, '开工。'), user(3, next), message(4, s.root, '继续。')];
  await s.publish(history); await s.publish(history);
  assert.equal((await s.parts()).length, 1, 'default routine turns still omit additional openings');
});

test('direct supplementary answers bypass card/hidden progress without changing the task or final owner', async () => {
  for (const progress of ['card_all', 'card_latest', 'card', 'none', 'messages']) {
    const policy = { version: 3, opening: false, progress, final: true };
    const s = await scenario(`direct-${progress}`, { baseline: false, policy });
    const next = await s.steer('font-correction');
    const history = [user(1, s.root), message(2, s.root, '普通开工文字'),
      user(3, next), message(4, s.root, '<reply>正文被误当成代码；已纳入修正，原任务继续。</reply>'),
      message(5, s.root, '<progress>正在验证原任务。</progress>')];
    await Promise.all([s.publish(history), s.publish(history)]);
    const replies = (await s.parts()).filter(part => part.surfaceKind === 'reply');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, '【回复】\n\n正文被误当成代码；已纳入修正，原任务继续。');
    assert.equal(replies[0].publicationRequestId, next.requestId);
    assert.equal(replies[0].target.messageId, 'in-font-correction');
    assert.equal(replies[0].target.threadId, 'font-correction');
    assert.equal(replies[0].runId, s.root.runId);
    assert.equal((await s.parts()).filter(part => part.surfaceKind === 'progress').length, progress === 'messages' ? 1 : 0);
    assert.equal((await s.store.get(s.root.key)).result, null, 'answering the supplement does not finish the task');
    assert.deepEqual(s.session.feishuProgressCards, { 2: { mode: 'expanded', revision: 4 } });
    const reopened = structuredClone(await s.store.get(s.root.key));
    await publishLiveRunReplies(reopened, history, { store: s.store, run: { id: s.root.runId },
      plan: reopened.deliveryPlan, session: s.session });
    assert.equal((await s.parts()).filter(part => part.surfaceKind === 'reply').length, 1);
    history.push(message(6, s.root, '原任务已验证完成。', { phase: 'final_answer' }));
    await s.publish(history);
    assert.equal((await s.parts()).some(part => part.surfaceKind === 'final'), false);
    await s.publish(history, false); await s.publish(history, false);
    assert.equal((await s.parts()).filter(part => part.surfaceKind === 'final').length, 1);
    assert.equal((await s.parts()).at(-1).target.messageId, 'in-root');
  }
});

test('direct replies retain native input acknowledgement and stop-recovery boundaries', async () => {
  const s = await scenario('direct-ack', { policy: { version: 3, opening: false, progress: 'card_all' } });
  const next = await s.steer('next', {}, { nativeReceipt: { accepted: false } });
  const history = [user(1, s.root), user(2, next),
    message(3, s.root, '<reply>补充问题的独立答复。</reply>')];
  await s.publish(history);
  assert.deepEqual(await s.parts(), [], 'unacknowledged native inputs cannot acquire a reply');
  await s.store.mutate(next.key, current => ({ ...current, nativeReceipt: { accepted: true } }));
  await s.publish(history, false);
  assert.deepEqual(await s.parts(), [], 'stopped recovery does not announce historical replies');
  await s.publish(history); await s.publish(history);
  assert.equal((await s.parts()).length, 1);
  assert.equal((await s.parts())[0].publicationRequestId, next.requestId);
});

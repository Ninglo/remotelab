import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectProgressStreams } from '../lib/progress-stream.mjs';
import { projectWorkboards } from '../lib/workboard-state.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { collectFeishuInstanceWorkboardCycles, expandFeishuWorkboardUpdates,
  publishFeishuWorkboardCycle } from '../connectors/feishu/workboard-pilot.mjs';
import { publishLiveAssistantReplies } from '../chat/native-final-publication.mjs';
import { createRequestStore } from '../chat/requests.mjs';

const session = { id: 'session', workboardPilot: true, conversation: { connector: 'feishu', sourceRouteId: 'bot',
  target: { chatType: 'group', chatId: 'group', conversationKind: 'thread' } } };
const inbound = (seq = 1, runId = 'run', sender = 'person') => ({ seq, type: 'message', role: 'user', runId,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatType: 'group', chatId: 'group',
    messageId: `in-${seq}`, sender: { openId: sender } },
  workboardAdmission: { personId: sender, identityId: `id-${sender}`, sourceRouteId: 'bot', senderOpenId: sender } });
const msg = (seq, content, extra = {}) => ({ seq, timestamp: 1000 + seq, type: 'message', role: 'assistant',
  runId: 'run', phase: 'commentary', providerMessageId: `message-${seq}`, content, ...extra });
const progress = (seq, text, extra) => msg(seq, `<progress>${text}</progress>`, extra);
const history = [inbound(), msg(2, '核对分组与显示'), progress(3, '分组规则已核对'),
  msg(4, '内部执行说明'), msg(5, '需要用户补充信息', { messageKind: 'user_question' }),
  progress(6, '已定位显示问题'), msg(7, '结果', { phase: 'final_answer' }),
  { seq: 8, type: 'status', runId: 'run', content: 'completed' }];
const pilot = () => ({ scope: 'instance', sourceRouteId: 'bot', chatId: 'group', progressStartedAt: 1000,
  protocolAfterSeq: 0, startedAfterSeq: 0, cards: [] });

test('unlisted work keeps one progress position, history, opening, question and final', () => {
  const raw = structuredClone(history);
  const display = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  const panel = display.find(event => event.messageKind === 'progress_panel');
  assert.equal(panel.seq, 3);
  assert.equal(panel.workboardUpdateSeq, 8);
  assert.equal(panel.workboardProgress.content, '已定位显示问题');
  assert.deepEqual(panel.workboardProgressHistory.map(update => update.seq), [3, 6]);
  assert.match(panel.workboardStatusLabel, /执行已结束/);
  assert.equal(panel.workboard, undefined);
  assert.deepEqual(projectWorkboards(history), [], 'display progress creates no acceptance task');
  assert.deepEqual(display.filter(e => e.type === 'message' && e.role === 'assistant').map(e => e.seq), [2, 3, 5, 7]);
  assert.deepEqual(history, raw, 'raw history and evidence are untouched');
  const progressFirst = [inbound(), progress(2, '可见发现'), msg(3, '未标记的内部说明'),
    msg(4, '最终结果', { phase: 'final_answer' })];
  assert.deepEqual(buildSessionDisplayEvents(progressFirst, { exposeWorkboard: true })
    .filter(event => event.type === 'message' && event.role === 'assistant').map(event => event.seq), [2, 4],
  'an initial progress panel cannot make later hidden commentary become an opening');
  const withInternalPlan = [...history.slice(0, 2), msg(2.5, '[ ] 内部检查步骤', { messageKind: 'todo_list' }), ...history.slice(2)];
  assert.equal(buildSessionDisplayEvents(withInternalPlan, { exposeWorkboard: true })
    .filter(event => event.messageKind === 'todo_list').length, 0, 'a native execution plan never becomes a public acceptance list');
  assert.deepEqual(buildSessionDisplayEvents(structuredClone(history), { exposeWorkboard: true }), display);
  assert.equal(projectProgressStreams([inbound(), msg(2, '直接回答', { phase: 'final_answer' })]).length, 0);
  assert.equal(buildSessionDisplayEvents(history).filter(e => e.surfaceKind === 'progress').length, 2,
    'non-opted-in surfaces retain their existing contract');
});

test('Runs and cancellation remain separate from accepted task completion', () => {
  const streams = projectProgressStreams([...history, inbound(9, 'next'),
    progress(10, '第二轮进展', { runId: 'next' }), { seq: 11, type: 'status', runId: 'next', content: 'cancelled' }]);
  assert.deepEqual(streams.map(stream => [stream.anchorSeq, stream.executionState]), [[3, 'ended'], [10, 'cancelled']]);
  const failed = projectProgressStreams([inbound(), progress(3, '进行中'),
    { seq: 4, type: 'status', runId: 'run', content: 'error: capacity' }]);
  assert.equal(failed[0].executionState, 'failed');
});

test('Feishu unlisted progress creates no card, including replay and restart', async () => {
  const state = pilot();
  for (const events of [history.slice(0, -2), history]) {
    assert.deepEqual(collectFeishuInstanceWorkboardCycles(events, state, session), []);
  }
  assert.equal(await publishFeishuWorkboardCycle({ progressOnly: true }, { pilot: state }), null);
  assert.deepEqual(state.cards, []);
  const existing = { ...pilot(), cards: [{ anchorSeq: 3, messageId: 'legacy-progress', latestSeq: 6 }] };
  assert.deepEqual(collectFeishuInstanceWorkboardCycles(history, existing, session), [],
    'an old lightweight receipt cannot make unlisted work create new cards or patches');
});

test('late acceptance list upgrades the original progress position and message', async () => {
  const state = pilot(), calls = [];
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async () => { calls.push('create'); return { code: 0, data: { message_id: 'original' } }; },
    patch: async input => { assert.equal(input.path.message_id, 'original'); calls.push('patch'); return { code: 0 }; },
  } } } } };
  const start = history.slice(0, 3);
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(start, state, session))) {
    await publishFeishuWorkboardCycle(cycle, options);
  }
  const board = { taskId: 'real-task', revision: 1, goal: '独立交付', status: 'running', reason: '',
    items: ['a', 'b'].map(id => ({ id, title: id, condition: '可验证', status: 'pending', evidenceRefs: [] })) };
  const expanded = [...start, msg(4, '目标：独立交付', { source: 'workboard_checklist', workboard: board })];
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(expanded, state, session))) {
    await publishFeishuWorkboardCycle(cycle, options);
  }
  assert.deepEqual(calls, ['create']);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].taskId, 'real-task');
  const legacyState = { ...pilot(), cards: [{ anchorSeq: 3, messageId: 'original', latestSeq: 3 }] };
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(expanded, legacyState, session))) {
    await publishFeishuWorkboardCycle(cycle, { ...options, pilot: legacyState });
  }
  assert.deepEqual(calls, ['create', 'patch'], 'an existing progress card upgrades to a real task in place');
  const display = buildSessionDisplayEvents(expanded, { exposeWorkboard: true });
  assert.equal(display.filter(event => event.workboard).length, 1);
  assert.equal(display.find(event => event.workboard).seq, 3);
  assert.equal(display.filter(event => event.messageKind === 'progress_panel').length, 0);
  const separate = [...start, msg(4, '上一个问题的结果', { phase: 'final_answer' }),
    msg(5, '目标：新的交付', { source: 'workboard_checklist', workboard: { ...board, taskId: 'next-task' } })];
  assert.equal(projectWorkboards(separate)[0].anchorSeq, 5,
    'a prior final closes the upgrade window; a new task cannot claim the old progress message');
});

test('admitted progress stays in cards; unadmitted turns also keep ordinary progress in history; replay queues no duplicates', async () => {
  let record = { key: 'request', runId: 'run', options: {}, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  await publishLiveAssistantReplies(record, history.slice(0, -2), {
    store, session, fullHistory: history, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.surfaceKind),
    ['opening', 'question']);
  assert.deepEqual(record.deliveries.filter(part => part.surfaceKind === 'progress').map(part => part.text),
    []);
  const published = structuredClone(record);
  await publishLiveAssistantReplies(published, history.slice(0, -2), {
    store, session, fullHistory: history, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.deepEqual(record, published, 'durable message identities survive observer replay/restart');
  record = { ...record, options: { workboardEnabled: false }, deliveries: [], streamedSurfaceMessageIds: [] };
  const unadmitted = structuredClone(history); delete unadmitted[0].workboardAdmission;
  await publishLiveAssistantReplies(record, unadmitted.slice(0, -2), {
    store, session, fullHistory: unadmitted, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, 0);
});

test('rollout fence preserves old card progress without resending it; new progress keeps its thread', async () => {
  let record = { key: 'request', runId: 'run', options: { workboardEnabled: false }, deliveries: [], progressMessageAfterSeq: 3 };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  const plan = { connector: 'feishu', sourceRouteId: 'bot',
    target: { chatId: 'group', chatType: 'group', conversationKind: 'thread', messageId: 'root', replyInThread: true } };
  await publishLiveAssistantReplies(record, history.slice(0, -2), { store, session, fullHistory: history, plan });
  const updates = record.deliveries.filter(part => part.surfaceKind === 'progress');
  assert.equal(updates.length, 0);
  assert.equal(record.streamedSurfaceMessageIds.includes('message-3'), false,
    'a suppression fence cannot masquerade as a sent message');
  const before = structuredClone(record);
  await publishLiveAssistantReplies(record, history, { store, session, fullHistory: history, plan, running: false });
  assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, 0,
    'cold terminal recovery never backfills intermediate progress');
  assert.deepEqual(record.deliveries.slice(0, before.deliveries.length), before.deliveries);
});

test('concurrent progress keeps each private chat or task topic and durable deduplication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'progress-publication-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createRequestStore(directory);
  const cases = [
    { chatId: 'private', chatType: 'p2p', conversationKind: 'main' },
    { chatId: 'group', chatType: 'group', conversationKind: 'thread', messageId: 'task-a', replyInThread: true },
    { chatId: 'group', chatType: 'group', conversationKind: 'thread', messageId: 'task-b', replyInThread: true },
  ];
  const inputs = await Promise.all(cases.map(async (target, index) => {
    const plan = { connector: 'feishu', sourceRouteId: 'bot', target };
    const { record } = await store.accept({ sessionId: `session-${index}`, requestId: `request-${index}`, text: '任务',
      deliveryPlan: plan, options: { workboardEnabled: false } });
    const event = msg(3, `任务 ${index} 的结果`, { runId: record.runId, phase: 'final_answer' });
    return { record, event, plan };
  }));
  const publish = ({ record, event, plan }) => publishLiveAssistantReplies(record, [event], { store, session, plan, running: false });
  await Promise.all(inputs.flatMap(input => [publish(input), publish(input)]));
  for (const { record, plan } of inputs) {
    const stored = await store.get(record.key);
    assert.equal(stored.deliveries.length, 1);
    assert.equal(stored.deliveries[0].surfaceKind, 'final');
    assert.deepEqual(stored.deliveries[0].target, plan.target);
    assert.deepEqual(stored.streamedFinalReplyIds, ['message-3'],
      'the same provider message identity in another Request cannot consume this delivery');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { projectProgressStreams } from '../lib/progress-stream.mjs';
import { projectWorkboards } from '../lib/workboard-state.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { collectFeishuInstanceWorkboardCycles, expandFeishuWorkboardUpdates,
  publishFeishuWorkboardCycle } from '../connectors/feishu/workboard-pilot.mjs';
import { publishLiveAssistantReplies } from '../chat/native-final-publication.mjs';

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

test('Feishu progress patches one original card and replay/restart sends no duplicate', async () => {
  const state = pilot(), calls = [];
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async input => { calls.push(['create', input]); return { code: 0, data: { message_id: 'original' } }; },
    patch: async input => { calls.push(['patch', input]); return { code: 0 }; },
  } } } } };
  const cycles = collectFeishuInstanceWorkboardCycles(history, state, session);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].replyMessageId, 'in-1');
  for (const update of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(history.slice(0, -2), state, session))) {
    await publishFeishuWorkboardCycle(update, options);
  }
  for (const update of expandFeishuWorkboardUpdates(cycles)) await publishFeishuWorkboardCycle(update, options);
  assert.deepEqual(calls.map(([kind]) => kind), ['create', 'patch', 'patch']);
  assert.equal(calls[0][1].path.message_id, 'in-1');
  assert.equal(calls[1][1].path.message_id, 'original');
  const finalCard = JSON.parse(calls.at(-1)[1].data.content);
  assert.equal(finalCard.header.title.content, '本轮进展');
  assert.equal(finalCard.body.elements[0].content, '已定位显示问题');
  assert.match(finalCard.body.elements.at(-1).content, /执行已结束/);
  assert.doesNotMatch(JSON.stringify(finalCard), /0\/0|已验收|\[x\]/);
  for (const update of expandFeishuWorkboardUpdates(cycles)) {
    assert.equal(await publishFeishuWorkboardCycle(update, { ...options, pilot: structuredClone(state) }), null);
  }
  assert.deepEqual(collectFeishuInstanceWorkboardCycles(history, { ...pilot(), progressStartedAt: 2000 }, session), [],
    'upgrade does not backfill old chat progress');
  const outsider = structuredClone(history);
  delete outsider[0].workboardAdmission;
  assert.deepEqual(collectFeishuInstanceWorkboardCycles(outsider, pilot(), session), []);
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
  assert.deepEqual(calls, ['create', 'patch']);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].taskId, 'real-task');
  const display = buildSessionDisplayEvents(expanded, { exposeWorkboard: true });
  assert.equal(display.filter(event => event.workboard).length, 1);
  assert.equal(display.find(event => event.workboard).seq, 3);
  assert.equal(display.filter(event => event.messageKind === 'progress_panel').length, 0);
});

test('admitted progress never also enters the message outbox', async () => {
  let record = { key: 'request', runId: 'run', options: {}, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } };
  await publishLiveAssistantReplies(record, history.slice(0, -2), {
    store, session, fullHistory: history, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.surfaceKind), ['opening', 'question']);
  record = { ...record, deliveries: [], streamedSurfaceMessageIds: [] };
  const unadmitted = structuredClone(history); delete unadmitted[0].workboardAdmission;
  await publishLiveAssistantReplies(record, unadmitted.slice(0, -2), {
    store, session, fullHistory: unadmitted, plan: { connector: 'feishu', target: { chatId: 'group' } } });
  assert.equal(record.deliveries.filter(part => part.surfaceKind === 'progress').length, 2);
});

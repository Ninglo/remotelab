import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkboardUpdate, projectWorkboards, workboardStatusLabel } from '../lib/workboard-state.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { collectFeishuGroupWorkboardCycles, expandFeishuWorkboardUpdates, publishFeishuWorkboardCycle } from '../connectors/feishu/workboard-pilot.mjs';

const make = (overrides = {}) => ({ taskId: 'task-1', revision: 1, goal: '交付结果', status: 'running', reason: '',
  items: [{ id: 'a', title: '结果', condition: '结果可读', status: 'pending', evidenceRefs: [] },
    { id: 'b', title: '验收', condition: '验收通过', status: 'pending', evidenceRefs: [] }], ...overrides });
const event = (seq, board, runId = 'run-1') => ({ seq, type: 'message', role: 'assistant',
  source: 'workboard_checklist', workboard: board, runId });
const evidence = { seq: 3, type: 'tool_result', exitCode: 0, output: '验证通过' };
const user = (seq = 1, runId = 'run-1', openId = 'authorized') => ({ seq, type: 'message', role: 'user', runId,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot-2', chatType: 'group', chatId: 'group',
    messageId: `om-${seq}`, sender: { openId } } });
const pilot = { groupEnabled: true, personId: 'person', senderOpenId: 'authorized', sourceRouteId: 'bot-2',
  sessionId: 'session', chatId: 'group', startedAfterSeq: 0, cards: [] };
const session = { workboardPilot: true, workboardOptInPersonId: 'person', conversation: {
  connector: 'feishu', sourceRouteId: 'bot-2', target: { chatType: 'group', chatId: 'group', conversationKind: 'thread' } } };

test('done requires existing successful evidence, scope edits need fresh verification', () => {
  const initial = normalizeWorkboardUpdate(make()).board;
  const done = make({ revision: 2, items: initial.items.map(item => ({ ...item, status: 'done', evidenceRefs: [3] })), status: 'completed' });
  assert.throws(() => normalizeWorkboardUpdate(done, { history: [event(2, initial)] }), /evidence/);
  assert.throws(() => normalizeWorkboardUpdate(done, { history: [event(2, initial), { ...evidence, exitCode: 1 }] }), /Failed tool/);
  const accepted = normalizeWorkboardUpdate(done, { history: [event(2, initial), evidence] }).board;
  const history = [event(2, initial), evidence, event(4, accepted)];
  assert.equal(normalizeWorkboardUpdate(done, { history }).duplicate, true);
  assert.throws(() => normalizeWorkboardUpdate({ ...done, revision: 1 }, { history }), /revision conflict/);
  assert.throws(() => normalizeWorkboardUpdate({ ...done, revision: 3,
    items: done.items.map(item => ({ ...item, condition: '新版验收' })) }, { history }), /scope requires/);
  assert.throws(() => normalizeWorkboardUpdate({ ...done, revision: 3, reason: '需求改变',
    items: done.items.map(item => ({ ...item, condition: '新版验收' })) }, { history }), /fresh verification/);
});

test('blocked result and ordinary commentary preserve the same task across Runs', () => {
  const initial = make();
  const blocked = make({ revision: 2, status: 'blocked', reason: '等待权限',
    items: initial.items.map((item, index) => index ? item : { ...item, status: 'done', evidenceRefs: [3] }) });
  const history = [user(), event(2, initial), evidence, event(4, blocked),
    { seq: 5, type: 'message', role: 'assistant', runId: 'run-1', phase: 'final_answer', content: '缺权限，尚未完成' },
    { seq: 6, type: 'status', runId: 'run-1', content: 'completed' }, user(7, 'run-2'),
    { seq: 8, type: 'message', role: 'assistant', runId: 'run-2', phase: 'commentary', content: '恢复中' },
    event(9, make({ ...blocked, revision: 3, status: 'running', reason: '' }), 'run-2')];
  const tasks = projectWorkboards(history);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].anchorSeq, 2);
  assert.equal(tasks[0].board.status, 'running');
  assert.equal(tasks[0].board.items[0].status, 'done');
  const cycles = collectFeishuGroupWorkboardCycles(history, pilot, session);
  assert.equal(cycles.length, 1); assert.equal(cycles[0].replyMessageId, 'om-1');
  const display = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  assert.equal(display.filter(e => e.source === 'workboard_checklist').length, 1);
  assert.equal(display.find(e => e.workboard).workboard.taskId, cycles[0].taskId);
});

for (const [content, expected] of [['error: process crashed', 'failed'], ['cancelled', 'cancelled'], ['completed', 'unconfirmed']]) {
  test(`runtime fallback ${expected} does not mark unchecked items complete`, () => {
    const task = projectWorkboards([event(2, make()), { seq: 3, type: 'status', runId: 'run-1', content }])[0];
    assert.equal(task.board.status, expected);
    assert.ok(task.board.items.every(item => item.status === 'pending'));
    assert.equal(task.latestSeq, 3);
  });
}
test('old Run failure cannot override a resumed task, stale revisions cannot roll it back', () => {
  const history = [event(2, make()), event(3, make({ revision: 2 }), 'run-2'),
    { seq: 4, type: 'status', runId: 'run-1', content: 'cancelled' }, event(5, make(), 'run-1')];
  const task = projectWorkboards(history)[0];
  assert.equal(task.runId, 'run-2'); assert.equal(task.latestSeq, 3); assert.equal(task.board.status, 'running');
});
test('completed items can be withdrawn with a reason; new task creates a separate card', () => {
  const done = make({ items: make().items.map(item => ({ ...item, status: 'done', evidenceRefs: [3] })), status: 'completed' });
  const history = [evidence, event(4, done)];
  assert.throws(() => normalizeWorkboardUpdate(make({ revision: 2 }), { history }), /Withdrawing/);
  const resumed = normalizeWorkboardUpdate(make({ revision: 2, reason: '发现验收遗漏' }), { history }).board;
  history.push(event(5, resumed), event(6, make({ taskId: 'task-2' })));
  assert.equal(projectWorkboards(history).length, 2);
});
test('execution steps cannot overwrite public acceptance criteria on either surface', () => {
  const history = [user(), event(2, make()), { seq: 3, type: 'message', role: 'assistant', messageKind: 'todo_list',
    runId: 'run-1', content: '[x] Read code\n[ ] Change function' }];
  const display = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  const board = display.find(e => e.workboard);
  assert.match(board.content, /结果可读/); assert.doesNotMatch(board.content, /Read code/);
  assert.equal(collectFeishuGroupWorkboardCycles(history, pilot, session)[0].content, board.content);
  assert.ok(!display.some(e => e.content?.includes('Read code')), 'execution steps stay inside the activity disclosure');
});
test('a native final remains visible while steering continues execution', () => {
  const display = buildSessionDisplayEvents([user(), { seq: 2, type: 'tool_result', output: 'verified' },
    { seq: 3, type: 'message', role: 'assistant', phase: 'final_answer', content: '最终结果' },
    { seq: 4, type: 'message', role: 'assistant', phase: 'commentary', content: '继续处理补充要求' }], { sessionRunning: true });
  assert.ok(display.some(event => event.content === '最终结果'));
  assert.equal(display.at(-1).state, 'running');
});
test('delivery receipts survive archival and do not equate blocked with success', () => {
  const blocked = make({ status: 'blocked', reason: '等待输入' });
  const history = [event(2, blocked), { seq: 3, type: 'message', role: 'assistant', runId: 'run-1',
    phase: 'final_answer', providerMessageId: 'final-1', content: '需要输入' },
    { seq: 4, type: 'source_delivery', runId: 'run-1', providerMessageId: 'final-1', deliveryId: 'd1', kind: 'content', state: 'delivered', externalId: 'om-result' }];
  let task = projectWorkboards(history)[0];
  assert.equal(task.board.deliveryState, 'delivered'); assert.equal(task.board.status, 'blocked');
  history.push(event(5, make({ ...blocked, revision: 2, status: 'running', reason: '' })));
  assert.equal(projectWorkboards(history)[0].board.deliveryState, undefined, 'old receipt does not settle new work');
  history[0] = event(2, make({ status: 'completed' })); history.pop();
  history.push({ ...history[2], seq: 5, deliveryId: 'd2', kind: 'attachment', state: 'delivery_failed', externalId: '' });
  task = projectWorkboards(history)[0];
  assert.equal(task.board.deliveryState, 'failed'); assert.match(workboardStatusLabel(task.board), /投递异常/);
});
test('replay, restart and card failure do not create duplicates or overwrite unknown sends', async () => {
  const history = [user(), event(2, make()), event(3, make({ revision: 2, status: 'blocked', reason: '待授权' })),
    user(4, 'run-2'), event(5, make({ revision: 3 }), 'run-2')];
  const state = structuredClone(pilot), calls = [];
  let failPatch = true;
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async () => { calls.push('create'); return { code: 0, data: { message_id: 'om-card' } }; },
    patch: async input => { assert.equal(input.path.message_id, 'om-card'); calls.push('patch');
      if (failPatch) throw new Error('transport unavailable'); return { code: 0 }; },
  } } } } };
  const cycles = collectFeishuGroupWorkboardCycles(history, state, session);
  const updates = expandFeishuWorkboardUpdates(cycles);
  await publishFeishuWorkboardCycle(updates[0], options);
  await assert.rejects(publishFeishuWorkboardCycle(updates[1], options), /transport/);
  assert.equal(state.cards[0].latestSeq, 2);
  failPatch = false;
  const restarted = { ...options, pilot: structuredClone(state) };
  for (const update of updates) await publishFeishuWorkboardCycle(update, restarted);
  for (const update of updates) assert.equal(await publishFeishuWorkboardCycle(update, restarted), null);
  assert.deepEqual(calls, ['create', 'patch', 'patch', 'patch']);
  assert.equal(restarted.pilot.cards.length, 1);
});
test('migration fence never replays old cards, and other senders cannot mutate the task', async () => {
  const history = [user(), event(2, make()), user(3, 'run-other', 'other'), event(4, make({ revision: 2 }), 'run-other')];
  const cycles = collectFeishuGroupWorkboardCycles(history, pilot, session);
  assert.equal(cycles[0].latestSeq, 2);
  assert.equal(await publishFeishuWorkboardCycle(cycles[0], { pilot: { ...pilot, protocolAfterSeq: 4 } }), null);
});

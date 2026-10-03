import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkboardUpdate, projectWorkboards, workboardStatusLabel, workboardProgressText } from '../lib/workboard-state.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { collectFeishuGroupWorkboardCycles, expandFeishuWorkboardUpdates, publishFeishuWorkboardCycle } from '../connectors/feishu/workboard-pilot.mjs';
import { publishLiveAssistantReplies, annotateTerminalReplyDeliveries, recoverTerminalReplyReceipt } from '../chat/native-final-publication.mjs';

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

test('terminal fallback receipts require every result part and cannot settle a later task revision', () => {
  const final = { seq: 3, type: 'message', role: 'assistant', phase: 'final_answer', runId: 'run-1', providerMessageId: 'answer' };
  const parts = annotateTerminalReplyDeliveries([{ kind: 'reaction' }, { kind: 'content' }, { kind: 'attachment' }], { displayEvents: [final] });
  assert.deepEqual(parts[0], { kind: 'reaction' });
  assert.equal(parts[1].providerMessageId, 'answer');
  assert.equal(parts[2].providerPartCount, 2);
  const history = [event(2, make({ status: 'completed' })), final,
    { ...parts[1], seq: 4, type: 'source_delivery', runId: 'run-1', deliveryId: 'text', state: 'delivered', externalId: 'om-text' }];
  assert.equal(projectWorkboards(history)[0].board.deliveryState, 'pending');
  history.push({ ...parts[2], seq: 5, type: 'source_delivery', runId: 'run-1', deliveryId: 'file', state: 'delivered', externalId: 'om-file' });
  assert.equal(projectWorkboards(history)[0].board.deliveryState, 'delivered');
  history.push(event(6, make({ status: 'completed', revision: 2 })));
  assert.equal(projectWorkboards(history)[0].board.deliveryState, undefined);
  const ambiguous = [{ kind: 'content' }];
  assert.deepEqual(annotateTerminalReplyDeliveries(ambiguous, { displayEvents: [final, { ...final, providerMessageId: 'other-answer' }] }), ambiguous);
  assert.deepEqual(annotateTerminalReplyDeliveries(ambiguous, null), ambiguous);
});

test('work completion alone cannot imply an external delivery is pending or confirmed', () => {
  assert.equal(workboardStatusLabel(make({ status: 'completed' })), '工作完成');
  assert.match(workboardStatusLabel(make({ status: 'completed', deliveryState: 'pending' })), /答复待送达/);
  assert.match(workboardStatusLabel(make({ status: 'completed', deliveryState: 'delivered' })), /答复已送达/);
  assert.match(workboardStatusLabel(make({ status: 'completed', deliveryState: 'failed' })), /答复投递异常/);
});

test('legacy receipt recovery needs one exact terminal payload and never borrows an opening or ambiguous result', () => {
  const payload = { text: '结果', attachments: [], displayEvents: [{ type: 'message', role: 'assistant', phase: 'final_answer', providerMessageId: 'final' }] };
  const delivery = { kind: 'content', connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'group' }, text: '【最终答复】\n\n结果' };
  const record = { options: { sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'group' } } }, result: { state: 'completed', payload }, deliveries: [delivery] };
  assert.deepEqual(recoverTerminalReplyReceipt(record, delivery), { providerMessageId: 'final', providerPartCount: 1, receiptRecovered: true });
  assert.equal(recoverTerminalReplyReceipt(record, { ...delivery, surfaceKind: 'opening' }), null);
  assert.equal(recoverTerminalReplyReceipt(record, { ...delivery, text: '不相同' }), null);
  assert.equal(recoverTerminalReplyReceipt(record, { ...delivery, target: { chatId: 'other' } }), null);
  assert.equal(recoverTerminalReplyReceipt({ ...record, deliveries: [delivery, delivery] }, delivery), null);
  assert.equal(recoverTerminalReplyReceipt({ ...record, result: { ...record.result, state: 'cancelled' } }, delivery), null);
});

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
test('a finished canonical task never creates a late card after its final reply', async () => {
  const history = [user(), event(2, make()),
    { seq: 3, type: 'message', role: 'assistant', runId: 'run-1', phase: 'final_answer', content: '本轮答复' }];
  const cycles = collectFeishuGroupWorkboardCycles(history, pilot, session);
  const state = { ...pilot, cards: [] };
  for (const update of expandFeishuWorkboardUpdates(cycles)) {
    assert.equal(await publishFeishuWorkboardCycle(update, { pilot: state,
      app: { im: { v1: { message: { reply: async () => assert.fail('no late card send') } } } },
      persist: async () => assert.fail('no late card receipt') }), null);
  }
  assert.equal(state.cards.length, 0);
});
test('an earlier final in a steered Run cannot suppress a genuinely new task card', () => {
  const cycles = collectFeishuGroupWorkboardCycles([user(), event(2, make()),
    { seq: 3, type: 'message', role: 'assistant', runId: 'run-1', phase: 'final_answer', content: '第一项结果' },
    user(4), event(5, make({ taskId: 'second-task', goal: '新的工作' }))], pilot, session);
  assert.deepEqual(cycles.map(item => [item.taskId, item.closed]), [['task-1', true], ['second-task', false]]);
});
test('local Session continuation updates an existing opted-in card without creating a new task', () => {
  const history = [user(), event(2, make()),
    { seq: 3, type: 'message', role: 'user', runId: 'local-run', content: '再看看' },
    event(4, make({ revision: 2 }), 'local-run'), event(5, make({ taskId: 'new-local-task' }), 'local-run')];
  const cycles = collectFeishuGroupWorkboardCycles(history, pilot, session);
  assert.equal(cycles.length, 1); assert.equal(cycles[0].anchorSeq, 2); assert.equal(cycles[0].latestSeq, 4);
  assert.equal(cycles[0].replyMessageId, 'om-1');
});
test('a later task final in the same Run cannot undo an earlier delivery receipt', () => {
  const final = (seq, providerMessageId) => ({ seq, type: 'message', role: 'assistant', runId: 'run-1', phase: 'final_answer', providerMessageId });
  const history = [event(2, make({ status: 'completed' })), final(3, 'answer-one'),
    { seq: 4, type: 'source_delivery', runId: 'run-1', deliveryId: 'one', providerMessageId: 'answer-one', kind: 'content', state: 'delivered', externalId: 'om-one' },
    event(5, make({ taskId: 'task-2' })), final(6, 'answer-two')];
  const tasks = projectWorkboards(history);
  assert.equal(tasks[0].board.deliveryState, 'delivered');
  assert.equal(tasks[1].board.deliveryState, undefined);
});
test('provider item IDs reused across Runs cannot reuse another Run delivery receipt', () => {
  const final = (seq, runId) => ({ seq, runId, type: 'message', role: 'assistant', phase: 'final_answer', providerMessageId: 'item-0' });
  const history = [event(2, make()), final(3, 'run-1'), { seq: 4, type: 'source_delivery', runId: 'run-1',
    deliveryId: 'first', providerMessageId: 'item-0', kind: 'content', state: 'delivered', externalId: 'om-first' },
    event(5, make({ revision: 2 }), 'run-2'), final(6, 'run-2')];
  assert.equal(projectWorkboards(history)[0].board.deliveryState, undefined);
  history.push({ ...history[2], seq: 7, runId: 'run-2', deliveryId: 'second', externalId: 'om-second' });
  assert.equal(projectWorkboards(history)[0].board.deliveryState, 'delivered');
});
test('explicit outbox result receipts bind to the task revision, including local continuations', () => {
  const board = make({ status: 'completed' });
  const receipt = { seq: 3, type: 'source_delivery', deliveryId: 'manual', workboardTaskId: board.taskId,
    workboardRevision: 1, kind: 'content', state: 'delivered', externalId: 'om-result', providerPartCount: 2 };
  const history = [event(2, board), receipt];
  assert.equal(projectWorkboards(history)[0].board.deliveryState, 'pending', 'one part does not prove all attachments delivered');
  history.push({ ...receipt, seq: 4, deliveryId: 'file', kind: 'attachment' });
  assert.equal(projectWorkboards(history)[0].board.deliveryState, 'delivered');
  history.push(event(5, make({ revision: 2 }), 'local-continuation'));
  assert.equal(projectWorkboards(history)[0].board.deliveryState, undefined);
});

test('a text checklist cannot be recreated under another ID, and historical duplicates keep its first anchor', () => {
  const initial = make({ taskId: 'wb_run-1' });
  const assigned = make({ taskId: 'custom-task', items: initial.items.map((item, i) => i ? item : { ...item, status: 'running' }) });
  assert.throws(() => normalizeWorkboardUpdate(assigned, { history: [user(), event(2, initial)], runId: 'run-1' }),
    error => error.statusCode === 409 && /reuse taskId wb_run-1 and revision 2/.test(error.message));
  const completed = { ...assigned, revision: 2, status: 'completed',
    items: assigned.items.map(item => ({ ...item, status: 'done', evidenceRefs: [3] })) };
  const history = [user(), event(2, initial), evidence, event(4, assigned), event(5, completed)];
  const tasks = projectWorkboards(history);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].anchorSeq, 2);
  assert.equal(tasks[0].taskId, 'custom-task');
  assert.equal(tasks[0].board.status, 'completed');
  assert.equal(tasks[0].board.revision, 2);
  assert.deepEqual(tasks[0].aliases, ['wb_run-1']);
  const display = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  assert.equal(display.filter(e => e.workboard).length, 1);
  assert.equal(display.find(e => e.workboard).seq, 2);
  assert.equal(projectWorkboards([user(), event(2, initial), event(4, { ...assigned, goal: '另一个目标' })]).length, 2,
    'separate goals must not merge');
  assert.equal(projectWorkboards([user(), event(2, initial), event(4, assigned, 'run-2')]).length, 2,
    'independent Runs must not merge');
  assert.equal(projectWorkboards([user(), event(2, { ...initial, status: 'completed' }), event(4, assigned)]).length, 2,
    'completed work must not absorb a new task');
  assert.equal(projectWorkboards([user(), event(2, initial),
    { seq: 3, type: 'message', role: 'assistant', phase: 'final_answer', runId: 'run-1', providerMessageId: 'final' }, event(4, assigned)]).length, 2,
    'a final result closes the default-task adoption window');
});

test('ordinary progress updates the original card; openings, questions and final results stay outside', async () => {
  const msg = (seq, phase, content, extra = {}) => ({ seq, type: 'message', role: 'assistant', runId: 'run-1',
    phase, content, providerMessageId: `message-${seq}`, ...extra });
  const history = [user(), msg(2, 'commentary', '核对原卡更新和重复任务 ID'), event(3, make()),
    msg(4, 'commentary', 'hidden <progress>发现两个 ID 对应相同验收条件</progress> hidden'),
    msg(5, 'commentary', '请选择部署窗口', { messageKind: 'user_question' }),
    msg(6, 'commentary', '<progress>修复已通过验证，正在推送</progress>'),
    msg(7, 'final_answer', '修复已交付')];
  const task = projectWorkboards(history)[0];
  assert.equal(task.latestSeq, 6);
  assert.equal(task.board.revision, 1, 'progress does not revise acceptance conditions');
  assert.equal(task.board.status, 'running', 'progress and final prose cannot claim task completion');
  assert.equal(task.progress.content, '修复已通过验证，正在推送');
  assert.deepEqual(task.progressHistory.map(update => update.seq), [4, 6]);
  const display = buildSessionDisplayEvents(history, { exposeWorkboard: true });
  assert.deepEqual(display.filter(e => e.type === 'message' && e.role === 'assistant' && !e.workboard).map(e => e.seq), [2, 5, 7]);
  assert.equal(display.find(e => e.workboard).workboardProgress.seq, 6);
  assert.match(history[3].content, /hidden <progress>/, 'durable history retains the complete original');
  const cycles = collectFeishuGroupWorkboardCycles(history.slice(0, -1), pilot, session);
  const updates = expandFeishuWorkboardUpdates(cycles);
  assert.deepEqual(updates.map(update => update.latestSeq), [3, 4, 6]);
  let record = { key: 'request', runId: 'run-1', responseId: 'response', options: {}, deliveries: [] };
  const options = { store: { get: async () => record, mutate: async (_key, fn) => { record = fn(record); } },
    session, plan: { connector: 'feishu', target: { chatId: 'group' } }, running: false };
  await publishLiveAssistantReplies(record, history, options);
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.text), ['【最终答复】\n\n修复已交付']);
  record = { ...record, deliveries: [], streamedSurfaceMessageIds: [], streamedFinalReplyIds: [] };
  await publishLiveAssistantReplies(record, history.slice(0, -1), { ...options, running: true });
  assert.deepEqual(record.deliveries.filter(part => part.kind === 'content').map(part => part.text),
    ['【开始处理】\n\n核对原卡更新和重复任务 ID', '【待你回复】\n\n请选择部署窗口']);
  const state = structuredClone(pilot), cards = [];
  const publishing = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    reply: async input => { cards.push(['create', JSON.parse(input.data.content)]); return { code: 0, data: { message_id: 'one-card' } }; },
    patch: async input => { assert.equal(input.path.message_id, 'one-card'); cards.push(['patch', JSON.parse(input.data.content)]); return { code: 0 }; },
  } } } } };
  for (const update of updates) await publishFeishuWorkboardCycle(update, publishing);
  for (const update of updates) assert.equal(await publishFeishuWorkboardCycle(update, publishing), null);
  assert.deepEqual(cards.map(([action]) => action), ['create', 'patch', 'patch']);
  assert.equal(cards.at(-1)[1].body.elements.at(-1).content, task.progress.content);
  assert.equal(state.cards.length, 1);
});

test('continuation progress uses full Session history and stale prior Runs cannot replace it', async () => {
  const initial = event(2, make());
  const resumed = event(4, make({ revision: 2 }), 'run-2');
  const progress = { seq: 5, type: 'message', role: 'assistant', runId: 'run-2', phase: 'commentary',
    providerMessageId: 'new-progress', content: '<progress>继续核验原任务</progress>' };
  const stale = { ...progress, seq: 6, runId: 'run-1', content: '<progress>过期进展</progress>' };
  const history = [user(), initial, user(3, 'run-2'), resumed, progress, stale];
  assert.equal(projectWorkboards(history)[0].progress.seq, 5);
  const record = { key: 'resumed', runId: 'run-2', options: {}, deliveries: [] };
  await publishLiveAssistantReplies(record, [progress], { session, fullHistory: history,
    plan: { connector: 'feishu', target: { chatId: 'group' } }, store: { get: async () => record, mutate: async () => assert.fail('card progress must not enter the message outbox') } });
});

test('a group sender outside the opt-in cannot supply progress on the same Run', () => {
  const progress = { seq: 4, type: 'message', role: 'assistant', runId: 'run-1', phase: 'commentary',
    content: '<progress>另一发言人的处理进展</progress>' };
  const history = [user(), event(2, make()), user(3, 'run-1', 'other'), progress];
  const cycles = collectFeishuGroupWorkboardCycles(history, pilot, session);
  assert.equal(cycles[0].latestSeq, 2);
  assert.equal(cycles[0].progress, undefined);
});

test('renderer upgrades patch an existing card once without creating or replaying older snapshots', async () => {
  const cycle = { taskId: 'task-1', anchorSeq: 2, latestSeq: 8, board: make(), content: '目标：交付结果',
    progress: { seq: 8, content: '当前验证进展' } };
  const state = { ...structuredClone(pilot), cards: [{ taskId: 'task-1', anchorSeq: 2, latestSeq: 8, messageId: 'existing-card' }] };
  const calls = [];
  const options = { pilot: state, persist: async () => {}, verifyMessage: async () => {}, app: { im: { v1: { message: {
    patch: async request => { calls.push(request); assert.equal(request.path.message_id, 'existing-card'); return { code: 0 }; },
  } } } } };
  assert.equal(await publishFeishuWorkboardCycle({ ...cycle, latestSeq: 4 }, options), null);
  assert.equal((await publishFeishuWorkboardCycle(cycle, options)).action, 'updated');
  assert.equal(JSON.parse(calls[0].data.content).body.elements.at(-1).content, '当前验证进展');
  assert.equal(await publishFeishuWorkboardCycle(cycle, { ...options, pilot: structuredClone(state) }), null);
  assert.equal(calls.length, 1);
  assert.equal(state.cards.length, 1);
});

test('verified task outcomes replace stale running progress and retain its history', () => {
  const progress = { seq: 3, type: 'message', role: 'assistant', runId: 'run-1', phase: 'commentary', content: '<progress>CI 还在运行</progress>' };
  const done = make({ revision: 2, status: 'completed', items: make().items.map(item => ({ ...item, status: 'done', evidenceRefs: [4] })) });
  const display = buildSessionDisplayEvents([user(), event(2, make()), progress, event(5, done)], { exposeWorkboard: true });
  const card = display.find(e => e.workboard);
  assert.equal(card.workboardProgress.content, '全部交付项已验收。');
  assert.equal(card.workboardProgress.derivedFromOutcome, true);
  assert.equal(card.workboardProgressHistory[0].content, 'CI 还在运行');
  for (const status of ['partial', 'blocked', 'failed', 'cancelled', 'unconfirmed']) {
    const text = workboardProgressText(make({ status, reason: status === 'unconfirmed' ? '' : '当前条件' }), { content: 'CI 还在运行' });
    assert.doesNotMatch(text, /CI 还在运行/);
    assert.ok(text.includes(status === 'unconfirmed' ? '待确认' : '当前条件'));
  }
});

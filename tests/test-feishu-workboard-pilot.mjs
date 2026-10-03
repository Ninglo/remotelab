import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeishuWorkboardCard,
  isFeishuInstanceWorkboardSession,
  collectFeishuInstanceWorkboardCycles,
  collectFeishuGroupWorkboardCycles,
  collectFeishuWorkboardCycles,
  expandFeishuWorkboardUpdates,
  isFeishuWorkboardGroupSession,
  isFeishuWorkboardPilotSession,
  publishFeishuWorkboardCycle,
} from '../connectors/feishu/workboard-pilot.mjs';

const pilot = {
  sessionId: 'session-zhang', sourceRouteId: 'bot-2', chatId: 'chat-zhang',
  senderOpenId: 'open-zhang', startedAfterSeq: 10, cards: [],
};
const session = { workboardPilot: true, conversation: {
  connector: 'feishu', sourceRouteId: 'bot-2',
  target: { chatType: 'p2p', conversationKind: 'main', chatId: 'chat-zhang' },
} };
const user = (seq, sender = 'open-zhang') => ({ seq, type: 'message', role: 'user',
  sourceContext: { sender: { openId: sender } } });
const list = (seq, done = false) => ({ seq, type: 'message', role: 'assistant',
  source: 'workboard_checklist', content: `目标：交付结果\n[${done ? 'x' : ' '}] 核验 — 可核对。` });

test('only the opted-in private chat can publish a checklist', () => {
  assert.equal(isFeishuWorkboardPilotSession(session, pilot), true);
  assert.equal(isFeishuWorkboardPilotSession({ ...session, workboardPilot: false }, pilot), false);
  assert.equal(isFeishuWorkboardPilotSession({ ...session, conversation: {
    ...session.conversation, target: { ...session.conversation.target, chatType: 'group' },
  } }, pilot), false);
  assert.equal(isFeishuWorkboardPilotSession({ ...session, conversation: {
    ...session.conversation, target: { ...session.conversation.target, chatId: 'chat-other' },
  } }, pilot), false);
  assert.deepEqual(collectFeishuWorkboardCycles([user(11, 'open-other'), list(12)], pilot), []);
});

test('group cards require the opted-in Person and her own source Run', () => {
  const groupPilot = { ...pilot, personId: 'zhang', groupEnabled: true, chatId: 'group-1',
    startedAfterSeq: 0 };
  const groupSession = { workboardPilot: true, workboardOptInPersonId: 'zhang',
    conversation: { connector: 'feishu', sourceRouteId: 'bot-2', target: {
      chatType: 'group', chatId: 'group-1', conversationKind: 'thread', tenantKey: 'tenant-1',
    } } };
  const groupUser = (seq, runId, sender, messageId) => ({ seq, type: 'message', role: 'user', runId,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot-2', chatType: 'group',
      chatId: 'group-1', tenantKey: 'tenant-1', messageId, sender: { openId: sender } } });
  const groupList = (seq, runId, done = false) => ({ ...list(seq, done), runId });
  const events = [
    groupUser(1, 'run-other', 'open-other', 'message-other'), groupList(2, 'run-other'),
    groupUser(3, 'run-zhang', 'open-zhang', 'message-zhang'), groupList(4, 'run-zhang'),
    groupUser(5, 'run-other-2', 'open-other', 'message-other-2'), groupList(6, 'run-other-2'),
    groupList(7, 'run-zhang', true),
    { seq: 8, type: 'message', role: 'assistant', runId: 'run-zhang', phase: 'final_answer', content: '结果' },
  ];
  assert.equal(isFeishuWorkboardGroupSession(groupSession, groupPilot), true);
  assert.equal(isFeishuWorkboardGroupSession({ ...groupSession, groupFeed: true }, groupPilot), false);
  assert.equal(isFeishuWorkboardGroupSession({ ...groupSession, workboardOptInPersonId: 'other' }, groupPilot), false);
  assert.deepEqual(collectFeishuGroupWorkboardCycles(events, groupPilot, groupSession)
    .map(({ anchorSeq, latestSeq, content, closed, replyMessageId }) => ({ anchorSeq, latestSeq, content, closed, replyMessageId })), [{
    anchorSeq: 4, latestSeq: 7, content: groupList(7, 'run-zhang', true).content,
    closed: true, replyMessageId: 'message-zhang',
  }]);
});

test('steering keeps one card while a final result closes the cycle', () => {
  const cycles = collectFeishuWorkboardCycles([
    user(9), list(10), user(11), list(12), user(13), list(14, true),
    { seq: 15, type: 'message', role: 'assistant', phase: 'final_answer', content: '结果' },
    user(16), list(17),
  ], pilot);
  assert.deepEqual(cycles.map(x => [x.anchorSeq, x.latestSeq, x.closed]), [[12, 14, true], [17, 17, false]]);
  assert.match(cycles[0].content, /\[x\]/);
});

test('card renderer keeps one item per row and updates its progress', () => {
  const card = buildFeishuWorkboardCard('目标：交付两项结果\n[x] 排序 — 日期递增。\n[ ] 核验 — 每项可查。');
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, '交付两项结果');
  assert.equal(card.body.elements[0].content, '**1/2 · 进行中**');
  assert.equal(card.body.elements[1].text.content, '✓ 排序 — 日期递增。');
  assert.equal(card.body.elements[2].text.content, '○ 核验 — 每项可查。');
  assert.equal(card.body.elements.at(-1).content, '暂无进度更新');
  const complete = buildFeishuWorkboardCard('目标：交付两项结果\n[x] 排序 — 日期递增。\n[x] 核验 — 每项可查。');
  assert.equal(complete.header.template, 'green');
  assert.equal(complete.body.elements[0].content, '**2/2 · 已完成**');
});

test('progress commentary and each verified item keep one group card across replay', async () => {
  const groupPilot = { ...pilot, personId: 'zhang', groupEnabled: true, chatId: 'group-1',
    sessionId: 'group-session', startedAfterSeq: 0, cards: [] };
  const groupSession = { workboardPilot: true, workboardOptInPersonId: 'zhang', conversation: {
    connector: 'feishu', sourceRouteId: 'bot-2', target: {
      chatType: 'group', chatId: 'group-1', conversationKind: 'thread',
    },
  } };
  const events = [{ seq: 1, type: 'message', role: 'user', runId: 'run-task', sourceContext: {
    connector: 'feishu', sourceRouteId: 'bot-2', chatType: 'group', chatId: 'group-1',
    messageId: 'om-task', sender: { openId: 'open-zhang' },
  } }];
  const calls = [];
  const options = { pilot: groupPilot, persist: async () => {}, verifyMessage: async () => {},
    app: { im: { v1: { message: {
      reply: async () => { calls.push('create'); return { code: 0, data: { message_id: 'om-one-card' } }; },
      patch: async request => { assert.equal(request.path.message_id, 'om-one-card'); calls.push('patch'); return { code: 0 }; },
    } } } },
  };
  let seq = 2;
  for (let done = 0; done <= 3; done++) {
    events.push({ seq: seq++, type: 'message', role: 'assistant', runId: 'run-task',
      source: 'workboard_checklist', content: '目标：逐项交付\n'
        + [1, 2, 3].map(i => `[${i <= done ? 'x' : ' '}] 项目${i} — 已核验`).join('\n') });
    const cycles = collectFeishuGroupWorkboardCycles(events, groupPilot, groupSession);
    assert.equal(cycles.length, 1);
    await publishFeishuWorkboardCycle(cycles[0], options);
    // Older histories have no phase; neither form may close or split a card.
    events.push({ seq: seq++, type: 'message', role: 'assistant', runId: 'run-task',
      ...(done % 2 ? { phase: 'commentary' } : {}), content: '有新的核验结果' });
  }
  events.push({ seq: seq++, type: 'message', role: 'assistant', runId: 'run-task',
    phase: 'final_answer', content: '最终结果' });
  const cycles = collectFeishuGroupWorkboardCycles(events, groupPilot, groupSession);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].closed, true);
  assert.equal(await publishFeishuWorkboardCycle(cycles[0], options), null);
  assert.deepEqual(calls, ['create', 'patch', 'patch', 'patch']);
  assert.equal(groupPilot.cards.length, 1);
  const replayPilot = { ...groupPilot, cards: [{ anchorSeq: cycles[0].anchorSeq,
    messageId: 'om-one-card', latestSeq: cycles[0].anchorSeq }] };
  calls.length = 0;
  for (const update of expandFeishuWorkboardUpdates(cycles, events)) {
    await publishFeishuWorkboardCycle(update, { ...options, pilot: replayPilot });
  }
  assert.deepEqual(calls, ['patch', 'patch', 'patch', 'patch'], 'recovery upgrades the known card format once, then replays each unseen item update');
});

test('private progress commentary does not split a checklist', () => {
  const cycles = collectFeishuWorkboardCycles([
    user(11), list(12), { seq: 13, type: 'message', role: 'assistant', phase: 'commentary', content: '进度' },
    list(14, true), { seq: 15, type: 'message', role: 'assistant', phase: 'final_answer', content: '结果' },
  ], pilot);
  assert.deepEqual(cycles.map(cycle => [cycle.anchorSeq, cycle.latestSeq, cycle.closed]), [[12, 14, true]]);
});

test('create once, edit the same message, and fence uncertain sends', async () => {
  const state = { ...pilot, cards: [] };
  const calls = [];
  const app = { im: { v1: { message: {
    create: async request => { calls.push(['create', request]); return { code: 0, data: { message_id: 'om-card' } }; },
    patch: async request => { calls.push(['patch', request]); return { code: 0 }; },
  } } } };
  const snapshots = [];
  const options = {
    pilot: state, app,
    persist: async () => snapshots.push(structuredClone(state.cards)),
    verifyMessage: async (id, { updated }) => {
      assert.equal(id, 'om-card');
      assert.equal(typeof updated, 'boolean');
    },
  };
  const first = { anchorSeq: 12, latestSeq: 12, content: list(12).content, closed: false };
  assert.equal((await publishFeishuWorkboardCycle(first, options)).action, 'created');
  assert.equal(snapshots[0][0].pendingCreate, true, 'unknown creation is durable before the API call');
  assert.equal(state.cards[0].messageId, 'om-card');
  assert.equal(await publishFeishuWorkboardCycle(first, options), null);
  const updated = { ...first, latestSeq: 14, content: list(14, true).content };
  assert.equal((await publishFeishuWorkboardCycle(updated, options)).action, 'updated');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].data.receive_id, 'chat-zhang');
  assert.equal(calls[0][1].data.msg_type, 'interactive');
  assert.equal(JSON.parse(calls[0][1].data.content).schema, '2.0');
  assert.equal(calls[1][1].path.message_id, 'om-card');
  assert.equal(calls[1][0], 'patch');
  assert.equal(state.cards[0].latestSeq, 14);
  assert.equal(await publishFeishuWorkboardCycle({ ...first, anchorSeq: 20, closed: true }, options), null,
    'a late checklist cannot appear after its result');
  state.cards.push({ anchorSeq: 30, messageId: '', pendingCreate: true, latestSeq: 0 });
  await assert.rejects(publishFeishuWorkboardCycle({ ...first, anchorSeq: 30 }, options), /outcome is unknown/);
  assert.equal(calls.length, 2, 'an uncertain create must not be sent again');
});

test('a group thread card replies once and patches that same message', async () => {
  const state = { ...pilot, sessionId: 'group-session', chatId: 'group-1', cards: [] };
  const calls = [];
  const app = { im: { v1: { message: {
    reply: async request => { calls.push(['reply', request]); return { code: 0, data: { message_id: 'om-group-card' } }; },
    patch: async request => { calls.push(['patch', request]); return { code: 0 }; },
  } } } };
  const options = { pilot: state, app, persist: async () => {}, verifyMessage: async () => {} };
  const first = { anchorSeq: 12, latestSeq: 12, content: list(12).content,
    closed: false, replyMessageId: 'om-user-task' };
  assert.equal((await publishFeishuWorkboardCycle(first, options)).action, 'created');
  assert.equal((await publishFeishuWorkboardCycle({ ...first, latestSeq: 13,
    content: list(13, true).content }, options)).action, 'updated');
  assert.equal(calls[0][0], 'reply');
  assert.equal(calls[0][1].path.message_id, 'om-user-task');
  assert.equal(calls[0][1].data.reply_in_thread, true);
  assert.equal(calls[1][0], 'patch');
  assert.equal(calls[1][1].path.message_id, 'om-group-card');
});


test('instance cards follow turn admission across members and keep the original reply on steering', async () => {
  const state = { scope: 'instance', sourceRouteId: 'bot-2', chatId: 'group-1', sessionId: 'group-session', cards: [] };
  const group = { workboardPilot: true, workboardOptInPersonId: 'last-member', conversation: {
    connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'group-1', chatType: 'group', conversationKind: 'thread' },
  } };
  const inbound = (seq, runId, sender, admitted = true) => ({ seq, type: 'message', role: 'user', runId,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot-2', chatId: 'group-1', chatType: 'group',
      messageId: `om-${seq}`, sender: { openId: sender } },
    ...(admitted ? { workboardAdmission: { personId: sender, identityId: `id-${sender}`, sourceRouteId: 'bot-2', senderOpenId: sender } } : {}),
  });
  const checklist = (seq, runId) => ({ ...list(seq), runId });
  const events = [inbound(1, 'a', 'open-a'), checklist(2, 'a'), inbound(3, 'a', 'open-a'),
    inbound(4, 'b', 'open-b'), checklist(5, 'b'), inbound(6, 'untrusted', 'open-c', false), checklist(7, 'untrusted')];
  const cycles = collectFeishuInstanceWorkboardCycles(events, state, group);
  assert.deepEqual(cycles.map(task => [task.anchorSeq, task.replyMessageId]), [[2, 'om-1'], [5, 'om-4']]);
  assert.equal(isFeishuInstanceWorkboardSession({ ...group, groupFeed: true }, state), false);
  assert.equal(isFeishuInstanceWorkboardSession(group, { ...state, sourceRouteId: 'wrong' }), false);
  const calls = [];
  const app = { im: { v1: { message: { reply: async request => {
    calls.push(request.path.message_id); return { code: 0, data: { message_id: `card-${calls.length}` } };
  }, patch: async () => { calls.push('patch'); return { code: 0 }; } } } } };
  const options = { pilot: state, app, persist: async () => {}, verifyMessage: async () => {} };
  for (const cycle of cycles) await publishFeishuWorkboardCycle(cycle, options);
  const restarted = JSON.parse(JSON.stringify(state));
  for (const cycle of collectFeishuInstanceWorkboardCycles(events, restarted, group)) {
    assert.equal(await publishFeishuWorkboardCycle(cycle, { ...options, pilot: restarted }), null);
  }
  assert.deepEqual(calls, ['om-1', 'om-4'], 'two members get two original cards, restart sends no duplicates');
  assert.deepEqual(collectFeishuInstanceWorkboardCycles(events.map(event => event.role === 'user'
    ? { ...event, sourceContext: { ...event.sourceContext, chatId: 'wrong' } } : event), state, group), []);
});

test('instance migration preserves known legacy cards but cannot create historical cards', () => {
  const group = { workboardPilot: true, conversation: { connector: 'feishu', sourceRouteId: 'bot-2',
    target: { chatId: 'group-1', chatType: 'group', conversationKind: 'main' } } };
  const state = { scope: 'instance', sourceRouteId: 'bot-2', legacySenderOpenId: 'open-zhang', cards: [{ anchorSeq: 2 }] };
  const inbound = (seq, runId) => ({ seq, type: 'message', role: 'user', runId,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot-2', chatId: 'group-1', chatType: 'group',
      messageId: `om-${seq}`, sender: { openId: 'open-zhang' } } });
  const events = [inbound(1, 'old-known'), { ...list(2), runId: 'old-known' },
    inbound(3, 'old-unknown'), { ...list(4), runId: 'old-unknown' }];
  assert.deepEqual(collectFeishuInstanceWorkboardCycles(events, state, group).map(task => task.anchorSeq), [2]);
});

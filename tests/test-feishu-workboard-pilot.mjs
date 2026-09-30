import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeishuWorkboardCard,
  collectFeishuGroupWorkboardCycles,
  collectFeishuWorkboardCycles,
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
    { seq: 8, type: 'message', role: 'assistant', runId: 'run-zhang', content: '结果' },
  ];
  assert.equal(isFeishuWorkboardGroupSession(groupSession, groupPilot), true);
  assert.equal(isFeishuWorkboardGroupSession({ ...groupSession, groupFeed: true }, groupPilot), false);
  assert.equal(isFeishuWorkboardGroupSession({ ...groupSession, workboardOptInPersonId: 'other' }, groupPilot), false);
  assert.deepEqual(collectFeishuGroupWorkboardCycles(events, groupPilot, groupSession), [{
    anchorSeq: 4, latestSeq: 7, content: groupList(7, 'run-zhang', true).content,
    closed: true, replyMessageId: 'message-zhang',
  }]);
});

test('steering keeps one card while a final result closes the cycle', () => {
  const cycles = collectFeishuWorkboardCycles([
    user(9), list(10), user(11), list(12), user(13), list(14, true),
    { seq: 15, type: 'message', role: 'assistant', content: '结果' },
    user(16), list(17),
  ], pilot);
  assert.deepEqual(cycles.map(x => [x.anchorSeq, x.latestSeq, x.closed]), [[12, 14, true], [17, 17, false]]);
  assert.match(cycles[0].content, /\[x\]/);
});

test('card renderer keeps one item per row and updates its progress', () => {
  const card = buildFeishuWorkboardCard('目标：交付两项结果\n[x] 排序 — 日期递增。\n[ ] 核验 — 每项可查。');
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.body.elements[1].content, '**1/2 · 进行中**');
  assert.equal(card.body.elements[2].text.content, '✓ 排序 — 日期递增。');
  assert.equal(card.body.elements[3].text.content, '○ 核验 — 每项可查。');
  const complete = buildFeishuWorkboardCard('目标：交付两项结果\n[x] 排序 — 日期递增。\n[x] 核验 — 每项可查。');
  assert.equal(complete.header.template, 'green');
  assert.equal(complete.body.elements[1].content, '**2/2 · 已完成**');
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

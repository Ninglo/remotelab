import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectFeishuWorkboardCycles,
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

test('steering keeps one card while a final result closes the cycle', () => {
  const cycles = collectFeishuWorkboardCycles([
    user(9), list(10), user(11), list(12), user(13), list(14, true),
    { seq: 15, type: 'message', role: 'assistant', content: '结果' },
    user(16), list(17),
  ], pilot);
  assert.deepEqual(cycles.map(x => [x.anchorSeq, x.latestSeq, x.closed]), [[12, 14, true], [17, 17, false]]);
  assert.match(cycles[0].content, /\[x\]/);
});

test('create once, edit the same message, and fence uncertain sends', async () => {
  const state = { ...pilot, cards: [] };
  const calls = [];
  const app = { im: { v1: { message: {
    create: async request => { calls.push(['create', request]); return { code: 0, data: { message_id: 'om-card' } }; },
    update: async request => { calls.push(['update', request]); return { code: 0 }; },
  } } } };
  const snapshots = [];
  const options = {
    pilot: state, app,
    persist: async () => snapshots.push(structuredClone(state.cards)),
    verifyMessage: async (id, content) => {
      assert.equal(id, 'om-card');
      assert.equal(JSON.parse(content).text.startsWith('目标：'), true);
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
  assert.equal(calls[1][1].path.message_id, 'om-card');
  assert.equal(state.cards[0].latestSeq, 14);
  assert.equal(await publishFeishuWorkboardCycle({ ...first, anchorSeq: 20, closed: true }, options), null,
    'a late checklist cannot appear after its result');
  state.cards.push({ anchorSeq: 30, messageId: '', pendingCreate: true, latestSeq: 0 });
  await assert.rejects(publishFeishuWorkboardCycle({ ...first, anchorSeq: 30 }, options), /outcome is unknown/);
  assert.equal(calls.length, 2, 'an uncertain create must not be sent again');
});

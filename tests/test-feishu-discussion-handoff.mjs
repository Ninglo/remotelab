import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDiscussionHandoffPilot,
  parseDiscussionHandoffAction,
  proposalKey,
  verifyDiscussionHandoff,
  verifyDiscussionHandoffTarget,
  verifyDiscussionHandoffVisibility,
} from '../connectors/feishu/discussion-handoff.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'feishu-discussion-handoff-'));
try {
  const link = { projectId: 'claude-tag', discussionChatId: 'oc_discussion',
    workChatId: 'oc_work', handoffCards: true };
  const sent = { cards: [], roots: [], notices: [], noticeRequests: [], patches: [], tasks: [] };
  const runtime = { config: { storageDir, projectLinks: [link] }, appClient: { im: { v1: { message: {
    reply: async request => {
      const content = JSON.parse(request.data.content);
      if (request.data.msg_type === 'interactive') {
        sent.cards.push(request);
        assert.equal(content.schema, '2.0');
        const columns = content.body.elements.at(-1).columns;
        assert.equal(columns[0].elements[0].behaviors[0].value.action, 'confirm');
        assert.equal(columns[1].elements[0].behaviors[0].value.action, 'dismiss');
        assert.ok(request.data.uuid.length <= 50);
        return { code: 0, data: { message_id: sent.cards.length === 1 ? 'om_card' : `om_card${sent.cards.length}` } };
      }
      sent.noticeRequests.push(request);
      assert.ok(request.data.uuid.length <= 50, 'Feishu rejects notice UUIDs longer than 50 characters');
      sent.notices.push(content.text);
      return { code: 0, data: { message_id: `om_notice_${sent.notices.length}` } };
    },
    patch: async request => {
      sent.patches.push({ messageId: request.path.message_id, card: JSON.parse(request.data.content) });
      return { code: 0, data: {} };
    },
    create: async request => {
      sent.roots.push(JSON.parse(request.data.content).text);
      assert.equal(request.data.receive_id, link.workChatId);
      return { code: 0, data: { message_id: 'om_work', thread_id: 'omt_work' } };
    },
  } } } } };
  const summary = { chatId: link.discussionChatId, messageId: 'om_source',
    messageText: '方案定了，开工吧', createTime: String(Date.now()),
    sender: { senderType: 'user', openId: 'ou_author', name: '发言人' } };
  const history = { messages: [{ messageId: 'om_earlier', sender: '甲', time: '2026-09-28 10:00:00',
    text: '讨论过实施范围' }] };
  const pilot = createDiscussionHandoffPilot(runtime, {
    readHistory: async () => history,
    verify: async evidence => ({ offer: evidence.includes('方案定了') && evidence.includes('实施范围') }),
    submitWork: async (proposal, found) => {
      sent.tasks.push({ proposal, found });
      return { sessionId: 'session-work', runId: 'run-work' };
    },
    verifyVisibility: async () => true,
    verifyTarget: async () => true,
  });
  const proposal = await pilot.offerCandidate(summary);
  assert.equal(proposal.status, 'offered');
  assert.equal(proposal.evidenceCount, 1);
  assert.equal(sent.cards.length, 1);
  assert.equal(await pilot.offerCandidate(summary), null, 'same source must not offer twice');
  assert.equal(proposalKey(summary), proposal.key);
  const rawAction = action => ({ event: { action: { value: { action, proposalId: proposal.key } },
    context: { open_chat_id: link.discussionChatId, open_message_id: 'om_card' },
    operator: { operator_id: { open_id: 'ou_confirm' } } } });
  assert.equal(parseDiscussionHandoffAction(rawAction('confirm')).operatorId, 'ou_confirm');
  assert.match((await pilot.actionFeedback(rawAction('confirm'))).toast.content, /已收到移交请求/);
  assert.equal(await pilot.handleAction({ event: { ...rawAction('confirm').event,
    context: { open_chat_id: 'oc_other', open_message_id: 'om_card' } } }), null);
  const result = await pilot.handleAction(rawAction('confirm'));
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-work');
  assert.equal(sent.roots.length, 1);
  assert.equal(sent.tasks.length, 1);
  assert.match(sent.tasks[0].found.evidence, /实施范围/);
  assert.match(sent.notices[0], /omt_work/);
  assert.equal(sent.patches[0].messageId, 'om_card');
  assert.equal(sent.patches[0].card.header.title.content, '已移交干活群');
  await pilot.handleAction(rawAction('confirm'));
  assert.equal(sent.roots.length, 1, 'a repeated click must reuse the work topic');
  assert.equal(sent.tasks.length, 1, 'a repeated click must reuse the Session');

  const second = await pilot.offerCandidate({ ...summary, messageId: 'om_second',
    threadId: 'omt_second', messageText: '另一个方案定了，开始做' });
  assert.equal(second.status, 'offered');
  const dismissed = await pilot.handleAction({ event: { action: { value: { action: 'dismiss', proposalId: second.key } },
    context: { open_chat_id: link.discussionChatId, open_message_id: 'om_card2' },
    operator: { operator_id: { open_id: 'ou_confirm' } } } });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(sent.roots.length, 1, 'dismissal must not start work');
  assert.equal(sent.patches[1].card.header.title.content, '已选择继续讨论');
  assert.match(sent.notices[1], /暂不移交/);
  const renewed = await pilot.renewCard(second.key);
  assert.equal(renewed.status, 'offered');
  assert.equal(renewed.cardMessageId, 'om_card3');
  assert.equal(sent.cards[2].data.uuid.endsWith('-1'), true, 'renewal needs a new Feishu idempotency key');
  assert.equal((await pilot.actionFeedback({ event: { ...rawAction('confirm').event,
    action: { value: { action: 'confirm', proposalId: second.key } },
    context: { open_chat_id: link.discussionChatId, open_message_id: 'om_card2' } } })).accepted, false,
  'the previous card must not start work after renewal');

  const weak = await verifyDiscussionHandoff('还在讨论要不要做', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      transfer: { choice: 'offer', probabilities: { offer: 0.7, none: 0.3 } },
    } }) }),
  });
  assert.equal(weak.offer, false, 'weak model support cannot publish a card');
  const supported = await verifyDiscussionHandoff('方向已定，现在移交开工', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      transfer: { choice: 'offer', probabilities: { offer: 0.84, none: 0.16 } },
    } }) }),
  });
  assert.equal(supported.offer, true, 'a second positive check at 0.84 must not discard the handoff');
  const visibility = { source: { chatId: link.discussionChatId }, workChatId: link.workChatId };
  const memberRuntime = (ids, chatMode = 'topic') => ({ appClient: { im: { v1: {
    chat: { get: async () => ({ code: 0, msg: 'success',
      data: { chat_mode: chatMode, chat_status: 'normal' } }) },
    chatMembers: {
    get: async request => ({ code: 0, data: { items: ids[request.path.chat_id].map(member_id => ({ member_id })) } }),
  } } } } });
  assert.equal(await verifyDiscussionHandoffVisibility(memberRuntime({
    [link.discussionChatId]: ['a', 'b'], [link.workChatId]: ['a'],
  }), visibility), true);
  await assert.rejects(() => verifyDiscussionHandoffVisibility(memberRuntime({
    [link.discussionChatId]: ['a'], [link.workChatId]: ['b'],
  }), visibility), /not all/);
  await assert.rejects(() => verifyDiscussionHandoffTarget(memberRuntime({}, 'group'), link.workChatId),
    /not an active topic chat/);

  const sourceTime = Date.now() - 1_000;
  const historyItem = (messageId, createTime, text) => ({
    message_id: messageId, create_time: String(createTime), msg_type: 'text',
    sender: { sender_type: 'user', sender_name: '讨论成员' },
    body: { content: JSON.stringify({ text }) },
  });
  const gapRuntime = { config: { storageDir: join(storageDir, 'gap-case'), projectLinks: [link] },
    appClient: { im: { v1: { message: { list: async () => ({ code: 0, data: {
      items: [historyItem('om_gap_source', sourceTime, '方向确定，现在开工'),
        historyItem('om_earlier_decision', sourceTime - 6 * 60 * 60 * 1_000, '六小时前定下实施范围')],
      has_more: false,
    } }) } } } } };
  const gapPilot = createDiscussionHandoffPilot(gapRuntime, {
    verify: async evidence => ({ offer: evidence.includes('六小时前定下实施范围') }),
    sendCard: async () => ({ message_id: 'om_gap_card' }),
    submitWork: async () => ({ sessionId: 'unused' }),
    verifyTarget: async () => true,
  });
  const gapProposal = await gapPilot.offerCandidate({ ...summary,
    messageId: 'om_gap_source', messageText: '方向确定，现在开工', createTime: String(sourceTime) });
  assert.equal(gapProposal.status, 'offered');
  assert.equal(gapProposal.evidenceCount, 2,
    'handoff lookup must retain decisions made over four hours before the start-work message');
  console.log('Feishu discussion handoff: evidence lookup, proposal card, confirmation and dedup passed');
} finally {
  await rm(storageDir, { recursive: true, force: true });
}

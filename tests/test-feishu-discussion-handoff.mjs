import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDiscussionHandoffPilot,
  parseDiscussionHandoffAction,
  proposalKey,
  verifyDiscussionHandoff,
  verifyDiscussionHandoffVisibility,
} from '../connectors/feishu/discussion-handoff.mjs';

const storageDir = await mkdtemp(join(tmpdir(), 'feishu-discussion-handoff-'));
try {
  const link = { projectId: 'claude-tag', discussionChatId: 'oc_discussion',
    workChatId: 'oc_work', handoffCards: true };
  const sent = { cards: [], roots: [], notices: [], tasks: [] };
  const runtime = { config: { storageDir, projectLinks: [link] }, appClient: { im: { v1: { message: {
    reply: async request => {
      const content = JSON.parse(request.data.content);
      if (request.data.msg_type === 'interactive') {
        sent.cards.push(request);
        assert.equal(content.elements.at(-1).actions[0].value.action, 'confirm');
        return { code: 0, data: { message_id: 'om_card' } };
      }
      sent.notices.push(content.text);
      return { code: 0, data: { message_id: `om_notice_${sent.notices.length}` } };
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
  assert.equal(await pilot.handleAction({ event: { ...rawAction('confirm').event,
    context: { open_chat_id: 'oc_other', open_message_id: 'om_card' } } }), null);
  const result = await pilot.handleAction(rawAction('confirm'));
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'session-work');
  assert.equal(sent.roots.length, 1);
  assert.equal(sent.tasks.length, 1);
  assert.match(sent.tasks[0].found.evidence, /实施范围/);
  assert.match(sent.notices[0], /omt_work/);
  await pilot.handleAction(rawAction('confirm'));
  assert.equal(sent.roots.length, 1, 'a repeated click must reuse the work topic');
  assert.equal(sent.tasks.length, 1, 'a repeated click must reuse the Session');

  const second = await pilot.offerCandidate({ ...summary, messageId: 'om_second',
    threadId: 'omt_second', messageText: '另一个方案定了，开始做' });
  assert.equal(second.status, 'offered');
  const dismissed = await pilot.handleAction({ event: { action: { value: { action: 'dismiss', proposalId: second.key } },
    context: { open_chat_id: link.discussionChatId, open_message_id: 'om_card' },
    operator: { operator_id: { open_id: 'ou_confirm' } } } });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(sent.roots.length, 1, 'dismissal must not start work');

  const weak = await verifyDiscussionHandoff('还在讨论要不要做', {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      transfer: { choice: 'offer', probabilities: { offer: 0.7, none: 0.3 } },
    } }) }),
  });
  assert.equal(weak.offer, false, 'weak model support cannot publish a card');
  const visibility = { source: { chatId: link.discussionChatId }, workChatId: link.workChatId };
  const memberRuntime = ids => ({ appClient: { im: { v1: { chatMembers: {
    get: async request => ({ code: 0, data: { items: ids[request.path.chat_id].map(member_id => ({ member_id })) } }),
  } } } } });
  assert.equal(await verifyDiscussionHandoffVisibility(memberRuntime({
    [link.discussionChatId]: ['a', 'b'], [link.workChatId]: ['a'],
  }), visibility), true);
  await assert.rejects(() => verifyDiscussionHandoffVisibility(memberRuntime({
    [link.discussionChatId]: ['a'], [link.workChatId]: ['b'],
  }), visibility), /not all/);
  console.log('Feishu discussion handoff: evidence lookup, proposal card, confirmation and dedup passed');
} finally {
  await rm(storageDir, { recursive: true, force: true });
}

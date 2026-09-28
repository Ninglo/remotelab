import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-ambient-'));
setIsolatedTestHome(home);
try {
  const { resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { resolveAmbientFeishuReplyPlan } = await import('../chat/ambient-feishu-reply.mjs');
  const { buildSessionEntryDeliveries } = await import('../chat/session-entry-notification.mjs');
  const { resolveSessionDeliveryPlan } = await import('../chat/session-conversations.mjs');
  const { summarizeFeishuMuteReaction } = await import('../connectors/feishu/reaction-mute.mjs');
  const { handleFeishuReactionMute, handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { getFeishuConversationSettings } = await import('../connectors/feishu/conversation-settings.mjs');
  const chatId = 'group-ambient';
  const config = {
    storageDir: home, sourceRouteId: 'bot-2',
    responsePolicy: { group: 'mention_only' },
    groups: { [chatId]: { participationMode: 'ambient' } },
  };
  const base = {
    chatId, chatType: 'group', chatMode: 'group', tenantKey: 'tenant',
    messageId: 'question-1', messageType: 'text', messageText: '这件事怎么办',
    sender: { senderType: 'user', openId: 'human' }, mentions: [],
  };
  const settings = resolveFeishuGroupSettings(config, base);
  assert.equal(settings.responseMode, 'all');
  assert.equal(settings.replyMode, 'inline');
  assert.match(settings.systemPrompt, /feishu-reply:thread/);
  assert.equal(resolveFeishuGroupSettings(config, { ...base, chatId: 'other-group' }).responseMode, 'mention_only');
  assert.equal(resolveFeishuGroupSettings(config, { ...base, threadId: 'thread-1' }).participationMode, undefined);
  const effects = [];
  const runtime = { config, botIdentity: { openId: 'self' }, storagePaths: {}, };
  await handleMessage(runtime, base, 'test', {
    addProcessingReaction: async () => effects.push('reaction'),
    submitRemoteLabRequest: async (_runtime, summary) => {
      effects.push('submit');
      assert.equal(summary.conversationKind, 'main');
      return { sessionId: 'group-session' };
    },
  });
  assert.deepEqual(effects, ['submit'], 'ambient chatter enters the main Session without a processing reaction');

  const plan = {
    connector: 'feishu', sourceRouteId: 'bot-2',
    target: { chatId, tenantKey: 'tenant', conversationKind: 'main', messageId: 'question-1' },
  };
  const record = { options: { sourceContext: { feishuParticipation: 'ambient' } } };
  const thread = resolveAmbientFeishuReplyPlan(record, plan, [
    { type: 'message', role: 'assistant', content: '<private>feishu-reply:thread</private>我来处理。' },
  ]);
  assert.equal(thread.target.conversationKind, 'thread');
  assert.equal(thread.target.rootId, 'question-1');
  assert.equal(thread.target.replyInThread, true);
  assert.equal(thread.target.sourceKind, 'ambient_thread_open');
  assert.equal(resolveAmbientFeishuReplyPlan(record, plan, [
    { type: 'message', role: 'assistant', content: '我来处理。' },
  ]).target.conversationKind, 'main');
  assert.equal(resolveAmbientFeishuReplyPlan(record, plan, [
    { type: 'message', role: 'user', content: '<private>feishu-reply:thread</private>' },
    { type: 'message', role: 'assistant', content: '正常回复' },
  ]).target.conversationKind, 'main', 'user text never selects a thread');
  assert.deepEqual(buildSessionEntryDeliveries({ id: 's1' }, { userMessageCount: 0 },
    { sourceDelivery: plan, sourceContext: { feishuParticipation: 'ambient' } }), []);
  assert.equal(resolveSessionDeliveryPlan({ conversation: plan },
    { sourceContext: { feishuParticipation: 'feedback' } }), null);

  const outbound = {
    direction: 'outbound', messageId: 'bot-reply', sessionId: 'group-session',
    chatId, accountId: 'tenant', conversationId: `feishu:group:${chatId}`,
    conversationKind: 'main', sourceMessageId: 'question-1',
  };
  const raw = {
    event_id: 'reaction-1', tenant_key: 'tenant', message_id: 'bot-reply',
    reaction_type: { emoji_type: 'SHHH' }, operator_type: 'user',
    user_id: { open_id: 'human' },
  };
  assert.equal(summarizeFeishuMuteReaction({ ...raw, reaction_type: { emoji_type: 'THUMBSUP' } }, outbound), null);
  assert.equal(summarizeFeishuMuteReaction(raw, { ...outbound, direction: 'inbound' }), null);
  const summary = summarizeFeishuMuteReaction(raw, outbound);
  assert.equal(summary.chatId, chatId);
  assert.equal(summary.threadId, undefined);
  const feedback = [];
  await handleFeishuReactionMute(runtime, summary, {
    submitFeishuFeedback: async (_runtime, item, kind, sessionId) => feedback.push({ item, kind, sessionId }),
  });
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, true);
  assert.equal(feedback[0].kind, 'mute_reaction');
  assert.equal(feedback[0].sessionId, 'group-session');
  assert.equal((await getFeishuConversationSettings({
    config, storagePaths: {}, botIdentity: { openId: 'self' },
  }, base)).muted, true, 'reaction mute survives a new Connector runtime');
  assert.equal((await getFeishuConversationSettings(runtime, { ...base, threadId: 'another-thread' })).muted, false);
  const threadOutbound = {
    ...outbound, conversationId: 'thread-1', conversationKind: 'thread', rootId: 'thread-1',
  };
  const threadSummary = summarizeFeishuMuteReaction({ ...raw, event_id: 'reaction-2' }, threadOutbound);
  await handleFeishuReactionMute(runtime, threadSummary, { submitFeishuFeedback: async () => {} });
  assert.equal((await getFeishuConversationSettings(runtime, { ...base, threadId: 'thread-1' })).muted, true);
  assert.equal((await getFeishuConversationSettings(runtime, { ...base, threadId: 'another-thread' })).muted, false);
  console.log('test-feishu-ambient-participation: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

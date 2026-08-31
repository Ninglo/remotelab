#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { upsertConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';
import { summarizeFeishuLegacyMessageEvent } from '../connectors/feishu/index.mjs';

const repoRoot = process.cwd();
const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-group-routing-'));
process.env.HOME = tempDir;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.REMOTELAB_CONFIG_DIR;
const {
  applyFeishuBotIdentity,
  normalizeGroupReplyPolicy,
  resolveFeishuBotIdentity,
  shouldRouteMessageToRemoteLab,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'feishu-connector.mjs')).href);

const messageIndexPath = join(tempDir, 'connector-message-index.json');
const runtime = {
  config: {
    groupReplyPolicy: normalizeGroupReplyPolicy(),
  },
  storagePaths: {
    messageIndexPath,
  },
  botIdentity: {
    openId: 'ou_current_bot',
    name: 'Muka-Manager-2',
  },
};

try {
  assert.equal(
    summarizeFeishuLegacyMessageEvent({
      open_message_id: 'legacy_mention',
      open_chat_id: 'legacy_group',
      chat_type: 'group',
      text_without_at_bot: 'hello',
    }).mentionedBot,
    true,
    'legacy Feishu callbacks with text_without_at_bot should retain their implicit Bot mention',
  );

  assert.deepEqual(
    await resolveFeishuBotIdentity({
      appClient: {
        request: async () => ({
          code: 0,
          bot: {
            open_id: 'ou_current_bot',
            app_name: 'Muka-Manager-2',
          },
        }),
      },
    }),
    { openId: 'ou_current_bot', userId: '', unionId: '', name: 'Muka-Manager-2' },
    'the connector should resolve the current Bot identity from Feishu before routing group mentions',
  );

  assert.deepEqual(
    normalizeGroupReplyPolicy(),
    { mode: 'mention_or_reply' },
    'group chats should default to mention-or-reply routing',
  );
  assert.deepEqual(
    normalizeGroupReplyPolicy({ mode: 'all' }),
    { mode: 'all' },
    'operators should be able to opt back into all group messages explicitly',
  );

  const privateSummary = applyFeishuBotIdentity({
    messageId: 'msg_private',
    chatId: 'chat_private',
    chatType: 'p2p',
    mentions: [],
  }, runtime.botIdentity);
  assert.equal(await shouldRouteMessageToRemoteLab(runtime, privateSummary), true, 'private messages should not require a mention');

  const ordinaryGroupSummary = applyFeishuBotIdentity({
    messageId: 'msg_group_unmentioned',
    chatId: 'chat_group',
    chatType: 'group',
    mentions: [{ openId: 'ou_someone_else', name: 'Someone Else' }],
  }, runtime.botIdentity);
  assert.equal(ordinaryGroupSummary.mentionedBot, false, 'mentions of other users must not count as mentioning this bot');
  assert.equal(
    await shouldRouteMessageToRemoteLab(runtime, ordinaryGroupSummary),
    false,
    'ordinary unmentioned group chatter must be blocked before entering the model',
  );

  const mentionedGroupSummary = applyFeishuBotIdentity({
    ...ordinaryGroupSummary,
    messageId: 'msg_group_mentioned',
    mentions: [{ openId: 'ou_current_bot', name: 'Muka-Manager-2' }],
  }, runtime.botIdentity);
  assert.equal(mentionedGroupSummary.mentionedBot, true, 'the current bot mention should be identified by open_id');
  assert.equal(
    await shouldRouteMessageToRemoteLab(runtime, mentionedGroupSummary),
    true,
    'a group message mentioning the current bot should enter the model',
  );

  await upsertConnectorMessageIndexRecord(messageIndexPath, {
    connector: 'feishu',
    accountId: 'tenant_1',
    messageId: 'msg_bot_reply',
    sessionId: 'session_1',
    chatId: 'chat_group',
    conversationId: 'feishu:group:chat_group',
    direction: 'outbound',
  });
  const directReplySummary = applyFeishuBotIdentity({
    messageId: 'msg_reply_to_bot',
    chatId: 'chat_group',
    chatType: 'group',
    tenantKey: 'tenant_1',
    parentId: 'msg_bot_reply',
    mentions: [],
  }, runtime.botIdentity);
  assert.equal(
    await shouldRouteMessageToRemoteLab(runtime, directReplySummary),
    true,
    'a direct reply to an indexed bot message should continue without another mention',
  );

  await upsertConnectorMessageIndexRecord(messageIndexPath, {
    connector: 'feishu',
    accountId: 'tenant_1',
    messageId: 'msg_bot_topic_reply',
    sessionId: 'session_topic_1',
    chatId: 'chat_topic',
    conversationId: 'thread_topic_1',
    direction: 'outbound',
  });
  const continuedTopicSummary = applyFeishuBotIdentity({
    messageId: 'msg_topic_continuation',
    chatId: 'chat_topic',
    chatType: 'group',
    tenantKey: 'tenant_1',
    threadId: 'thread_topic_1',
    parentId: 'msg_other_user',
    mentions: [],
  }, runtime.botIdentity);
  assert.equal(
    await shouldRouteMessageToRemoteLab(runtime, continuedTopicSummary),
    true,
    'a topic where the bot already replied should continue without repeated mentions',
  );

  runtime.config.groupReplyPolicy = normalizeGroupReplyPolicy({ mode: 'all' });
  assert.equal(
    await shouldRouteMessageToRemoteLab(runtime, ordinaryGroupSummary),
    true,
    'explicit all mode should preserve the opt-in legacy behavior',
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('ok - Feishu group routing is mention-first and keeps bot conversations alive');

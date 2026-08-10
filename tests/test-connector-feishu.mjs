#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';

import {
  DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT,
  FEISHU_CONNECTOR_ID,
  FEISHU_SKILLS,
  buildExternalTriggerId,
  buildFeishuConversationQueueKey,
  buildFeishuApiUuid,
  buildFeishuMessageIndexRecord,
  buildFeishuOutboundMessageIndexRecord,
  buildFeishuPostContent,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildRequestId,
  buildSessionSourceContext,
  collectFeishuTopicParentMessageCandidates,
  feishuMatchFn,
  normalizeReplyText,
  summarizeFeishuEvent,
  summarizeFeishuLegacyMessageEvent,
} from '../connectors/feishu/index.mjs';

const repoRoot = process.cwd();
const manifest = JSON.parse(await readFile(join(repoRoot, 'connectors', 'feishu', 'manifest.json'), 'utf8'));

assert.equal(manifest.id, FEISHU_CONNECTOR_ID);
assert.equal(manifest.channel, FEISHU_CONNECTOR_ID);
assert.equal(manifest.entry, './index.mjs');
assert.ok(manifest.capabilities.includes('inbound'));
assert.ok(manifest.capabilities.includes('reply'));
assert.ok(manifest.capabilities.includes('attachments'));
assert.ok(FEISHU_SKILLS.some((skill) => skill.name === 'send_message'));
assert.match(DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT, /Feishu or Lark bot/);

const textSummary = summarizeFeishuEvent({
  event_id: 'evt_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_1',
  sender: {
    sender_type: 'user',
    tenant_key: 'tenant_1',
    sender_id: { open_id: 'ou_user_1', user_id: 'u_user_1' },
  },
  message: {
    chat_id: 'oc_chat_1',
    chat_type: 'group',
    message_id: 'om_msg_1',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 帮我看一下' }),
    mentions: [{
      key: '@_user_1',
      name: 'Rowan',
      id: { open_id: 'ou_rowan_1' },
    }],
  },
});

assert.equal(textSummary.chatId, 'oc_chat_1');
assert.equal(textSummary.messageText, '@_user_1 帮我看一下');
assert.equal(textSummary.mentions[0].name, 'Rowan');
assert.equal(buildRequestId(textSummary), 'feishu:om_msg_1');
assert.equal(buildExternalTriggerId(textSummary), 'feishu:group:oc_chat_1');
assert.equal(buildRemoteLabMessage(textSummary), '@Rowan 帮我看一下');

const topicSummary = {
  ...textSummary,
  chatType: 'topic',
  groupMessageType: 'thread',
  messageId: 'om_topic_reply_1',
  rootId: 'om_topic_root_1',
  threadId: 'thread_1',
  imageKeys: ['img_1'],
  sourceRouteId: 'bot-alpha',
};

assert.equal(buildExternalTriggerId(topicSummary), 'feishu:topic:oc_chat_1:thread_1');
assert.equal(buildFeishuConversationQueueKey(topicSummary), 'feishu:topic:oc_chat_1:thread_1');
assert.equal(
  buildFeishuConversationQueueKey({ ...topicSummary, threadId: 'thread_2' }),
  'feishu:topic:oc_chat_1:thread_2',
  'different topics in the same group should use independent processing queues',
);
assert.deepEqual(buildSessionSourceContext(topicSummary), {
  connector: 'feishu',
  conversationKind: 'topic',
  chatType: 'topic',
  chatId: 'oc_chat_1',
  sourceRouteId: 'bot-alpha',
  groupMessageType: 'thread',
  topicId: 'thread_1',
  threadId: 'thread_1',
  rootId: 'om_topic_root_1',
});
assert.deepEqual(buildMessageSourceContext(topicSummary).attachments, { imageCount: 1 });
assert.equal(buildMessageSourceContext(topicSummary).sourceRouteId, 'bot-alpha');
assert.deepEqual(
  collectFeishuTopicParentMessageCandidates({
    ...topicSummary,
    rootId: 'independent_topic_root',
    parentId: 'bot_reply_message',
    threadId: 'thread_1',
  }),
  ['independent_topic_root', 'bot_reply_message', 'thread_1'],
  'topic parent lookup should try root, parent, and thread identities independently',
);
assert.deepEqual(buildFeishuMessageIndexRecord(topicSummary, 'session-1'), {
  connector: 'feishu',
  accountId: 'tenant_1',
  messageId: 'om_topic_reply_1',
  sessionId: 'session-1',
  chatId: 'oc_chat_1',
  conversationId: 'thread_1',
  externalTriggerId: 'feishu:topic:oc_chat_1:thread_1',
  direction: 'inbound',
});
assert.deepEqual(buildFeishuOutboundMessageIndexRecord(topicSummary, 'session-1', 'om_bot_reply_1'), {
  connector: 'feishu',
  accountId: 'tenant_1',
  messageId: 'om_bot_reply_1',
  sessionId: 'session-1',
  chatId: 'oc_chat_1',
  conversationId: 'thread_1',
  externalTriggerId: 'feishu:topic:oc_chat_1:thread_1',
  sourceMessageId: 'om_topic_reply_1',
  direction: 'outbound',
});

const postSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_chat_2',
    chat_type: 'p2p',
    message_id: 'om_post_1',
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: '标题',
        content: [
          [{ tag: 'text', text: '第一行' }],
          [{ tag: 'at', user_name: 'Alex', user_id: 'ou_alex_1' }, { tag: 'text', text: ' 第二行' }],
        ],
      },
    }),
  },
});

assert.equal(postSummary.messageText, '标题\n第一行\n@Alex 第二行');
assert.match(postSummary.contentSummary, /Rich text post/);

const legacySummary = summarizeFeishuLegacyMessageEvent({
  open_chat_id: 'oc_legacy_1',
  open_message_id: 'om_legacy_1',
  msg_type: 'text',
  text: JSON.stringify({ text: 'legacy text' }),
  text_without_at_bot: 'legacy without at',
});
assert.equal(legacySummary.messageText, 'legacy without at');
assert.equal(buildExternalTriggerId(legacySummary), 'feishu:chat:oc_legacy_1');

const normalizedReply = normalizeReplyText('<hide>internal</hide>\n\n已收到 [委屈] 👍');
assert.equal(normalizedReply, '已收到');

const postContent = JSON.parse(await buildFeishuPostContent('**处理完成**\n@Alex 请看', [
  { key: '@_alex', name: 'Alex', openId: 'ou_alex_1' },
]));
assert.equal(postContent.zh_cn.content[0][0].tag, 'md');
assert.equal(postContent.zh_cn.content[1][0].tag, 'at');
assert.equal(postContent.zh_cn.content[1][0].user_id, 'ou_alex_1');

const inlineMathPostContent = JSON.parse(await buildFeishuPostContent('结论：$x_i = y^2$，请看 @Alex', [
  { key: '@_alex', name: 'Alex', openId: 'ou_alex_1' },
]));
assert.deepEqual(inlineMathPostContent.zh_cn.content[0], [
  { tag: 'md', text: '结论：xᵢ = y²，请看 ' },
  { tag: 'at', user_id: 'ou_alex_1', user_name: 'Alex' },
]);

const displayMathPostContent = JSON.parse(await buildFeishuPostContent(
  '公式如下：\n$$\n\\frac{a_b}{c^2}\n$$\n完成',
  [],
  {
    resolveFormulaImage: async () => 'img_formula_test_1',
  },
));
assert.deepEqual(displayMathPostContent.zh_cn.content, [
  [{ tag: 'md', text: '公式如下：' }],
  [{ tag: 'img', image_key: 'img_formula_test_1' }],
  [{ tag: 'md', text: '完成' }],
]);

assert.equal(buildFeishuApiUuid('resp:feishu:0:content').includes(':'), false);
assert.equal(feishuMatchFn('oc_chat_1', { sourceContext: { chatId: 'oc_chat_1' } }), true);
assert.equal(feishuMatchFn('missing', { sourceContext: { chatId: 'oc_chat_1' } }), false);

console.log('ok - feishu connector helpers');

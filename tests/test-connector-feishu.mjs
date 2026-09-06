#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';

import {
  DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT,
  FEISHU_CONNECTOR_ID,
  buildExternalTriggerId,
  buildFeishuConversationQueueKey,
  buildFeishuApiUuid,
  buildFeishuMessageIndexRecord,
  buildFeishuOutboundMessageIndexRecord,
  buildFeishuPostContent,
  buildFeishuForkExternalTriggerId,
  buildFeishuForkSourceContext,
  buildFeishuTopicId,
  buildMessageSourceContext,
  buildRemoteLabMessage,
  buildRequestId,
  buildSessionSourceContext,
  getSummaryFeishuResources,
  feishuMatchFn,
  isSupportedRemoteLabInboundMessage,
  normalizeReplyText,
  summarizeFeishuEvent,
  summarizeFeishuLegacyMessageEvent,
} from '../connectors/feishu/index.mjs';

const repoRoot = process.cwd();
const manifest = JSON.parse(await readFile(join(repoRoot, 'connectors', 'feishu', 'manifest.json'), 'utf8'));
const packageManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));

assert.equal(manifest.id, FEISHU_CONNECTOR_ID);
assert.equal(manifest.channel, FEISHU_CONNECTOR_ID);
assert.equal(manifest.entry, './index.mjs');
assert.ok(manifest.capabilities.includes('inbound'));
assert.ok(manifest.capabilities.includes('reply'));
assert.ok(manifest.capabilities.includes('attachments'));
assert.equal(
  manifest.capabilities.includes('actions'),
  false,
  'Feishu is a message transport, not an in-session application capability provider',
);
assert.equal(
  packageManifest.dependencies?.['@larksuite/cli'],
  '1.0.61',
  'lark-cli should remain available to harnesses without becoming a RemoteLab connector tool',
);
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

const quotedReplySummary = {
  ...textSummary,
  messageId: 'om_quoted_reply_1',
  rootId: 'om_quoted_message_1',
  parentId: 'om_quoted_message_1',
};
assert.equal(
  buildFeishuTopicId(quotedReplySummary),
  '',
  'root_id on an ordinary reply must not turn it into a Thread',
);

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
const forkSummary = {
  ...topicSummary,
  messageId: 'om_fork_command_1',
  sourceRouteId: 'bot-alpha',
};
assert.equal(
  buildFeishuForkExternalTriggerId(forkSummary),
  'feishu:fork:bot-alpha:tenant_1:oc_chat_1:om_fork_command_1',
);
assert.deepEqual(buildFeishuForkSourceContext(forkSummary), {
  connector: 'feishu',
  sourceRouteId: 'bot-alpha',
  chatType: 'topic',
  chatId: 'oc_chat_1',
  messageId: 'om_fork_command_1',
  threadId: 'thread_1',
  rootId: 'om_topic_root_1',
});
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

const fileSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_chat_file_1',
    chat_type: 'p2p',
    message_id: 'om_file_1',
    message_type: 'file',
    content: JSON.stringify({
      file_key: 'file_report_1',
      file_name: 'report.pdf',
    }),
  },
});
assert.deepEqual(getSummaryFeishuResources(fileSummary), [{
  fileKey: 'file_report_1',
  resourceType: 'file',
  kind: 'file',
  downloadType: 'file',
  originalName: 'report.pdf',
}]);
assert.equal(isSupportedRemoteLabInboundMessage(fileSummary), true, 'file messages must enter RemoteLab');

const audioSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_chat_audio_1',
    chat_type: 'p2p',
    message_id: 'om_audio_1',
    message_type: 'audio',
    content: JSON.stringify({ file_key: 'file_audio_1' }),
  },
});
assert.deepEqual(getSummaryFeishuResources(audioSummary), [{
  fileKey: 'file_audio_1',
  resourceType: 'file',
  kind: 'audio',
  downloadType: 'audio',
}]);

const mediaSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_chat_media_1',
    chat_type: 'p2p',
    message_id: 'om_media_1',
    message_type: 'media',
    content: JSON.stringify({
      file_key: 'file_video_1',
      image_key: 'img_cover_1',
      file_name: 'demo.mp4',
    }),
  },
});
assert.deepEqual(getSummaryFeishuResources(mediaSummary), [{
  fileKey: 'file_video_1',
  resourceType: 'file',
  kind: 'media',
  downloadType: 'media',
  originalName: 'demo.mp4',
}, {
  fileKey: 'img_cover_1',
  resourceType: 'image',
  kind: 'image',
  downloadType: 'image',
}]);

const unknownSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_chat_forward_1',
    chat_type: 'group',
    message_id: 'om_forward_1',
    message_type: 'merge_forward',
    content: JSON.stringify({
      title: '项目讨论转发',
      message_ids: ['om_nested_1', 'om_nested_2'],
    }),
  },
});
assert.equal(isSupportedRemoteLabInboundMessage(unknownSummary), true, 'unknown message structures must not be dropped');
assert.equal(buildMessageSourceContext(unknownSummary).ingestion.status, 'unparsed');
assert.deepEqual(buildMessageSourceContext(unknownSummary).sourceReference, {
  kind: 'feishu_message',
  messageId: 'om_forward_1',
  messageType: 'merge_forward',
});
assert.match(buildRemoteLabMessage(unknownSummary), /Feishu source reference/);
assert.match(buildRemoteLabMessage(unknownSummary), /message_id=om_forward_1/);

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
assert.deepEqual(postContent.zh_cn.content, [[{
  tag: 'md', text: '**处理完成**\n<at user_id="ou_alex_1">Alex</at> 请看',
}]]);

const inlineMathPostContent = JSON.parse(await buildFeishuPostContent('结论：$x_i = y^2$，请看 @Alex', [
  { key: '@_alex', name: 'Alex', openId: 'ou_alex_1' },
]));
assert.deepEqual(inlineMathPostContent.zh_cn.content[0], [
  { tag: 'md', text: '结论：xᵢ = y²，请看 <at user_id="ou_alex_1">Alex</at>' },
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

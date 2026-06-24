#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-feishu-connector-'));
process.env.HOME = tempHome;

const { selectAssistantReplyEvent } = await import(pathToFileURL(join(repoRoot, 'lib', 'reply-selection.mjs')).href);
const { waitForReplyPublication } = await import(pathToFileURL(join(repoRoot, 'lib', 'reply-publication-client.mjs')).href);
const { saveUiRuntimeSelection } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);
const {
  findConnectorMessageIndexRecord,
  upsertConnectorMessageIndexRecord,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-message-index.mjs')).href);

const {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildSessionDescription,
  createRuntimeContext,
  buildRemoteLabMessage,
  claimConnectorPidLock,
  compileFeishuReplyText,
  ensureAuthCookie,
  ensureAllowedSendersFile,
  extractLocalCommand,
  generateRemoteLabReply,
  handleChatMemberUserAdded,
  handleMessage,
  isAllowedByPolicy,
  loadConfig,
  loadPersistedAccessState,
  normalizeReplyText,
  normalizeProcessingReactionConfig,
  releaseConnectorPidLock,
  resolveFeishuMessageAttachments,
  buildFeishuPostContent,
  buildExternalTriggerId,
  buildFeishuMessageIndexRecord,
  buildFeishuQueueKey,
  buildMessageSourceContext,
  buildSessionSourceContext,
  resolveFeishuTopicForkParentSessionId,
  sendFeishuText,
  summarizeChatMemberUserAddedEvent,
  summarizeEvent,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'feishu-connector.mjs')).href);

const runtime = {
  processingMessageIds: new Set(),
  storagePaths: {
    handledMessagesPath: '/tmp/remotelab-feishu-connector-test-handled.json',
    messageIndexPath: join(tempHome, 'connector-message-index.json'),
  },
};

let publicationPolls = 0;
const noTimeoutPublication = await waitForReplyPublication(async () => {
  publicationPolls += 1;
  return {
    response: { ok: true },
    json: {
      replyPublication: publicationPolls < 3
        ? { state: 'pending' }
        : { state: 'ready', payload: { text: 'done' } },
    },
  };
}, 'session_poll_test', 'response_poll_test', {
  timeoutMs: 0,
  intervalMs: 1,
});
assert.equal(noTimeoutPublication.state, 'ready');
assert.equal(publicationPolls, 3, 'timeoutMs=0 should wait until a terminal reply publication');

assert.equal(
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', threadId: 'thread_a' }),
  'feishu:topic:chat_topic_test:thread_a',
  'topic messages should queue by topic, not only by group chat',
);
assert.equal(
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', rootId: 'root_a' }),
  'feishu:topic:chat_topic_test:root_a',
  'root-id topic messages should queue by topic root',
);
assert.notEqual(
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', threadId: 'thread_a' }),
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', threadId: 'thread_b' }),
  'different topics in the same group should use different queue keys',
);
assert.equal(
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', messageId: 'msg_a' }),
  buildFeishuQueueKey({ chatType: 'group', chatId: 'chat_topic_test', messageId: 'msg_b' }),
  'non-topic group messages should still serialize by group chat',
);
assert.deepEqual(
  buildFeishuMessageIndexRecord({
    tenantKey: 'tenant_topic_test',
    chatType: 'group',
    chatId: 'chat_topic_test',
    messageId: 'msg_topic_root_index',
    threadId: 'thread_topic_index',
  }, 'sess_topic_index'),
  {
    connector: 'feishu',
    accountId: 'tenant_topic_test',
    messageId: 'msg_topic_root_index',
    sessionId: 'sess_topic_index',
    chatId: 'chat_topic_test',
    conversationId: 'thread_topic_index',
    externalTriggerId: 'feishu:topic:chat_topic_test:thread_topic_index',
    direction: 'inbound',
  },
  'Feishu message index records should keep connector, message, session, and conversation identity',
);

const summary = {
  messageId: 'msg_test_1',
  chatId: 'chat_test_1',
  messageType: 'text',
  sender: {
    senderType: 'user',
  },
};

let sendCalls = 0;
const handled = [];

await handleMessage(runtime, summary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_test_1',
    runId: 'run_test_1',
    requestId: 'request_test_1',
    duplicate: false,
    replyText: '',
  }),
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'empty assistant replies should not be sent to Feishu');
assert.equal(handled.length, 1, 'empty assistant replies should still be marked handled');
assert.equal(handled[0].messageId, summary.messageId);
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');
assert.equal(handled[0].metadata.sessionId, 'session_test_1');
assert.equal(runtime.processingMessageIds.size, 0, 'message processing state should always be cleaned up');

const confirmationTexts = [];
sendCalls = 0;
handled.length = 0;
runtime.config = { silentConfirmationText: '[委屈]' };

await handleMessage(runtime, { ...summary, messageId: 'msg_test_confirmation_1' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_confirmation_test_1',
    runId: 'run_confirmation_test_1',
    requestId: 'request_confirmation_test_1',
    duplicate: false,
    replyText: '',
  }),
  sendFeishuText: async (_runtime, _summary, text) => {
    sendCalls += 1;
    confirmationTexts.push(text);
    return { message_id: 'out_confirmation_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'emoji-only confirmation text should be stripped before sending');
assert.deepEqual(confirmationTexts, []);
assert.equal(handled.length, 1, 'confirmation sends should still be marked handled');
assert.equal(handled[0].messageId, 'msg_test_confirmation_1');
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');
assert.equal(handled[0].metadata.responseMessageId, undefined);

runtime.config = { silentConfirmationText: '已收到。' };
sendCalls = 0;
handled.length = 0;

await handleMessage(runtime, { ...summary, messageId: 'msg_test_confirmation_plain_1' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_confirmation_plain_test_1',
    runId: 'run_confirmation_plain_test_1',
    requestId: 'request_confirmation_plain_test_1',
    duplicate: false,
    replyText: '',
  }),
  sendFeishuText: async (_runtime, _summary, text) => {
    sendCalls += 1;
    confirmationTexts.push(text);
    return { message_id: 'out_confirmation_plain_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 1, 'plain-text confirmations should still be sent');
assert.equal(confirmationTexts.at(-1), '已收到。');
assert.equal(handled.length, 1, 'plain-text confirmation sends should still be marked handled');
assert.equal(handled[0].messageId, 'msg_test_confirmation_plain_1');
assert.equal(handled[0].metadata.status, 'confirmation_sent');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');
assert.equal(handled[0].metadata.responseMessageId, 'out_confirmation_plain_test_1');
const outboundConfirmationIndexRecord = await findConnectorMessageIndexRecord(runtime.storagePaths.messageIndexPath, {
  connector: 'feishu',
  messageId: 'out_confirmation_plain_test_1',
  chatId: 'chat_test_1',
});
assert.equal(outboundConfirmationIndexRecord?.sessionId, 'session_confirmation_plain_test_1');
assert.equal(outboundConfirmationIndexRecord?.sourceMessageId, 'msg_test_confirmation_plain_1');
assert.equal(outboundConfirmationIndexRecord?.direction, 'outbound');

const connectorLockDir = join(tempHome, 'connector-lock');
const claimedLock = await claimConnectorPidLock(connectorLockDir, 54321);
assert.equal(claimedLock.processId, 54321, 'pid lock should return the claimed process id');
assert.equal(
  (await readFile(claimedLock.pidPath, 'utf8')).trim(),
  '54321',
  'pid lock should persist the claimed pid',
);
releaseConnectorPidLock(claimedLock);

await writeFile(claimedLock.pidPath, `${process.pid}\n`);
await assert.rejects(
  claimConnectorPidLock(connectorLockDir, 65432),
  /already running/,
  'pid lock should reject when another live connector already owns the lock',
);

await writeFile(claimedLock.pidPath, '999999\n');
const recoveredLock = await claimConnectorPidLock(connectorLockDir, 65432);
assert.equal(
  (await readFile(recoveredLock.pidPath, 'utf8')).trim(),
  '65432',
  'pid lock should recover stale lock files',
);
releaseConnectorPidLock(recoveredLock);

sendCalls = 0;
handled.length = 0;

await handleMessage(runtime, { ...summary, messageId: 'msg_test_duplicate_1' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_duplicate_test_1',
    runId: '',
    requestId: 'request_duplicate_test_1',
    duplicate: true,
    queued: false,
    replyText: '',
  }),
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_duplicate_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'duplicate no-reply paths should not send silent confirmations');
assert.equal(handled.length, 1, 'duplicate no-reply paths should still be marked handled');
assert.equal(handled[0].metadata.reason, 'duplicate_request');

let reactionCalls = [];
sendCalls = 0;
handled.length = 0;
runtime.config = { processingReaction: { removeOnCompletion: false } };

await handleMessage(runtime, { ...summary, messageId: 'msg_test_processing_reaction' }, 'test', {
  wasMessageHandled: async () => false,
  addProcessingReaction: async (_runtime, reactionSummary) => {
    reactionCalls.push(['add', reactionSummary.messageId]);
    return { reactionId: 'react_test_1', emojiType: 'GLANCE' };
  },
  generateRemoteLabReply: async () => {
    reactionCalls.push(['generate']);
    return {
      sessionId: 'session_reaction_test_1',
      runId: 'run_reaction_test_1',
      requestId: 'request_reaction_test_1',
      duplicate: false,
      replyText: 'Reaction-backed reply.',
    };
  },
  sendFeishuText: async () => {
    reactionCalls.push(['send']);
    sendCalls += 1;
    return { message_id: 'out_reaction_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.deepEqual(reactionCalls, [
  ['add', 'msg_test_processing_reaction'],
  ['generate'],
  ['send'],
], 'processing reactions should stay attached by default after the long-running reply path');
assert.equal(sendCalls, 1, 'non-empty assistant replies should still be sent');
assert.equal(handled.length, 1, 'reaction-backed replies should still be marked handled');
assert.equal(handled[0].metadata.status, 'sent');

reactionCalls = [];
sendCalls = 0;
handled.length = 0;
runtime.config = { processingReaction: { removeOnCompletion: true } };

await handleMessage(runtime, { ...summary, messageId: 'msg_test_processing_reaction_silent' }, 'test', {
  wasMessageHandled: async () => false,
  addProcessingReaction: async (_runtime, reactionSummary) => {
    reactionCalls.push(['add', reactionSummary.messageId]);
    return { reactionId: 'react_test_2', emojiType: 'GLANCE' };
  },
  generateRemoteLabReply: async () => {
    reactionCalls.push(['generate']);
    return {
      sessionId: 'session_reaction_test_2',
      runId: 'run_reaction_test_2',
      requestId: 'request_reaction_test_2',
      duplicate: false,
      replyText: '',
    };
  },
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_reaction_test_2' };
  },
  removeProcessingReaction: async (_runtime, reactionSummary, reaction) => {
    reactionCalls.push(['remove', reactionSummary.messageId, reaction.reactionId]);
    return true;
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.deepEqual(reactionCalls, [
  ['add', 'msg_test_processing_reaction_silent'],
  ['generate'],
  ['remove', 'msg_test_processing_reaction_silent', 'react_test_2'],
], 'processing reactions should still be removable when explicitly configured');
assert.equal(sendCalls, 0, 'silent assistant replies should not send Feishu messages');
assert.equal(handled.length, 1, 'silent reaction-backed replies should still be marked handled');
assert.equal(handled[0].metadata.status, 'silent_no_reply');

const imageSummary = summarizeEvent({
  event_id: 'evt_image_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_image_1',
  sender: {
    sender_id: { open_id: 'ou_image_1' },
    sender_type: 'user',
    tenant_key: 'tenant_image_1',
  },
  message: {
    chat_id: 'chat_image_1',
    chat_type: 'group',
    message_id: 'msg_image_1',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v2_1' }),
  },
});

assert.equal(imageSummary.textPreview, '', 'image payloads should not fake a text preview');
assert.equal(imageSummary.contentSummary, 'Image attachment');
assert.deepEqual(imageSummary.contentKeys, ['image_key']);
assert.deepEqual(imageSummary.imageKeys, ['img_v2_1']);

let resourceDownloadPayload = null;
const pngBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const imageAttachments = await resolveFeishuMessageAttachments({
  appClient: {
    im: {
      v1: {
        messageResource: {
          get: async (payload) => {
            resourceDownloadPayload = payload;
            return {
              headers: {
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename="drawing.png"',
              },
              getReadableStream: () => Readable.from([pngBuffer]),
            };
          },
        },
      },
    },
  },
}, imageSummary);

assert.deepEqual(resourceDownloadPayload, {
  params: { type: 'image' },
  path: { message_id: 'msg_image_1', file_key: 'img_v2_1' },
});
assert.equal(imageAttachments.failures.length, 0, 'image resource downloads should not report failures on success');
assert.equal(imageAttachments.attachments.length, 1);
assert.equal(imageAttachments.attachments[0].mimeType, 'image/png', 'image MIME type should be detected from bytes when Feishu returns octet-stream');
assert.equal(imageAttachments.attachments[0].originalName, 'drawing.png');
assert.equal(imageAttachments.attachments[0].data, pngBuffer.toString('base64'));

const richPostSummary = summarizeEvent({
  event_id: 'evt_post_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_post_1',
  sender: {
    sender_id: { open_id: 'ou_post_1' },
    sender_type: 'user',
    tenant_key: 'tenant_post_1',
  },
  message: {
    chat_id: 'chat_post_1',
    chat_type: 'group',
    message_id: 'msg_post_1',
    message_type: 'post',
    content: JSON.stringify({
      title: 'Weekly update',
      content: [[
        { tag: 'text', text: 'Alpha milestone' },
        { tag: 'text', text: 'Beta follow-up' },
      ]],
    }),
  },
});

assert.match(richPostSummary.contentSummary, /Rich text post/i);
assert.match(richPostSummary.contentSummary, /Weekly update/i);
assert.equal(richPostSummary.messageText, 'Weekly update\nAlpha milestoneBeta follow-up');

sendCalls = 0;
handled.length = 0;
let richPostRemoteLabMessage = '';

await handleMessage(runtime, richPostSummary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async (_runtime, postSummary) => {
    richPostRemoteLabMessage = buildRemoteLabMessage(postSummary);
    return {
      sessionId: 'session_test_post',
      runId: 'run_test_post',
      requestId: 'request_test_post',
      duplicate: false,
      replyText: '收到富文本。',
    };
  },
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_post' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.match(richPostRemoteLabMessage, /Weekly update/);
assert.match(richPostRemoteLabMessage, /Alpha milestone/);
assert.equal(sendCalls, 1, 'textual rich-post payloads should be sent through RemoteLab');
assert.equal(handled.length, 1, 'textual rich-post payloads should be marked handled after reply');
assert.equal(handled[0].messageId, 'msg_post_1');
assert.equal(handled[0].metadata.status, 'sent');

const richPostImageSummary = summarizeEvent({
  event_id: 'evt_post_image_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_post_image_1',
  sender: {
    sender_id: { open_id: 'ou_post_image_1' },
    sender_type: 'user',
    tenant_key: 'tenant_post_image_1',
  },
  message: {
    chat_id: 'chat_post_image_1',
    chat_type: 'group',
    message_id: 'msg_post_image_1',
    message_type: 'post',
    content: JSON.stringify({
      content: [[
        { tag: 'img', image_key: 'img_post_v2_1' },
        { tag: 'text', text: ' 这个是主页图' },
      ]],
    }),
  },
});

assert.deepEqual(richPostImageSummary.imageKeys, ['img_post_v2_1']);
assert.equal(richPostImageSummary.messageText, '[image] 这个是主页图');
assert.equal(buildRemoteLabMessage(richPostImageSummary), '[image] 这个是主页图');

const longPostSummary = summarizeEvent({
  event_id: 'evt_post_long_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_post_long_1',
  sender: {
    sender_id: { open_id: 'ou_post_long_1' },
    sender_type: 'user',
    tenant_key: 'tenant_post_long_1',
  },
  message: {
    chat_id: 'chat_post_long_1',
    chat_type: 'group',
    message_id: 'msg_post_long_1',
    message_type: 'post',
    mentions: [{
      key: '@_user_1',
      name: 'Rowan',
      id: { open_id: 'ou_rowan_1' },
    }],
    content: JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'at', user_id: '@_user_1', user_name: 'Rowan' },
          { tag: 'text', text: ' 审核该口播稿' },
        ],
        ...Array.from({ length: 12 }, (_unused, index) => [{ tag: 'text', text: `第 ${index + 1} 行` }]),
      ],
    }),
  },
});

assert.equal(
  longPostSummary.messageText.split('\n').length,
  13,
  'rich post extraction should preserve all paragraph lines, not just preview fragments',
);
assert.match(longPostSummary.messageText, /^@Rowan 审核该口播稿/);
assert.match(longPostSummary.messageText, /第 12 行$/);
assert.match(buildRemoteLabMessage(longPostSummary), /第 12 行$/);

const topicSummary = summarizeEvent({
  event_id: 'evt_topic_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_topic_1',
  sender: {
    sender_id: { open_id: 'ou_topic_1' },
    sender_type: 'user',
    tenant_key: 'tenant_topic_1',
  },
  message: {
    chat_id: 'chat_topic_1',
    chat_type: 'group',
    group_message_type: 'thread',
    chat_mode: 'group',
    message_id: 'msg_topic_reply_1',
    root_id: 'msg_topic_root_1',
    parent_id: 'msg_topic_root_1',
    thread_id: 'thread_topic_1',
    message_type: 'text',
    content: JSON.stringify({ text: 'topic scoped question' }),
  },
});

assert.equal(topicSummary.groupMessageType, 'thread');
assert.equal(topicSummary.threadId, 'thread_topic_1');
assert.equal(
  buildExternalTriggerId(topicSummary),
  'feishu:topic:chat_topic_1:thread_topic_1',
  'topic-group messages should use a topic-scoped RemoteLab session key',
);
assert.deepEqual(buildSessionSourceContext(topicSummary), {
  connector: 'feishu',
  conversationKind: 'topic',
  chatType: 'group',
  chatId: 'chat_topic_1',
  groupMessageType: 'thread',
  chatMode: 'group',
  topicId: 'thread_topic_1',
  threadId: 'thread_topic_1',
  rootId: 'msg_topic_root_1',
});
assert.equal(buildMessageSourceContext(topicSummary).topicId, 'thread_topic_1');
assert.equal(
  buildExternalTriggerId({ chatType: 'group', chatId: 'chat_topic_1', messageId: 'msg_normal_group_1' }),
  'feishu:group:chat_topic_1',
  'ordinary group messages should keep the original group-level RemoteLab session key',
);

sendCalls = 0;
handled.length = 0;
let imageInvokedRemoteLab = false;

await handleMessage(runtime, imageSummary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async (_runtime, inboundSummary) => {
    imageInvokedRemoteLab = true;
    assert.deepEqual(inboundSummary.imageKeys, ['img_v2_1']);
    assert.equal(buildRemoteLabMessage(inboundSummary), 'Image attachment');
    return {
      sessionId: 'session_test_image',
      runId: 'run_test_image',
      requestId: 'request_test_image',
      duplicate: false,
      replyText: '我看到了这张图。',
    };
  },
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_image' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(imageInvokedRemoteLab, true, 'image payloads should be submitted to RemoteLab instead of stopping as unsupported');
assert.equal(sendCalls, 1, 'image payloads with assistant replies should send Feishu replies');
assert.equal(handled.length, 1, 'image payloads should be marked handled after reply');
assert.equal(handled[0].messageId, 'msg_image_1');
assert.equal(handled[0].metadata.status, 'sent');
assert.equal(handled[0].metadata.sessionId, 'session_test_image');
assert.equal(runtime.processingMessageIds.size, 0, 'image payload processing state should always be cleaned up');

const authRefreshRuntime = {
  authCookie: 'session_token=stale-cookie',
  authToken: 'stale-token',
  config: { chatBaseUrl: 'http://127.0.0.1:7690' },
  readOwnerToken: async () => 'fresh-token',
  loginWithToken: async (_baseUrl, token) => `session_token=${token}`,
};

assert.equal(
  await ensureAuthCookie(authRefreshRuntime, false),
  'session_token=stale-cookie',
  'cached auth cookies should be reused when no refresh is needed',
);

assert.equal(
  await ensureAuthCookie(authRefreshRuntime, true),
  'session_token=fresh-token',
  'forced auth refresh should re-read the current owner token before logging in again',
);
assert.equal(authRefreshRuntime.authToken, 'fresh-token');
assert.equal(authRefreshRuntime.authCookie, 'session_token=fresh-token');

assert.equal(normalizeReplyText('  \n\n  '), '');
assert.equal(normalizeReplyText('  hello\r\n'), 'hello');
assert.equal(normalizeReplyText(' <private>internal only</private> '), '');
assert.equal(normalizeReplyText('  😺 hello [委屈]\r\n'), 'hello');
assert.equal(normalizeReplyText('好的😺，我来处理。'), '好的，我来处理。');

let feishuCreatePayload = null;
let feishuReplyPayload = null;
const fakeSendRuntime = {
  appClient: {
    im: {
      v1: {
        message: {
          create: async (payload) => {
            feishuCreatePayload = payload;
            return { code: 0, data: { message_id: 'out_create_1' } };
          },
          reply: async (payload) => {
            feishuReplyPayload = payload;
            return { code: 0, data: { message_id: 'out_reply_1', thread_id: 'thread_topic_1' } };
          },
        },
      },
    },
  },
};

await sendFeishuText(fakeSendRuntime, topicSummary, 'topic answer', 'uuid-topic-1');
assert.equal(feishuReplyPayload?.path?.message_id, 'msg_topic_reply_1');
assert.equal(feishuReplyPayload?.data?.reply_in_thread, true);
assert.equal(feishuReplyPayload?.data?.uuid, 'uuid-topic-1');
assert.equal(feishuReplyPayload?.data?.msg_type, 'post');
assert.match(feishuReplyPayload?.data?.content || '', /topic answer/);
assert.equal(feishuCreatePayload, null, 'topic-group replies should not fall back to chat-level create sends');

feishuCreatePayload = null;
feishuReplyPayload = null;
await sendFeishuText(
  fakeSendRuntime,
  topicSummary,
  'topic answer with long idempotency key',
  'feishu:msg:feishu:topic:chat_topic_1:thread_topic_1:0:content:'.repeat(3),
);
assert.match(feishuReplyPayload?.data?.uuid || '', /^rl_[a-f0-9]{32}$/);
assert.ok(
  (feishuReplyPayload?.data?.uuid || '').length <= 64,
  'long connector idempotency keys should be compressed before calling Feishu',
);

feishuCreatePayload = null;
feishuReplyPayload = null;
await sendFeishuText(
  fakeSendRuntime,
  { chatType: 'group', chatId: 'chat_regular_1', messageId: 'msg_regular_1' },
  'regular answer',
  'uuid-regular-1',
);
assert.equal(feishuReplyPayload, null, 'ordinary group replies should keep using chat-level create sends');
assert.equal(feishuCreatePayload?.params?.receive_id_type, 'chat_id');
assert.equal(feishuCreatePayload?.data?.receive_id, 'chat_regular_1');
assert.equal(feishuCreatePayload?.data?.msg_type, 'post');
assert.equal(feishuCreatePayload?.data?.uuid, 'uuid-regular-1');

sendCalls = 0;
handled.length = 0;

await handleMessage(runtime, { ...summary, messageId: 'msg_test_hidden_only' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_test_hidden',
    runId: 'run_test_hidden',
    requestId: 'request_test_hidden',
    duplicate: false,
    replyText: '  <private>internal only</private>  ',
  }),
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_hidden' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'hidden-only assistant replies should not be sent to Feishu');
assert.equal(handled.length, 1, 'hidden-only assistant replies should still be marked handled');
assert.equal(handled[0].messageId, 'msg_test_hidden_only');
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');

const explicitArtifactReply = await selectAssistantReplyEvent([
  {
    seq: 2,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_2',
    requestId: 'request_test_2',
    content: 'The real summary reply.',
  },
  {
    seq: 3,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_2',
    requestId: 'request_test_2',
    content: '[x] Inspect\n[x] Reply',
    messageKind: 'todo_list',
  },
], {
  match: (event) => event.runId === 'run_test_2',
});
assert.equal(explicitArtifactReply?.seq, 2, 'reply selection should skip explicit todo artifacts');

const hydratedLegacyReply = await selectAssistantReplyEvent([
  {
    seq: 2,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_3',
    requestId: 'request_test_3',
    content: '',
    bodyAvailable: true,
    bodyLoaded: false,
  },
  {
    seq: 3,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_3',
    requestId: 'request_test_3',
    content: '[x] Inspect\n[x] Reply',
  },
], {
  match: (event) => event.runId === 'run_test_3',
  hydrate: async (event) => ({
    ...event,
    content: 'Hydrated substantive reply.',
    bodyLoaded: true,
  }),
});
assert.equal(hydratedLegacyReply?.seq, 2, 'reply selection should fall back past a trailing legacy checklist');

const attachmentTextReply = await selectAssistantReplyEvent([
  {
    seq: 2,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_4',
    requestId: 'request_test_4',
    content: 'The report is ready.',
  },
  {
    seq: 3,
    type: 'attachment_delivery',
    role: 'assistant',
    runId: 'run_test_4',
    requestId: 'request_test_4',
    attachments: [{ originalName: 'report.csv', mimeType: 'text/csv' }],
    images: [{ originalName: 'report.csv', mimeType: 'text/csv' }],
  },
], {
  match: (event) => event.runId === 'run_test_4',
});
assert.equal(attachmentTextReply?.seq, 2, 'reply selection should keep the substantive text reply ahead of a later attachment delivery row');

const attachmentOnlyReply = await selectAssistantReplyEvent([
  {
    seq: 5,
    type: 'attachment_delivery',
    role: 'assistant',
    runId: 'run_test_5',
    requestId: 'request_test_5',
    attachments: [{ originalName: 'export.txt', mimeType: 'text/plain' }],
    images: [{ originalName: 'export.txt', mimeType: 'text/plain' }],
  },
], {
  match: (event) => event.runId === 'run_test_5',
});
assert.equal(attachmentOnlyReply?.seq, 5, 'reply selection should fall back to attachment-only deliveries when no text reply exists');

const mentionSummary = {
  chatType: 'group',
  chatId: 'chat_group_1',
  messageId: 'msg_group_1',
  textPreview: '厉害不，@_user_1 你发一条消息',
  mentions: [{
    key: '@_user_1',
    name: '江虹',
    openId: 'ou_mention_1',
    unionId: 'on_mention_1',
  }],
};

const mentionPrompt = buildRemoteLabMessage(mentionSummary);
assert.equal(mentionPrompt, '厉害不，@江虹 你发一条消息');
assert.doesNotMatch(mentionPrompt, /open_id=|union_id=|Chat type:|Thread ID:|Sender:/);
assert.doesNotMatch(mentionPrompt, /^Group chat\./);
assert.doesNotMatch(mentionPrompt, /If you need to mention someone in your reply, use these exact tokens:/);
assert.doesNotMatch(mentionPrompt, /Write the exact plain-text Feishu reply to send back/);

assert.equal(
  buildSessionDescription({
    chatType: 'group',
    chatId: 'chat_group_1',
    sender: { openId: 'ou_sender_1' },
  }),
  'Inbound Feishu group chat',
  'session descriptions should stay human-readable instead of embedding transport IDs',
);

assert.match(DEFAULT_SESSION_SYSTEM_PROMPT, /Keep connector-specific overrides minimal/i);

const tempConfigDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-config-'));
const tempConfigPath = join(tempConfigDir, 'config.json');
await writeFile(tempConfigPath, `${JSON.stringify({
  appId: 'cli_test',
  appSecret: 'secret_test',
  region: 'feishu-cn',
  chatBaseUrl: 'http://127.0.0.1:7690',
}, null, 2)}\n`, 'utf8');

const loadedConfig = await loadConfig(tempConfigPath);
assert.equal(loadedConfig.systemPrompt, '', 'default config should rely on backend-owned source prompt logic');
assert.equal(loadedConfig.runtimeSelectionMode, 'ui');
assert.deepEqual(loadedConfig.processingReaction, {
  enabled: false,
  emojiType: 'THINKING',
  removeOnCompletion: false,
}, 'processing reactions should default to disabled');
assert.equal(loadedConfig.silentConfirmationText, '', 'silent confirmations should default to disabled');

assert.deepEqual(normalizeProcessingReactionConfig(true), {
  enabled: true,
  emojiType: 'THINKING',
  removeOnCompletion: false,
});
assert.deepEqual(normalizeProcessingReactionConfig('wronged'), {
  enabled: true,
  emojiType: 'WRONGED',
  removeOnCompletion: false,
});
assert.deepEqual(normalizeProcessingReactionConfig('fingerheart'), {
  enabled: true,
  emojiType: 'FINGERHEART',
  removeOnCompletion: false,
});
assert.deepEqual(normalizeProcessingReactionConfig('thinking'), {
  enabled: true,
  emojiType: 'THINKING',
  removeOnCompletion: false,
});
assert.deepEqual(normalizeProcessingReactionConfig({
  enabled: true,
  emojiType: 'smart',
  removeOnCompletion: false,
}), {
  enabled: true,
  emojiType: 'SMART',
  removeOnCompletion: false,
});

assert.equal(
  compileFeishuReplyText('@_user_1 这是一条消息。', mentionSummary.mentions),
  '<at user_id="ou_mention_1">江虹</at> 这是一条消息。',
  'reply mention tokens should compile into Feishu mention tags before sending',
);
assert.equal(
  compileFeishuReplyText('@江虹 这是一条消息。', mentionSummary.mentions),
  '<at user_id="ou_mention_1">江虹</at> 这是一条消息。',
  'natural @displayName mentions should also compile into Feishu mention tags',
);
assert.equal(
  compileFeishuReplyText('😺 @_user_1 [委屈] 这是一条消息。', mentionSummary.mentions),
  '<at user_id="ou_mention_1">江虹</at> 这是一条消息。',
  'outbound emoji and sticker aliases should be stripped before mention compilation',
);

const markdownPostContent = JSON.parse(buildFeishuPostContent('**重点**\n\n- 第一项\n- 第二项'));
assert.deepEqual(markdownPostContent.zh_cn.content, [
  [{ tag: 'md', text: '**重点**' }],
  [{ tag: 'text', text: '\u200B' }],
  [{ tag: 'md', text: '- 第一项' }],
  [{ tag: 'md', text: '- 第二项' }],
]);

const mentionPostContent = JSON.parse(buildFeishuPostContent('@_user_1 请看 **这段**', mentionSummary.mentions));
assert.deepEqual(mentionPostContent.zh_cn.content[0], [
  { tag: 'at', user_id: 'ou_mention_1', user_name: '江虹' },
  { tag: 'md', text: ' 请看 **这段**' },
]);

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-whitelist-'));
const whitelistPath = join(tempDir, 'allowed-senders.json');
const whitelistPolicy = {
  mode: 'whitelist',
  allowedSendersPath: whitelistPath,
  allowedSenders: {
    openIds: ['ou_bootstrap_only'],
    userIds: [],
    unionIds: [],
    tenantKeys: [],
  },
};

await ensureAllowedSendersFile(whitelistPath, whitelistPolicy.allowedSenders);

await writeFile(whitelistPath, `${JSON.stringify({
  openIds: ['ou_dynamic_first'],
  userIds: [],
  unionIds: [],
  tenantKeys: [],
}, null, 2)}\n`, 'utf8');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_first' },
}), true, 'whitelist file should allow the current openId');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_bootstrap_only' },
}), false, 'once the whitelist file exists, it should be the live source of truth');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_second' },
}), false, 'unknown openIds should still be blocked');

await writeFile(whitelistPath, `${JSON.stringify({
  openIds: ['ou_dynamic_second'],
  userIds: [],
  unionIds: [],
  tenantKeys: [],
}, null, 2)}\n`, 'utf8');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_first' },
}), false, 'policy checks should re-read the whitelist file without restart');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_second' },
}), true, 'newly written whitelist entries should take effect immediately');

const accessStateDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-access-state-'));
const accessStatePath = join(accessStateDir, 'access-state.json');
const accessAllowedSendersPath = join(accessStateDir, 'allowed-senders.json');
const accessPolicy = {
  mode: 'whitelist',
  accessStatePath,
  allowedSendersPath: accessAllowedSendersPath,
  allowedSenders: {
    openIds: ['ou_owner_1'],
    userIds: ['usr_owner_1'],
    unionIds: ['on_owner_1'],
    tenantKeys: [],
  },
};

const accessState = await loadPersistedAccessState(accessPolicy);
const accessRuntime = createRuntimeContext({
  appId: 'cli_test',
  appSecret: 'test-secret',
  region: 'feishu-cn',
  loggerLevel: 'error',
  intakePolicy: accessPolicy,
  storeRawEvents: false,
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  sessionTool: 'codex',
  systemPrompt: 'Reply with plain text only.',
  thinking: false,
  model: '',
  effort: '',
}, {
  eventsLogPath: join(accessStateDir, 'events.jsonl'),
  knownSendersPath: join(accessStateDir, 'known-senders.json'),
  handledMessagesPath: join(accessStateDir, 'handled-messages.json'),
}, accessState);

const approveSummary = {
  messageId: 'msg_group_approve_1',
  chatId: 'chat_group_approve_1',
  chatType: 'group',
  messageType: 'text',
  textPreview: '@_user_1 授权本群',
  tenantKey: 'tenant_group_1',
  mentions: [{
    key: '@_user_1',
    name: 'rowan',
    openId: 'ou_bot_1',
  }],
  sender: {
    openId: 'ou_owner_1',
    userId: 'usr_owner_1',
    unionId: 'on_owner_1',
    senderType: 'user',
    tenantKey: 'tenant_group_1',
  },
};
accessRuntime.chatMetadataCache.set('chat_group_approve_1', {
  name: 'Family Group',
  groupMessageType: 'chat',
  chatMode: 'group',
  chatType: 'group',
});

assert.equal(extractLocalCommand(approveSummary)?.type, 'approve_current_chat');

let localCommandReply = '';
const localCommandHandled = [];

await handleMessage(accessRuntime, approveSummary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => {
    throw new Error('local group approval should not invoke RemoteLab');
  },
  sendFeishuText: async (_runtime, _summary, text) => {
    localCommandReply = text;
    return { message_id: 'out_group_approve_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    localCommandHandled.push({ messageId, metadata });
  },
});

assert.match(localCommandReply, /chat_id=chat_group_approve_1/);
assert.equal(localCommandHandled.length, 1, 'local command should still mark the message handled');
assert.equal(localCommandHandled[0].metadata.status, 'approved_chat');

const persistedApproval = JSON.parse(await readFile(accessStatePath, 'utf8'));
assert.equal(persistedApproval.approvedChats.chat_group_approve_1.chatId, 'chat_group_approve_1');
assert.equal(persistedApproval.approvedChats.chat_group_approve_1.autoApproveNewMembers, true);

const joinSummary = summarizeChatMemberUserAddedEvent({
  event_id: 'event_join_1',
  event_type: 'im.chat.member.user.added_v1',
  tenant_key: 'tenant_group_1',
  app_id: 'cli_test',
  chat_id: 'chat_group_approve_1',
  name: 'Family Group',
  users: [{
    name: 'New Member',
    tenant_key: 'tenant_group_1',
    user_id: {
      open_id: 'ou_new_user_1',
      user_id: 'usr_new_user_1',
      union_id: 'on_new_user_1',
    },
  }],
});

const joinResult = await handleChatMemberUserAdded(accessRuntime, joinSummary, { demo: true }, 'im.chat.member.user.added_v1');
assert.equal(joinResult.approved, true);
assert.equal(joinResult.grantedCount, 1, 'approved chats should auto-grant newly joined members');

assert.equal(await isAllowedByPolicy(accessPolicy, {
  tenantKey: 'tenant_group_1',
  sender: { openId: 'ou_new_user_1' },
}, accessRuntime.access), true, 'joined users should be allowed immediately from in-memory cache');

const persistedAfterJoin = JSON.parse(await readFile(accessStatePath, 'utf8'));
assert.ok(persistedAfterJoin.allowedSenders.openIds.includes('ou_new_user_1'));
assert.ok(persistedAfterJoin.membershipGrants['chat_group_approve_1:ou_new_user_1']);
assert.equal(persistedAfterJoin.approvedChats.chat_group_approve_1.name, 'Family Group');

let createdPayload = null;
let submittedPayload = null;
let generatedReplyResourcePayload = null;
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createdPayload = JSON.parse(body || '{}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_feishu_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_feishu_1',
        latestSeq: 1,
        activity: {
          run: { state: 'idle' },
          queue: { count: 0 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_feishu_1/messages') {
    submittedPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_feishu_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_feishu_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_feishu_1', state: 'completed' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_1/responses/feishu%3Amsg_for_scope') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: 'feishu:msg_for_scope',
        responseIds: ['feishu:msg_for_scope'],
        state: 'ready',
        ready: true,
        rootRunId: 'run_feishu_1',
        finalRunId: 'run_feishu_1',
        continuationRunIds: [],
        payload: {
          text: 'Feishu reply ready.',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'assistant',
        runId: 'run_feishu_1',
        requestId: 'feishu:msg_for_scope',
        content: 'Feishu reply ready.',
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  await saveUiRuntimeSelection({
    selectedTool: 'claude',
    selectedModel: 'claude-sonnet-4-5',
    thinkingEnabled: true,
    reasoningKind: 'toggle',
  });
  const reply = await generateRemoteLabReply(
    {
      authCookie: 'session_token=test-cookie',
      authToken: 'ignored',
      config: {
        chatBaseUrl: `http://127.0.0.1:${address.port}`,
        sessionFolder: repoRoot,
        sessionTool: 'micro-agent',
        systemPrompt: 'Reply with plain text only.',
        thinking: false,
        model: 'gpt-5.4',
        effort: 'low',
      },
      appClient: {
        im: {
          v1: {
            messageResource: {
              get: async (payload) => {
                generatedReplyResourcePayload = payload;
                return {
                  headers: { 'content-type': 'image/jpeg' },
                  getReadableStream: () => Readable.from([jpegBuffer]),
                };
              },
            },
          },
        },
      },
    },
    {
      chatType: 'p2p',
      chatId: 'chat_for_scope',
      messageId: 'msg_for_scope',
      textPreview: 'Please confirm the app scope.',
      imageKeys: ['img_scope_1'],
      sender: { openId: 'ou_scope_test' },
    },
  );

  assert.equal(createdPayload?.sourceId, 'feishu');
  assert.equal(createdPayload?.sourceName, 'Feishu');
  assert.equal(createdPayload?.tool, 'claude');
  assert.equal(createdPayload?.name, '', 'Feishu connector should let RemoteLab auto-rename sessions from the turn content');
  assert.equal(createdPayload?.systemPrompt, 'Reply with plain text only.');
  assert.equal(createdPayload?.externalTriggerId, 'feishu:p2p:chat_for_scope');
  assert.equal(createdPayload?.sourceContext?.chatType, 'p2p');
  assert.equal(createdPayload?.sourceContext?.chatId, 'chat_for_scope');
  assert.equal(submittedPayload?.tool, 'claude');
  assert.equal(submittedPayload?.model, 'claude-sonnet-4-5');
  assert.equal(submittedPayload?.thinking, true);
  assert.equal(submittedPayload?.effort, undefined);
  assert.equal(submittedPayload?.text, 'Please confirm the app scope.');
  assert.deepEqual(generatedReplyResourcePayload, {
    params: { type: 'image' },
    path: { message_id: 'msg_for_scope', file_key: 'img_scope_1' },
  });
  assert.equal(submittedPayload?.attachments?.length, 1);
  assert.equal(submittedPayload.attachments[0].mimeType, 'image/jpeg');
  assert.equal(submittedPayload.attachments[0].originalName, 'img_scope_1.jpg');
  assert.equal(submittedPayload.attachments[0].data, jpegBuffer.toString('base64'));
  assert.equal(submittedPayload?.sourceContext?.messageId, 'msg_for_scope');
  assert.equal(submittedPayload?.sourceContext?.chatType, 'p2p');
  assert.deepEqual(submittedPayload?.sourceContext?.attachments, { imageCount: 1 });
  assert.equal(reply.sessionId, 'sess_feishu_1');
  assert.equal(reply.runId, 'run_feishu_1');
  assert.equal(reply.attachmentCount, 1);
  assert.equal(reply.replyText, 'Feishu reply ready.');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempHome, { recursive: true, force: true });
}

const topicForkTempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-topic-fork-'));
const topicForkIndexPath = join(topicForkTempDir, 'connector-message-index.json');
await upsertConnectorMessageIndexRecord(topicForkIndexPath, {
  connector: 'feishu',
  accountId: 'tenant_topic_fork',
  messageId: 'msg_topic_parent_1',
  sessionId: 'sess_parent_topic_fork',
  chatId: 'chat_topic_fork_1',
  externalTriggerId: 'feishu:group:chat_topic_fork_1',
});
await upsertConnectorMessageIndexRecord(topicForkIndexPath, {
  connector: 'feishu',
  accountId: 'tenant_topic_fork',
  messageId: 'bot_reply_topic_parent_1',
  sessionId: 'sess_parent_topic_fork',
  chatId: 'chat_topic_fork_1',
  externalTriggerId: 'feishu:group:chat_topic_fork_1',
  sourceMessageId: 'msg_topic_parent_1',
  direction: 'outbound',
});

let topicForkPayload = null;
let topicForkSubmittedPayload = null;
let topicFreshCreateCalled = false;
const topicForkServer = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'GET' && req.url === '/api/sessions?sourceId=feishu') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessions: [{
        id: 'sess_parent_topic_fork',
        sourceId: 'feishu',
        externalTriggerId: 'feishu:group:chat_topic_fork_1',
      }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_parent_topic_fork') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_parent_topic_fork',
        sourceId: 'feishu',
        sourceContext: { connector: 'feishu', chatId: 'chat_topic_fork_1' },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_parent_topic_fork/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 2,
        type: 'message',
        role: 'user',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fork_1',
          messageId: 'msg_topic_parent_1',
        },
      }],
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_parent_topic_fork/fork') {
    topicForkPayload = JSON.parse(body || '{}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_topic_child_1' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions') {
    topicFreshCreateCalled = true;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_unexpected_fresh_topic' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_topic_child_1/messages') {
    topicForkSubmittedPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_topic_child_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_child_1/responses/feishu%3Amsg_topic_child_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        state: 'ready',
        ready: true,
        finalRunId: 'run_topic_child_1',
        payload: { text: 'Topic fork reply.' },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_child_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: [] }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => topicForkServer.listen(0, '127.0.0.1', resolve));

try {
  const address = topicForkServer.address();
  const topicSummaryForParent = {
    tenantKey: 'tenant_topic_fork',
    chatType: 'group',
    chatId: 'chat_topic_fork_1',
    messageId: 'msg_topic_child_1',
    rootId: 'msg_topic_parent_1',
    parentId: 'msg_topic_parent_1',
    threadId: 'thread_topic_child_1',
    textPreview: 'Continue this in a topic.',
    sender: { openId: 'ou_topic_fork', tenantKey: 'tenant_topic_fork' },
  };
  const parentSessionId = await resolveFeishuTopicForkParentSessionId(
    {
      storagePaths: { messageIndexPath: topicForkIndexPath },
    },
    async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const text = await response.text();
      return { response, text, json: text ? JSON.parse(text) : null };
    },
    topicSummaryForParent,
  );
  assert.equal(parentSessionId, 'sess_parent_topic_fork');
  const factsOnlyParentSessionId = await resolveFeishuTopicForkParentSessionId(
    {
      storagePaths: { messageIndexPath: join(topicForkTempDir, 'empty-index.json') },
    },
    async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const text = await response.text();
      return { response, text, json: text ? JSON.parse(text) : null };
    },
    topicSummaryForParent,
  );
  assert.equal(factsOnlyParentSessionId, 'sess_parent_topic_fork', 'topic parent lookup should fall back to session/events facts when the rebuildable index misses');
  const botReplyParentSessionId = await resolveFeishuTopicForkParentSessionId(
    {
      storagePaths: { messageIndexPath: topicForkIndexPath },
    },
    async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const text = await response.text();
      return { response, text, json: text ? JSON.parse(text) : null };
    },
    {
      ...topicSummaryForParent,
      messageId: 'msg_topic_child_from_bot_reply_1',
      rootId: 'topic_root_independent_1',
      parentId: 'bot_reply_topic_parent_1',
      threadId: 'thread_topic_from_bot_reply_1',
    },
  );
  assert.equal(
    botReplyParentSessionId,
    'sess_parent_topic_fork',
    'topic parent lookup should try parentId when rootId is an independent topic root id',
  );
  const handledOnlyPath = join(topicForkTempDir, 'handled-only.json');
  await writeFile(handledOnlyPath, JSON.stringify({
    messages: {
      msg_topic_parent_1: {
        status: 'sent',
        chatId: 'chat_topic_fork_1',
        sessionId: 'sess_parent_topic_fork',
        responseMessageId: 'legacy_bot_reply_topic_parent_1',
      },
    },
  }));
  const handledOnlyParentSessionId = await resolveFeishuTopicForkParentSessionId(
    {
      storagePaths: {
        handledMessagesPath: handledOnlyPath,
        messageIndexPath: join(topicForkTempDir, 'handled-only-empty-index.json'),
      },
    },
    async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const text = await response.text();
      return { response, text, json: text ? JSON.parse(text) : null };
    },
    {
      ...topicSummaryForParent,
      messageId: 'msg_topic_child_from_legacy_bot_reply_1',
      rootId: 'legacy_bot_reply_topic_parent_1',
      parentId: 'legacy_bot_reply_topic_parent_1',
      threadId: 'thread_topic_from_legacy_bot_reply_1',
    },
  );
  assert.equal(
    handledOnlyParentSessionId,
    'sess_parent_topic_fork',
    'topic parent lookup should backfill legacy outbound bot replies from handled messages',
  );

  const reply = await generateRemoteLabReply(
    {
      authCookie: 'session_token=test-cookie',
      authToken: 'ignored',
      storagePaths: { messageIndexPath: topicForkIndexPath },
      config: {
        chatBaseUrl: `http://127.0.0.1:${address.port}`,
        sessionFolder: repoRoot,
        sessionTool: 'codex',
        systemPrompt: 'Reply with plain text only.',
      },
      appClient: {},
    },
    topicSummaryForParent,
  );

  assert.equal(topicFreshCreateCalled, false, 'new topics with a verified parent should fork instead of fresh-create');
  assert.equal(topicForkPayload?.externalTriggerId, 'feishu:topic:chat_topic_fork_1:thread_topic_child_1');
  assert.equal(topicForkPayload?.sourceContext?.conversationKind, 'topic');
  assert.equal(topicForkPayload?.sourceContext?.chatId, 'chat_topic_fork_1');
  assert.equal(topicForkPayload?.sourceContext?.topicId, 'thread_topic_child_1');
  assert.equal(topicForkSubmittedPayload?.sourceContext?.messageId, 'msg_topic_child_1');
  assert.equal(reply.sessionId, 'sess_topic_child_1');
  assert.equal(reply.replyText, 'Topic fork reply.');
} finally {
  await new Promise((resolve) => topicForkServer.close(resolve));
  await rm(topicForkTempDir, { recursive: true, force: true });
}

let planningSubmittedPayload = null;
const planningServer = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'POST' && req.url === '/api/sessions') {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_feishu_planning_1',
        latestSeq: 11,
        activity: {
          run: { state: 'idle' },
          queue: { count: 0 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_feishu_planning_1/messages') {
    planningSubmittedPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      response: {
        id: 'feishu:msg_planning_scope',
        state: 'checking',
      },
      run: null,
      queued: false,
      duplicate: false,
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_planning_1/responses/feishu%3Amsg_planning_scope') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: 'feishu:msg_planning_scope',
        responseIds: ['feishu:msg_planning_scope'],
        state: 'ready',
        ready: true,
        rootRunId: 'run_feishu_planning_1',
        finalRunId: 'run_feishu_planning_1',
        continuationRunIds: [],
        payload: {
          text: 'Planning reply is ready now.',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_planning_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 12,
        type: 'message',
        role: 'assistant',
        runId: 'run_feishu_planning_1',
        requestId: 'feishu:msg_planning_scope',
        content: 'Planning reply is ready now.',
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => planningServer.listen(0, '127.0.0.1', resolve));

try {
  const address = planningServer.address();
  await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5.4',
    thinkingEnabled: false,
  });
  const reply = await generateRemoteLabReply(
    {
      authCookie: 'session_token=test-cookie',
      authToken: 'ignored',
      config: {
        chatBaseUrl: `http://127.0.0.1:${address.port}`,
        sessionFolder: repoRoot,
        sessionTool: 'codex',
        systemPrompt: 'Reply with plain text only.',
      },
    },
    {
      chatType: 'p2p',
      chatId: 'chat_planning_scope',
      messageId: 'msg_planning_scope',
      textPreview: 'Wait through the planning phase before replying.',
      sender: { openId: 'ou_scope_test_planning' },
    },
  );

  assert.equal(planningSubmittedPayload?.requestId, 'feishu:msg_planning_scope');
  assert.equal(reply.sessionId, 'sess_feishu_planning_1');
  assert.equal(reply.runId, 'run_feishu_planning_1');
  assert.equal(reply.queued, false);
  assert.equal(reply.replyText, 'Planning reply is ready now.');
} finally {
  await new Promise((resolve) => planningServer.close(resolve));
}

let queuedSubmittedPayload = null;
const queuedServer = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'POST' && req.url === '/api/sessions') {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_feishu_queued_1',
        latestSeq: 7,
        activity: {
          run: { state: 'idle' },
          queue: { count: 0 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_queued_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_feishu_queued_1',
        latestSeq: 7,
        activity: {
          run: { state: 'idle' },
          queue: { count: 0 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_feishu_queued_1/messages') {
    queuedSubmittedPayload = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      queued: true,
      run: null,
      session: {
        id: 'sess_feishu_queued_1',
        activity: {
          run: { state: 'running' },
          queue: { count: 1 },
          compact: { state: 'idle' },
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_queued_1/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [
        {
          seq: 8,
          type: 'message',
          role: 'user',
          runId: 'run_feishu_queued_1',
          requestId: 'queued_batch_internal',
          sourceContext: {
            queuedMessages: [{
              requestId: 'feishu:msg_queued_scope',
              sourceContext: {
                connector: 'feishu',
                messageId: 'msg_queued_scope',
                chatType: 'group',
              },
            }],
          },
        },
      ],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_feishu_queued_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_feishu_queued_1', state: 'completed' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_queued_1/responses/feishu%3Amsg_queued_scope') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: 'feishu:msg_queued_scope',
        responseIds: ['feishu:msg_queued_scope'],
        state: 'ready',
        ready: true,
        rootRunId: 'run_feishu_queued_1',
        finalRunId: 'run_feishu_queued_1',
        continuationRunIds: [],
        payload: {
          text: 'Queued reply is ready now.',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_queued_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 9,
        type: 'message',
        role: 'assistant',
        runId: 'run_feishu_queued_1',
        requestId: 'queued_batch_internal',
        content: 'Queued reply is ready now.',
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => queuedServer.listen(0, '127.0.0.1', resolve));

try {
  const address = queuedServer.address();
  await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: '',
    thinkingEnabled: false,
  });
  const reply = await generateRemoteLabReply(
    {
      authCookie: 'session_token=test-cookie',
      authToken: 'ignored',
      config: {
        chatBaseUrl: `http://127.0.0.1:${address.port}`,
        sessionFolder: repoRoot,
        sessionTool: 'codex',
        systemPrompt: 'Reply with plain text only.',
      },
    },
    {
      chatType: 'group',
      chatId: 'chat_queued_scope',
      messageId: 'msg_queued_scope',
      textPreview: 'Please wait until the queued reply is actually ready.',
      sender: { openId: 'ou_scope_test_queued' },
    },
  );

  assert.equal(queuedSubmittedPayload?.requestId, 'feishu:msg_queued_scope');
  assert.equal(reply.sessionId, 'sess_feishu_queued_1');
  assert.equal(reply.runId, 'run_feishu_queued_1');
  assert.equal(reply.queued, true);
  assert.equal(reply.replyText, 'Queued reply is ready now.');
} finally {
  await new Promise((resolve) => queuedServer.close(resolve));
}

console.log('ok - empty assistant replies stay silent');
console.log('ok - processing reactions bracket delayed Feishu replies');
console.log('ok - Feishu image payloads are downloaded and submitted as RemoteLab attachments');
console.log('ok - mention tokens are rendered inbound and compiled outbound');
console.log('ok - whitelist file reloads without restart');
console.log('ok - local group approval commands persist approved chats');
console.log('ok - approved chats auto-grant newly joined members');
console.log('ok - generated Feishu sessions use the feishu app scope');
console.log('ok - planning-phase Feishu replies wait for publication readiness');
console.log('ok - queued Feishu follow-ups wait for the eventual assistant reply');

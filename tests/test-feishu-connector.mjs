#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-feishu-connector-'));
process.env.HOME = tempHome;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.LARKSUITE_CLI_CONFIG_DIR;

const { selectAssistantReplyEvent } = await import(pathToFileURL(join(repoRoot, 'lib', 'reply-selection.mjs')).href);
const { waitForReplyPublication } = await import(pathToFileURL(join(repoRoot, 'lib', 'reply-publication-client.mjs')).href);
const { saveUiRuntimeSelection } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);

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
  initializeFeishuInstanceRuntime,
  loadConfig,
  loadPersistedAccessState,
  loadRemoteLabReplyAttachment,
  normalizeReplyText,
  normalizeProcessingReactionConfig,
  releaseConnectorPidLock,
  resolveFeishuMessageAttachments,
  resolveFeishuOutboundFileType,
  buildFeishuPostContent,
  buildExternalTriggerId,
  buildMessageSourceContext,
  buildSessionSourceContext,
  resolveFeishuTopicForkParentSessionId,
  sendFeishuAttachment,
  sendFeishuText,
  processSourceDeliveryOnce,
  summarizeChatMemberUserAddedEvent,
  summarizeEvent,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'feishu-connector.mjs')).href);

const connectorLauncherSource = await readFile(join(repoRoot, 'scripts', 'feishu-connector.mjs'), 'utf8');
assert.ok(
  connectorLauncherSource.indexOf('await claimConnectorPidLock(config.storageDir)')
    < connectorLauncherSource.indexOf('await initializeFeishuInstanceRuntime(config)'),
  'connector startup must claim its single-process lock before writing the shared lark-cli profile',
);

let initializedRuntimeProfile = null;
await initializeFeishuInstanceRuntime({
  appId: 'cli_runtime_test',
  appSecret: 'runtime_secret',
  region: 'feishu-cn',
  sessionFolder: tempHome,
}, {
  ensureProfile: async (options) => {
    initializedRuntimeProfile = options;
    return { configDir: options.configDir, identity: 'bot', strictMode: 'bot' };
  },
});
assert.equal(initializedRuntimeProfile.configDir, join(tempHome, 'config', 'lark-cli'));
assert.equal(initializedRuntimeProfile.appId, 'cli_runtime_test');
assert.equal(initializedRuntimeProfile.appSecret, 'runtime_secret');
assert.equal(initializedRuntimeProfile.brand, 'feishu');
assert.equal(initializedRuntimeProfile.cliPath, join(repoRoot, 'node_modules', '.bin', 'lark-cli'));

const runtime = {
  processingMessageIds: new Set(),
  storagePaths: {
    handledMessagesPath: '/tmp/remotelab-feishu-connector-test-handled.json',
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

const attachmentOnlySends = [];
handled.length = 0;
runtime.config = { silentConfirmationText: '' };
await handleMessage(runtime, { ...summary, messageId: 'msg_test_attachment_only_1' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_attachment_only_test_1',
    runId: 'run_attachment_only_test_1',
    requestId: 'request_attachment_only_test_1',
    responseId: 'response_attachment_only_test_1',
    duplicate: false,
    replyText: '',
    replyAttachments: [{
      assetId: 'fasset_attachment_only_1',
      originalName: 'attachment-only.txt',
      mimeType: 'text/plain',
    }],
  }),
  sendFeishuText: async () => {
    throw new Error('attachment-only replies must not send an empty text message');
  },
  sendFeishuAttachment: async (_runtime, _summary, attachment, uuid) => {
    attachmentOnlySends.push({ attachment, uuid });
    return { message_id: 'out_attachment_only_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});
assert.equal(attachmentOnlySends.length, 1);
assert.equal(attachmentOnlySends[0].attachment.originalName, 'attachment-only.txt');
assert.match(attachmentOnlySends[0].uuid, /:attachment:0$/);
assert.equal(handled[0].metadata.status, 'sent');
assert.equal(handled[0].metadata.attachmentCount, 1);
assert.equal(handled[0].metadata.responseMessageId, 'out_attachment_only_test_1');

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
  publishRemoteLabAsset: async ({ body, mimeType, originalName, sessionId }) => {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    assert.equal(sessionId, 'session_image_asset_test');
    assert.equal(mimeType, 'image/png');
    assert.equal(originalName, 'drawing.png');
    assert.deepEqual(Buffer.concat(chunks), pngBuffer);
    return {
      id: 'fasset_aaaaaaaaaaaaaaaaaaaaaaaa',
      originalName,
      mimeType,
      sizeBytes: pngBuffer.length,
    };
  },
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
}, imageSummary, { sessionId: 'session_image_asset_test' });

assert.deepEqual(resourceDownloadPayload, {
  params: { type: 'image' },
  path: { message_id: 'msg_image_1', file_key: 'img_v2_1' },
});
assert.equal(imageAttachments.failures.length, 0, 'image resource downloads should not report failures on success');
assert.equal(imageAttachments.attachments.length, 1);
assert.equal(imageAttachments.attachments[0].mimeType, 'image/png', 'image MIME type should be detected from bytes when Feishu returns octet-stream');
assert.equal(imageAttachments.attachments[0].originalName, 'drawing.png');
assert.equal(imageAttachments.attachments[0].assetId, 'fasset_aaaaaaaaaaaaaaaaaaaaaaaa');
assert.equal('data' in imageAttachments.attachments[0], false, 'Feishu ingress must not inline base64 bytes into the session message');

const mixedResourceSummary = summarizeEvent({
  message: {
    chat_id: 'chat_media_partial_1',
    chat_type: 'p2p',
    message_id: 'msg_media_partial_1',
    message_type: 'media',
    content: JSON.stringify({
      file_key: 'file_media_failed_1',
      image_key: 'img_media_cover_1',
      file_name: 'clip.mp4',
    }),
  },
});
const mixedResourceDownloadTypes = [];
const mixedResourceResolution = await resolveFeishuMessageAttachments({
  publishRemoteLabAsset: async ({ body, mimeType }) => {
    for await (const _chunk of body) { /* consume the bounded stream */ }
    return {
      id: 'fasset_media_cover_1',
      originalName: 'cover.png',
      mimeType,
      sizeBytes: pngBuffer.length,
    };
  },
  appClient: {
    im: {
      v1: {
        messageResource: {
          get: async ({ params, path }) => {
            mixedResourceDownloadTypes.push({ fileKey: path.file_key, type: params.type });
            if (path.file_key === 'file_media_failed_1') {
              throw new Error('simulated media download failure');
            }
            return {
              headers: { 'content-type': 'image/png' },
              getReadableStream: () => Readable.from([pngBuffer]),
            };
          },
        },
      },
    },
  },
}, mixedResourceSummary, { sessionId: 'session_media_partial_1' });
assert.deepEqual(mixedResourceDownloadTypes, [
  { fileKey: 'file_media_failed_1', type: 'media' },
  { fileKey: 'img_media_cover_1', type: 'image' },
]);
assert.equal(mixedResourceResolution.attachments.length, 1, 'one failed resource must not discard successful siblings');
assert.equal(mixedResourceResolution.failures.length, 1);
const partialMixedResourceSummary = {
  ...mixedResourceSummary,
  attachmentDownloadFailures: mixedResourceResolution.failures,
};
assert.equal(buildMessageSourceContext(partialMixedResourceSummary).ingestion.status, 'partial');
assert.match(buildRemoteLabMessage(partialMixedResourceSummary), /Feishu source reference/);

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

sendCalls = 0;
handled.length = 0;
let unknownInvokedRemoteLab = false;

await handleMessage(runtime, {
  chatId: 'chat_unknown_1',
  chatType: 'group',
  messageId: 'msg_unknown_1',
  messageType: 'future_feishu_structure',
  contentSummary: 'Feishu future_feishu_structure message reference (keys=payload)',
  contentKeys: ['payload'],
  rawContent: JSON.stringify({ payload: { nested: true } }),
  sender: { openId: 'ou_unknown_1' },
}, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async (_runtime, inboundSummary) => {
    unknownInvokedRemoteLab = true;
    assert.match(buildRemoteLabMessage(inboundSummary), /message_id=msg_unknown_1/);
    return {
      sessionId: 'session_test_unknown',
      runId: 'run_test_unknown',
      requestId: 'request_test_unknown',
      duplicate: false,
      replyText: '我收到了这条尚未完整解析的消息。',
    };
  },
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_unknown' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(unknownInvokedRemoteLab, true, 'unparsed inbound structures should still invoke RemoteLab');
assert.equal(sendCalls, 1);
assert.equal(handled[0].metadata.status, 'sent');

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

let attachmentDownloadCookie = '';
const attachmentDownloadServer = http.createServer((req, res) => {
  attachmentDownloadCookie = String(req.headers.cookie || '');
  if (req.url === '/api/assets/fasset_download_test_1/download?download=1') {
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Length': Buffer.byteLength('name,value\ntest,1\n'),
    });
    res.end('name,value\ntest,1\n');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => attachmentDownloadServer.listen(0, '127.0.0.1', resolve));
try {
  const address = attachmentDownloadServer.address();
  const downloadedAttachment = await loadRemoteLabReplyAttachment({
    authCookie: 'session_token=asset-cookie',
    config: { chatBaseUrl: `http://127.0.0.1:${address.port}` },
  }, {
    assetId: 'fasset_download_test_1',
    originalName: 'download.csv',
    mimeType: 'text/csv',
    sizeBytes: 18,
  });
  assert.equal(downloadedAttachment.buffer.toString('utf8'), 'name,value\ntest,1\n');
  assert.equal(downloadedAttachment.filename, 'download.csv');
  assert.equal(downloadedAttachment.mimeType, 'text/csv');
  assert.equal(attachmentDownloadCookie, 'session_token=asset-cookie');
} finally {
  await new Promise((resolve) => attachmentDownloadServer.close(resolve));
}

assert.equal(normalizeReplyText('  \n\n  '), '');
assert.equal(normalizeReplyText('  hello\r\n'), 'hello');
assert.equal(normalizeReplyText(' <private>internal only</private> '), '');
assert.equal(normalizeReplyText('  😺 hello [委屈]\r\n'), 'hello');
assert.equal(normalizeReplyText('好的😺，我来处理。'), '好的，我来处理。');

let feishuCreatePayload = null;
let feishuReplyPayload = null;
let feishuImagePayload = null;
let feishuFilePayload = null;
const fakeSendRuntime = {
  appClient: {
    im: {
      v1: {
        image: {
          create: async (payload) => {
            feishuImagePayload = payload;
            return { image_key: 'img_formula_uploaded_1' };
          },
        },
        file: {
          create: async (payload) => {
            feishuFilePayload = payload;
            return { file_key: 'file_uploaded_1' };
          },
        },
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

feishuReplyPayload = null;
await sendFeishuText(fakeSendRuntime, {
  chatId: 'chat_topic_1',
  messageId: 'msg_topic_anchor_only',
  topicId: 'topic_explicit_1',
}, 'explicit topic answer', 'uuid-topic-explicit');
assert.equal(feishuReplyPayload?.path?.message_id, 'msg_topic_anchor_only');
assert.equal(feishuReplyPayload?.data?.reply_in_thread, true);

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

feishuCreatePayload = null;
feishuImagePayload = null;
await sendFeishuText(
  fakeSendRuntime,
  { chatType: 'group', chatId: 'chat_regular_1', messageId: 'msg_regular_formula_1' },
  '$$\\frac{a_b}{c^2}$$',
  'uuid-regular-formula-1',
);
assert.equal(feishuImagePayload?.data?.image_type, 'message');
assert.ok(Buffer.isBuffer(feishuImagePayload?.data?.image));
assert.deepEqual(
  JSON.parse(feishuCreatePayload?.data?.content || '{}').zh_cn.content,
  [[{ tag: 'img', image_key: 'img_formula_uploaded_1' }]],
);

assert.equal(resolveFeishuOutboundFileType({ originalName: 'report.xlsx' }), 'xls');
assert.equal(resolveFeishuOutboundFileType({ mimeType: 'application/pdf' }), 'pdf');
assert.equal(resolveFeishuOutboundFileType({ originalName: 'archive.zip' }), 'stream');

feishuCreatePayload = null;
feishuImagePayload = null;
await sendFeishuAttachment(
  fakeSendRuntime,
  { chatType: 'group', chatId: 'chat_regular_1', messageId: 'msg_image_reply_1' },
  {
    originalName: 'preview.png',
    mimeType: 'image/png',
    data: Buffer.from('small-png').toString('base64'),
  },
  'uuid-image-attachment-1',
);
assert.equal(feishuImagePayload?.data?.image_type, 'message');
assert.ok(Buffer.isBuffer(feishuImagePayload?.data?.image));
assert.equal(feishuCreatePayload?.data?.msg_type, 'image');
assert.equal(feishuCreatePayload?.data?.uuid, 'uuid-image-attachment-1');
assert.deepEqual(JSON.parse(feishuCreatePayload?.data?.content || '{}'), {
  image_key: 'img_formula_uploaded_1',
});

feishuReplyPayload = null;
feishuFilePayload = null;
await sendFeishuAttachment(
  fakeSendRuntime,
  topicSummary,
  {
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from('%PDF-test').toString('base64'),
  },
  'uuid-file-attachment-1',
);
assert.equal(feishuFilePayload?.data?.file_type, 'pdf');
assert.equal(feishuFilePayload?.data?.file_name, 'report.pdf');
assert.ok(Buffer.isBuffer(feishuFilePayload?.data?.file));
assert.equal(feishuReplyPayload?.path?.message_id, topicSummary.messageId);
assert.equal(feishuReplyPayload?.data?.msg_type, 'file');
assert.equal(feishuReplyPayload?.data?.reply_in_thread, true);
assert.equal(feishuReplyPayload?.data?.uuid, 'uuid-file-attachment-1');
assert.deepEqual(JSON.parse(feishuReplyPayload?.data?.content || '{}'), {
  file_key: 'file_uploaded_1',
});

const sourceDeliveryRequests = [];
const sourceDeliveryResult = await processSourceDeliveryOnce({ config: { sourceRouteId: 'bot-alpha' } }, {
  requestRemoteLab: async (path, options = {}) => {
    sourceDeliveryRequests.push({ path, options });
    if (path === '/api/source-deliveries/claim') {
      return {
        response: { ok: true },
        json: {
          claim: {
            leaseId: 'lease_123',
            delivery: {
              id: 'srcd_000000000000000000000001',
              responseId: 'trigger:trg_1',
              kind: 'content',
              text: '今天日期：2026-07-27',
              target: {
                chatId: 'chat_topic_1',
                messageId: 'msg_topic_reply_1',
                topicId: 'thread_topic_1',
                threadId: 'thread_topic_1',
              },
            },
          },
        },
      };
    }
    return {
      response: { ok: true },
      json: { delivery: { id: 'srcd_000000000000000000000001', state: 'delivered' } },
    };
  },
  deliverFeishuVisibleReply: async (_runtime, target, message) => {
    assert.equal(target.messageId, 'msg_topic_reply_1');
    assert.equal(target.threadId, 'thread_topic_1');
    assert.equal(message.responseId, 'trigger:trg_1');
    return { message_id: 'om_source_delivery_out' };
  },
});
assert.equal(sourceDeliveryResult.state, 'delivered');
assert.equal(sourceDeliveryRequests[0].options.body.sourceRouteId, 'bot-alpha');
assert.equal(sourceDeliveryRequests[1].path, '/api/source-deliveries/srcd_000000000000000000000001/complete');
assert.equal(sourceDeliveryRequests[1].options.body.externalId, 'om_source_delivery_out');

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
  botId: 'bot-alpha',
}, null, 2)}\n`, 'utf8');

const loadedConfig = await loadConfig(tempConfigPath);
assert.equal(loadedConfig.sourceRouteId, 'bot-alpha');
const derivedRouteDir = join(tempConfigDir, 'connector-beta');
const derivedRouteConfigPath = join(derivedRouteDir, 'config.json');
await mkdir(derivedRouteDir, { recursive: true });
await writeFile(derivedRouteConfigPath, `${JSON.stringify({
  appId: 'cli_test',
  appSecret: 'secret_test',
  region: 'feishu-cn',
  chatBaseUrl: 'http://127.0.0.1:7690',
}, null, 2)}\n`, 'utf8');
assert.equal((await loadConfig(derivedRouteConfigPath)).sourceRouteId, 'connector-beta');
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
assert.equal(
  normalizeReplyText('前文  多余空格\n```json\n{\n  "nested": {\n    "value": 1\n  }\n}\n```\n后文  多余空格'),
  '前文 多余空格\n```json\n{\n  "nested": {\n    "value": 1\n  }\n}\n```\n后文 多余空格',
  'outbound normalization should preserve indentation inside fenced code blocks',
);

const markdownPostContent = JSON.parse(await buildFeishuPostContent('**重点**\n\n- 第一项\n- 第二项'));
assert.deepEqual(markdownPostContent.zh_cn.content, [
  [{ tag: 'md', text: '**重点**' }],
  [{ tag: 'text', text: '\u200B' }],
  [{ tag: 'md', text: '- 第一项' }],
  [{ tag: 'md', text: '- 第二项' }],
]);

const fencedCodePostContent = JSON.parse(await buildFeishuPostContent(
  '结果如下：\n```json\n{\n  "hello": "world",\n  "count": 2\n}\n```\n处理完成。',
));
assert.deepEqual(fencedCodePostContent.zh_cn.content, [
  [{ tag: 'md', text: '结果如下：' }],
  [{
    tag: 'code_block',
    language: 'JSON',
    text: '{\n  "hello": "world",\n  "count": 2\n}',
  }],
  [{ tag: 'md', text: '处理完成。' }],
]);

const aliasedCodePostContent = JSON.parse(await buildFeishuPostContent('```ts\nconst answer = 42;\n```'));
assert.deepEqual(aliasedCodePostContent.zh_cn.content, [[{
  tag: 'code_block',
  language: 'TYPESCRIPT',
  text: 'const answer = 42;',
}]]);

const mentionPostContent = JSON.parse(await buildFeishuPostContent('@_user_1 请看 **这段**', mentionSummary.mentions));
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
let generatedReplyAssetIntentPayload = null;
let generatedReplyUploadedBytes = null;
let generatedReplyFinalizePayload = null;
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  await new Promise((resolve) => req.on('end', resolve));
  const bodyBuffer = Buffer.concat(chunks);
  const body = bodyBuffer.toString('utf8');

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

  if (req.method === 'POST' && req.url === '/api/assets/upload-intents') {
    generatedReplyAssetIntentPayload = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      asset: {
        id: 'fasset_bbbbbbbbbbbbbbbbbbbbbbbb',
        originalName: 'img_scope_1.jpg',
        mimeType: 'image/jpeg',
      },
      upload: {
        method: 'PUT',
        url: '/api/assets/fasset_bbbbbbbbbbbbbbbbbbbbbbbb/upload',
        headers: { 'Content-Type': 'image/jpeg' },
      },
    }));
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/assets/fasset_bbbbbbbbbbbbbbbbbbbbbbbb/upload') {
    generatedReplyUploadedBytes = bodyBuffer;
    res.writeHead(200, { ETag: 'etag-feishu-asset' });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/assets/fasset_bbbbbbbbbbbbbbbbbbbbbbbb/finalize') {
    generatedReplyFinalizePayload = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      asset: {
        id: 'fasset_bbbbbbbbbbbbbbbbbbbbbbbb',
        originalName: 'img_scope_1.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: jpegBuffer.length,
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
          text: 'Feishu reply ready.\n\nAttached file: report.csv',
          displayEvents: [{
            seq: 1,
            type: 'message',
            role: 'assistant',
            content: 'Feishu reply ready.',
          }, {
            seq: 2,
            type: 'attachment_delivery',
            role: 'assistant',
            attachments: [{
              assetId: 'fasset_111111111111111111111111',
              originalName: 'report.csv',
              mimeType: 'text/csv',
              sizeBytes: 12,
            }],
          }],
          attachments: [{
            assetId: 'fasset_111111111111111111111111',
            originalName: 'report.csv',
            mimeType: 'text/csv',
            sizeBytes: 12,
          }],
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
  assert.deepEqual(generatedReplyAssetIntentPayload, {
    sessionId: 'sess_feishu_1',
    originalName: 'img_scope_1.jpg',
    mimeType: 'image/jpeg',
  });
  assert.deepEqual(generatedReplyUploadedBytes, jpegBuffer);
  assert.deepEqual(generatedReplyFinalizePayload, {
    sizeBytes: jpegBuffer.length,
    etag: 'etag-feishu-asset',
  });
  assert.equal(submittedPayload?.attachments?.length, 1);
  assert.equal(submittedPayload.attachments[0].mimeType, 'image/jpeg');
  assert.equal(submittedPayload.attachments[0].originalName, 'img_scope_1.jpg');
  assert.equal(submittedPayload.attachments[0].assetId, 'fasset_bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal('data' in submittedPayload.attachments[0], false);
  assert.equal(submittedPayload?.sourceContext?.messageId, 'msg_for_scope');
  assert.equal(submittedPayload?.sourceContext?.chatType, 'p2p');
  assert.deepEqual(submittedPayload?.sourceContext?.attachments, { imageCount: 1 });
  assert.equal(reply.sessionId, 'sess_feishu_1');
  assert.equal(reply.runId, 'run_feishu_1');
  assert.equal(reply.attachmentCount, 1);
  assert.equal(reply.replyText, 'Feishu reply ready.');
  assert.equal(reply.replyAttachments.length, 1);
  assert.equal(reply.replyAttachments[0].originalName, 'report.csv');
} finally {
  await new Promise((resolve) => server.close(resolve));
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
  assert.equal(
    planningSubmittedPayload?.model,
    'gpt-5.6-sol',
    'Feishu should upgrade stale inherited Codex UI models before submitting a message',
  );
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

let topicMetadataSessionPayload = null;
let topicMetadataSubmittedPayload = null;
const topicMetadataRuntime = createRuntimeContext({
  appId: 'cli_test',
  appSecret: 'test-secret',
  region: 'feishu-cn',
  loggerLevel: 'error',
  intakePolicy: {
    mode: 'allow_all',
    accessStatePath: join(tempHome, 'topic-metadata-access-state.json'),
    allowedSendersPath: join(tempHome, 'topic-metadata-allowed-senders.json'),
  },
  storeRawEvents: false,
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  sessionTool: 'codex',
  systemPrompt: 'Reply with plain text only.',
  thinking: false,
  model: '',
  effort: '',
}, {
  eventsLogPath: join(tempHome, 'topic-metadata-events.jsonl'),
  knownSendersPath: join(tempHome, 'topic-metadata-known-senders.json'),
  handledMessagesPath: join(tempHome, 'topic-metadata-handled-messages.json'),
  messageIndexPath: join(tempHome, 'topic-metadata-message-index.json'),
});
topicMetadataRuntime.chatMetadataCache.set('chat_topic_metadata_1', {
  name: 'Topic Metadata Chat',
  groupMessageType: 'thread',
  chatMode: 'topic',
  chatType: 'group',
});
topicMetadataRuntime.authCookie = 'session_token=topic-metadata-test';
topicMetadataRuntime.authToken = 'ignored';

const topicMetadataServer = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'POST' && req.url === '/api/sessions') {
    if (body) {
      topicMetadataSessionPayload = JSON.parse(body);
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_topic_metadata_test_1' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_topic_metadata_test_1/messages') {
    topicMetadataSubmittedPayload = JSON.parse(body);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_topic_metadata_test_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions?sourceId=feishu') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_metadata_test_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_topic_metadata_test_1',
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

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_metadata_test_1/responses/feishu%3Amsg_topic_metadata_test_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replyPublication: {
        id: 'feishu:msg_topic_metadata_test_1',
        responseIds: ['feishu:msg_topic_metadata_test_1'],
        state: 'ready',
        ready: true,
        rootRunId: 'run_topic_metadata_test_1',
        finalRunId: 'run_topic_metadata_test_1',
        continuationRunIds: [],
        payload: {
          text: 'Metadata scope reply.',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_topic_metadata_test_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_topic_metadata_test_1', state: 'completed' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_metadata_test_1/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: [] }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => topicMetadataServer.listen(0, '127.0.0.1', resolve));
try {
  const address = topicMetadataServer.address();
  topicMetadataRuntime.config.chatBaseUrl = `http://127.0.0.1:${address.port}`;
  const topicMetadataReply = await generateRemoteLabReply(topicMetadataRuntime, {
    chatType: 'group',
    chatId: 'chat_topic_metadata_1',
    messageId: 'msg_topic_metadata_test_1',
    textPreview: 'No groupMessageType or chatMode in payload.',
    chatName: 'Topic Metadata Chat',
    sender: {
      openId: 'ou_topic_metadata_sender_1',
      tenantKey: 'tenant_topic_metadata_1',
    },
  });
  assert.equal(topicMetadataSessionPayload?.externalTriggerId, 'feishu:topic:chat_topic_metadata_1:msg_topic_metadata_test_1');
  assert.equal(topicMetadataSessionPayload?.sourceContext?.conversationKind, 'topic');
  assert.equal(topicMetadataSessionPayload?.sourceContext?.topicId, 'msg_topic_metadata_test_1');
  assert.equal(topicMetadataSubmittedPayload?.sourceContext?.messageId, 'msg_topic_metadata_test_1');
  assert.equal(topicMetadataReply.sessionId, 'sess_topic_metadata_test_1');
  assert.equal(topicMetadataReply.replyText, 'Metadata scope reply.');
} finally {
  await new Promise((resolve) => topicMetadataServer.close(resolve));
}

const topicFallbackHandledPath = join(tempHome, 'topic-fallback-handled.json');
await writeFile(topicFallbackHandledPath, JSON.stringify({
  messages: {
    topic_msg_old: {
      status: 'sent',
      chatId: 'chat_topic_fallback_group_1',
      sessionId: 'sess_topic_fallback_old_1',
      responseMessageId: 'msg_topic_fallback_old_reply',
      updatedAt: '2026-07-24T18:00:00.000Z',
    },
    topic_msg_recent: {
      status: 'sent',
      chatId: 'chat_topic_fallback_group_1',
      sessionId: 'sess_topic_fallback_recent_1',
      responseMessageId: 'msg_topic_fallback_recent_reply',
      updatedAt: '2026-07-24T21:00:00.000Z',
    },
  },
}));
const topicFallbackRuntime = {
  storagePaths: {
    handledMessagesPath: topicFallbackHandledPath,
    messageIndexPath: join(tempHome, 'topic-fallback-message-index.json'),
  },
};

const readHandledMessagesForTest = async (pathname) => JSON.parse(await readFile(pathname, 'utf8'));

const topicFallbackServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/sessions?sourceId=feishu') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessions: [{
        id: 'sess_topic_fallback_old_1',
        sourceId: 'feishu',
        externalTriggerId: 'feishu:topic:chat_topic_fallback_group_1:old_root',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'topic',
          chatMode: 'topic',
        },
        updatedAt: '2026-07-24T18:30:00.000Z',
      }, {
        id: 'sess_topic_fallback_recent_1',
        sourceId: 'feishu',
        externalTriggerId: 'feishu:topic:chat_topic_fallback_group_1:recent_root',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'topic',
          chatMode: 'topic',
        },
        updatedAt: '2026-07-24T20:00:00.000Z',
      }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_recent_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_topic_fallback_recent_1',
        sourceId: 'feishu',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'topic',
          chatMode: 'topic',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_recent_1/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'user',
        sourceContext: {
          connector: 'feishu',
          messageId: 'topic_msg_recent',
        },
      }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_old_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_topic_fallback_old_1',
        sourceId: 'feishu',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'topic',
          chatMode: 'topic',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_old_1/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'user',
        sourceContext: {
          connector: 'feishu',
          messageId: 'topic_msg_old',
        },
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => topicFallbackServer.listen(0, '127.0.0.1', resolve));
try {
  const fallbackSessionId = await resolveFeishuTopicForkParentSessionId(topicFallbackRuntime, async (path, options = {}) => {
    const port = topicFallbackServer.address().port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { response, text, json: text ? JSON.parse(text) : null };
  }, {
    chatType: 'group',
    chatId: 'chat_topic_fallback_group_1',
    messageId: 'msg_topic_fallback_current_1',
    chatMode: 'topic',
    textPreview: 'Continue topic, no parent ids',
    sender: { openId: 'ou_topic_fallback_1', tenantKey: 'tenant_topic_fallback_1' },
  }, {
    loadHandledMessages: readHandledMessagesForTest,
  });
  assert.equal(fallbackSessionId, 'sess_topic_fallback_recent_1');
} finally {
  await new Promise((resolve) => topicFallbackServer.close(resolve));
}

const groupContentFallbackHandledPath = join(tempHome, 'topic-fallback-content-handled.json');
await writeFile(groupContentFallbackHandledPath, JSON.stringify({
  messages: {
    group_msg_general: {
      status: 'sent',
      chatId: 'chat_topic_fallback_group_1',
      sessionId: 'sess_topic_fallback_general_1',
      responseMessageId: 'msg_topic_fallback_general_reply',
      updatedAt: '2026-07-24T20:30:00.000Z',
    },
  },
}));
const groupContentFallbackRuntime = {
  storagePaths: {
    handledMessagesPath: groupContentFallbackHandledPath,
    messageIndexPath: join(tempHome, 'topic-fallback-content-message-index.json'),
  },
};

const groupContentFallbackServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/sessions?sourceId=feishu') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessions: [{
        id: 'sess_topic_fallback_general_1',
        sourceId: 'feishu',
        externalTriggerId: 'feishu:group:chat_topic_fallback_group_1',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'chat',
          chatMode: 'group',
        },
        updatedAt: '2026-07-24T20:30:00.000Z',
      }],
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_general_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: {
        id: 'sess_topic_fallback_general_1',
        sourceId: 'feishu',
        sourceContext: {
          connector: 'feishu',
          chatId: 'chat_topic_fallback_group_1',
          conversationKind: 'chat',
          chatMode: 'group',
        },
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_topic_fallback_general_1/events?filter=all') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'user',
        sourceContext: {
          connector: 'feishu',
          messageId: 'group_msg_general',
        },
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => groupContentFallbackServer.listen(0, '127.0.0.1', resolve));
try {
  const groupContentFallbackSessionId = await resolveFeishuTopicForkParentSessionId(groupContentFallbackRuntime, async (path, options = {}) => {
    const port = groupContentFallbackServer.address().port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { response, text, json: text ? JSON.parse(text) : null };
  }, {
    chatType: 'group',
    chatId: 'chat_topic_fallback_group_1',
    messageId: 'msg_topic_fallback_current_2',
    chatMode: 'topic',
    textPreview: 'Continue group, no parent ids',
    sender: { openId: 'ou_topic_fallback_2', tenantKey: 'tenant_topic_fallback_2' },
  }, {
    loadHandledMessages: readHandledMessagesForTest,
  });
  assert.equal(groupContentFallbackSessionId, 'sess_topic_fallback_general_1');
} finally {
  await new Promise((resolve) => groupContentFallbackServer.close(resolve));
}

console.log('ok - empty assistant replies stay silent');
console.log('ok - processing reactions bracket delayed Feishu replies');
console.log('ok - Feishu image payloads are downloaded and submitted as RemoteLab attachments');
console.log('ok - mention tokens are rendered inbound and compiled outbound');
console.log('ok - topic metadata from chat metadata fallback enables topic-scoped sessions');
console.log('ok - whitelist file reloads without restart');
console.log('ok - local group approval commands persist approved chats');
console.log('ok - approved chats auto-grant newly joined members');
console.log('ok - topic session parent fallback can recover nearest recent topic session');
console.log('ok - same-group content fallback can reuse nearest recent chat session when no topic parent trace');
console.log('ok - generated Feishu sessions use the feishu app scope');
console.log('ok - planning-phase Feishu replies wait for publication readiness');
console.log('ok - queued Feishu follow-ups wait for the eventual assistant reply');

await rm(tempHome, { recursive: true, force: true });

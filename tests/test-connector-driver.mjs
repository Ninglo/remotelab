#!/usr/bin/env node
import assert from 'assert/strict';

import {
  CONNECTOR_DRIVER_EVENT_TYPES,
  ConnectorDriver,
  OUTBOUND_CHAT_MESSAGE_KINDS,
  buildConnectorIdempotencyKey,
  mapConnectorEventToOutboundMessage,
} from '../lib/connector-driver.mjs';
import {
  createEmailConnectorTransport,
  createFeishuConnectorTransport,
  createWeChatConnectorTransport,
} from '../lib/connector-driver-transports.mjs';

function createEvent(type, fields = {}) {
  return {
    type,
    responseId: 'resp_test_1',
    ...fields,
  };
}

{
  const message = mapConnectorEventToOutboundMessage(createEvent(
    CONNECTOR_DRIVER_EVENT_TYPES.REDIRECT_DECIDED,
    {
      order: 0,
      text: '这件事已经转到另一个 chat。',
      openUrl: '/chat/sess_redirect_1',
      targetId: 'wechat:chat_1',
    },
  ));

  assert.equal(message.kind, OUTBOUND_CHAT_MESSAGE_KINDS.REDIRECT_NOTICE);
  assert.equal(message.link, '/chat/sess_redirect_1');
  assert.equal(
    message.idempotencyKey,
    buildConnectorIdempotencyKey({
      responseId: 'resp_test_1',
      order: 0,
      kind: OUTBOUND_CHAT_MESSAGE_KINDS.REDIRECT_NOTICE,
      targetId: 'wechat:chat_1',
    }),
  );
}

{
  const sentKinds = [];
  const sentKeys = [];
  const alerts = [];
  const attemptsByKey = new Map();

  const driver = new ConnectorDriver({
    targetId: 'feishu:chat_1',
    sleep: async () => {},
    onAlert: async (record) => {
      alerts.push(record.idempotencyKey);
    },
    transport: {
      async send(message) {
        sentKinds.push(message.kind);
        sentKeys.push(message.idempotencyKey);
        const nextAttempt = (attemptsByKey.get(message.idempotencyKey) || 0) + 1;
        attemptsByKey.set(message.idempotencyKey, nextAttempt);
        if (message.kind === OUTBOUND_CHAT_MESSAGE_KINDS.SUMMARY && nextAttempt === 1) {
          return {
            state: 'delivery_failed',
            retryable: true,
            lastError: 'temporary send failure',
          };
        }
        return {
          state: 'delivered',
          externalId: `external_${message.order}_${nextAttempt}`,
          retryable: false,
        };
      },
    },
  });

  const noRedirectResults = await driver.dispatchEvents([
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.CONTENT_READY, {
      order: 0,
      text: '处理中。',
    }),
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.SUMMARY_READY, {
      order: 1,
      text: '处理完成。',
    }),
  ]);
  assert.deepEqual(
    noRedirectResults.map((entry) => entry.message.kind),
    ['content', 'summary'],
  );
  assert.deepEqual(
    sentKinds,
    ['content', 'summary', 'summary'],
    'summary should retry in-place and keep ordering stable',
  );
  assert.equal(alerts.length, 0, 'successful retry should not alert');
  assert.equal(noRedirectResults[1].record.state, 'delivered');
  assert.equal(noRedirectResults[1].record.attempts, 2);
  assert.equal(noRedirectResults[1].message.idempotencyKey, sentKeys[1]);
  assert.equal(noRedirectResults[1].message.idempotencyKey, sentKeys[2]);

  const duplicate = await driver.dispatchMessage(noRedirectResults[1].message);
  assert.equal(duplicate.duplicate, true, 'already-delivered messages should be idempotent');
  assert.equal(sentKinds.length, 3, 'duplicates should not re-send');
}

{
  const sentKinds = [];
  const driver = new ConnectorDriver({
    targetId: 'wechat:chat_1',
    sleep: async () => {},
    transport: {
      async send(message) {
        sentKinds.push(message.kind);
        return {
          state: 'delivered',
          externalId: `sent_${message.kind}`,
          retryable: false,
        };
      },
    },
  });

  const redirectAndContent = await driver.dispatchEvents([
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.REDIRECT_DECIDED, {
      responseId: 'resp_redirect_keep_1',
      order: 0,
      text: '这件事已经转到别的 chat。',
      openUrl: '/chat/sess_redirect_keep_1',
    }),
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.CONTENT_READY, {
      responseId: 'resp_redirect_keep_1',
      order: 1,
      text: '当前 chat 还需要继续输出内容。',
    }),
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.SUMMARY_READY, {
      responseId: 'resp_redirect_keep_1',
      order: 2,
      text: '当前 chat 的总结。',
    }),
  ]);

  assert.deepEqual(
    redirectAndContent.map((entry) => entry.message.kind),
    ['redirect_notice', 'content', 'summary'],
  );
  assert.deepEqual(sentKinds, ['redirect_notice', 'content', 'summary']);

  sentKinds.length = 0;
  const redirectOnly = await driver.dispatchEvents([
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.REDIRECT_DECIDED, {
      responseId: 'resp_redirect_only_1',
      order: 0,
      text: '请去另一个 chat 查看后续处理。',
      openUrl: '/chat/sess_redirect_only_1',
    }),
    createEvent(CONNECTOR_DRIVER_EVENT_TYPES.RESPONSE_FINALIZED, {
      responseId: 'resp_redirect_only_1',
      order: 1,
    }),
  ]);

  assert.deepEqual(
    redirectOnly.map((entry) => entry.message.kind),
    ['redirect_notice'],
  );
  assert.deepEqual(sentKinds, ['redirect_notice']);
}

{
  const alerts = [];
  const driver = new ConnectorDriver({
    targetId: 'email:thread_1',
    maxAttempts: 2,
    sleep: async () => {},
    onAlert: async (record) => {
      alerts.push(record);
    },
    transport: {
      async send() {
        return {
          state: 'delivery_failed',
          retryable: false,
          lastError: 'permanent failure',
        };
      },
    },
  });

  const failed = await driver.dispatchEvent(createEvent(
    CONNECTOR_DRIVER_EVENT_TYPES.SUMMARY_READY,
    {
      responseId: 'resp_failed_1',
      order: 0,
      text: '发送失败。',
    },
  ));
  assert.equal(failed.record.state, 'delivery_failed');
  assert.equal(failed.record.attempts, 1);
  assert.equal(alerts.length, 1, 'terminal failures should alert once');
}

{
  const sent = [];
  const transport = createWeChatConnectorTransport({
    runtime: { accountsDoc: {}, contextTokensDoc: {}, config: {} },
    summary: { accountId: 'acc_1', peerUserId: 'peer_1' },
    sendWeChatTextImpl: async (_runtime, summary, text) => {
      sent.push({ summary, text });
      return { message_id: 'wechat_msg_1' };
    },
  });

  const result = await transport.send({
    messageId: 'msg_wechat_1',
    responseId: 'resp_wechat_1',
    kind: 'redirect_notice',
    text: '请在新 chat 里继续查看。',
    attachments: [{ filename: 'report.pdf' }],
    link: '/chat/sess_wechat_redirect_1',
    order: 0,
    idempotencyKey: 'resp_wechat_1:wechat:0:redirect_notice',
  });

  assert.equal(result.state, 'delivered');
  assert.equal(result.externalId, 'wechat_msg_1');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /请在新 chat 里继续查看。/);
  assert.match(sent[0].text, /report\.pdf/);
  assert.match(sent[0].text, /\/chat\/sess_wechat_redirect_1/);
}

{
  const requests = [];
  const transport = createFeishuConnectorTransport({
    runtime: { appClient: {} },
    summary: {
      chatId: 'oc_chat_1',
      mentions: [{ name: 'Ning', key: 'user_1' }],
    },
    sendFeishuTextImpl: async (_runtime, summary, text, uuid, mentions) => {
      requests.push({ summary, text, uuid, mentions });
      return { message_id: 'feishu_msg_1' };
    },
  });

  const result = await transport.send({
    messageId: 'msg_feishu_1',
    responseId: 'resp_feishu_1',
    kind: 'content',
    text: '处理中。',
    attachments: [],
    link: '/chat/sess_feishu_1',
    order: 0,
    idempotencyKey: 'resp_feishu_1:feishu:0:content',
  });

  assert.equal(result.state, 'delivered');
  assert.equal(result.externalId, 'feishu_msg_1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].summary.chatId, 'oc_chat_1');
  assert.equal(requests[0].uuid, 'resp_feishu_1:feishu:0:content:text');
  assert.match(requests[0].text, /处理中。/);
  assert.match(requests[0].text, /\/chat\/sess_feishu_1/);
  assert.equal(requests[0].mentions.length, 1);
}

{
  const partCalls = [];
  let secondAttachmentAttempts = 0;
  const transport = createFeishuConnectorTransport({
    runtime: { appClient: {} },
    summary: { chatId: 'oc_chat_attachments_1', mentions: [] },
    sendFeishuTextImpl: async (_runtime, _summary, text, uuid) => {
      partCalls.push({ kind: 'text', text, uuid });
      return { message_id: 'feishu_text_attachments_1' };
    },
    sendFeishuAttachmentImpl: async (_runtime, _summary, attachment, uuid) => {
      partCalls.push({ kind: 'attachment', name: attachment.originalName, uuid });
      if (attachment.originalName === 'second.csv') {
        secondAttachmentAttempts += 1;
        if (secondAttachmentAttempts === 1) {
          throw new Error('temporary attachment send failure');
        }
      }
      return { message_id: `feishu_${attachment.originalName}` };
    },
  });
  const driver = new ConnectorDriver({
    targetId: 'feishu:chat_attachments_1',
    transport,
    sleep: async () => {},
  });

  const result = await driver.dispatchMessage({
    responseId: 'resp_feishu_attachments_1',
    kind: 'content',
    text: '文件已经生成。',
    attachments: [
      { assetId: 'fasset_first', originalName: 'first.pdf' },
      { assetId: 'fasset_second', originalName: 'second.csv' },
    ],
    order: 0,
  });

  assert.equal(result.record.state, 'delivered');
  assert.equal(result.record.attempts, 2);
  assert.deepEqual(partCalls.map((call) => call.kind), [
    'text',
    'attachment',
    'attachment',
    'attachment',
  ]);
  assert.equal(partCalls.filter((call) => call.kind === 'text').length, 1, 'transport retries must not duplicate the text part');
  assert.equal(partCalls.filter((call) => call.name === 'first.pdf').length, 1, 'transport retries must not duplicate delivered files');
  assert.equal(partCalls.filter((call) => call.name === 'second.csv').length, 2, 'only the failed file should be retried');
  assert.match(partCalls[0].uuid, /:text$/);
  assert.match(partCalls[1].uuid, /:attachment:0$/);
  assert.match(partCalls[2].uuid, /:attachment:1$/);
}

{
  const attachmentCalls = [];
  const transport = createFeishuConnectorTransport({
    runtime: { appClient: {} },
    summary: { chatId: 'oc_chat_attachment_only_1' },
    sendFeishuTextImpl: async () => {
      throw new Error('attachment-only delivery must not send an empty text message');
    },
    sendFeishuAttachmentImpl: async (_runtime, _summary, attachment) => {
      attachmentCalls.push(attachment.originalName);
      return { message_id: 'feishu_attachment_only_1' };
    },
  });

  const result = await transport.send({
    messageId: 'msg_feishu_attachment_only_1',
    responseId: 'resp_feishu_attachment_only_1',
    kind: 'content',
    text: '',
    attachments: [{ originalName: 'only.txt' }],
    order: 0,
    idempotencyKey: 'resp_feishu_attachment_only_1:feishu:0:content',
  });
  assert.equal(result.state, 'delivered');
  assert.deepEqual(attachmentCalls, ['only.txt']);
}

{
  let createPayload = null;
  const transport = createFeishuConnectorTransport({
    runtime: {
      appClient: {
        im: {
          v1: {
            message: {
              create: async (payload) => {
                createPayload = payload;
                return { code: 0, data: { message_id: 'feishu_post_1' } };
              },
            },
          },
        },
      },
    },
    summary: {
      chatId: 'oc_chat_markdown_1',
      mentions: [{ name: 'Ning', key: 'user_1', openId: 'ou_ning_1' }],
    },
  });

  const result = await transport.send({
    messageId: 'msg_feishu_markdown_1',
    responseId: 'resp_feishu_markdown_1',
    kind: 'content',
    text: '**处理完成**\n\n@Ning 请看',
    attachments: [],
    order: 0,
  });

  assert.equal(result.state, 'delivered');
  assert.equal(createPayload?.data?.msg_type, 'post');
  assert.match(createPayload?.data?.content || '', /"tag":"md"/);
  assert.match(createPayload?.data?.content || '', /"tag":"at"/);
}

{
  const calls = [];
  const transport = createEmailConnectorTransport({
    defaults: {
      to: 'owner@example.com',
      from: 'rowan@example.com',
      subject: 'Connector driver summary',
    },
    sendOutboundEmailImpl: async (message) => {
      calls.push(message);
      return {
        provider: 'cloudflare_worker',
        summary: { id: 'mail_msg_1' },
      };
    },
  });

  const result = await transport.send({
    messageId: 'msg_email_1',
    responseId: 'resp_email_1',
    kind: 'summary',
    text: '本轮处理完成。',
    attachments: [{
      filename: 'summary.txt',
      contentType: 'text/plain',
      contentBase64: Buffer.from('hello').toString('base64'),
    }],
    link: '/chat/sess_email_1',
    order: 1,
    idempotencyKey: 'resp_email_1:email:1:summary',
  });

  assert.equal(result.state, 'delivered');
  assert.equal(result.externalId, 'mail_msg_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'owner@example.com');
  assert.match(calls[0].text, /本轮处理完成。/);
  assert.match(calls[0].text, /\/chat\/sess_email_1/);
  assert.equal(calls[0].attachments.length, 1);
}

console.log('ok');

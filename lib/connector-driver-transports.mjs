import { createHash } from 'crypto';
import { sendOutboundEmail } from './agent-mail-outbound.mjs';
import { renderOutboundChatMessageText, normalizeConnectorSendResult } from './connector-driver.mjs';
import { sendWeChatText } from '../scripts/wechat-connector.mjs';
import { buildFeishuPostContent } from '../scripts/feishu-connector.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeFeishuMode(value) {
  return trimString(value).toLowerCase().replace(/[_\s-]+/g, '_');
}

function isFeishuTopicSummary(summary) {
  const chatType = normalizeFeishuMode(summary?.chatType);
  const groupMessageType = normalizeFeishuMode(summary?.groupMessageType);
  const chatMode = normalizeFeishuMode(summary?.chatMode);
  return chatType === 'topic'
    || groupMessageType === 'thread'
    || groupMessageType === 'topic'
    || chatMode === 'thread'
    || chatMode === 'topic'
    || !!trimString(summary?.threadId)
    || !!trimString(summary?.rootId);
}

function buildFeishuApiUuid(value) {
  const seed = trimString(value) || `${Date.now()}`;
  const normalized = seed
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized && normalized.length <= 64) {
    return normalized;
  }
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 32);
  return `rl_${digest}`;
}

function summarizeEmailExternalId(result) {
  return firstNonEmpty(
    result?.summary?.id,
    result?.response?.id,
    result?.response?.messageId,
    result?.response?.message_id,
  );
}

export function createWeChatConnectorTransport({
  runtime,
  summary,
  sendWeChatTextImpl = sendWeChatText,
  includeAttachmentFallback = true,
} = {}) {
  if (!runtime || !summary) {
    throw new Error('WeChat transport requires runtime and summary');
  }
  return {
    async send(message) {
      try {
        const text = renderOutboundChatMessageText(message, { includeAttachmentFallback });
        const result = await sendWeChatTextImpl(runtime, summary, text);
        return normalizeConnectorSendResult({
          state: 'delivered',
          externalId: firstNonEmpty(result?.message_id, result?.messageId),
          retryable: false,
          metadata: {
            provider: 'wechat_connector',
            response: result,
          },
        });
      } catch (error) {
        return normalizeConnectorSendResult(null, error);
      }
    },
  };
}

async function defaultFeishuSend(runtime, summary, text, uuid, mentions) {
  const content = buildFeishuPostContent(text, mentions);
  const apiUuid = buildFeishuApiUuid(uuid);
  if (isFeishuTopicSummary(summary) && trimString(summary?.messageId)) {
    const response = await runtime.appClient.im.v1.message.reply({
      path: {
        message_id: summary.messageId,
      },
      data: {
        msg_type: 'post',
        content,
        reply_in_thread: true,
        uuid: apiUuid,
      },
    });
    if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
      throw new Error(response.msg || 'Failed to send Feishu topic reply');
    }
    return response.data;
  }

  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: summary.chatId,
      msg_type: 'post',
      content,
      uuid: apiUuid,
    },
  });
  if ((response.code !== undefined && response.code !== 0) || !response.data?.message_id) {
    throw new Error(response.msg || 'Failed to send Feishu reply');
  }
  return response.data;
}

export function createFeishuConnectorTransport({
  runtime,
  summary,
  sendFeishuTextImpl = defaultFeishuSend,
  includeAttachmentFallback = true,
} = {}) {
  if (!runtime || !summary?.chatId) {
    throw new Error('Feishu transport requires runtime and summary.chatId');
  }
  return {
    async send(message) {
      try {
        const text = renderOutboundChatMessageText(message, { includeAttachmentFallback });
        const result = await sendFeishuTextImpl(
          runtime,
          summary,
          text,
          trimString(message.idempotencyKey) || trimString(message.messageId),
          summary?.mentions,
        );
        return normalizeConnectorSendResult({
          state: 'delivered',
          externalId: firstNonEmpty(result?.message_id, result?.messageId),
          retryable: false,
          metadata: {
            provider: 'feishu_connector',
            response: result,
          },
        });
      } catch (error) {
        return normalizeConnectorSendResult(null, error);
      }
    },
  };
}

export function createEmailConnectorTransport({
  config = {},
  options = {},
  defaults = {},
  sendOutboundEmailImpl = sendOutboundEmail,
} = {}) {
  return {
    async send(message) {
      try {
        const text = renderOutboundChatMessageText(message, { includeAttachmentFallback: false });
        const result = await sendOutboundEmailImpl({
          ...defaults,
          text,
          ...(Array.isArray(message.attachments) && message.attachments.length > 0
            ? { attachments: message.attachments }
            : {}),
        }, config, options);
        return normalizeConnectorSendResult({
          state: 'delivered',
          externalId: summarizeEmailExternalId(result),
          retryable: false,
          metadata: result,
        });
      } catch (error) {
        return normalizeConnectorSendResult(null, error);
      }
    },
  };
}

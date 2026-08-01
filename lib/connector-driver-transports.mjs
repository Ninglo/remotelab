import { sendOutboundEmail } from './agent-mail-outbound.mjs';
import { renderOutboundChatMessageText, normalizeConnectorSendResult } from './connector-driver.mjs';
import { sendWeChatText } from '../scripts/wechat-connector.mjs';
import {
  buildFeishuApiUuid,
  buildFeishuPostContent,
  isFeishuTopicSummary,
} from '../connectors/feishu/index.mjs';
import { resolveFeishuFormulaImage } from '../connectors/feishu/math-renderer.mjs';

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
  const content = await buildFeishuPostContent(text, mentions, {
    resolveFormulaImage: (formula) => resolveFeishuFormulaImage(runtime, formula),
    onFormulaError: (error, formula) => {
      console.warn(
        `[feishu-connector] ${formula?.display ? 'display' : 'inline'} formula fallback: ${error?.message || error}`,
      );
    },
  });
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

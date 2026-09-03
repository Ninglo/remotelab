import { sendOutboundEmail } from './agent-mail-outbound.mjs';
import { renderOutboundChatMessageText, normalizeConnectorSendResult } from './connector-driver.mjs';
import { sendWeChatText } from '../scripts/wechat-connector.mjs';
import {
  buildFeishuApiUuid,
  buildFeishuPostContent,
  isFeishuDocumentCommentSummary,
  isFeishuTopicSummary,
} from '../connectors/feishu/index.mjs';
import { sendFeishuCommentReply } from '../connectors/feishu/comment-flow.mjs';
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

const DEFAULT_FEISHU_SEND_TIMEOUT_MS = 30_000;

function normalizePositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function withTimeout(work, timeoutMs, label) {
  let timeoutHandle = null;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.code = 'CONNECTOR_SEND_TIMEOUT';
          error.retryable = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
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
  if (isFeishuDocumentCommentSummary(summary)) {
    return sendFeishuCommentReply(runtime, summary, text);
  }
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
  sendFeishuAttachmentImpl = null,
  includeAttachmentFallback = true,
  sendTimeoutMs = DEFAULT_FEISHU_SEND_TIMEOUT_MS,
} = {}) {
  const documentComment = isFeishuDocumentCommentSummary(summary);
  if (!runtime || (!summary?.chatId && !documentComment)) {
    throw new Error('Feishu transport requires a chat or document-comment target');
  }
  const deliveredParts = new Map();
  const effectiveSendTimeoutMs = normalizePositiveTimeout(sendTimeoutMs, DEFAULT_FEISHU_SEND_TIMEOUT_MS);
  const sendPartOnce = async (key, label, sender) => {
    if (deliveredParts.has(key)) {
      return deliveredParts.get(key);
    }
    const result = await withTimeout(sender, effectiveSendTimeoutMs, label);
    deliveredParts.set(key, result);
    return result;
  };
  return {
    async send(message) {
      try {
        const attachments = Array.isArray(message.attachments)
          ? message.attachments.filter((attachment) => attachment && typeof attachment === 'object')
          : [];
        const baseKey = trimString(message.idempotencyKey) || trimString(message.messageId);
        const attachmentSender = documentComment ? null : sendFeishuAttachmentImpl;
        const text = renderOutboundChatMessageText(message, {
          includeAttachmentFallback: includeAttachmentFallback && typeof attachmentSender !== 'function',
        });
        const responses = [];
        if (text) {
          responses.push(await sendPartOnce(`${baseKey}:text`, 'Feishu text send', () => sendFeishuTextImpl(
            runtime,
            summary,
            text,
            `${baseKey}:text`,
            summary?.mentions,
          )));
        }
        if (typeof attachmentSender === 'function') {
          for (let index = 0; index < attachments.length; index += 1) {
            responses.push(await sendPartOnce(
              `${baseKey}:attachment:${index}`,
              `Feishu attachment send (${index + 1}/${attachments.length})`,
              () => attachmentSender(
                runtime,
                summary,
                attachments[index],
                `${baseKey}:attachment:${index}`,
              ),
            ));
          }
        }
        if (responses.length === 0) {
          throw new Error('Feishu delivery requires text or attachments');
        }
        const result = responses[responses.length - 1] || null;
        return normalizeConnectorSendResult({
          state: 'delivered',
          externalId: firstNonEmpty(result?.message_id, result?.messageId),
          retryable: false,
          metadata: {
            provider: 'feishu_connector',
            response: result,
            responses,
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

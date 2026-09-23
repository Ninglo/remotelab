import { normalizeConversationTarget } from '../../lib/conversation-target.mjs';
import { buildFeishuTopicId, isFeishuDocumentCommentSummary } from './index.mjs';
import { resolveFeishuReplyMode } from './reply-policy.mjs';

const trimString = value => typeof value === 'string' ? value.trim() : '';

export function isFeishuThreadConversation(summary) {
  return summary?.conversationKind === 'thread' || Boolean(buildFeishuTopicId(summary));
}

export function applyFeishuReplyRouting(config, summary) {
  if (isFeishuDocumentCommentSummary(summary)) return summary;
  if (isFeishuThreadConversation(summary)) {
    return { ...summary, conversationKind: 'thread', replyInThread: true };
  }
  const replyMode = summary.replyModeOverride || resolveFeishuReplyMode(config, summary);
  if (replyMode === 'thread') {
    return { ...summary, conversationKind: 'thread', replyInThread: true, startThread: true };
  }
  return { ...summary, conversationKind: 'main', replyInThread: false, startThread: false };
}

export function buildFeishuSessionConversationTarget(summary) {
  if (isFeishuDocumentCommentSummary(summary)) return normalizeConversationTarget(summary);
  if (!isFeishuThreadConversation(summary)) {
    return normalizeConversationTarget({
      chatId: summary?.chatId,
      tenantKey: summary?.tenantKey || summary?.sender?.tenantKey,
      chatType: summary?.chatType,
      conversationKind: 'main',
    });
  }
  const topicId = buildFeishuTopicId(summary);
  // A new thread starts on the inbound message even when that message is
  // itself an inline reply to an older message. Its inherited root_id is not
  // the root of the new thread.
  const rootId = (summary?.startThread === true ? trimString(summary?.messageId) : '')
    || trimString(summary?.rootId) || trimString(summary?.parentId)
    || (!topicId ? trimString(summary?.messageId) : '');
  return normalizeConversationTarget({
    ...summary,
    conversationKind: 'thread',
    ...(rootId ? { rootId } : {}),
    replyInThread: true,
  });
}

export function buildFeishuRequestDeliveryTarget(summary) {
  return normalizeConversationTarget({
    ...summary,
    conversationKind: isFeishuThreadConversation(summary) ? 'thread' : 'main',
    ...(summary?.startThread === true && trimString(summary?.messageId)
      ? { rootId: trimString(summary.messageId) } : {}),
  });
}

export function buildFeishuSessionExternalTriggerId(summary, sourceRouteId = 'default') {
  const safe = value => encodeURIComponent(trimString(value) || 'unknown');
  const route = safe(sourceRouteId);
  const tenant = safe(summary?.tenantKey || summary?.sender?.tenantKey);
  const chat = safe(summary?.chatId);
  if (isFeishuThreadConversation(summary)) {
    const topic = (summary?.startThread === true ? trimString(summary?.messageId) : '')
      || buildFeishuTopicId(summary) || trimString(summary?.rootId)
      || trimString(summary?.parentId) || trimString(summary?.messageId);
    return `feishu:thread:${route}:${tenant}:${chat}:${safe(topic)}`;
  }
  return `feishu:main:${route}:${tenant}:${chat}`;
}

/**
 * Feishu connector definition and protocol helpers.
 *
 * Keep Feishu/Lark message normalization and outbound content rendering here.
 * Runtime launchers such as scripts/feishu-connector.mjs should own process
 * lifecycle and config loading only.
 */

import { createHash } from 'crypto';

import { stripHiddenBlocks } from '../../lib/reply-selection.mjs';
import {
  buildFeishuIngestionState,
  buildFeishuSourceReference,
  extractFeishuImageKeysFromContent,
  extractFeishuResourcesFromContent,
  getSummaryFeishuImageKeys,
  getSummaryFeishuResources,
} from './inbound-envelope.mjs';
import { buildFeishuMathDocument } from './math-renderer.mjs';

export {
  extractFeishuImageKeysFromContent,
  extractFeishuResourcesFromContent,
  getSummaryFeishuImageKeys,
  getSummaryFeishuResources,
};

export const FEISHU_CONNECTOR_ID = 'feishu';
export const FEISHU_CONNECTOR_NAME = 'Feishu';
export const LARK_CONNECTOR_NAME = 'Lark';

export const LEGACY_DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT = [
  'You are replying as a Feishu bot powered by RemoteLab on the user\'s own machine.',
  'For each assistant turn, output exactly the plain-text message to send back to Feishu.',
  'Keep replies concise, helpful, and natural.',
  'Match the user\'s language when practical.',
  'In group chats, prefer silence by default: if the message is mainly human-to-human chatter, laughter, status updates, side remarks, or is not clearly asking for you, output an empty string.',
  'Reply when you are directly addressed, clearly asked for help or information, asked to take an action, or when a short reply is genuinely useful.',
  'If the chat asks you to speak less or not reply to every message, treat that as an active local rule until someone clearly changes it.',
  'If you are unsure whether to reply, choose silence and output an empty string. An empty string means no Feishu message should be sent.',
  'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
].join('\n');

export const DEFAULT_FEISHU_SESSION_SYSTEM_PROMPT = [
  'You are interacting through a Feishu or Lark bot on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by RemoteLab backend prompt logic.',
].join('\n');

export const MAX_FEISHU_TEXT_LENGTH = 5000;
export const MAX_INBOUND_LOG_PREVIEW_LENGTH = 240;

export const FEISHU_SKILLS = [
  {
    name: 'send_message',
    description: 'Send a Feishu/Lark bot message to a chat.',
    schema: {
      chatId: { type: 'string', required: true, description: 'Target Feishu/Lark chat_id' },
      text: { type: 'string', required: true, description: 'Plain text or markdown message body' },
      replyToMessageId: { type: 'string', description: 'Optional message_id to reply to' },
      replyInThread: { type: 'boolean', description: 'Whether to reply inside a topic/thread when replyToMessageId is set' },
    },
  },
];

const FEISHU_EMOJI_ALIAS_PATTERN = /\[(?:[\u3400-\u9FFF]{1,4})\]/gu;
const UNICODE_EMOJI_PATTERN = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0E|\uFE0F)?)*)/gu;

export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isFeishuDocumentCommentSummary(summary) {
  return trimString(summary?.sourceKind) === 'document_comment'
    || (
      trimString(summary?.messageType) === 'comment'
      && Boolean(trimString(summary?.fileToken))
      && Boolean(trimString(summary?.commentId))
    );
}

export function parseTextPreview(rawContent) {
  const content = trimString(rawContent);
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === 'string') {
      return parsed.text;
    }
  } catch {}
  return '';
}

export function parseMessageContent(rawContent) {
  const content = trimString(rawContent);
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {}
  return null;
}

export function truncateLogPreview(value, maxLength = MAX_INBOUND_LOG_PREVIEW_LENGTH) {
  const normalized = trimString(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function collectStructuredText(value, fragments, seen, depth = 0) {
  if (depth > 5 || fragments.length >= 8 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const normalized = trimString(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      fragments.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredText(item, fragments, seen, depth + 1);
      if (fragments.length >= 8) return;
    }
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['title', 'text', 'name', 'label', 'content']) {
    if (!(key in value)) continue;
    collectStructuredText(value[key], fragments, seen, depth + 1);
    if (fragments.length >= 8) return;
  }
}

export function extractStructuredTextPreview(value) {
  const fragments = [];
  collectStructuredText(value, fragments, new Set());
  return truncateLogPreview(fragments.join(' '));
}

function selectPostContentVariant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Array.isArray(value.content)) return value;
  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    const candidate = value[key];
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(value)) {
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  return null;
}

function renderPostElementText(element) {
  if (typeof element === 'string') return element;
  if (!element || typeof element !== 'object') return '';
  const tag = trimString(element.tag).toLowerCase();
  if (tag === 'at') {
    const name = trimString(element.user_name || element.name || element.text);
    const userId = trimString(element.user_id);
    return name ? `@${name.replace(/^@+/, '')}` : (userId ? `@${userId.replace(/^@+/, '')}` : '');
  }
  if (tag === 'a') {
    const text = typeof element.text === 'string' ? element.text : '';
    const href = trimString(element.href || element.url);
    if (!href) return text;
    return text && text !== href ? `${text} (${href})` : href;
  }
  if (['text', 'md'].includes(tag)) {
    return typeof element.text === 'string' ? element.text : '';
  }
  if (tag === 'img' || tag === 'image') return '[image]';
  if (tag === 'media') return '[media]';
  if (tag === 'file') {
    const fileName = trimString(element.file_name || element.name);
    return fileName ? `[file: ${fileName}]` : '[file]';
  }
  return typeof element.text === 'string' ? element.text : '';
}

export function extractPostMessageText(parsedContent) {
  const variant = selectPostContentVariant(parsedContent);
  if (!variant) return extractStructuredTextPreview(parsedContent);

  const lines = [];
  const title = trimString(variant.title);
  if (title) lines.push(title);

  for (const block of variant.content) {
    const elements = Array.isArray(block) ? block : [block];
    const line = elements.map(renderPostElementText).join('').trimEnd();
    if (line.trim()) {
      lines.push(line);
    }
  }
  return lines.join('\n').trim();
}

export function contentKeyPreview(parsedContent) {
  if (!parsedContent || Array.isArray(parsedContent) || typeof parsedContent !== 'object') {
    return [];
  }
  return Object.keys(parsedContent).filter(Boolean).slice(0, 6);
}

export function summarizeMessageContent(messageType, rawContent) {
  const normalizedType = trimString(messageType).toLowerCase();
  const parsedContent = parseMessageContent(rawContent);
  const resources = extractFeishuResourcesFromContent(parsedContent, normalizedType);
  const imageKeys = resources
    .filter((resource) => resource.resourceType === 'image')
    .map((resource) => resource.fileKey);
  let messageText = '';
  let textPreview = '';

  if (normalizedType === 'text') {
    messageText = parseTextPreview(rawContent) || trimString(rawContent);
    textPreview = messageText;
  } else if (normalizedType === 'post') {
    messageText = extractPostMessageText(parsedContent);
    textPreview = truncateLogPreview(messageText || extractStructuredTextPreview(parsedContent));
  } else if (normalizedType === 'file') {
    textPreview = trimString(parsedContent?.file_name || parsedContent?.name);
  } else if (normalizedType === 'share_chat') {
    textPreview = trimString(parsedContent?.chat_name || parsedContent?.name || parsedContent?.chat_id);
  } else if (normalizedType === 'share_user') {
    textPreview = trimString(parsedContent?.user_name || parsedContent?.name || parsedContent?.user_id);
  } else if (normalizedType === 'location') {
    textPreview = trimString(parsedContent?.name || parsedContent?.title || parsedContent?.address);
  } else if (normalizedType === 'interactive') {
    textPreview = extractStructuredTextPreview(parsedContent);
  } else if (!['image', 'audio', 'media', 'sticker'].includes(normalizedType)) {
    textPreview = extractStructuredTextPreview(parsedContent);
  }

  const contentSummary = (() => {
    switch (normalizedType) {
      case 'text':
        return textPreview ? `Text message: ${truncateLogPreview(textPreview)}` : 'Text message';
      case 'image':
        return 'Image attachment';
      case 'file':
        return textPreview ? `File attachment: ${truncateLogPreview(textPreview)}` : 'File attachment';
      case 'audio':
        return 'Audio attachment';
      case 'media':
        return 'Media attachment';
      case 'sticker':
        return 'Sticker message';
      case 'post':
        return textPreview ? `Rich text post: ${truncateLogPreview(textPreview)}` : 'Rich text post';
      case 'share_chat':
        return textPreview ? `Shared chat: ${truncateLogPreview(textPreview)}` : 'Shared chat';
      case 'share_user':
        return textPreview ? `Shared contact: ${truncateLogPreview(textPreview)}` : 'Shared contact';
      case 'location':
        return textPreview ? `Location message: ${truncateLogPreview(textPreview)}` : 'Location message';
      case 'interactive':
        return textPreview ? `Interactive card: ${truncateLogPreview(textPreview)}` : 'Interactive card';
      default: {
        const typeLabel = normalizedType || 'unknown';
        const keys = contentKeyPreview(parsedContent);
        return keys.length
          ? `Feishu ${typeLabel} message reference (keys=${keys.join(',')})`
          : `Feishu ${typeLabel} message reference`;
      }
    }
  })();

  return {
    messageText,
    textPreview,
    contentSummary,
    contentKeys: contentKeyPreview(parsedContent),
    resources,
    imageKeys,
  };
}

export function summarizeFeishuEventForLog(summary) {
  return {
    eventId: summary?.eventId || '',
    eventType: summary?.eventType || '',
    chatId: summary?.chatId || '',
    chatType: summary?.chatType || '',
    groupMessageType: summary?.groupMessageType || '',
    chatMode: summary?.chatMode || '',
    messageId: summary?.messageId || '',
    messageType: summary?.messageType || '',
    rootId: summary?.rootId || '',
    threadId: summary?.threadId || '',
    senderOpenId: summary?.sender?.openId || '',
    mentionCount: Array.isArray(summary?.mentions) ? summary.mentions.length : 0,
    textPreview: truncateLogPreview(summary?.textPreview),
    contentSummary: truncateLogPreview(summary?.contentSummary),
    sourceKind: summary?.sourceKind || '',
    fileType: summary?.fileType || '',
    fileToken: summary?.fileToken || '',
    commentId: summary?.commentId || '',
    replyId: summary?.replyId || '',
    mentionedBot: summary?.mentionedBot === true,
  };
}

export function summarizeFeishuEvent(data) {
  const sender = data?.sender || {};
  const senderId = sender?.sender_id || {};
  const message = data?.message || {};
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const rawContent = typeof message.content === 'string' ? message.content : '';
  const normalizedContent = summarizeMessageContent(message.message_type || '', rawContent);
  return {
    eventId: data?.event_id || '',
    eventType: data?.event_type || '',
    tenantKey: data?.tenant_key || '',
    appId: data?.app_id || '',
    createTime: data?.create_time || '',
    sender: {
      openId: senderId?.open_id || '',
      userId: senderId?.user_id || '',
      unionId: senderId?.union_id || '',
      senderType: sender?.sender_type || '',
      tenantKey: sender?.tenant_key || '',
    },
    chatId: message.chat_id || '',
    chatType: message.chat_type || '',
    groupMessageType: message.group_message_type || data?.group_message_type || '',
    chatMode: message.chat_mode || data?.chat_mode || '',
    messageId: message.message_id || '',
    rootId: message.root_id || '',
    parentId: message.parent_id || '',
    threadId: message.thread_id || '',
    messageType: message.message_type || '',
    mentions: mentions.map((mention) => ({
      key: mention?.key || '',
      name: mention?.name || '',
      openId: mention?.id?.open_id || '',
      userId: mention?.id?.user_id || '',
      unionId: mention?.id?.union_id || '',
      tenantKey: mention?.tenant_key || '',
    })),
    messageText: normalizedContent.messageText,
    textPreview: normalizedContent.textPreview,
    contentSummary: normalizedContent.contentSummary,
    contentKeys: normalizedContent.contentKeys,
    resources: normalizedContent.resources,
    imageKeys: normalizedContent.imageKeys,
    rawContent,
  };
}

export function summarizeFeishuLegacyMessageEvent(data) {
  const messageType = data?.msg_type || data?.message_type || '';
  const rawContent = typeof data?.text === 'string' ? data.text : '';
  const normalizedContent = summarizeMessageContent(messageType, rawContent);
  return {
    eventId: data?.uuid || data?.event_id || '',
    eventType: 'message',
    tenantKey: data?.tenant_key || '',
    appId: data?.app_id || '',
    createTime: data?.ts || '',
    sender: {
      openId: data?.open_id || data?.sender?.open_id || '',
      userId: data?.employee_id || data?.sender?.employee_id || '',
      unionId: '',
      senderType: 'user',
      tenantKey: data?.tenant_key || '',
    },
    chatId: data?.open_chat_id || data?.chat_id || '',
    chatType: data?.chat_type || '',
    groupMessageType: data?.group_message_type || '',
    chatMode: data?.chat_mode || '',
    messageId: data?.open_message_id || data?.message_id || '',
    rootId: '',
    parentId: '',
    threadId: '',
    messageType,
    mentions: [],
    messageText: typeof data?.text_without_at_bot === 'string'
      ? data.text_without_at_bot
      : normalizedContent.messageText,
    textPreview: typeof data?.text_without_at_bot === 'string' ? data.text_without_at_bot : normalizedContent.textPreview,
    contentSummary: normalizedContent.contentSummary,
    contentKeys: normalizedContent.contentKeys,
    resources: normalizedContent.resources,
    imageKeys: normalizedContent.imageKeys,
    rawContent,
  };
}

export function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

export function normalizeFeishuMode(value) {
  return trimString(value).toLowerCase().replace(/[_\s-]+/g, '_');
}

export function isFeishuTopicChat(summary) {
  const chatType = normalizeFeishuMode(summary?.chatType);
  const groupMessageType = normalizeFeishuMode(summary?.groupMessageType);
  const chatMode = normalizeFeishuMode(summary?.chatMode);
  return chatType === 'topic'
    || groupMessageType === 'thread'
    || groupMessageType === 'topic'
    || chatMode === 'thread'
    || chatMode === 'topic';
}

export function buildFeishuTopicId(summary) {
  const threadId = trimString(summary?.threadId);
  if (threadId) return threadId;

  const topicId = trimString(summary?.topicId);
  if (topicId) return topicId;

  const rootId = trimString(summary?.rootId);
  if (rootId) return rootId;

  if (isFeishuTopicChat(summary)) {
    return trimString(summary?.parentId) || trimString(summary?.messageId);
  }

  return '';
}

export function isFeishuTopicSummary(summary) {
  return Boolean(buildFeishuTopicId(summary));
}

export function buildFeishuConversationKind(summary) {
  if (isFeishuDocumentCommentSummary(summary)) return 'document_comment';
  return buildFeishuTopicId(summary) ? 'topic' : sanitizeIdPart(summary?.chatType || 'chat');
}

export function buildExternalTriggerId(summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return `feishu:document_comment:${sanitizeIdPart(summary?.fileType || 'file')}:${sanitizeIdPart(summary?.fileToken)}:${sanitizeIdPart(summary?.commentId)}`;
  }
  const chatId = sanitizeIdPart(summary?.chatId || 'unknown_chat');
  const topicId = buildFeishuTopicId(summary);
  if (topicId) {
    return `feishu:topic:${chatId}:${sanitizeIdPart(topicId)}`;
  }
  return `feishu:${sanitizeIdPart(summary?.chatType || 'chat')}:${chatId}`;
}

export function buildFeishuConversationQueueKey(summary) {
  if (trimString(summary?.chatId)) {
    return buildExternalTriggerId(summary);
  }
  return `feishu:message:${sanitizeIdPart(summary?.messageId || 'unknown_message')}`;
}

export function buildRequestId(summary) {
  return `feishu:${sanitizeIdPart(summary?.messageId || `${Date.now()}`)}`;
}

export function buildReplyUuid(summary) {
  return `reply:${sanitizeIdPart(summary?.messageId || `${Date.now()}`).slice(0, 60)}`;
}

export function buildFeishuApiUuid(value, summary) {
  const seed = trimString(value) || buildReplyUuid(summary);
  const normalized = seed
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized && normalized.length <= 64) {
    return normalized;
  }
  const digest = createHash('sha1').update(seed || `${Date.now()}`).digest('hex').slice(0, 32);
  return `rl_${digest}`;
}

export function buildSessionDescription(summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    return 'Inbound Feishu document comment';
  }
  if (buildFeishuTopicId(summary)) {
    return 'Inbound Feishu topic thread';
  }
  const chatType = trimString(summary?.chatType);
  return chatType ? `Inbound Feishu ${chatType} chat` : 'Inbound Feishu chat';
}

export function mentionDisplayName(mention) {
  const name = trimString(mention?.name);
  if (name) return name;
  const token = trimString(mention?.key).replace(/^@+/, '');
  return token || 'user';
}

export function renderMentionPreview(text, mentions) {
  let rendered = trimString(text);
  if (!rendered) return '';
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const token = trimString(mention?.key);
    if (!token) continue;
    rendered = rendered.split(token).join(`@${mentionDisplayName(mention)}`);
  }
  return rendered;
}

export function isSupportedRemoteLabInboundMessage(summary) {
  return Boolean(
    trimString(summary?.messageId)
    || trimString(summary?.messageType)
    || trimString(summary?.messageText || summary?.textPreview || summary?.contentSummary),
  );
}

export function buildRemoteLabMessage(summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    const current = trimString(summary?.messageText) || trimString(summary?.textPreview) || '[空评论]';
    const quote = trimString(summary?.commentQuote);
    const thread = (Array.isArray(summary?.commentThread) ? summary.commentThread : [])
      .map((entry) => ({
        text: trimString(entry?.text) || '[空评论]',
        isCurrent: entry?.isCurrent === true,
      }));
    const lines = [];
    if (quote) {
      lines.push(`文档中被评论的内容：\n${quote}`);
    }
    if (thread.length > 1) {
      lines.push(`文档评论线程：\n${thread.map((entry) => `${entry.isCurrent ? '→' : '-'} ${entry.text}`).join('\n')}`);
    }
    lines.push(`当前 @ 你的评论：\n${current}`);
    return lines.join('\n\n');
  }
  const rawMessage = trimString(summary?.messageText) || trimString(summary?.textPreview);
  const renderedMessage = renderMentionPreview(rawMessage, summary?.mentions);
  const displayMessage = renderedMessage || rawMessage || trimString(summary?.contentSummary) || '[non-text or empty message]';
  const senderName = trimString(summary?.sender?.name || summary?.sender?.displayName);
  const senderPrefix = summary?.chatType === 'group' && senderName ? `${senderName}: ` : '';
  const downloadFailures = Array.isArray(summary?.attachmentDownloadFailures)
    ? summary.attachmentDownloadFailures
    : [];
  const failureText = downloadFailures.length > 0
    ? `\n\n[Feishu attachment ingestion is partial: ${downloadFailures.length} resource(s) failed.]`
    : '';
  const ingestion = buildFeishuIngestionState(summary);
  const sourceReference = buildFeishuSourceReference(summary);
  const topicId = buildFeishuTopicId(summary);
  const referenceText = sourceReference && (ingestion.status !== 'complete' || topicId)
    ? `\n\n[Feishu source reference: message_id=${sourceReference.messageId}, message_type=${sourceReference.messageType}${topicId ? `, thread_id=${topicId}` : ''}]`
    : '';
  return `${senderPrefix}${displayMessage}${failureText}${referenceText}`;
}

export function buildSessionSourceContext(summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    const context = {
      connector: FEISHU_CONNECTOR_ID,
      conversationKind: 'document_comment',
      fileType: trimString(summary?.fileType),
      fileToken: trimString(summary?.fileToken),
      commentId: trimString(summary?.commentId),
    };
    const sourceRouteId = trimString(summary?.sourceRouteId);
    if (sourceRouteId) context.sourceRouteId = sourceRouteId;
    return context;
  }
  const topicId = buildFeishuTopicId(summary);
  const context = {
    connector: FEISHU_CONNECTOR_ID,
    conversationKind: buildFeishuConversationKind(summary),
    chatType: trimString(summary?.chatType),
    chatId: trimString(summary?.chatId),
  };
  const sourceRouteId = trimString(summary?.sourceRouteId);
  if (sourceRouteId) context.sourceRouteId = sourceRouteId;
  const chatName = trimString(summary?.chatName);
  if (chatName) context.chatName = chatName;
  const groupMessageType = trimString(summary?.groupMessageType);
  if (groupMessageType) context.groupMessageType = groupMessageType;
  const chatMode = trimString(summary?.chatMode);
  if (chatMode) context.chatMode = chatMode;
  if (topicId) context.topicId = topicId;
  const threadId = trimString(summary?.threadId);
  if (threadId) context.threadId = threadId;
  const rootId = trimString(summary?.rootId);
  if (rootId) context.rootId = rootId;
  return context;
}

export function buildMessageSourceContext(summary) {
  if (isFeishuDocumentCommentSummary(summary)) {
    const context = {
      connector: FEISHU_CONNECTOR_ID,
      conversationKind: 'document_comment',
      messageId: trimString(summary?.messageId),
      fileType: trimString(summary?.fileType),
      fileToken: trimString(summary?.fileToken),
      commentId: trimString(summary?.commentId),
    };
    const sourceRouteId = trimString(summary?.sourceRouteId);
    if (sourceRouteId) context.sourceRouteId = sourceRouteId;
    const replyId = trimString(summary?.replyId);
    if (replyId) context.replyId = replyId;
    const contentSummary = trimString(summary?.contentSummary);
    if (contentSummary) context.contentSummary = contentSummary;
    return context;
  }
  const topicId = buildFeishuTopicId(summary);
  const resources = getSummaryFeishuResources(summary);
  const imageCount = resources.filter((resource) => resource.resourceType === 'image').length;
  const fileCount = resources.filter((resource) => resource.resourceType === 'file').length;
  const sourceReference = buildFeishuSourceReference(summary);
  const context = {
    connector: FEISHU_CONNECTOR_ID,
    messageId: trimString(summary?.messageId),
    messageType: trimString(summary?.messageType).toLowerCase(),
    chatType: trimString(summary?.chatType),
    conversationKind: buildFeishuConversationKind(summary),
    ingestion: buildFeishuIngestionState(summary),
  };
  if (sourceReference) context.sourceReference = sourceReference;
  const sourceRouteId = trimString(summary?.sourceRouteId);
  if (sourceRouteId) context.sourceRouteId = sourceRouteId;
  if (topicId) context.topicId = topicId;
  const threadId = trimString(summary?.threadId);
  if (threadId) context.threadId = threadId;
  const rootId = trimString(summary?.rootId);
  if (rootId) context.rootId = rootId;
  const parentId = trimString(summary?.parentId);
  if (parentId) context.parentId = parentId;
  const groupMessageType = trimString(summary?.groupMessageType);
  if (groupMessageType) context.groupMessageType = groupMessageType;
  const chatMode = trimString(summary?.chatMode);
  if (chatMode) context.chatMode = chatMode;
  const senderName = trimString(summary?.sender?.name || summary?.sender?.displayName);
  if (senderName) {
    context.sender = { name: senderName };
  }
  const mentions = (Array.isArray(summary?.mentions) ? summary.mentions : [])
    .map((mention) => {
      const name = mentionDisplayName(mention);
      const token = trimString(mention?.key);
      if (!name && !token) return null;
      return {
        ...(name ? { name } : {}),
        ...(token ? { token } : {}),
      };
    })
    .filter(Boolean);
  if (mentions.length > 0) {
    context.mentions = mentions;
  }
  const contentSummary = trimString(summary?.contentSummary);
  if (contentSummary) {
    context.contentSummary = contentSummary;
  }
  if (resources.length > 0) {
    context.attachments = {
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(fileCount > 0 ? { fileCount } : {}),
    };
  }
  return context;
}

export function buildFeishuMessageIndexRecord(summary, sessionId) {
  const messageId = trimString(summary?.messageId);
  const normalizedSessionId = trimString(sessionId);
  if (!messageId || !normalizedSessionId) return null;
  return {
    connector: FEISHU_CONNECTOR_ID,
    ...(trimString(summary?.tenantKey || summary?.sender?.tenantKey) ? { accountId: trimString(summary?.tenantKey || summary?.sender?.tenantKey) } : {}),
    messageId,
    sessionId: normalizedSessionId,
    ...(trimString(summary?.chatId) ? { chatId: trimString(summary.chatId) } : {}),
    conversationId: buildFeishuTopicId(summary) || buildExternalTriggerId(summary),
    externalTriggerId: buildExternalTriggerId(summary),
    direction: 'inbound',
  };
}

export function buildFeishuOutboundMessageIndexRecord(summary, sessionId, outboundMessageId) {
  const messageId = trimString(outboundMessageId);
  const normalizedSessionId = trimString(sessionId);
  if (!messageId || !normalizedSessionId) return null;
  return {
    connector: FEISHU_CONNECTOR_ID,
    ...(trimString(summary?.tenantKey || summary?.sender?.tenantKey) ? { accountId: trimString(summary?.tenantKey || summary?.sender?.tenantKey) } : {}),
    messageId,
    sessionId: normalizedSessionId,
    ...(trimString(summary?.chatId) ? { chatId: trimString(summary.chatId) } : {}),
    conversationId: buildFeishuTopicId(summary) || buildExternalTriggerId(summary),
    externalTriggerId: buildExternalTriggerId(summary),
    sourceMessageId: trimString(summary?.messageId),
    direction: 'outbound',
  };
}

export function collectFeishuTopicParentMessageCandidates(summary) {
  const currentMessageId = trimString(summary?.messageId);
  const seen = new Set();
  const candidates = [];
  for (const value of [summary?.rootId, summary?.parentId, summary?.threadId]) {
    const messageId = trimString(value);
    if (!messageId || messageId === currentMessageId || seen.has(messageId)) continue;
    seen.add(messageId);
    candidates.push(messageId);
  }
  return candidates;
}

export function stripOutboundEmojiArtifacts(text) {
  return String(text || '')
    .replace(UNICODE_EMOJI_PATTERN, ' ')
    .replace(FEISHU_EMOJI_ALIAS_PATTERN, ' ')
    .replace(/[\u200D\uFE0E\uFE0F]/g, '')
    .replace(/\s+([,.;:!?，。！？；：、])/g, '$1')
    .replace(/([([{（【])\s+/g, '$1')
    .replace(/\s+([)\]}）】])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export function normalizeReplyText(text) {
  const normalized = stripOutboundEmojiArtifacts(stripHiddenBlocks(String(text || '').replace(/\r\n/g, '\n'))).trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_FEISHU_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_FEISHU_TEXT_LENGTH - 16).trimEnd()}\n\n[truncated]`;
}

function resolveMentionTargetId(mention) {
  return trimString(mention?.openId) || trimString(mention?.userId) || trimString(mention?.unionId);
}

function escapeFeishuMentionValue(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function compileFeishuReplyText(text, mentions) {
  let compiled = normalizeReplyText(text);
  const normalizedMentions = (Array.isArray(mentions) ? mentions : [])
    .map((mention) => ({
      mention,
      token: trimString(mention?.key),
      targetId: resolveMentionTargetId(mention),
      displayName: mentionDisplayName(mention),
    }))
    .filter((entry) => entry.targetId && (entry.token || entry.displayName));
  for (const { mention, token, targetId } of normalizedMentions.sort((left, right) => right.token.length - left.token.length)) {
    if (!token) continue;
    const tag = `<at user_id="${escapeFeishuMentionValue(targetId)}">${escapeFeishuMentionValue(mentionDisplayName(mention))}</at>`;
    compiled = compiled.split(token).join(tag);
  }
  for (const { mention, displayName, targetId } of normalizedMentions.sort((left, right) => right.displayName.length - left.displayName.length)) {
    if (!displayName) continue;
    const alias = `@${displayName}`;
    const tag = `<at user_id="${escapeFeishuMentionValue(targetId)}">${escapeFeishuMentionValue(mentionDisplayName(mention))}</at>`;
    compiled = compiled.split(alias).join(tag);
  }
  return compiled;
}

function normalizeMentionEntries(mentions) {
  return (Array.isArray(mentions) ? mentions : [])
    .map((mention) => ({
      mention,
      token: trimString(mention?.key),
      targetId: resolveMentionTargetId(mention),
      displayName: mentionDisplayName(mention),
    }))
    .filter((entry) => entry.targetId && (entry.token || entry.displayName));
}

function findNextMentionMatch(line, mentionEntries, startIndex) {
  let best = null;
  for (const entry of mentionEntries) {
    const markers = [
      entry.token,
      entry.displayName ? `@${entry.displayName}` : '',
    ].filter(Boolean);
    for (const marker of markers) {
      const index = line.indexOf(marker, startIndex);
      if (index < 0) continue;
      if (!best || index < best.index || (index === best.index && marker.length > best.marker.length)) {
        best = { entry, marker, index };
      }
    }
  }
  return best;
}

function appendFeishuMarkdownElements(elements, line, mentionEntries) {
  let cursor = 0;
  while (cursor < line.length) {
    const match = findNextMentionMatch(line, mentionEntries, cursor);
    if (!match) {
      elements.push({ tag: 'md', text: line.slice(cursor) });
      break;
    }
    if (match.index > cursor) {
      elements.push({ tag: 'md', text: line.slice(cursor, match.index) });
    }
    elements.push({
      tag: 'at',
      user_id: match.entry.targetId,
      user_name: match.entry.displayName || match.entry.targetId,
    });
    cursor = match.index + match.marker.length;
  }
  return elements;
}

function buildFeishuTextRow(text) {
  return [{ tag: 'text', text: text || '\u200B' }];
}

function pushFeishuMarkdownRow(content, text, mentionEntries) {
  const elements = [];
  appendFeishuMarkdownElements(elements, text, mentionEntries);
  content.push(elements.length > 0 ? elements : buildFeishuTextRow('\u200B'));
}

function pushFeishuDocumentLine(content, block, mentionEntries) {
  let markdown = '';
  const flushMarkdown = () => {
    pushFeishuMarkdownRow(content, markdown, mentionEntries);
    markdown = '';
  };
  let pushed = false;
  for (const segment of block.segments) {
    if (segment.type === 'text' || segment.type === 'inline_math') {
      markdown += segment.text;
      continue;
    }
    if (markdown) {
      flushMarkdown();
      pushed = true;
    }
    if (segment.type === 'formula_image' && segment.imageKey) {
      content.push([{ tag: 'img', image_key: segment.imageKey }]);
      pushed = true;
    }
  }
  if (markdown || !pushed) {
    flushMarkdown();
  }
}

export async function buildFeishuPostContent(text, mentions, options = {}) {
  const normalized = normalizeReplyText(text);
  const mentionEntries = normalizeMentionEntries(mentions)
    .sort((left, right) => Math.max(right.token.length, right.displayName.length) - Math.max(left.token.length, left.displayName.length));
  const document = await buildFeishuMathDocument(normalized, options);
  const content = [];
  for (const block of document.blocks) {
    if (block.type === 'line') {
      pushFeishuDocumentLine(content, block, mentionEntries);
      continue;
    }
    if (block.type === 'formula_image' && block.imageKey) {
      content.push([{ tag: 'img', image_key: block.imageKey }]);
      continue;
    }
    if (block.type === 'formula_fallback') {
      content.push(buildFeishuTextRow(block.text));
    }
  }
  return JSON.stringify({ zh_cn: { content } });
}

export function feishuMatchFn(pattern, message) {
  const normalizedPattern = trimString(pattern);
  if (!normalizedPattern || normalizedPattern === '*') return true;
  const candidates = [
    message?.targetId,
    message?.thread?.externalId,
    message?.sourceContext?.chatId,
    message?.sourceContext?.topicId,
    message?.to?.chatId,
    message?.to?.address,
  ].map((value) => trimString(value)).filter(Boolean);
  return candidates.includes(normalizedPattern);
}

import {
  buildFeishuTopicId,
  isFeishuDocumentCommentSummary,
  renderMentionPreview,
  summarizeMessageContent,
} from './index.mjs';
import { withTimeout } from '../../lib/connector-driver-transports.mjs';

export const FEISHU_CONTEXT_MAX_MESSAGES = 100;
export const FEISHU_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FEISHU_CONTEXT_ACTIVITY_GAP_MS = 4 * 60 * 60 * 1000;
export const FEISHU_CONTEXT_MAX_CHARACTERS = 48_000;

const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 50;
const MAX_MESSAGE_CHARACTERS = 6_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseFeishuMessageTime(value) {
  const text = trimString(String(value ?? ''));
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return 0;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatFeishuConversationTime(value, { timeZone } = {}) {
  const timestamp = typeof value === 'number' ? value : parseFeishuMessageTime(value);
  if (!timestamp) return '';
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    ...(timeZone ? { timeZone } : {}),
  };
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date(timestamp));
  const selected = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${selected.year}-${selected.month}-${selected.day} ${selected.hour}:${selected.minute}:${selected.second}`;
}

function senderName(item) {
  const sender = item?.sender || {};
  const localized = sender.sender_i18n_names || {};
  return trimString(sender.sender_name)
    || trimString(localized.zh_cn)
    || trimString(localized.en_us)
    || trimString(localized.ja_jp)
    || (trimString(sender.sender_type).toLowerCase() === 'app' ? '机器人' : '群成员');
}

function attachmentPlaceholder(messageType, preview) {
  switch (trimString(messageType).toLowerCase()) {
    case 'image': return '[图片]';
    case 'file': return preview ? `[文件：${preview}]` : '[文件]';
    case 'audio': return '[音频]';
    case 'media': return '[视频或媒体]';
    case 'sticker': return '[表情]';
    default: return '';
  }
}

function historyMessageText(item) {
  const messageType = trimString(item?.msg_type || item?.message_type).toLowerCase();
  const rawContent = typeof item?.body?.content === 'string'
    ? item.body.content
    : (typeof item?.content === 'string' ? item.content : '');
  const summary = summarizeMessageContent(messageType, rawContent);
  const messageText = renderMentionPreview(summary.messageText || summary.textPreview, item?.mentions);
  const fallback = attachmentPlaceholder(messageType, summary.textPreview) || summary.contentSummary;
  const text = trimString(messageText || fallback);
  return text.length > MAX_MESSAGE_CHARACTERS
    ? `${text.slice(0, MAX_MESSAGE_CHARACTERS)}…`
    : text;
}

function isConnectorReceiptOnly(text, item) {
  if (trimString(item?.sender?.sender_type).toLowerCase() !== 'app') return false;
  const normalized = trimString(text).replace(/\r\n/g, '\n');
  return /^(?:会话已创建|Session created)(?:[。.!！\n]|$)/i.test(normalized)
    && /(?:查看会话详情和进度|session=)/i.test(normalized);
}

export function normalizeFeishuHistoryItem(item, options = {}) {
  if (!item || item.deleted === true) return null;
  const timestamp = parseFeishuMessageTime(item.create_time || item.createTime);
  if (!timestamp) return null;
  const text = historyMessageText(item);
  if (!text || isConnectorReceiptOnly(text, item)) return null;
  return {
    sender: senderName(item),
    time: formatFeishuConversationTime(timestamp, options),
    text,
    timestamp,
  };
}

async function listMessages(runtime, {
  containerId,
  containerIdType,
  endTimeMs,
  startTimeMs = 0,
  maxMessages,
  timeoutMs,
}) {
  const list = runtime?.appClient?.im?.v1?.message?.list;
  if (typeof list !== 'function') return [];
  const items = [];
  const seenMessageIds = new Set();
  let pageToken = '';
  while (items.length < maxMessages) {
    const params = {
      container_id_type: containerIdType,
      container_id: containerId,
      sort_type: 'ByCreateTimeDesc',
      page_size: Math.min(PAGE_SIZE, maxMessages - items.length),
      with_sender_name: true,
      ...(startTimeMs ? { start_time: String(Math.floor(startTimeMs / 1000)) } : {}),
      ...(endTimeMs ? { end_time: String(Math.floor(endTimeMs / 1000)) } : {}),
      ...(pageToken ? { page_token: pageToken } : {}),
    };
    const response = await withTimeout(
      () => list.call(runtime.appClient.im.v1.message, { params }),
      timeoutMs,
      'Feishu conversation context lookup',
    );
    if (response?.code !== undefined && response.code !== 0) {
      throw new Error(response.msg || `Failed to load Feishu conversation context (${response.code})`);
    }
    const pageItems = Array.isArray(response?.data?.items) ? response.data.items : [];
    for (const item of pageItems) {
      const messageId = trimString(item?.message_id);
      if (messageId && seenMessageIds.has(messageId)) continue;
      if (messageId) seenMessageIds.add(messageId);
      items.push(item);
      if (items.length >= maxMessages) break;
    }
    pageToken = trimString(response?.data?.page_token);
    if (response?.data?.has_more !== true || !pageToken || pageItems.length === 0) break;
  }
  return items;
}

function keepCurrentActivity(messages, maxGapMs) {
  const newestFirst = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  if (newestFirst.length < 2) return newestFirst;
  const selected = [newestFirst[0]];
  for (let index = 1; index < newestFirst.length; index += 1) {
    const newer = selected[selected.length - 1];
    const older = newestFirst[index];
    if (newer.timestamp - older.timestamp > maxGapMs) break;
    selected.push(older);
  }
  return selected;
}

function fitCharacterBudget(messages, maxCharacters) {
  const newestFirst = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  const selected = [];
  let characters = 0;
  let truncated = false;
  for (const message of newestFirst) {
    const cost = message.time.length + message.sender.length + message.text.length + 8;
    if (selected.length > 0 && characters + cost > maxCharacters) {
      truncated = true;
      break;
    }
    if (selected.length === 0 && cost > maxCharacters) {
      const room = Math.max(1, maxCharacters - message.time.length - message.sender.length - 9);
      selected.push({ ...message, text: `${message.text.slice(0, room)}…` });
      truncated = true;
      break;
    }
    selected.push(message);
    characters += cost;
  }
  if (selected.length < messages.length) truncated = true;
  return { messages: selected.reverse(), truncated };
}

export async function loadFeishuConversationContext(runtime, summary, options = {}) {
  if (isFeishuDocumentCommentSummary(summary)) return null;
  const chatId = trimString(summary?.chatId);
  if (!chatId) return null;
  const currentMessageId = trimString(summary?.messageId);
  const now = parseFeishuMessageTime(summary?.createTime) || Date.now();
  const maxMessages = positiveInteger(options.maxMessages, FEISHU_CONTEXT_MAX_MESSAGES);
  const maxAgeMs = positiveInteger(options.maxAgeMs, FEISHU_CONTEXT_MAX_AGE_MS);
  const maxGapMs = positiveInteger(options.maxGapMs, FEISHU_CONTEXT_ACTIVITY_GAP_MS);
  const maxCharacters = positiveInteger(options.maxCharacters, FEISHU_CONTEXT_MAX_CHARACTERS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const topicId = buildFeishuTopicId(summary);
  const rawItems = await listMessages(runtime, {
    containerId: topicId || chatId,
    containerIdType: topicId ? 'thread' : 'chat',
    endTimeMs: now,
    startTimeMs: topicId ? 0 : now - maxAgeMs,
    maxMessages,
    timeoutMs,
  });
  const normalized = rawItems
    .filter((item) => !currentMessageId || trimString(item?.message_id) !== currentMessageId)
    .map((item) => normalizeFeishuHistoryItem(item, { timeZone: options.timeZone }))
    .filter((item) => item && item.timestamp <= now);
  const relevant = topicId ? normalized : keepCurrentActivity(normalized, maxGapMs);
  const fitted = fitCharacterBudget(relevant, maxCharacters);
  if (fitted.messages.length === 0) return null;
  return {
    messages: fitted.messages.map(({ sender, time, text }) => ({ sender, time, text })),
    truncated: fitted.truncated || rawItems.length >= maxMessages,
  };
}

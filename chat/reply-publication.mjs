import {
  buildAssistantReplyAttachmentFallbackText,
  getAssistantReplyAttachments,
  isFeishuNoTextDecision,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs';
import {
  appendSessionEntryFooter,
  buildSessionEntry,
  buildSessionNavigationHref,
} from '../lib/session-navigation.mjs';
import { buildSessionDisplayEvents } from './session-display-events.mjs';
import { parseFeishuReactionDirective } from '../lib/feishu-reaction-directive.mjs';
import { isReplyMessage } from '../lib/assistant-message-phase.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function attachmentIdentity(attachment, index = 0) {
  if (!(attachment && typeof attachment === 'object')) {
    return `unknown:${index}`;
  }
  const assetId = trimString(attachment.assetId);
  if (assetId) return `asset:${assetId}`;
  const downloadUrl = trimString(attachment.downloadUrl);
  if (downloadUrl) return `download:${downloadUrl}`;
  const filename = trimString(attachment.filename);
  if (filename) return `filename:${filename}`;
  const originalName = trimString(attachment.originalName);
  const mimeType = trimString(attachment.mimeType);
  const sizeBytes = Number.isInteger(attachment.sizeBytes) ? String(attachment.sizeBytes) : '';
  return `meta:${originalName}:${mimeType}:${sizeBytes}:${index}`;
}

export function normalizeReplyPublicationResponseIds(values = [], fallback = '') {
  const normalized = [];
  const seen = new Set();
  const entries = Array.isArray(values) ? values : [];
  for (const value of entries) {
    const candidate = trimString(value);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  const fallbackId = trimString(fallback);
  if (fallbackId && !seen.has(fallbackId)) {
    normalized.push(fallbackId);
  }
  return normalized;
}

export function getRunResponseIds(run = {}) {
  return normalizeReplyPublicationResponseIds(
    [],
    trimString(run?.responseId || run?.requestId),
  );
}

export function runIncludesResponseId(run, responseId) {
  const requested = trimString(responseId);
  if (!requested) return false;
  return getRunResponseIds(run).includes(requested);
}

export function sourceContextReferencesRequest(sourceContext, requestId, messageId = '') {
  if (!sourceContext || typeof sourceContext !== 'object' || Array.isArray(sourceContext)) {
    return false;
  }

  const normalizedRequestId = trimString(requestId);
  const normalizedMessageId = trimString(messageId);
  if (normalizedRequestId && trimString(sourceContext.requestId) === normalizedRequestId) {
    return true;
  }
  if (normalizedMessageId && trimString(sourceContext.messageId) === normalizedMessageId) {
    return true;
  }

  if (!Array.isArray(sourceContext.queuedMessages)) {
    return false;
  }

  return sourceContext.queuedMessages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (normalizedRequestId && trimString(entry.requestId) === normalizedRequestId) {
      return true;
    }
    return sourceContextReferencesRequest(entry.sourceContext, normalizedRequestId, normalizedMessageId);
  });
}

export function resolveReplyPublicationUserEvent(history = [], responseId = '') {
  const requested = trimString(responseId);
  if (!requested) return null;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.type !== 'message' || event.role !== 'user') continue;
    if (trimString(event.responseId) === requested) return event;
    if (trimString(event.requestId) === requested) return event;
    if (sourceContextReferencesRequest(event.sourceContext, requested, requested)) {
      return event;
    }
  }

  return null;
}

export function collectReplyPublicationRunIds(run = {}) {
  return trimString(run.id) ? [trimString(run.id)] : [];
}

export function collectReplyPublicationHistory(history = [], rootRun = {}) {
  const runIdSet = new Set(collectReplyPublicationRunIds(rootRun));
  const responseIdSet = new Set(getRunResponseIds(rootRun));
  return (Array.isArray(history) ? history : []).filter((event) => {
    if (!(event && typeof event === 'object')) return false;
    const runId = trimString(event.runId);
    if (runId && runIdSet.has(runId)) return true;
    const resultRunId = trimString(event.resultRunId);
    if (resultRunId && runIdSet.has(resultRunId)) return true;
    const responseId = trimString(event.responseId);
    return !!(responseId && responseIdSet.has(responseId));
  });
}

export function buildFeishuAmbientIncompleteWorkNotice(history = [], payload = {}, session = null) {
  if ((trimString(payload.text) && !payload.invalidReactionDirective)
      || (payload.attachments || []).length > 0) return '';
  if (!history.some(event => event?.type === 'tool_use' && event.role === 'assistant')) return '';
  const url = session?.id ? buildSessionNavigationHref(session.id, { requireAbsolute: true }) : '';
  return ['我开始检查这条消息，但本轮没有形成可交付的结论；这项工作仍未完成。',
    ...(url ? [`查看已做的检查：${url}`] : [])].join('\n');
}

function collectPayloadAttachments(events = []) {
  const attachments = [];
  const seen = new Set();
  for (const event of events) {
    const eventAttachments = getAssistantReplyAttachments(event);
    for (const attachment of eventAttachments) {
      const identity = attachmentIdentity(attachment, attachments.length);
      if (seen.has(identity)) continue;
      seen.add(identity);
      attachments.push({ ...attachment });
    }
  }
  return attachments;
}

function buildPayloadText(displayEvents = []) {
  const parts = [];
  for (const event of displayEvents) {
    if (event?.type === 'message' && event.role === 'assistant') {
      const content = stripHiddenBlocks(event.content || '');
      if (content) {
        parts.push(content);
      }
      continue;
    }
    if (event?.type === 'attachment_delivery') {
      const fallback = buildAssistantReplyAttachmentFallbackText(event);
      if (fallback) {
        parts.push(fallback);
      }
    }
  }
  return parts.join('\n\n').trim();
}

function sameHistoryEvent(left, right) {
  if (!left || !right) return false;
  if (Number.isInteger(left.seq) && Number.isInteger(right.seq)) {
    return left.seq === right.seq;
  }
  return left === right;
}

function isFirstUserTurnPublication(history, rootRun, fullHistory) {
  const completeHistory = Array.isArray(fullHistory) ? fullHistory : history;
  const firstUserEvent = completeHistory.find((event) => event?.type === 'message' && event.role === 'user');
  if (!firstUserEvent) return false;

  for (const responseId of getRunResponseIds(rootRun)) {
    const publicationUserEvent = resolveReplyPublicationUserEvent(completeHistory, responseId);
    if (sameHistoryEvent(firstUserEvent, publicationUserEvent)) return true;
  }

  const publicationUserEvent = history.find((event) => event?.type === 'message' && event.role === 'user');
  return sameHistoryEvent(firstUserEvent, publicationUserEvent);
}

export function buildReplyPublicationPayload(history = [], rootRun = {}, {
  session = null,
  fullHistory = history,
  includeSessionEntry = true,
} = {}) {
  const replyHistory = history.filter(event => event?.type !== 'message'
    || event.role !== 'assistant' || isReplyMessage(event));
  const displayEvents = buildSessionDisplayEvents(replyHistory, { sessionRunning: false })
    .filter((event) => event?.role === 'assistant')
    .filter((event) => event.type === 'message' || event.type === 'attachment_delivery');
  const lastAssistantMessage = [...replyHistory].reverse().find(isReplyMessage);
  const reactionDirective = session?.sourceId === 'feishu'
    ? parseFeishuReactionDirective(lastAssistantMessage?.content) : null;
  const noTextDecision = reactionDirective
    ? !stripHiddenBlocks(reactionDirective.text)
    : isFeishuNoTextDecision(lastAssistantMessage?.content);

  const payload = {
    responseIds: getRunResponseIds(rootRun),
    displayEvents,
    attachments: noTextDecision ? [] : collectPayloadAttachments(displayEvents),
    text: reactionDirective
      ? (reactionDirective.invalid
        ? ['这条消息的表情指令无效，表情未能添加。', stripHiddenBlocks(reactionDirective.text)]
          .filter(Boolean).join('\n')
        : stripHiddenBlocks(reactionDirective.text))
      : noTextDecision ? '' : buildPayloadText(displayEvents),
  };
  if (reactionDirective?.emojiType) payload.reaction = reactionDirective.emojiType;
  if (reactionDirective?.invalid) payload.invalidReactionDirective = true;

  if (includeSessionEntry && (payload.text || payload.attachments.length)
      && isFirstUserTurnPublication(history, rootRun, fullHistory)) {
    const sessionEntry = buildSessionEntry(session);
    if (sessionEntry) {
      payload.sessionEntry = sessionEntry;
      payload.text = appendSessionEntryFooter(payload.text, sessionEntry);
    }
  }

  return payload;
}

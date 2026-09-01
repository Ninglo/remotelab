import {
  buildAssistantReplyAttachmentFallbackText,
  getAssistantReplyAttachments,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs';
import { buildSessionDisplayEvents } from './session-display-events.mjs';

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
    run?.replyPublication?.responseIds,
    trimString(run?.responseId),
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

export function collectReplyPublicationRunIds(rootRun = {}) {
  const runIds = [];
  const seen = new Set();
  for (const candidate of [
    trimString(rootRun?.replyPublication?.rootRunId),
    trimString(rootRun?.id),
    ...(Array.isArray(rootRun?.replyPublication?.continuationRunIds) ? rootRun.replyPublication.continuationRunIds : []),
    trimString(rootRun?.replyPublication?.finalRunId),
  ]) {
    const runId = trimString(candidate);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    runIds.push(runId);
  }
  return runIds;
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

export function buildReplyPublicationPayload(history = [], rootRun = {}) {
  const displayEvents = buildSessionDisplayEvents(history, { sessionRunning: false })
    .filter((event) => event?.role === 'assistant')
    .filter((event) => event.type === 'message' || event.type === 'attachment_delivery');

  return {
    responseIds: getRunResponseIds(rootRun),
    displayEvents,
    attachments: collectPayloadAttachments(displayEvents),
    text: buildPayloadText(displayEvents),
  };
}

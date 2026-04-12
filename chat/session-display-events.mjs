import {
  getMessageAttachments,
  stripAttachmentSavedPath,
  stripEventAttachmentSavedPaths,
} from './attachment-utils.mjs';
import {
  rewriteAssistantLocalMarkdownImageTargets,
  stripAssistantArtifactDeliveryHints,
} from './session-result-files.mjs';

const HIDDEN_EVENT_TYPES = new Set(['reasoning', 'manager_context', 'tool_use', 'tool_result', 'file_change']);

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function isAssistantMessageEvent(event) {
  return event?.type === 'message' && event?.role === 'assistant';
}

function getAttachmentIdentity(attachment, index = 0) {
  if (!(attachment && typeof attachment === 'object')) {
    return `unknown:${index}`;
  }
  const assetId = typeof attachment.assetId === 'string' ? attachment.assetId.trim() : '';
  if (assetId) return `asset:${assetId}`;
  const downloadUrl = typeof attachment.downloadUrl === 'string' ? attachment.downloadUrl.trim() : '';
  if (downloadUrl) return `download:${downloadUrl}`;
  const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : '';
  if (filename) return `filename:${filename}`;
  const originalName = typeof attachment.originalName === 'string' ? attachment.originalName.trim() : '';
  const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.trim() : '';
  const parsedSize = Number.parseInt(String(attachment.sizeBytes || ''), 10);
  const sizeKey = Number.isInteger(parsedSize) && parsedSize > 0 ? String(parsedSize) : '';
  return `meta:${originalName}:${mimeType}:${sizeKey}:${index}`;
}

function collectAttachmentDeliveryAttachments(events = []) {
  const attachments = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    for (const attachment of getMessageAttachments(event)) {
      const identity = getAttachmentIdentity(attachment, attachments.length);
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      const normalized = stripAttachmentSavedPath(cloneJson(attachment));
      if (!(normalized && typeof normalized === 'object')) continue;
      attachments.push({
        ...normalized,
        renderAs: 'file',
      });
    }
  }
  return attachments;
}

function buildAttachmentDeliveryKey(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment, index) => getAttachmentIdentity(attachment, index))
    .join('|');
}

function buildAttachmentDeliveryEvent(events = [], { referenceEvent = null } = {}) {
  const attachments = collectAttachmentDeliveryAttachments(events);
  if (attachments.length === 0) return null;
  const reference = referenceEvent || events[events.length - 1] || null;
  return {
    type: 'attachment_delivery',
    seq: Number.isInteger(reference?.seq) ? reference.seq : 0,
    role: 'assistant',
    timestamp: reference?.timestamp || null,
    deliveryKey: buildAttachmentDeliveryKey(attachments),
    attachments: cloneJson(attachments),
    images: cloneJson(attachments),
  };
}

function collectMirroredAttachmentSourceEvents(events = []) {
  const sourceEvents = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!isAssistantMessageEvent(event)) continue;
    if (getMessageAttachments(event).length === 0) continue;
    sourceEvents.push(event);
  }
  return sourceEvents;
}

function collectMirroredAttachmentSeqs(events = []) {
  return new Set(
    collectMirroredAttachmentSourceEvents(events)
      .map((event) => (Number.isInteger(event?.seq) ? event.seq : 0))
      .filter((seq) => seq > 0),
  );
}

function hasVisibleMessagePayload(event, { includeAttachments = true } = {}) {
  if (event?.type !== 'message') return true;
  const content = typeof event.content === 'string' ? event.content.trim() : '';
  if (content) return true;
  return includeAttachments && getMessageAttachments(event).length > 0;
}

function shouldStripVisibleMessageAttachments(event, mirroredAttachmentSeqs) {
  if (!(mirroredAttachmentSeqs instanceof Set) || mirroredAttachmentSeqs.size === 0) return false;
  return Number.isInteger(event?.seq) && mirroredAttachmentSeqs.has(event.seq);
}

function isIgnoredStatusEvent(event) {
  if (event?.type !== 'status') return false;
  const content = typeof event.content === 'string' ? event.content.trim().toLowerCase() : '';
  return content === 'thinking' || content === 'completed';
}

function isHiddenEvent(event) {
  return HIDDEN_EVENT_TYPES.has(event?.type);
}

function isVisibleEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'message') return true;
  if (event.type === 'context_barrier' || event.type === 'context_operation' || event.type === 'usage') return true;
  if (event.type === 'status') return !isIgnoredStatusEvent(event) && !!String(event.content || '').trim();
  return false;
}

function collectLocalMarkdownImageRewriteMap(events = []) {
  const rewriteMapBySeq = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const rewrites = Array.isArray(event?.localMarkdownImageRewrites)
      ? event.localMarkdownImageRewrites
      : [];
    for (const rewrite of rewrites) {
      const seq = Number.isInteger(rewrite?.seq) ? rewrite.seq : 0;
      const candidate = typeof rewrite?.candidate === 'string' ? rewrite.candidate.trim() : '';
      const url = typeof rewrite?.url === 'string' ? rewrite.url.trim() : '';
      if (seq < 1 || !candidate || !url) continue;
      if (!rewriteMapBySeq.has(seq)) {
        rewriteMapBySeq.set(seq, new Map());
      }
      rewriteMapBySeq.get(seq).set(candidate, url);
    }
  }
  return rewriteMapBySeq;
}

function stripDeferredBodyFields(event, { localMarkdownImageRewriteMapBySeq = null } = {}) {
  const next = stripEventAttachmentSavedPaths(cloneJson(event));
  if (!next || typeof next !== 'object') return next;
  if (next.type === 'message' && next.role === 'assistant' && typeof next.content === 'string') {
    const messageRewrites = Number.isInteger(next.seq) && localMarkdownImageRewriteMapBySeq instanceof Map
      ? localMarkdownImageRewriteMapBySeq.get(next.seq)
      : null;
    next.content = rewriteAssistantLocalMarkdownImageTargets(next.content, messageRewrites);
    next.content = stripAssistantArtifactDeliveryHints(next.content);
  }
  delete next.bodyRef;
  delete next.bodyField;
  delete next.bodyAvailable;
  delete next.bodyLoaded;
  delete next.bodyPreview;
  delete next.bodyBytes;
  return next;
}

function collectToolNames(events = []) {
  const names = [];
  const seen = new Set();
  for (const event of events) {
    if (event?.type !== 'tool_use') continue;
    const toolName = typeof event?.toolName === 'string' ? event.toolName.trim() : '';
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    names.push(toolName);
  }
  return names;
}

function formatToolNames(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return names.slice(0, max).join(', ') + ` +${names.length - max}`;
}

function buildThinkingBlockLabel(hiddenEvents, state = 'completed') {
  const toolNames = collectToolNames(hiddenEvents);
  if (state === 'running') {
    if (toolNames.length > 0) {
      return `Thinking · using ${formatToolNames(toolNames)}`;
    }
    return 'Thinking…';
  }
  if (toolNames.length > 0) {
    return `Thought · used ${formatToolNames(toolNames)}`;
  }
  return 'Thought';
}

function buildThinkingBlockEvent(hiddenEvents, state = 'completed') {
  const first = hiddenEvents[0] || null;
  const last = hiddenEvents[hiddenEvents.length - 1] || first;
  const toolNames = collectToolNames(hiddenEvents);
  return {
    type: 'thinking_block',
    seq: Number.isInteger(first?.seq) ? first.seq : 0,
    blockStartSeq: Number.isInteger(first?.seq) ? first.seq : 0,
    blockEndSeq: Number.isInteger(last?.seq) ? last.seq : 0,
    state,
    label: buildThinkingBlockLabel(hiddenEvents, state),
    hiddenEventCount: hiddenEvents.length,
    ...(toolNames.length > 0 ? { toolNames } : {}),
  };
}

function pushVisibleEvent(target, event, { stripAttachments = false, localMarkdownImageRewriteMapBySeq = null } = {}) {
  if (!isVisibleEvent(event)) return;
  if (!hasVisibleMessagePayload(event, { includeAttachments: !stripAttachments })) return;
  const next = stripDeferredBodyFields(event, { localMarkdownImageRewriteMapBySeq });
  if (stripAttachments && next?.type === 'message') {
    delete next.attachments;
    delete next.images;
  }
  target.push(next);
}

function emitSegmentedTurnBody(target, bodyEvents, {
  sessionRunning = false,
  mirroredAttachmentSeqs = null,
  localMarkdownImageRewriteMapBySeq = null,
} = {}) {
  const hiddenSegment = [];

  for (const event of bodyEvents) {
    if (isHiddenEvent(event)) {
      hiddenSegment.push(event);
      continue;
    }

    if (hiddenSegment.length > 0) {
      target.push(buildThinkingBlockEvent(hiddenSegment.splice(0), 'completed'));
    }

    pushVisibleEvent(target, event, {
      stripAttachments: shouldStripVisibleMessageAttachments(event, mirroredAttachmentSeqs),
      localMarkdownImageRewriteMapBySeq,
    });
  }

  if (hiddenSegment.length > 0) {
    target.push(buildThinkingBlockEvent(hiddenSegment, sessionRunning ? 'running' : 'completed'));
  }
}

function getTurnEventsWithoutIgnoredStatuses(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => !isIgnoredStatusEvent(event));
}

function findLastHiddenEventIndex(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isHiddenEvent(events[index])) {
      return index;
    }
  }
  return -1;
}

function findTurnForBlockRange(history = [], startSeq = 0, endSeq = 0) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  let startIndex = -1;
  let endIndex = -1;

  for (let index = 0; index < normalizedHistory.length; index += 1) {
    const seq = Number.isInteger(normalizedHistory[index]?.seq) ? normalizedHistory[index].seq : 0;
    if (seq < 1) continue;
    if (startIndex < 0 && seq >= startSeq) {
      startIndex = index;
    }
    if (seq <= endSeq) {
      endIndex = index;
    }
  }

  if (startIndex < 0 || endIndex < startIndex) return null;

  let userIndex = -1;
  for (let index = startIndex; index >= 0; index -= 1) {
    const event = normalizedHistory[index];
    if (event?.type === 'message' && event.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;

  let nextUserIndex = normalizedHistory.length;
  for (let index = userIndex + 1; index < normalizedHistory.length; index += 1) {
    const event = normalizedHistory[index];
    if (event?.type === 'message' && event.role === 'user') {
      nextUserIndex = index;
      break;
    }
  }
  if (endIndex >= nextUserIndex) return null;

  return {
    body: normalizedHistory.slice(userIndex + 1, nextUserIndex),
  };
}

function flushTurnInto(target, turn, { sessionRunning = false } = {}) {
  if (!turn?.user) return;
  target.push(stripDeferredBodyFields(turn.user));

  const bodyEvents = getTurnEventsWithoutIgnoredStatuses(turn.body);
  if (bodyEvents.length === 0) return;

  const mirroredAttachmentSourceEvents = collectMirroredAttachmentSourceEvents(bodyEvents);
  const mirroredAttachmentSeqs = collectMirroredAttachmentSeqs(bodyEvents);
  const localMarkdownImageRewriteMapBySeq = collectLocalMarkdownImageRewriteMap(bodyEvents);
  const deliveryEvent = buildAttachmentDeliveryEvent(mirroredAttachmentSourceEvents, {
    referenceEvent: bodyEvents[bodyEvents.length - 1] || turn.user,
  });

  if (sessionRunning) {
    target.push(buildThinkingBlockEvent(bodyEvents, 'running'));
    if (deliveryEvent) {
      target.push(deliveryEvent);
    }
    return;
  }

  const lastHiddenIndex = findLastHiddenEventIndex(bodyEvents);
  if (lastHiddenIndex < 0) {
    emitSegmentedTurnBody(target, bodyEvents, {
      sessionRunning,
      mirroredAttachmentSeqs,
      localMarkdownImageRewriteMapBySeq,
    });
    if (deliveryEvent) {
      target.push(deliveryEvent);
    }
    return;
  }

  const visibleTail = bodyEvents.slice(lastHiddenIndex + 1).filter(isVisibleEvent);
  if (visibleTail.length === 0) {
    emitSegmentedTurnBody(target, bodyEvents, {
      sessionRunning,
      mirroredAttachmentSeqs,
      localMarkdownImageRewriteMapBySeq,
    });
    if (deliveryEvent) {
      target.push(deliveryEvent);
    }
    return;
  }

  const collapsedPrefix = bodyEvents.slice(0, lastHiddenIndex + 1);
  if (collapsedPrefix.length > 0) {
    target.push(buildThinkingBlockEvent(collapsedPrefix, 'completed'));
  }
  for (const event of visibleTail) {
    pushVisibleEvent(target, event, {
      stripAttachments: shouldStripVisibleMessageAttachments(event, mirroredAttachmentSeqs),
      localMarkdownImageRewriteMapBySeq,
    });
  }
  if (deliveryEvent) {
    target.push(deliveryEvent);
  }
}

export function buildSessionDisplayEvents(history = [], options = {}) {
  const displayEvents = [];
  let currentTurn = null;

  for (const event of Array.isArray(history) ? history : []) {
    if (event?.type === 'message' && event.role === 'user') {
      flushTurnInto(displayEvents, currentTurn, { sessionRunning: false });
      currentTurn = {
        user: event,
        body: [],
      };
      continue;
    }

    if (currentTurn) {
      currentTurn.body.push(event);
      continue;
    }

    pushVisibleEvent(displayEvents, event);
  }

  flushTurnInto(displayEvents, currentTurn, options);
  return displayEvents;
}

export function buildEventBlockEvents(history = [], startSeq = 0, endSeq = 0) {
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq) || startSeq < 1 || endSeq < startSeq) {
    return [];
  }
  const turn = findTurnForBlockRange(history, startSeq, endSeq);
  const mirroredAttachmentSeqs = turn
    ? collectMirroredAttachmentSeqs(getTurnEventsWithoutIgnoredStatuses(turn.body))
    : new Set();

  return (Array.isArray(history) ? history : [])
    .filter((event) => Number.isInteger(event?.seq) && event.seq >= startSeq && event.seq <= endSeq)
    .filter((event) => !isIgnoredStatusEvent(event))
    .map((event) => {
      const stripAttachments = shouldStripVisibleMessageAttachments(event, mirroredAttachmentSeqs);
      if (!stripAttachments) {
        return stripDeferredBodyFields(event);
      }
      if (!hasVisibleMessagePayload(event, { includeAttachments: false })) {
        return null;
      }
      const next = stripDeferredBodyFields(event);
      if (next?.type === 'message') {
        delete next.attachments;
        delete next.images;
      }
      return next;
    })
    .filter(Boolean);
}

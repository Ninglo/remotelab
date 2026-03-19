const HIDDEN_EVENT_TYPES = new Set(['reasoning', 'manager_context', 'tool_use', 'tool_result', 'file_change']);

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
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
  if (event.type === 'context_barrier' || event.type === 'usage') return true;
  if (event.type === 'status') return !isIgnoredStatusEvent(event) && !!String(event.content || '').trim();
  return false;
}

function stripDeferredBodyFields(event) {
  const next = cloneJson(event);
  if (!next || typeof next !== 'object') return next;
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
    const toolName = typeof event?.toolName === 'string' ? event.toolName.trim() : '';
    if (!toolName || seen.has(toolName)) continue;
    seen.add(toolName);
    names.push(toolName);
  }
  return names;
}

function buildThinkingBlockLabel(hiddenEvents, state = 'completed') {
  const toolNames = collectToolNames(hiddenEvents);
  if (state === 'running') {
    if (toolNames.length > 0) {
      return `Thinking · using ${toolNames.join(', ')}`;
    }
    return 'Thinking…';
  }
  if (toolNames.length > 0) {
    return `Thought · used ${toolNames.join(', ')}`;
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

function pushVisibleEvent(target, event) {
  if (!isVisibleEvent(event)) return;
  target.push(stripDeferredBodyFields(event));
}

function emitSegmentedTurnBody(target, bodyEvents, { sessionRunning = false } = {}) {
  const hiddenSegment = [];

  for (const event of bodyEvents) {
    if (isHiddenEvent(event)) {
      hiddenSegment.push(event);
      continue;
    }

    if (hiddenSegment.length > 0) {
      target.push(buildThinkingBlockEvent(hiddenSegment.splice(0), 'completed'));
    }

    pushVisibleEvent(target, event);
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

function flushTurnInto(target, turn, { sessionRunning = false } = {}) {
  if (!turn?.user) return;
  target.push(stripDeferredBodyFields(turn.user));

  const bodyEvents = getTurnEventsWithoutIgnoredStatuses(turn.body);
  if (bodyEvents.length === 0) return;

  if (sessionRunning) {
    target.push(buildThinkingBlockEvent(bodyEvents, 'running'));
    return;
  }

  const lastHiddenIndex = findLastHiddenEventIndex(bodyEvents);
  if (lastHiddenIndex < 0) {
    emitSegmentedTurnBody(target, bodyEvents, { sessionRunning });
    return;
  }

  const visibleTail = bodyEvents.slice(lastHiddenIndex + 1).filter(isVisibleEvent);
  if (visibleTail.length === 0) {
    emitSegmentedTurnBody(target, bodyEvents, { sessionRunning });
    return;
  }

  const collapsedPrefix = bodyEvents.slice(0, lastHiddenIndex + 1);
  if (collapsedPrefix.length > 0) {
    target.push(buildThinkingBlockEvent(collapsedPrefix, 'completed'));
  }
  for (const event of visibleTail) {
    pushVisibleEvent(target, event);
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
  return (Array.isArray(history) ? history : [])
    .filter((event) => Number.isInteger(event?.seq) && event.seq >= startSeq && event.seq <= endSeq)
    .filter((event) => !isIgnoredStatusEvent(event))
    .map(stripDeferredBodyFields);
}

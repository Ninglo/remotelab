import { readFile } from 'fs/promises';
import { join } from 'path';
import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import {
  createKeyedTaskQueue,
  ensureDir,
  readJson,
  removePath,
  writeJsonAtomic,
  writeTextAtomic,
} from './fs-utils.mjs';

const EVENT_FILE_WIDTH = 9;
const BODY_FIELD_BY_TYPE = {
  message: 'content',
  reasoning: 'content',
  tool_use: 'toolInput',
  tool_result: 'output',
};
const ALWAYS_EXTERNALIZE_TYPES = new Set(['reasoning']);
const DEFERRED_INDEX_BODY_TYPES = new Set(['reasoning', 'tool_use', 'tool_result']);
const INLINE_BODY_LIMITS = {
  message: 64 * 1024,
  reasoning: 0,
  tool_use: 2048,
  tool_result: 4096,
  status: 4096,
};
const PREVIEW_LIMITS = {
  message: 1600,
  reasoning: 1600,
  tool_use: 800,
  tool_result: 1200,
  status: 800,
};

const metaCache = new Map();
const contextCache = new Map();
const eventCache = new Map();
const bodyCache = new Map();
const runSessionMutation = createKeyedTaskQueue();

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function clipMiddle(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head);
  return `${text.slice(0, head).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tail).trimStart()}`;
}

function eventCacheKey(sessionId, seq) {
  return `${sessionId}:${seq}`;
}

function bodyCacheKey(sessionId, ref) {
  return `${sessionId}:${ref}`;
}

function sessionDir(sessionId) {
  return join(CHAT_HISTORY_DIR, sessionId);
}

function sessionMetaPath(sessionId) {
  return join(sessionDir(sessionId), 'meta.json');
}

function sessionContextPath(sessionId) {
  return join(sessionDir(sessionId), 'context.json');
}

function sessionEventsDir(sessionId) {
  return join(sessionDir(sessionId), 'events');
}

function sessionBodiesDir(sessionId) {
  return join(sessionDir(sessionId), 'bodies');
}

function eventPath(sessionId, seq) {
  return join(sessionEventsDir(sessionId), `${String(seq).padStart(EVENT_FILE_WIDTH, '0')}.json`);
}

function bodyPath(sessionId, ref) {
  return join(sessionBodiesDir(sessionId), `${ref}.txt`);
}

async function ensureSessionDir(sessionId) {
  await ensureDir(sessionDir(sessionId));
  await ensureDir(sessionEventsDir(sessionId));
  await ensureDir(sessionBodiesDir(sessionId));
}

function emptyMeta() {
  return {
    latestSeq: 0,
    lastEventAt: null,
    size: 0,
    counts: {},
  };
}

function normalizeStoredEvent(event, fallbackSeq) {
  const seq = Number.isInteger(event?.seq) ? event.seq : fallbackSeq;
  return {
    ...(event || {}),
    seq,
    timestamp: Number.isFinite(event?.timestamp) ? event.timestamp : Date.now(),
  };
}

function eventBodyField(event) {
  return BODY_FIELD_BY_TYPE[event?.type] || null;
}

function previewLimitFor(event) {
  return PREVIEW_LIMITS[event?.type] || 800;
}

function inlineLimitFor(event) {
  return INLINE_BODY_LIMITS[event?.type] ?? 4096;
}

function shouldDeferEventBodyInIndex(event, options = {}) {
  if (options.includeBodies === true) return false;
  return DEFERRED_INDEX_BODY_TYPES.has(event?.type);
}

function serializeEventForIndex(event, options = {}) {
  const next = clone(event);
  if (!shouldDeferEventBodyInIndex(next, options)) {
    return next;
  }
  const bodyField = eventBodyField(next);
  if (!bodyField) {
    return next;
  }
  const inlineBody = typeof next[bodyField] === 'string' ? next[bodyField] : '';
  const hasBody = !!inlineBody || next.bodyAvailable === true || !!next.bodyRef;
  next[bodyField] = '';
  next.bodyField = bodyField;
  next.bodyAvailable = hasBody;
  next.bodyLoaded = false;
  if (hasBody && !Number.isInteger(next.bodyBytes) && inlineBody) {
    next.bodyBytes = Buffer.byteLength(inlineBody, 'utf8');
  }
  return next;
}

async function loadMeta(sessionId) {
  if (metaCache.has(sessionId)) {
    return clone(metaCache.get(sessionId));
  }
  const meta = await readJson(sessionMetaPath(sessionId), emptyMeta());
  metaCache.set(sessionId, meta);
  return clone(meta);
}

async function saveMetaUnlocked(sessionId, meta) {
  const normalized = {
    ...emptyMeta(),
    ...(meta || {}),
    counts: { ...(meta?.counts || {}) },
  };
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionMetaPath(sessionId), normalized);
  metaCache.set(sessionId, normalized);
  return clone(normalized);
}

async function loadContext(sessionId) {
  if (contextCache.has(sessionId)) {
    return clone(contextCache.get(sessionId));
  }
  const context = await readJson(sessionContextPath(sessionId), null);
  contextCache.set(sessionId, context);
  return clone(context);
}

async function saveContextUnlocked(sessionId, context) {
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionContextPath(sessionId), context || null);
  contextCache.set(sessionId, context || null);
  return clone(context || null);
}

async function clearContextUnlocked(sessionId) {
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(sessionContextPath(sessionId), null);
  contextCache.set(sessionId, null);
}

async function writeBody(sessionId, seq, field, value) {
  await ensureSessionDir(sessionId);
  const ref = `evt_${String(seq).padStart(EVENT_FILE_WIDTH, '0')}_${field}`;
  await writeTextAtomic(bodyPath(sessionId, ref), value || '');
  bodyCache.set(bodyCacheKey(sessionId, ref), value || '');
  return ref;
}

async function readBody(sessionId, ref) {
  if (!ref) return '';
  const key = bodyCacheKey(sessionId, ref);
  if (bodyCache.has(key)) return bodyCache.get(key);
  try {
    const value = await readFile(bodyPath(sessionId, ref), 'utf8');
    bodyCache.set(key, value);
    return value;
  } catch {
    return '';
  }
}

async function storeEvent(sessionId, event) {
  const normalized = normalizeStoredEvent(event, 0);
  const stored = { ...normalized };
  const bodyField = eventBodyField(stored);
  if (bodyField && typeof stored[bodyField] === 'string') {
    const raw = stored[bodyField];
    const shouldExternalize = ALWAYS_EXTERNALIZE_TYPES.has(stored.type) || raw.length > inlineLimitFor(stored);
    if (shouldExternalize && raw) {
      stored[bodyField] = clipMiddle(raw, previewLimitFor(stored));
      stored.bodyAvailable = true;
      stored.bodyLoaded = false;
      stored.bodyField = bodyField;
      stored.bodyRef = await writeBody(sessionId, stored.seq, bodyField, raw);
      stored.bodyBytes = Buffer.byteLength(raw, 'utf8');
    } else {
      stored.bodyAvailable = !!raw;
      stored.bodyLoaded = true;
    }
  }
  await ensureSessionDir(sessionId);
  await writeJsonAtomic(eventPath(sessionId, stored.seq), stored);
  eventCache.set(eventCacheKey(sessionId, stored.seq), stored);
  return clone(stored);
}

async function loadStoredEvent(sessionId, seq) {
  const key = eventCacheKey(sessionId, seq);
  if (eventCache.has(key)) {
    return clone(eventCache.get(key));
  }
  const stored = await readJson(eventPath(sessionId, seq), null);
  if (stored) {
    eventCache.set(key, stored);
  }
  return clone(stored);
}

async function countMessageEventsAfter(sessionId, afterSeq = 0) {
  const meta = await loadMeta(sessionId);
  let count = 0;
  for (let seq = Math.max(1, afterSeq + 1); seq <= meta.latestSeq; seq += 1) {
    const stored = await loadStoredEvent(sessionId, seq);
    if (stored?.type === 'message') {
      count += 1;
    }
  }
  return count;
}

async function hydrateEvent(sessionId, event) {
  if (!event?.bodyRef || !event?.bodyField) return event;
  const hydrated = { ...event };
  hydrated[hydrated.bodyField] = await readBody(sessionId, hydrated.bodyRef);
  hydrated.bodyLoaded = true;
  return hydrated;
}

function incrementCounts(counts, event) {
  const next = { ...(counts || {}) };
  next[event.type] = (next[event.type] || 0) + 1;
  if (event.type === 'message' && event.role === 'user') {
    next.message_user = (next.message_user || 0) + 1;
  }
  if (event.type === 'message' && event.role === 'assistant') {
    next.message_assistant = (next.message_assistant || 0) + 1;
  }
  return next;
}

async function appendEventUnlocked(sessionId, event) {
  await ensureSessionDir(sessionId);
  const meta = await loadMeta(sessionId);
  const seq = meta.latestSeq + 1;
  const normalized = normalizeStoredEvent(event, seq);
  normalized.seq = seq;
  const stored = await storeEvent(sessionId, normalized);
  await saveMetaUnlocked(sessionId, {
    latestSeq: seq,
    lastEventAt: stored.timestamp || Date.now(),
    size: meta.size + 1,
    counts: incrementCounts(meta.counts, stored),
  });
  return stored;
}

async function appendEventsUnlocked(sessionId, events) {
  await ensureSessionDir(sessionId);
  const meta = await loadMeta(sessionId);
  let latestSeq = meta.latestSeq;
  let lastEventAt = meta.lastEventAt;
  let size = meta.size;
  let counts = meta.counts;
  const appended = [];
  for (const event of events || []) {
    latestSeq += 1;
    const normalized = normalizeStoredEvent(event, latestSeq);
    normalized.seq = latestSeq;
    const stored = await storeEvent(sessionId, normalized);
    appended.push(stored);
    lastEventAt = stored.timestamp || lastEventAt;
    size += 1;
    counts = incrementCounts(counts, stored);
  }
  await saveMetaUnlocked(sessionId, {
    latestSeq,
    lastEventAt,
    size,
    counts,
  });
  return appended;
}

function clearSessionCaches(sessionId) {
  metaCache.delete(sessionId);
  contextCache.delete(sessionId);
  for (const key of [...eventCache.keys()]) {
    if (key.startsWith(`${sessionId}:`)) eventCache.delete(key);
  }
  for (const key of [...bodyCache.keys()]) {
    if (key.startsWith(`${sessionId}:`)) bodyCache.delete(key);
  }
}

async function clearHistoryUnlocked(sessionId) {
  await removePath(sessionDir(sessionId));
  clearSessionCaches(sessionId);
}

export async function loadHistory(sessionId, options = {}) {
  const meta = await loadMeta(sessionId);
  const includeBodies = options.includeBodies !== false;
  const fromSeq = Number.isInteger(options.fromSeq) && options.fromSeq > 0 ? options.fromSeq : 1;
  const events = [];
  for (let seq = fromSeq; seq <= meta.latestSeq; seq += 1) {
    const stored = await loadStoredEvent(sessionId, seq);
    if (!stored) continue;
    events.push(includeBodies ? await hydrateEvent(sessionId, stored) : stored);
  }
  return events;
}

export async function readLastTurnEvents(sessionId, options = {}) {
  const meta = await loadMeta(sessionId);
  const includeBodies = options.includeBodies !== false;
  const events = [];
  for (let seq = meta.latestSeq; seq >= 1; seq -= 1) {
    const stored = await loadStoredEvent(sessionId, seq);
    if (!stored) continue;
    events.unshift(includeBodies ? await hydrateEvent(sessionId, stored) : stored);
    if (stored.type === 'message' && stored.role === 'user') {
      break;
    }
  }
  return events;
}

export async function findLatestAssistantMessage(sessionId, options = {}) {
  const meta = await loadMeta(sessionId);
  const includeBodies = options.includeBodies !== false;
  const match = typeof options.match === 'function' ? options.match : null;
  for (let seq = meta.latestSeq; seq >= 1; seq -= 1) {
    const stored = await loadStoredEvent(sessionId, seq);
    if (!stored) continue;
    if (stored.type === 'message' && stored.role === 'assistant' && (!match || match(stored))) {
      return includeBodies ? hydrateEvent(sessionId, stored) : stored;
    }
  }
  return null;
}

export async function getHistorySnapshot(sessionId) {
  const [meta, context] = await Promise.all([
    loadMeta(sessionId),
    loadContext(sessionId),
  ]);
  const activeFromSeq = Number.isInteger(context?.activeFromSeq) ? context.activeFromSeq : 0;
  const messageCount = (meta.counts?.message_user || 0) + (meta.counts?.message_assistant || 0);
  const activeMessageCount = activeFromSeq > 0
    ? await countMessageEventsAfter(sessionId, activeFromSeq)
    : messageCount;
  return {
    latestSeq: meta.latestSeq || 0,
    lastEventAt: meta.lastEventAt || null,
    size: meta.size || 0,
    counts: { ...(meta.counts || {}) },
    messageCount,
    activeMessageCount,
    userMessageCount: meta.counts?.message_user || 0,
    contextMode: context?.mode || 'history',
    activeFromSeq,
    compactedThroughSeq: Number.isInteger(context?.compactedThroughSeq) ? context.compactedThroughSeq : 0,
    contextTokenEstimate: Number.isInteger(context?.inputTokens) ? context.inputTokens : null,
    contextUpdatedAt: context?.updatedAt || null,
  };
}

export async function appendEvent(sessionId, event) {
  return runSessionMutation(sessionId, async () => appendEventUnlocked(sessionId, event));
}

export async function appendEvents(sessionId, events) {
  return runSessionMutation(sessionId, async () => appendEventsUnlocked(sessionId, events));
}

export async function readEventsAfter(sessionId, afterSeq = 0, options = {}) {
  const meta = await loadMeta(sessionId);
  const includeBodies = options.includeBodies === true;
  const events = [];
  for (let seq = Math.max(1, afterSeq + 1); seq <= meta.latestSeq; seq += 1) {
    const stored = await loadStoredEvent(sessionId, seq);
    if (!stored) continue;
    if (includeBodies) {
      events.push(await hydrateEvent(sessionId, stored));
    } else {
      events.push(serializeEventForIndex(stored, options));
    }
  }
  return events;
}

export async function readEventBody(sessionId, seq) {
  const stored = await loadStoredEvent(sessionId, seq);
  const bodyField = stored?.bodyField || eventBodyField(stored);
  if (!stored || !bodyField) return null;
  let body = '';
  if (stored.bodyRef) {
    body = await readBody(sessionId, stored.bodyRef);
  } else if (typeof stored[bodyField] === 'string') {
    body = stored[bodyField];
  }
  if (!body) return null;
  return {
    seq,
    field: bodyField,
    value: body,
    bytes: stored.bodyBytes || Buffer.byteLength(body, 'utf8'),
  };
}

export async function getContextHead(sessionId) {
  return loadContext(sessionId);
}

export async function setContextHead(sessionId, context = {}) {
  return runSessionMutation(sessionId, async () => saveContextUnlocked(sessionId, {
    mode: context.mode || 'summary',
    summary: typeof context.summary === 'string' ? context.summary.trim() : '',
    activeFromSeq: Number.isInteger(context.activeFromSeq) ? context.activeFromSeq : 0,
    compactedThroughSeq: Number.isInteger(context.compactedThroughSeq) ? context.compactedThroughSeq : 0,
    inputTokens: Number.isInteger(context.inputTokens) ? context.inputTokens : null,
    updatedAt: context.updatedAt || new Date().toISOString(),
    source: context.source || 'manual',
  }));
}

export async function clearContextHead(sessionId) {
  return runSessionMutation(sessionId, async () => {
    await clearContextUnlocked(sessionId);
    return null;
  });
}

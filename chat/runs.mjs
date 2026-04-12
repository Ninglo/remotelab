import { randomBytes } from 'crypto';
import { appendFile, open, readFile, readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { StringDecoder } from 'string_decoder';
import { CHAT_RUNS_DIR } from '../lib/config.mjs';
import {
  createKeyedTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
  writeTextAtomic,
} from './fs-utils.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const SPOOL_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SPOOL_RECORD_CHARS = 2 * 1024 * 1024;
const MAX_SPOOL_INLINE_CHARS = 16 * 1024;
const MAX_SPOOL_PREVIEW_CHARS = 4096;

const runStatusCache = new Map();
const runManifestCache = new Map();
const runResultCache = new Map();
const runArtifactCache = new Map();
const runMutationQueue = createKeyedTaskQueue();

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function clipMiddle(text, maxChars = MAX_SPOOL_PREVIEW_CHARS) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * 0.6));
  const tail = Math.max(1, maxChars - head);
  return `${text.slice(0, head).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tail).trimStart()}`;
}

export async function ensureRunsDir() {
  await ensureDir(CHAT_RUNS_DIR);
}

export function createRunId() {
  return `run_${randomBytes(12).toString('hex')}`;
}

export function runDir(runId) {
  return join(CHAT_RUNS_DIR, runId);
}

export function runStatusPath(runId) {
  return join(runDir(runId), 'status.json');
}

export function runManifestPath(runId) {
  return join(runDir(runId), 'manifest.json');
}

export function runSpoolPath(runId) {
  return join(runDir(runId), 'spool.jsonl');
}

export function runResultPath(runId) {
  return join(runDir(runId), 'result.json');
}

export function runArtifactsDir(runId) {
  return join(runDir(runId), 'artifacts');
}

function runArtifactPath(runId, ref) {
  return join(runArtifactsDir(runId), `${ref}.txt`);
}

async function writeRunArtifactText(runId, prefix, text) {
  await ensureRunDirectory(runId);
  const ref = `${prefix}_${randomBytes(6).toString('hex')}`;
  const path = runArtifactPath(runId, ref);
  await writeTextAtomic(path, text || '');
  runArtifactCache.set(`${runId}:${ref}`, text || '');
  return ref;
}

async function readRunArtifactText(runId, ref) {
  const cacheKey = `${runId}:${ref}`;
  if (runArtifactCache.has(cacheKey)) return runArtifactCache.get(cacheKey);
  try {
    const value = await readFile(runArtifactPath(runId, ref), 'utf8');
    runArtifactCache.set(cacheKey, value);
    return value;
  } catch {
    return '';
  }
}

export async function ensureRunDirectory(runId) {
  await ensureDir(runDir(runId));
  await ensureDir(runArtifactsDir(runId));
}

export function isTerminalRunState(state) {
  return TERMINAL_STATES.has(state);
}

function pickRunState(currentState, nextState) {
  if (isTerminalRunState(nextState)) return nextState;
  if (isTerminalRunState(currentState)) return currentState;
  if (nextState === 'running' || currentState === 'running') return 'running';
  return nextState || currentState || 'accepted';
}

function pickDefined(preferred, fallback, defaultValue = null) {
  if (preferred !== undefined && preferred !== null) return preferred;
  if (fallback !== undefined && fallback !== null) return fallback;
  return defaultValue;
}

function pickMaxInt(currentValue, nextValue, defaultValue = 0) {
  const current = Number.isInteger(currentValue) ? currentValue : null;
  const next = Number.isInteger(nextValue) ? nextValue : null;
  if (current === null && next === null) return defaultValue;
  if (current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}

function mergeRunRecords(current, proposed) {
  const merged = {
    ...current,
    ...proposed,
  };

  merged.state = pickRunState(current?.state, proposed?.state);
  merged.startedAt = pickDefined(proposed?.startedAt, current?.startedAt);
  merged.completedAt = pickDefined(proposed?.completedAt, current?.completedAt);
  merged.finalizedAt = pickDefined(proposed?.finalizedAt, current?.finalizedAt);
  merged.cancelRequested = current?.cancelRequested === true || proposed?.cancelRequested === true;
  merged.cancelRequestedAt = pickDefined(proposed?.cancelRequestedAt, current?.cancelRequestedAt);
  merged.result = pickDefined(proposed?.result, current?.result);
  merged.failureReason = pickDefined(proposed?.failureReason, current?.failureReason);
  merged.providerResumeId = pickDefined(proposed?.providerResumeId, current?.providerResumeId);
  merged.claudeSessionId = pickDefined(proposed?.claudeSessionId, current?.claudeSessionId);
  merged.codexThreadId = pickDefined(proposed?.codexThreadId, current?.codexThreadId);
  merged.runnerProcessId = pickDefined(proposed?.runnerProcessId, current?.runnerProcessId);
  merged.runnerUnitName = pickDefined(proposed?.runnerUnitName, current?.runnerUnitName);
  merged.runnerUnitScope = pickDefined(proposed?.runnerUnitScope, current?.runnerUnitScope);
  merged.runnerLaunchMode = pickDefined(proposed?.runnerLaunchMode, current?.runnerLaunchMode);
  merged.toolProcessId = pickDefined(proposed?.toolProcessId, current?.toolProcessId);
  merged.normalizedLineCount = pickMaxInt(current?.normalizedLineCount, proposed?.normalizedLineCount, 0);
  merged.normalizedByteOffset = pickMaxInt(current?.normalizedByteOffset, proposed?.normalizedByteOffset, 0);
  merged.normalizedEventCount = pickMaxInt(current?.normalizedEventCount, proposed?.normalizedEventCount, 0);
  merged.contextInputTokens = pickMaxInt(current?.contextInputTokens, proposed?.contextInputTokens, null);
  merged.contextWindowTokens = pickMaxInt(current?.contextWindowTokens, proposed?.contextWindowTokens, null);

  return merged;
}

export function createRunRecord(input = {}) {
  const id = input.id || createRunId();
  const now = new Date().toISOString();
  return {
    id,
    sessionId: input.sessionId,
    requestId: input.requestId,
    responseId: input.responseId || null,
    state: input.state || 'accepted',
    tool: input.tool || null,
    model: input.model || null,
    effort: input.effort || null,
    thinking: input.thinking === true,
    createdAt: input.createdAt || now,
    startedAt: input.startedAt || null,
    updatedAt: input.updatedAt || now,
    completedAt: input.completedAt || null,
    providerResumeId: input.providerResumeId || null,
    runnerId: input.runnerId || 'runner_local_detached',
    cancelRequested: input.cancelRequested === true,
    result: input.result || null,
    claudeSessionId: input.claudeSessionId || null,
    codexThreadId: input.codexThreadId || null,
    runnerProcessId: input.runnerProcessId || null,
    runnerUnitName: input.runnerUnitName || null,
    runnerUnitScope: input.runnerUnitScope || null,
    runnerLaunchMode: input.runnerLaunchMode || null,
    toolProcessId: input.toolProcessId || null,
    normalizedLineCount: Number.isInteger(input.normalizedLineCount)
      ? input.normalizedLineCount
      : 0,
    normalizedByteOffset: Number.isInteger(input.normalizedByteOffset)
      ? input.normalizedByteOffset
      : 0,
    normalizedEventCount: Number.isInteger(input.normalizedEventCount)
      ? input.normalizedEventCount
      : 0,
    finalizedAt: input.finalizedAt || null,
    lastNormalizedAt: input.lastNormalizedAt || null,
    failureReason: input.failureReason || null,
    contextInputTokens: Number.isInteger(input.contextInputTokens) ? input.contextInputTokens : null,
    contextWindowTokens: Number.isInteger(input.contextWindowTokens) ? input.contextWindowTokens : null,
    replyPublicationRootRunId: input.replyPublicationRootRunId || null,
    replyPublication: input.replyPublication || null,
  };
}

async function getRunUnlocked(runId) {
  const run = await readJson(runStatusPath(runId), null);
  if (run) {
    runStatusCache.set(runId, run);
  } else {
    runStatusCache.delete(runId);
  }
  return clone(run);
}

async function getRunManifestUnlocked(runId) {
  if (runManifestCache.has(runId)) return clone(runManifestCache.get(runId));
  const manifest = await readJson(runManifestPath(runId), null);
  if (manifest) runManifestCache.set(runId, manifest);
  return clone(manifest);
}

async function getRunResultUnlocked(runId) {
  const result = await readJson(runResultPath(runId), null);
  if (result) {
    runResultCache.set(runId, result);
  } else {
    runResultCache.delete(runId);
  }
  return clone(result);
}

export async function createRun({ status, manifest }) {
  const run = createRunRecord(status);
  await runMutationQueue(run.id, async () => {
    await ensureRunDirectory(run.id);
    await writeJsonAtomic(runStatusPath(run.id), run);
    await writeJsonAtomic(runManifestPath(run.id), { ...(manifest || {}), id: run.id });
    runStatusCache.set(run.id, run);
    runManifestCache.set(run.id, { ...(manifest || {}), id: run.id });
  });
  return clone(run);
}

export async function getRun(runId) {
  return getRunUnlocked(runId);
}

export async function updateRun(runId, updater) {
  return runMutationQueue(runId, async () => {
    const current = await getRunUnlocked(runId);
    if (!current) return null;
    const draft = { ...current };
    const proposed = typeof updater === 'function'
      ? (updater(draft) || draft)
      : { ...draft, ...updater };
    const latest = await getRunUnlocked(runId) || current;
    const next = mergeRunRecords(latest, proposed);
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomic(runStatusPath(runId), next);
    runStatusCache.set(runId, next);
    return clone(next);
  });
}

export async function getRunManifest(runId) {
  return getRunManifestUnlocked(runId);
}

export async function getRunResult(runId) {
  return getRunResultUnlocked(runId);
}

export async function writeRunResult(runId, result) {
  await runMutationQueue(runId, async () => {
    await ensureRunDirectory(runId);
    await writeJsonAtomic(runResultPath(runId), result || {});
    runResultCache.set(runId, result || {});
  });
  return getRunResultUnlocked(runId);
}

async function externalizeStringField(runId, container, field, prefix) {
  if (!container || typeof container[field] !== 'string') return false;
  const value = container[field];
  if (!value || value.length <= MAX_SPOOL_INLINE_CHARS) return false;
  container[field] = clipMiddle(value);
  container[`${field}Artifact`] = await writeRunArtifactText(runId, prefix, value);
  container[`${field}Bytes`] = Buffer.byteLength(value, 'utf8');
  return true;
}

async function sanitizeStructuredRecord(runId, value) {
  const next = clone(value);
  if (!next || typeof next !== 'object') return next;

  if (next.item && typeof next.item === 'object') {
    await externalizeStringField(runId, next.item, 'aggregated_output', 'aggregated_output');
    await externalizeStringField(runId, next.item, 'text', 'item_text');
    await externalizeStringField(runId, next.item, 'command', 'item_command');
  }

  if (next.message && typeof next.message === 'object' && Array.isArray(next.message.content)) {
    for (const block of next.message.content) {
      if (!block || typeof block !== 'object') continue;
      await externalizeStringField(runId, block, 'text', 'message_text');
      await externalizeStringField(runId, block, 'thinking', 'message_thinking');
      await externalizeStringField(runId, block, 'input', 'message_input');
      await externalizeStringField(runId, block, 'content', 'message_content');
    }
  }

  if (next.event && typeof next.event === 'object' && next.event.delta && typeof next.event.delta === 'object') {
    await externalizeStringField(runId, next.event.delta, 'thinking', 'event_thinking');
    await externalizeStringField(runId, next.event.delta, 'text', 'event_text');
  }

  return next;
}

async function hydrateStructuredRecord(runId, value) {
  const next = clone(value);
  if (!next || typeof next !== 'object') return next;

  const restoreField = async (container, field) => {
    const artifactKey = `${field}Artifact`;
    if (!container?.[artifactKey]) return;
    container[field] = await readRunArtifactText(runId, container[artifactKey]);
  };

  if (next.item && typeof next.item === 'object') {
    await restoreField(next.item, 'aggregated_output');
    await restoreField(next.item, 'text');
    await restoreField(next.item, 'command');
  }

  if (next.message && typeof next.message === 'object' && Array.isArray(next.message.content)) {
    for (const block of next.message.content) {
      if (!block || typeof block !== 'object') continue;
      await restoreField(block, 'text');
      await restoreField(block, 'thinking');
      await restoreField(block, 'input');
      await restoreField(block, 'content');
    }
  }

  if (next.event && typeof next.event === 'object' && next.event.delta && typeof next.event.delta === 'object') {
    await restoreField(next.event.delta, 'thinking');
    await restoreField(next.event.delta, 'text');
  }

  return next;
}

async function normalizeSpoolRecord(runId, record) {
  const normalized = { ...(record || {}) };
  if (normalized.json && typeof normalized.json === 'object') {
    normalized.json = await sanitizeStructuredRecord(runId, normalized.json);
    normalized.line = JSON.stringify(normalized.json);
  }
  if (typeof normalized.line === 'string' && normalized.line.length > MAX_SPOOL_INLINE_CHARS) {
    const ref = await writeRunArtifactText(runId, 'line', normalized.line);
    normalized.lineArtifact = ref;
    normalized.lineBytes = Buffer.byteLength(normalized.line, 'utf8');
    normalized.line = clipMiddle(normalized.line);
  }
  return normalized;
}

export async function appendRunSpoolRecord(runId, record) {
  return runMutationQueue(runId, async () => {
    await ensureRunDirectory(runId);
    const normalized = await normalizeSpoolRecord(runId, record);
    await appendFile(runSpoolPath(runId), `${JSON.stringify(normalized)}\n`, 'utf8');
  });
}

export async function readRunSpoolRecords(runId) {
  try {
    const content = await readFile(runSpoolPath(runId), 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function maybeParseSpoolRecord(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function findOffsetAfterLines(fd, fileSize, lineCount) {
  if (!lineCount || lineCount <= 0) {
    return { offset: 0, skippedLineCount: 0 };
  }

  const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
  let position = 0;
  let skippedLineCount = 0;
  while (position < fileSize) {
    const bytesToRead = Math.min(buffer.length, fileSize - position);
    const { bytesRead } = await fd.read(buffer, 0, bytesToRead, position);
    if (bytesRead <= 0) break;

    let searchStart = 0;
    while (searchStart < bytesRead) {
      const index = buffer.indexOf(0x0A, searchStart);
      if (index === -1 || index >= bytesRead) break;
      skippedLineCount += 1;
      if (skippedLineCount >= lineCount) {
        return {
          offset: position + index + 1,
          skippedLineCount,
        };
      }
      searchStart = index + 1;
    }

    position += bytesRead;
  }

  return { offset: position, skippedLineCount };
}

export async function readRunSpoolDelta(runId, options = {}) {
  const path = runSpoolPath(runId);
  try {
    const stats = await statOrNull(path);
    if (!stats) {
      return {
        records: [],
        nextOffset: 0,
        processedLineCount: 0,
      };
    }

    const requestedOffset = Number.isInteger(options.startOffset) ? options.startOffset : 0;
    const canResumeFromOffset = requestedOffset > 0 && requestedOffset <= stats.size;
    let startOffset = canResumeFromOffset ? requestedOffset : 0;
    const records = [];
    let processedLineCount = 0;
    let skippedLineCount = 0;
    let remainder = '';
    let discardingOversizeLine = false;
    let position = startOffset;
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(SPOOL_READ_CHUNK_BYTES);
    const fd = await open(path, 'r');
    let nextOffset = startOffset;

    try {
      if (!canResumeFromOffset) {
        const recovery = await findOffsetAfterLines(
          fd,
          stats.size,
          Math.max(0, Number.isInteger(options.skipLines) ? options.skipLines : 0),
        );
        startOffset = recovery.offset;
        skippedLineCount = recovery.skippedLineCount;
        position = startOffset;
      }

      while (position < stats.size) {
        const bytesToRead = Math.min(buffer.length, stats.size - position);
        const { bytesRead } = await fd.read(buffer, 0, bytesToRead, position);
        if (bytesRead <= 0) break;
        position += bytesRead;

        let chunk = decoder.write(buffer.subarray(0, bytesRead));
        if (discardingOversizeLine) {
          const newlineIndex = chunk.indexOf('\n');
          if (newlineIndex === -1) {
            continue;
          }
          processedLineCount += 1;
          discardingOversizeLine = false;
          chunk = chunk.slice(newlineIndex + 1);
        }

        chunk = remainder + chunk;
        let lineStart = 0;
        while (true) {
          const newlineIndex = chunk.indexOf('\n', lineStart);
          if (newlineIndex === -1) break;

          const line = chunk.slice(lineStart, newlineIndex);
          processedLineCount += 1;
          const record = maybeParseSpoolRecord(line);
          if (record) records.push(record);
          lineStart = newlineIndex + 1;
        }
        remainder = chunk.slice(lineStart);
        if (remainder.length > MAX_SPOOL_RECORD_CHARS) {
          remainder = '';
          discardingOversizeLine = true;
        }
      }

      remainder += decoder.end();
      if (discardingOversizeLine) {
        processedLineCount += 1;
      } else if (remainder) {
        processedLineCount += 1;
        const record = maybeParseSpoolRecord(remainder);
        if (record) records.push(record);
      }
      nextOffset = position;
    } finally {
      await fd.close();
    }

    return {
      records,
      nextOffset,
      processedLineCount,
      skippedLineCount,
    };
  } catch {
    return {
      records: [],
      nextOffset: 0,
      processedLineCount: 0,
      skippedLineCount: 0,
    };
  }
}

export async function materializeRunSpoolLine(runId, record) {
  if (record?.json && typeof record.json === 'object') {
    return JSON.stringify(await hydrateStructuredRecord(runId, record.json));
  }
  if (record?.lineArtifact) {
    return readRunArtifactText(runId, record.lineArtifact);
  }
  return typeof record?.line === 'string' ? record.line : '';
}

export async function requestRunCancel(runId) {
  return updateRun(runId, (run) => ({
    ...run,
    cancelRequested: true,
    cancelRequestedAt: new Date().toISOString(),
  }));
}

export async function listRunIds() {
  await ensureRunsDir();
  try {
    return (await readdir(CHAT_RUNS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function findRunByRequest(sessionId, requestId) {
  if (!sessionId || !requestId) return null;
  const runIds = (await listRunIds()).reverse();
  for (const runId of runIds) {
    const run = await getRun(runId);
    if (!run) continue;
    if (run.sessionId === sessionId && run.requestId === requestId) {
      return run;
    }
  }
  return null;
}

import { createReadStream, createWriteStream } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import readline from 'readline';

import { USAGE_LEDGER_DIR } from '../lib/config.mjs';
import { ensureDir } from './fs-utils.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_TOP = 10;

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveLedgerDir(value = '') {
  return trimString(value) || USAGE_LEDGER_DIR;
}

function formatDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pickNonNegativeInt(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function pickFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

function roundAverage(value) {
  return Math.round(value * 100) / 100;
}

function normalizeTimestampMs(value) {
  const timestampMs = Date.parse(value || '');
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function disableLogging(error) {
  if (loggingDisabled) return;
  loggingDisabled = true;
  currentDateKey = '';
  if (currentStream) {
    currentStream.destroy();
    currentStream = null;
  }
  console.error(`[usage-ledger] Disabled usage ledger writes: ${error?.message || error}`);
}

function ensureStream(now = new Date()) {
  if (loggingDisabled) return null;
  const dateKey = formatDateKey(now);
  if (currentStream && currentDateKey === dateKey) {
    return currentStream;
  }
  try {
    const nextPath = join(USAGE_LEDGER_DIR, `${dateKey}.jsonl`);
    const nextStream = createWriteStream(nextPath, { flags: 'a', encoding: 'utf8' });
    nextStream.on('error', disableLogging);
    if (currentStream) {
      currentStream.end();
    }
    currentStream = nextStream;
    currentDateKey = dateKey;
    return currentStream;
  } catch (error) {
    disableLogging(error);
    return null;
  }
}

function resolvePrincipal(session = {}) {
  const userId = trimString(session.userId);
  const userName = trimString(session.userName);
  const visitorId = trimString(session.visitorId);
  const visitorName = trimString(session.visitorName);

  if (userId) {
    return {
      principalType: 'user',
      principalId: userId,
      principalName: userName || userId,
      userId,
      userName,
      visitorId,
      visitorName,
    };
  }

  if (visitorId) {
    return {
      principalType: 'visitor',
      principalId: visitorId,
      principalName: visitorName || visitorId,
      userId,
      userName,
      visitorId,
      visitorName,
    };
  }

  return {
    principalType: 'owner',
    principalId: 'owner',
    principalName: userName || 'Owner',
    userId,
    userName,
    visitorId,
    visitorName,
  };
}

function resolveOperationInfo(session = {}, manifest = {}) {
  const internalRole = trimString(session.internalRole);
  const internalOperation = trimString(manifest.internalOperation);
  return {
    internalSession: !!internalRole,
    internalRole,
    internalOperation,
    operationKey: internalOperation || internalRole || 'user_turn',
  };
}

export function buildUsageLedgerRecord({
  session,
  run,
  usageEvent,
  manifest,
  recordedAt = new Date(),
} = {}) {
  if (!session || !run || !usageEvent) return null;

  const timestampMs = normalizeTimestampMs(run.finalizedAt || run.completedAt || recordedAt.toISOString());
  const inputTokens = pickNonNegativeInt(usageEvent.inputTokens);
  const outputTokens = pickNonNegativeInt(usageEvent.outputTokens);
  const cachedInputTokens = pickNonNegativeInt(usageEvent.cachedInputTokens);
  const reasoningTokens = pickNonNegativeInt(usageEvent.reasoningTokens);
  const contextTokens = pickNonNegativeInt(usageEvent.contextTokens);
  const contextWindowTokens = pickNonNegativeInt(usageEvent.contextWindowTokens);
  const costUsd = pickFiniteNumber(usageEvent.costUsd);
  const estimatedCostUsd = pickFiniteNumber(usageEvent.estimatedCostUsd);

  if (!Number.isFinite(timestampMs)) return null;
  if (
    inputTokens === null
    && outputTokens === null
    && cachedInputTokens === null
    && reasoningTokens === null
    && contextTokens === null
    && costUsd === null
    && estimatedCostUsd === null
  ) {
    return null;
  }

  const principal = resolvePrincipal(session);
  const operation = resolveOperationInfo(session, manifest);
  const requestId = trimString(run.requestId);
  const tool = trimString(run.tool || session.tool);
  const model = trimString(run.model || session.model);
  const effort = trimString(run.effort || session.effort);
  const state = trimString(run.state) || 'completed';
  const timestampIso = new Date(timestampMs).toISOString();
  const totalTokens = (inputTokens || 0) + (outputTokens || 0);

  return {
    type: 'run_usage',
    ts: timestampIso,
    recordedAt: recordedAt.toISOString(),
    runId: trimString(run.id),
    ...(requestId ? { requestId } : {}),
    sessionId: trimString(session.id),
    sessionName: trimString(session.name),
    ...(trimString(session.group) ? { sessionGroup: trimString(session.group) } : {}),
    ...(trimString(session.rootSessionId) ? { rootSessionId: trimString(session.rootSessionId) } : {}),
    principalType: principal.principalType,
    principalId: principal.principalId,
    principalName: principal.principalName,
    ...(principal.userId ? { userId: principal.userId } : {}),
    ...(principal.userName ? { userName: principal.userName } : {}),
    ...(principal.visitorId ? { visitorId: principal.visitorId } : {}),
    ...(principal.visitorName ? { visitorName: principal.visitorName } : {}),
    tool,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    state,
    totalTokens,
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(trimString(usageEvent.contextSource) ? { contextSource: trimString(usageEvent.contextSource) } : {}),
    ...(costUsd !== null ? { costUsd: roundUsd(costUsd) } : {}),
    ...(estimatedCostUsd !== null ? { estimatedCostUsd: roundUsd(estimatedCostUsd) } : {}),
    ...(trimString(usageEvent.estimatedCostModel) ? { estimatedCostModel: trimString(usageEvent.estimatedCostModel) } : {}),
    ...(trimString(usageEvent.costSource) ? { costSource: trimString(usageEvent.costSource) } : {}),
    internalSession: operation.internalSession,
    ...(operation.internalRole ? { internalRole: operation.internalRole } : {}),
    ...(operation.internalOperation ? { internalOperation: operation.internalOperation } : {}),
    operation: operation.operationKey,
  };
}

export async function initUsageLedger() {
  try {
    await ensureDir(USAGE_LEDGER_DIR);
  } catch (error) {
    disableLogging(error);
  }
}

export function appendUsageLedgerRecord(record) {
  const normalized = normalizeLedgerRecord(record);
  if (!normalized) return false;
  const stream = ensureStream(new Date(normalized.timestampMs));
  if (!stream) return false;
  stream.write(`${JSON.stringify(record)}\n`);
  return true;
}

function normalizeLedgerRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const runId = trimString(record.runId);
  const sessionId = trimString(record.sessionId);
  const timestampMs = normalizeTimestampMs(record.ts);
  if (!runId || !sessionId || !Number.isFinite(timestampMs)) return null;

  const inputTokens = pickNonNegativeInt(record.inputTokens) || 0;
  const outputTokens = pickNonNegativeInt(record.outputTokens) || 0;
  const cachedInputTokens = pickNonNegativeInt(record.cachedInputTokens);
  const reasoningTokens = pickNonNegativeInt(record.reasoningTokens);
  const totalTokens = pickNonNegativeInt(record.totalTokens) ?? (inputTokens + outputTokens);
  const contextTokens = pickNonNegativeInt(record.contextTokens);
  const contextWindowTokens = pickNonNegativeInt(record.contextWindowTokens);
  const costUsd = pickFiniteNumber(record.costUsd);
  const estimatedCostUsd = pickFiniteNumber(record.estimatedCostUsd);
  const recordedAtMs = normalizeTimestampMs(record.recordedAt);
  const principalType = ['owner', 'user', 'visitor'].includes(trimString(record.principalType))
    ? trimString(record.principalType)
    : 'owner';
  const principalId = trimString(record.principalId) || (principalType === 'owner' ? 'owner' : '');
  const principalName = trimString(record.principalName) || (principalType === 'owner' ? 'Owner' : principalId || '(unknown)');

  return {
    type: 'run_usage',
    ts: new Date(timestampMs).toISOString(),
    timestampMs,
    recordedAt: recordedAtMs ? new Date(recordedAtMs).toISOString() : null,
    recordedAtMs,
    day: formatDateKey(new Date(timestampMs)),
    runId,
    requestId: trimString(record.requestId),
    sessionId,
    sessionName: trimString(record.sessionName),
    sessionGroup: trimString(record.sessionGroup),
    rootSessionId: trimString(record.rootSessionId),
    principalType,
    principalId,
    principalName,
    userId: trimString(record.userId),
    userName: trimString(record.userName),
    visitorId: trimString(record.visitorId),
    visitorName: trimString(record.visitorName),
    tool: trimString(record.tool),
    model: trimString(record.model),
    effort: trimString(record.effort),
    state: trimString(record.state) || 'completed',
    totalTokens,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(trimString(record.contextSource) ? { contextSource: trimString(record.contextSource) } : {}),
    ...(costUsd !== null ? { costUsd: roundUsd(costUsd) } : {}),
    ...(estimatedCostUsd !== null ? { estimatedCostUsd: roundUsd(estimatedCostUsd) } : {}),
    ...(trimString(record.estimatedCostModel) ? { estimatedCostModel: trimString(record.estimatedCostModel) } : {}),
    ...(trimString(record.costSource) ? { costSource: trimString(record.costSource) } : {}),
    internalSession: record.internalSession === true,
    internalRole: trimString(record.internalRole),
    internalOperation: trimString(record.internalOperation),
    operation: trimString(record.operation) || trimString(record.internalOperation) || trimString(record.internalRole) || 'user_turn',
  };
}

function createTotals() {
  return {
    runCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedCostUsd: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    maxContextTokens: null,
    maxContextWindowTokens: null,
  };
}

function appendMetrics(target, record) {
  target.runCount += 1;
  target.inputTokens += record.inputTokens || 0;
  target.outputTokens += record.outputTokens || 0;
  target.totalTokens += record.totalTokens || 0;
  target.costUsd = roundUsd((target.costUsd || 0) + (record.costUsd || 0));
  target.estimatedCostUsd = roundUsd((target.estimatedCostUsd || 0) + (record.estimatedCostUsd || 0));
  target.cachedInputTokens += record.cachedInputTokens || 0;
  target.reasoningTokens += record.reasoningTokens || 0;
  if (Number.isInteger(record.contextTokens)) {
    target.maxContextTokens = target.maxContextTokens === null
      ? record.contextTokens
      : Math.max(target.maxContextTokens, record.contextTokens);
  }
  if (Number.isInteger(record.contextWindowTokens)) {
    target.maxContextWindowTokens = target.maxContextWindowTokens === null
      ? record.contextWindowTokens
      : Math.max(target.maxContextWindowTokens, record.contextWindowTokens);
  }
}

function touchLatest(target, record) {
  if (!Number.isFinite(record.timestampMs)) return;
  if (!Number.isFinite(target.latestTimestampMs) || record.timestampMs >= target.latestTimestampMs) {
    target.latestTimestampMs = record.timestampMs;
    target.latestTimestamp = record.ts;
  }
}

function getOrCreateBucket(map, key, extra = {}) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      ...extra,
      ...createTotals(),
      latestTimestamp: null,
      latestTimestampMs: null,
    });
  }
  return map.get(key);
}

function sortBuckets(map, limit = Infinity) {
  return [...map.values()]
    .map((bucket) => ({
      ...bucket,
      costUsd: roundUsd(bucket.costUsd || 0),
      estimatedCostUsd: roundUsd(bucket.estimatedCostUsd || 0),
    }))
    .sort((left, right) => {
      if ((right.totalTokens || 0) !== (left.totalTokens || 0)) {
        return (right.totalTokens || 0) - (left.totalTokens || 0);
      }
      const rightCost = (right.costUsd || 0) + (right.estimatedCostUsd || 0);
      const leftCost = (left.costUsd || 0) + (left.estimatedCostUsd || 0);
      if (rightCost !== leftCost) {
        return rightCost - leftCost;
      }
      return String(left.key).localeCompare(String(right.key));
    })
    .slice(0, limit);
}

function parsePositiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function normalizeWindow(options = {}) {
  const endMs = Number.isFinite(options.endMs) ? options.endMs : Date.now();
  if (Number.isFinite(options.startMs)) {
    return {
      startMs: options.startMs,
      endMs,
      days: Math.max(1, Math.ceil((endMs - options.startMs) / DAY_MS)),
    };
  }
  const days = parsePositiveInteger(options.days, DEFAULT_DAYS);
  return {
    startMs: endMs - (days * DAY_MS),
    endMs,
    days,
  };
}

async function listLedgerFiles(startMs, endMs, ledgerDir = USAGE_LEDGER_DIR) {
  let entries;
  try {
    entries = await readdir(resolveLedgerDir(ledgerDir), { withFileTypes: true });
  } catch {
    return [];
  }

  const minKey = formatDateKey(new Date(startMs));
  const maxKey = formatDateKey(new Date(endMs));
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      const dayKey = name.slice(0, -'.jsonl'.length);
      return dayKey >= minKey && dayKey <= maxKey;
    })
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(resolveLedgerDir(ledgerDir), name));
}

function matchesRecordFilters(record, filters = {}) {
  if (filters.principalType && record.principalType !== filters.principalType) return false;
  if (filters.principalId && record.principalId !== filters.principalId) return false;
  if (filters.sessionId && record.sessionId !== filters.sessionId) return false;
  if (filters.tool && record.tool !== filters.tool) return false;
  if (filters.model && record.model !== filters.model) return false;
  return true;
}

function summarizeTopRun(record) {
  return {
    ts: record.ts,
    runId: record.runId,
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    principalType: record.principalType,
    principalId: record.principalId,
    principalName: record.principalName,
    tool: record.tool,
    model: record.model,
    effort: record.effort,
    state: record.state,
    totalTokens: record.totalTokens,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(Number.isInteger(record.cachedInputTokens) ? { cachedInputTokens: record.cachedInputTokens } : {}),
    ...(Number.isInteger(record.reasoningTokens) ? { reasoningTokens: record.reasoningTokens } : {}),
    ...(Number.isInteger(record.contextTokens) ? { contextTokens: record.contextTokens } : {}),
    ...(Number.isInteger(record.contextWindowTokens) ? { contextWindowTokens: record.contextWindowTokens } : {}),
    ...(typeof record.costUsd === 'number' ? { costUsd: record.costUsd } : {}),
    ...(typeof record.estimatedCostUsd === 'number' ? { estimatedCostUsd: record.estimatedCostUsd } : {}),
    ...(typeof record.estimatedCostModel === 'string' && record.estimatedCostModel
      ? { estimatedCostModel: record.estimatedCostModel }
      : {}),
    ...(typeof record.costSource === 'string' && record.costSource
      ? { costSource: record.costSource }
      : {}),
    operation: record.operation,
  };
}

export async function queryUsageLedger(options = {}) {
  const top = parsePositiveInteger(options.top, DEFAULT_TOP);
  const { startMs, endMs, days } = normalizeWindow(options);
  const ledgerDir = resolveLedgerDir(options.ledgerDir);
  const filters = {
    principalType: trimString(options.principalType),
    principalId: trimString(options.principalId),
    sessionId: trimString(options.sessionId),
    tool: trimString(options.tool),
    model: trimString(options.model),
  };

  const files = await listLedgerFiles(startMs, endMs, ledgerDir);
  const deduped = new Map();
  let recordsScanned = 0;

  for (const filePath of files) {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const rawLine of input) {
        const line = rawLine.trim();
        if (!line) continue;

        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const record = normalizeLedgerRecord(parsed);
        if (!record) continue;
        if (record.timestampMs < startMs || record.timestampMs > endMs) continue;

        recordsScanned += 1;
        deduped.set(record.runId, record);
      }
    } finally {
      input.close();
      stream.destroy();
    }
  }

  const records = [...deduped.values()]
    .filter((record) => matchesRecordFilters(record, filters))
    .sort((left, right) => {
      if ((right.totalTokens || 0) !== (left.totalTokens || 0)) {
        return (right.totalTokens || 0) - (left.totalTokens || 0);
      }
      const rightCost = (right.costUsd || 0) + (right.estimatedCostUsd || 0);
      const leftCost = (left.costUsd || 0) + (left.estimatedCostUsd || 0);
      if (rightCost !== leftCost) {
        return rightCost - leftCost;
      }
      return right.timestampMs - left.timestampMs;
    });

  const totals = createTotals();
  const byPrincipal = new Map();
  const byTool = new Map();
  const byModel = new Map();
  const byOperation = new Map();
  const byDay = new Map();
  const bySession = new Map();
  let contextTokenSum = 0;
  let contextTokenCount = 0;

  for (const record of records) {
    appendMetrics(totals, record);

    if (Number.isInteger(record.contextTokens)) {
      contextTokenSum += record.contextTokens;
      contextTokenCount += 1;
    }

    const principalBucket = getOrCreateBucket(
      byPrincipal,
      `${record.principalType}:${record.principalId || '(unknown)'}`,
      {
        principalType: record.principalType,
        principalId: record.principalId,
        principalName: record.principalName,
      },
    );
    appendMetrics(principalBucket, record);
    touchLatest(principalBucket, record);

    const toolBucket = getOrCreateBucket(byTool, record.tool || '(unknown)', { label: record.tool || '(unknown)' });
    appendMetrics(toolBucket, record);
    touchLatest(toolBucket, record);

    const modelBucket = getOrCreateBucket(byModel, record.model || '(unknown)', { label: record.model || '(unknown)' });
    appendMetrics(modelBucket, record);
    touchLatest(modelBucket, record);

    const operationBucket = getOrCreateBucket(byOperation, record.operation || 'user_turn', { label: record.operation || 'user_turn' });
    appendMetrics(operationBucket, record);
    touchLatest(operationBucket, record);

    const dayBucket = getOrCreateBucket(byDay, record.day, { label: record.day });
    appendMetrics(dayBucket, record);
    touchLatest(dayBucket, record);

    const sessionBucket = getOrCreateBucket(bySession, record.sessionId, {
      sessionId: record.sessionId,
      sessionName: record.sessionName || record.sessionId,
      principalType: record.principalType,
      principalId: record.principalId,
      tool: record.tool,
      model: record.model,
    });
    appendMetrics(sessionBucket, record);
    touchLatest(sessionBucket, record);
  }

  return {
    generatedAt: new Date().toISOString(),
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      days,
    },
    filters,
    filesScanned: files.length,
    recordsScanned,
    runCount: records.length,
    totals: {
      ...totals,
      costUsd: roundUsd(totals.costUsd || 0),
      estimatedCostUsd: roundUsd(totals.estimatedCostUsd || 0),
      cachedInputShare: totals.inputTokens > 0
        ? roundAverage(totals.cachedInputTokens / totals.inputTokens)
        : null,
      avgContextTokens: contextTokenCount > 0
        ? roundAverage(contextTokenSum / contextTokenCount)
        : null,
    },
    byPrincipal: sortBuckets(byPrincipal, top),
    byTool: sortBuckets(byTool, top),
    byModel: sortBuckets(byModel, top),
    byOperation: sortBuckets(byOperation, top),
    byDay: sortBuckets(byDay, top),
    bySession: sortBuckets(bySession, top),
    topRuns: records.slice(0, top).map(summarizeTopRun),
  };
}

export function closeUsageLedger() {
  if (!currentStream) return Promise.resolve();
  const stream = currentStream;
  currentStream = null;
  currentDateKey = '';
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}

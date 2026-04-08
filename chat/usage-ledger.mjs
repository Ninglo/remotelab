import { createReadStream, createWriteStream } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import readline from 'readline';

import { USAGE_LEDGER_DIR } from '../lib/config.mjs';
import { estimateUsageCost } from '../lib/model-pricing.mjs';
import { ensureDir } from './fs-utils.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_TOP = 10;

let currentDateKey = '';
let currentStream = null;
let loggingDisabled = false;
let detachedUsageSequence = 0;

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

function pickMeaningfulCost(value) {
  const parsed = pickFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

function roundAverage(value) {
  return Math.round(value * 100) / 100;
}

function roundRatio(value) {
  return Math.round(value * 10000) / 10000;
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

function sanitizeOperationKey(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'background_prompt';
}

export function classifyUsageOperation(input, extra = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input))
    ? input
    : {
        operation: input,
        internalOperation: extra.internalOperation,
        internalRole: extra.internalRole,
      };
  const operation = trimString(source.operation)
    || trimString(source.internalOperation)
    || trimString(source.internalRole)
    || 'user_turn';

  switch (operation) {
    case 'user_turn':
      return {
        key: operation,
        label: 'User turn',
        group: 'foreground',
        category: 'user_chat',
        background: false,
      };
    case 'reply_self_repair':
      return {
        key: operation,
        label: 'Reply self repair',
        group: 'background',
        category: 'reply_automation',
        background: true,
      };
    case 'reply_self_check':
    case 'reply_self_check_review':
      return {
        key: operation,
        label: 'Reply self check',
        group: 'background',
        category: 'reply_automation',
        background: true,
      };
    case 'context_compaction_worker':
    case 'context_compactor':
      return {
        key: operation,
        label: 'Context compaction',
        group: 'background',
        category: 'context_management',
        background: true,
      };
    case 'session_label_suggestion':
      return {
        key: operation,
        label: 'Session labeling',
        group: 'background',
        category: 'session_management',
        background: true,
      };
    case 'workflow_state_suggestion':
      return {
        key: operation,
        label: 'Workflow state suggestion',
        group: 'background',
        category: 'session_management',
        background: true,
      };
    case 'task_card_suggestion':
      return {
        key: operation,
        label: 'Task card suggestion',
        group: 'background',
        category: 'memory_management',
        background: true,
      };
    case 'memory_writeback_review':
      return {
        key: operation,
        label: 'Memory writeback review',
        group: 'background',
        category: 'memory_management',
        background: true,
      };
    case 'session_dispatch_classifier':
      return {
        key: operation,
        label: 'Session dispatch classifier',
        group: 'background',
        category: 'orchestration',
        background: true,
      };
    case 'trigger_delivery':
      return {
        key: operation,
        label: 'Trigger delivery',
        group: 'background',
        category: 'delivery',
        background: true,
      };
    case 'agent_delegate':
      return {
        key: operation,
        label: 'Agent delegate',
        group: 'background',
        category: 'orchestration',
        background: true,
      };
    default:
      if (trimString(source.internalOperation) || trimString(source.internalRole)) {
        return {
          key: operation,
          label: operation,
          group: 'background',
          category: 'other_internal',
          background: true,
        };
      }
      return {
        key: operation,
        label: operation,
        group: 'foreground',
        category: 'other_foreground',
        background: false,
      };
  }
}

function buildOperationFields(source = {}) {
  const classified = classifyUsageOperation(source);
  return {
    operationGroup: classified.group,
    operationCategory: classified.category,
    operationLabel: classified.label,
    backgroundOperation: classified.background,
  };
}

function createDetachedRunId(operation, timestampMs) {
  detachedUsageSequence += 1;
  return `detached_${sanitizeOperationKey(operation)}_${timestampMs}_${detachedUsageSequence}`;
}

function resolveCostFields({
  tool,
  model,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  costUsd,
  estimatedCostUsd,
  estimatedCostModel,
  costSource,
} = {}) {
  const explicitCostUsd = pickMeaningfulCost(costUsd);
  const explicitEstimatedCostUsd = pickMeaningfulCost(estimatedCostUsd);
  const normalizedEstimatedCostModel = trimString(estimatedCostModel);
  const normalizedCostSource = trimString(costSource);
  const fallbackEstimate = explicitCostUsd === null && explicitEstimatedCostUsd === null
    ? estimateUsageCost({
      tool,
      model,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    })
    : null;
  const resolvedEstimatedCostUsd = explicitEstimatedCostUsd ?? fallbackEstimate?.estimatedCostUsd ?? null;
  const resolvedEstimatedCostModel = normalizedEstimatedCostModel
    || (resolvedEstimatedCostUsd !== null ? trimString(fallbackEstimate?.pricingModel) : '');
  const resolvedCostSource = normalizedCostSource
    || (explicitCostUsd !== null
      ? 'provider_reported'
      : (explicitEstimatedCostUsd !== null
          ? 'provider_estimated'
          : trimString(fallbackEstimate?.costSource)));

  return {
    ...(explicitCostUsd !== null ? { costUsd: roundUsd(explicitCostUsd) } : {}),
    ...(resolvedEstimatedCostUsd !== null ? { estimatedCostUsd: roundUsd(resolvedEstimatedCostUsd) } : {}),
    ...(resolvedEstimatedCostModel ? { estimatedCostModel: resolvedEstimatedCostModel } : {}),
    ...(resolvedCostSource ? { costSource: resolvedCostSource } : {}),
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
  const tool = trimString(run.tool || session.tool);
  const model = trimString(run.model || session.model);
  const resolvedCostFields = resolveCostFields({
    tool,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: usageEvent.costUsd,
    estimatedCostUsd: usageEvent.estimatedCostUsd,
    estimatedCostModel: usageEvent.estimatedCostModel,
    costSource: usageEvent.costSource,
  });

  if (!Number.isFinite(timestampMs)) return null;
  if (
    inputTokens === null
    && outputTokens === null
    && cachedInputTokens === null
    && reasoningTokens === null
    && contextTokens === null
    && !Object.keys(resolvedCostFields).length
  ) {
    return null;
  }

  const principal = resolvePrincipal(session);
  const operation = resolveOperationInfo(session, manifest);
  const requestId = trimString(run.requestId);
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
    ...resolvedCostFields,
    internalSession: operation.internalSession,
    ...(operation.internalRole ? { internalRole: operation.internalRole } : {}),
    ...(operation.internalOperation ? { internalOperation: operation.internalOperation } : {}),
    operation: operation.operationKey,
    ...buildOperationFields({
      operation: operation.operationKey,
      internalOperation: operation.internalOperation,
      internalRole: operation.internalRole,
    }),
  };
}

export function buildDetachedUsageLedgerRecord({
  session,
  usageEvent,
  tracking = {},
  recordedAt = new Date(),
} = {}) {
  if (!session || !usageEvent) return null;

  const timestampMs = normalizeTimestampMs(
    trimString(tracking.completedAt)
    || trimString(tracking.recordedAt)
    || (recordedAt instanceof Date ? recordedAt.toISOString() : recordedAt)
  );
  const inputTokens = pickNonNegativeInt(usageEvent.inputTokens);
  const outputTokens = pickNonNegativeInt(usageEvent.outputTokens);
  const cachedInputTokens = pickNonNegativeInt(usageEvent.cachedInputTokens);
  const reasoningTokens = pickNonNegativeInt(usageEvent.reasoningTokens);
  const contextTokens = pickNonNegativeInt(usageEvent.contextTokens);
  const contextWindowTokens = pickNonNegativeInt(usageEvent.contextWindowTokens);
  const tool = trimString(tracking.tool || session.tool);
  const model = trimString(tracking.model || session.model);
  const resolvedCostFields = resolveCostFields({
    tool,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: usageEvent.costUsd,
    estimatedCostUsd: usageEvent.estimatedCostUsd,
    estimatedCostModel: usageEvent.estimatedCostModel,
    costSource: usageEvent.costSource,
  });

  if (!Number.isFinite(timestampMs)) return null;
  if (
    inputTokens === null
    && outputTokens === null
    && cachedInputTokens === null
    && reasoningTokens === null
    && contextTokens === null
    && !Object.keys(resolvedCostFields).length
  ) {
    return null;
  }

  const principal = resolvePrincipal(session);
  const internalRole = trimString(tracking.internalRole);
  const internalOperation = trimString(tracking.internalOperation);
  const operation = trimString(tracking.operation) || internalOperation || internalRole || 'background_prompt';
  const effort = trimString(tracking.effort || session.effort);
  const requestId = trimString(tracking.requestId);
  const state = trimString(tracking.state) || 'completed';
  const timestampIso = new Date(timestampMs).toISOString();
  const totalTokens = (inputTokens || 0) + (outputTokens || 0);

  return {
    type: 'run_usage',
    ts: timestampIso,
    recordedAt: new Date(timestampMs).toISOString(),
    runId: trimString(tracking.runId) || createDetachedRunId(operation, timestampMs),
    ...(requestId ? { requestId } : {}),
    sessionId: trimString(session.id),
    sessionName: trimString(tracking.sessionName || session.name),
    ...(trimString(tracking.sessionGroup || session.group) ? { sessionGroup: trimString(tracking.sessionGroup || session.group) } : {}),
    ...(trimString(tracking.rootSessionId || session.rootSessionId) ? { rootSessionId: trimString(tracking.rootSessionId || session.rootSessionId) } : {}),
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
    ...resolvedCostFields,
    internalSession: tracking.internalSession === true || !!internalRole || !!trimString(session.internalRole),
    ...(internalRole ? { internalRole } : {}),
    ...(internalOperation ? { internalOperation } : {}),
    operation,
    ...buildOperationFields({
      operation,
      internalOperation,
      internalRole,
    }),
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
  const tool = trimString(record.tool);
  const model = trimString(record.model);
  const resolvedCostFields = resolveCostFields({
    tool,
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: record.costUsd,
    estimatedCostUsd: record.estimatedCostUsd,
    estimatedCostModel: record.estimatedCostModel,
    costSource: record.costSource,
  });
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
    tool,
    model,
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
    ...resolvedCostFields,
    internalSession: record.internalSession === true,
    internalRole: trimString(record.internalRole),
    internalOperation: trimString(record.internalOperation),
    operation: trimString(record.operation) || trimString(record.internalOperation) || trimString(record.internalRole) || 'user_turn',
    ...buildOperationFields({
      operation: trimString(record.operation) || trimString(record.internalOperation) || trimString(record.internalRole) || 'user_turn',
      internalOperation: trimString(record.internalOperation),
      internalRole: trimString(record.internalRole),
    }),
  };
}

function createTotals() {
  return {
    runCount: 0,
    exactCostRunCount: 0,
    estimatedCostRunCount: 0,
    costedRunCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costedTokenCount: 0,
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
  const hasExactCost = pickMeaningfulCost(record.costUsd) !== null;
  const hasEstimatedCost = pickMeaningfulCost(record.estimatedCostUsd) !== null;
  if (hasExactCost) target.exactCostRunCount += 1;
  if (hasEstimatedCost) target.estimatedCostRunCount += 1;
  if (hasExactCost || hasEstimatedCost) {
    target.costedRunCount += 1;
    target.costedTokenCount += record.totalTokens || 0;
  }
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
    operationGroup: record.operationGroup,
    operationCategory: record.operationCategory,
    operationLabel: record.operationLabel,
    backgroundOperation: record.backgroundOperation === true,
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
  const byOperationGroup = new Map();
  const byOperationCategory = new Map();
  const byDay = new Map();
  const bySession = new Map();
  let contextTokenSum = 0;
  let contextTokenCount = 0;
  let backgroundTokens = 0;
  let backgroundRuns = 0;
  let foregroundTokens = 0;
  let foregroundRuns = 0;

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

    const operationGroupKey = trimString(record.operationGroup) || (record.backgroundOperation ? 'background' : 'foreground');
    const operationGroupBucket = getOrCreateBucket(byOperationGroup, operationGroupKey, { label: operationGroupKey });
    appendMetrics(operationGroupBucket, record);
    touchLatest(operationGroupBucket, record);

    const operationCategoryKey = trimString(record.operationCategory) || 'uncategorized';
    const operationCategoryBucket = getOrCreateBucket(byOperationCategory, operationCategoryKey, {
      label: operationCategoryKey,
      operationGroup: operationGroupKey,
    });
    appendMetrics(operationCategoryBucket, record);
    touchLatest(operationCategoryBucket, record);

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

    if (record.backgroundOperation) {
      backgroundTokens += record.totalTokens || 0;
      backgroundRuns += 1;
    } else {
      foregroundTokens += record.totalTokens || 0;
      foregroundRuns += 1;
    }
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
      unpricedRunCount: Math.max(0, (totals.runCount || 0) - (totals.costedRunCount || 0)),
      unpricedTokenCount: Math.max(0, (totals.totalTokens || 0) - (totals.costedTokenCount || 0)),
      costCoverageShare: totals.totalTokens > 0
        ? roundRatio((totals.costedTokenCount || 0) / totals.totalTokens)
        : null,
      cachedInputShare: totals.inputTokens > 0
        ? roundAverage(totals.cachedInputTokens / totals.inputTokens)
        : null,
      avgContextTokens: contextTokenCount > 0
        ? roundAverage(contextTokenSum / contextTokenCount)
        : null,
      backgroundTokens,
      backgroundRuns,
      foregroundTokens,
      foregroundRuns,
      backgroundShare: totals.totalTokens > 0
        ? roundAverage(backgroundTokens / totals.totalTokens)
        : null,
    },
    byPrincipal: sortBuckets(byPrincipal, top),
    byTool: sortBuckets(byTool, top),
    byModel: sortBuckets(byModel, top),
    byOperation: sortBuckets(byOperation, top),
    byOperationGroup: sortBuckets(byOperationGroup, top),
    byOperationCategory: sortBuckets(byOperationCategory, top),
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

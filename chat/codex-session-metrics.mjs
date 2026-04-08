import { createReadStream } from 'fs';
import { open, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import readline from 'readline';
import { statOrNull } from './fs-utils.mjs';
import { CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { estimateGpt54CostUsd, getGpt54PricingMetadata } from '../lib/openai-pricing.mjs';

const SESSION_LOG_CACHE = new Map();
const TAIL_CHUNK_BYTES = 128 * 1024;
const MAX_TAIL_SCAN_BYTES = 2 * 1024 * 1024;
let cachedSessionsRootsKey = '';

function buildUniqueRoots(paths = []) {
  const seen = new Set();
  const roots = [];
  for (const value of paths) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  return roots;
}

function getCodexSessionsRoots() {
  const homeOverride = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
  const homeDir = homeOverride || homedir();
  const codeHomeOverride = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : '';
  const sessionsRoots = buildUniqueRoots([
    codeHomeOverride ? join(codeHomeOverride, 'sessions') : '',
    join(CODEX_MANAGED_HOME_DIR, 'sessions'),
    join(homeDir, '.codex', 'sessions'),
  ]);
  const nextRootsKey = sessionsRoots.join('\n');
  if (nextRootsKey !== cachedSessionsRootsKey) {
    cachedSessionsRootsKey = nextRootsKey;
    SESSION_LOG_CACHE.clear();
  }
  return sessionsRoots;
}

function pickNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function readTokenUsageRecord(record) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') {
    return null;
  }

  const timestampMs = normalizeTimestampMs(record.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  const info = record.payload?.info || {};
  const totalUsage = info.total_token_usage || {};
  const lastUsage = info.last_token_usage || {};
  const inputTokens = pickNonNegativeInt(totalUsage.input_tokens) || 0;
  const cachedInputTokens = pickNonNegativeInt(totalUsage.cached_input_tokens) || 0;
  const outputTokens = pickNonNegativeInt(totalUsage.output_tokens) || 0;
  const reasoningTokens = pickNonNegativeInt(totalUsage.reasoning_output_tokens) || 0;
  const totalTokens = pickNonNegativeInt(totalUsage.total_tokens) || (inputTokens + outputTokens);

  return {
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    timestampMs,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    contextTokens: pickNonNegativeInt(lastUsage.input_tokens),
    contextWindowTokens: pickNonNegativeInt(info.model_context_window),
  };
}

function diffUsageTotals(current, previous) {
  if (!previous || current.totalTokens < previous.totalTokens) {
    return { ...current };
  }

  return {
    ...current,
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

async function findSessionLogRecursive(rootDir, threadId) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const fileSuffix = `${threadId}.jsonl`;
  const directHit = entries.find((entry) => entry.isFile() && entry.name.endsWith(fileSuffix));
  if (directHit) {
    return join(rootDir, directHit.name);
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));

  for (const directory of directories) {
    const found = await findSessionLogRecursive(join(rootDir, directory.name), threadId);
    if (found) return found;
  }

  return null;
}

export async function findCodexSessionLog(threadId) {
  if (!threadId) return null;

  const sessionsRoots = getCodexSessionsRoots();
  const cached = SESSION_LOG_CACHE.get(threadId);
  if (cached && await statOrNull(cached)) {
    return cached;
  }

  for (const sessionsDir of sessionsRoots) {
    const located = await findSessionLogRecursive(sessionsDir, threadId);
    if (located) {
      SESSION_LOG_CACHE.set(threadId, located);
      return located;
    }
  }

  SESSION_LOG_CACHE.delete(threadId);
  return null;
}

async function readLastMatchingJsonLine(filePath, predicate) {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    let position = stats.size;
    let bytesScanned = 0;
    let remainder = '';

    while (position > 0 && bytesScanned < MAX_TAIL_SCAN_BYTES) {
      const chunkSize = Math.min(TAIL_CHUNK_BYTES, position, MAX_TAIL_SCAN_BYTES - bytesScanned);
      position -= chunkSize;

      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead <= 0) break;

      bytesScanned += bytesRead;
      const text = buffer.toString('utf8', 0, bytesRead) + remainder;
      const lines = text.split(/\r?\n/);
      remainder = lines.shift() || '';

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (predicate(parsed)) return parsed;
        } catch {}
      }
    }

    const finalLine = remainder.trim();
    if (finalLine) {
      try {
        const parsed = JSON.parse(finalLine);
        if (predicate(parsed)) return parsed;
      } catch {}
    }

    return null;
  } finally {
    await handle.close();
  }
}

async function readLatestTokenUsageWindow(filePath, options = {}) {
  const startMs = normalizeTimestampMs(options.startedAt);
  const endMs = normalizeTimestampMs(
    options.completedAt
    || options.finalizedAt
    || options.endAt
  );
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let previousUsage = null;
  let latestUsage = null;

  try {
    for await (const rawLine of input) {
      const line = rawLine.trim();
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const usage = readTokenUsageRecord(record);
      if (!usage) continue;

      if (Number.isFinite(startMs) && usage.timestampMs < startMs) {
        previousUsage = usage;
        continue;
      }
      if (Number.isFinite(endMs) && usage.timestampMs > endMs) {
        break;
      }
      latestUsage = usage;
    }
  } finally {
    input.close();
    stream.close();
  }

  if (!latestUsage) {
    return null;
  }

  return {
    latestUsage,
    deltaUsage: diffUsageTotals(latestUsage, previousUsage),
  };
}

export async function readLatestCodexSessionMetrics(threadId, options = {}) {
  const sessionLogPath = await findCodexSessionLog(threadId);
  if (!sessionLogPath) return null;

  const windowUsage = (
    options
    && (
      typeof options.startedAt === 'string'
      || typeof options.completedAt === 'string'
      || typeof options.finalizedAt === 'string'
      || typeof options.endAt === 'string'
    )
  )
    ? await readLatestTokenUsageWindow(sessionLogPath, options)
    : null;

  if (windowUsage?.latestUsage) {
    const latestUsage = windowUsage.latestUsage;
    const deltaUsage = windowUsage.deltaUsage;
    const estimatedCostUsd = estimateGpt54CostUsd({
      inputTokens: deltaUsage.inputTokens,
      cachedInputTokens: deltaUsage.cachedInputTokens,
      outputTokens: deltaUsage.outputTokens,
    });
    const pricingMetadata = getGpt54PricingMetadata();

    return {
      threadId,
      sessionLogPath,
      source: 'provider_last_token_count',
      timestamp: latestUsage.timestamp,
      contextTokens: latestUsage.contextTokens,
      inputTokens: deltaUsage.inputTokens,
      cachedInputTokens: deltaUsage.cachedInputTokens,
      outputTokens: deltaUsage.outputTokens,
      reasoningTokens: deltaUsage.reasoningTokens,
      contextWindowTokens: latestUsage.contextWindowTokens,
      ...(Number.isFinite(estimatedCostUsd) ? { estimatedCostUsd } : {}),
      estimatedCostModel: pricingMetadata.pricingModel,
      costSource: pricingMetadata.costSource,
    };
  }

  const tokenCountRecord = await readLastMatchingJsonLine(
    sessionLogPath,
    (record) => record?.type === 'event_msg' && record?.payload?.type === 'token_count',
  );
  if (!tokenCountRecord) return null;

  const latestUsage = readTokenUsageRecord(tokenCountRecord);
  const contextTokens = latestUsage?.contextTokens;
  if (!Number.isInteger(contextTokens)) return null;
  const estimatedCostUsd = estimateGpt54CostUsd({
    inputTokens: latestUsage.inputTokens,
    cachedInputTokens: latestUsage.cachedInputTokens,
    outputTokens: latestUsage.outputTokens,
  });
  const pricingMetadata = getGpt54PricingMetadata();

  return {
    threadId,
    sessionLogPath,
    source: 'provider_last_token_count',
    timestamp: latestUsage.timestamp,
    contextTokens,
    inputTokens: latestUsage.inputTokens,
    cachedInputTokens: latestUsage.cachedInputTokens,
    outputTokens: latestUsage.outputTokens,
    reasoningTokens: latestUsage.reasoningTokens,
    contextWindowTokens: latestUsage.contextWindowTokens,
    ...(Number.isFinite(estimatedCostUsd) ? { estimatedCostUsd } : {}),
    estimatedCostModel: pricingMetadata.pricingModel,
    costSource: pricingMetadata.costSource,
  };
}

export function buildCodexContextMetricsPayload(metrics) {
  if (!metrics || !Number.isInteger(metrics.contextTokens)) return null;

  return {
    type: 'remotelab.context_metrics',
    contextTokens: metrics.contextTokens,
    ...(Number.isInteger(metrics.inputTokens) ? { inputTokens: metrics.inputTokens } : {}),
    ...(Number.isInteger(metrics.cachedInputTokens)
      ? { cachedInputTokens: metrics.cachedInputTokens }
      : {}),
    ...(Number.isInteger(metrics.outputTokens) ? { outputTokens: metrics.outputTokens } : {}),
    ...(Number.isInteger(metrics.reasoningTokens) ? { reasoningTokens: metrics.reasoningTokens } : {}),
    ...(Number.isInteger(metrics.contextWindowTokens)
      ? { contextWindowTokens: metrics.contextWindowTokens }
      : {}),
    ...(Number.isFinite(metrics.estimatedCostUsd)
      ? { estimatedCostUsd: metrics.estimatedCostUsd }
      : {}),
    ...(typeof metrics.estimatedCostModel === 'string' && metrics.estimatedCostModel
      ? { estimatedCostModel: metrics.estimatedCostModel }
      : {}),
    ...(typeof metrics.source === 'string' && metrics.source
      ? { contextSource: metrics.source }
      : {}),
    ...(typeof metrics.costSource === 'string' && metrics.costSource
      ? { costSource: metrics.costSource }
      : {}),
  };
}

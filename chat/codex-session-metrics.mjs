import { open, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { statOrNull } from './fs-utils.mjs';
import { estimateGpt54CostUsd, getGpt54PricingMetadata } from '../lib/openai-pricing.mjs';

const SESSION_LOG_CACHE = new Map();
const TAIL_CHUNK_BYTES = 128 * 1024;
const MAX_TAIL_SCAN_BYTES = 2 * 1024 * 1024;
let cachedSessionsDir = '';

function getCodexSessionsDir() {
  const homeOverride = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
  const homeDir = homeOverride || homedir();
  const sessionsDir = join(homeDir, '.codex', 'sessions');
  if (sessionsDir !== cachedSessionsDir) {
    cachedSessionsDir = sessionsDir;
    SESSION_LOG_CACHE.clear();
  }
  return sessionsDir;
}

function pickNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
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

  const sessionsDir = getCodexSessionsDir();
  const cached = SESSION_LOG_CACHE.get(threadId);
  if (cached && await statOrNull(cached)) {
    return cached;
  }

  const located = await findSessionLogRecursive(sessionsDir, threadId);
  if (located) {
    SESSION_LOG_CACHE.set(threadId, located);
    return located;
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

export async function readLatestCodexSessionMetrics(threadId) {
  const sessionLogPath = await findCodexSessionLog(threadId);
  if (!sessionLogPath) return null;

  const tokenCountRecord = await readLastMatchingJsonLine(
    sessionLogPath,
    (record) => record?.type === 'event_msg' && record?.payload?.type === 'token_count',
  );
  if (!tokenCountRecord) return null;

  const info = tokenCountRecord.payload?.info || {};
  const lastUsage = info.last_token_usage || {};
  const totalUsage = info.total_token_usage || {};
  const contextTokens = pickNonNegativeInt(lastUsage.input_tokens);
  if (!Number.isInteger(contextTokens)) return null;
  const inputTokens = pickNonNegativeInt(totalUsage.input_tokens);
  const cachedInputTokens = pickNonNegativeInt(totalUsage.cached_input_tokens);
  const outputTokens = pickNonNegativeInt(totalUsage.output_tokens);
  const reasoningTokens = pickNonNegativeInt(totalUsage.reasoning_output_tokens);
  const estimatedCostUsd = estimateGpt54CostUsd({
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });
  const pricingMetadata = getGpt54PricingMetadata();

  return {
    threadId,
    sessionLogPath,
    source: 'provider_last_token_count',
    timestamp: typeof tokenCountRecord.timestamp === 'string' ? tokenCountRecord.timestamp : null,
    contextTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    contextWindowTokens: pickNonNegativeInt(info.model_context_window),
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

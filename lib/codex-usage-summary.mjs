import { createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { basename, join } from 'path';
import readline from 'readline';
import { resolveCodexHomeDir } from './codex-home.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTimestampMs(value) {
  const timestampMs = Date.parse(value || '');
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function formatLocalDay(timestampMs) {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalTimestamp(timestampMs) {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatInteger(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0';
}

function formatPercent(part, total, digits = 1) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(digits)}%`;
}

function collapseWhitespace(value) {
  return trimString(value).replace(/\s+/g, ' ');
}

function clipText(value, maxLength = 180) {
  const normalized = collapseWhitespace(value);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeUserMessageText(value) {
  let text = trimString(value);
  if (!text) return '';
  const extracted = text.match(/(?:Current user message|User message):\s*([\s\S]*)$/);
  if (extracted?.[1]) {
    text = extracted[1];
  }
  text = text.replace(/<(private|hide)>[\s\S]*?<\/\1>/gi, ' ');
  return clipText(text, 220);
}

function isNoiseUserMessage(value) {
  const text = trimString(value);
  if (!text) return true;
  return [
    /^Warning:\s*apply_patch was requested via shell/i,
    /^IMPORTANT:\s*Complete ALL requested work/i,
    /^You are an AI agent operating on this computer via RemoteLab\./i,
    /^# AGENTS\.md instructions for /i,
  ].some((pattern) => pattern.test(text));
}

function readUserMessageText(record) {
  if (record?.type === 'event_msg' && record?.payload?.type === 'user_message') {
    const normalized = normalizeUserMessageText(record.payload.message || record.payload.text || '');
    return isNoiseUserMessage(normalized) ? '' : normalized;
  }
  if (record?.type === 'response_item'
    && record?.payload?.type === 'message'
    && record?.payload?.role === 'user') {
    const content = Array.isArray(record.payload.content) ? record.payload.content : [];
    const text = content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .join(' ');
    const normalized = normalizeUserMessageText(text);
    return isNoiseUserMessage(normalized) ? '' : normalized;
  }
  return '';
}

function readTurnContext(record) {
  if (record?.type !== 'turn_context') return null;
  return {
    cwd: trimString(record.payload?.cwd),
    model: trimString(record.payload?.model),
    effort: trimString(record.payload?.effort || record.payload?.model_reasoning_effort),
  };
}

function readTokenUsage(record) {
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null;

  const timestampMs = normalizeTimestampMs(record.timestamp);
  if (!Number.isFinite(timestampMs)) return null;

  const info = record.payload?.info || {};
  const totalUsage = info.total_token_usage || {};
  const lastUsage = info.last_token_usage || {};

  const inputTokens = pickNonNegativeInt(totalUsage.input_tokens) || 0;
  const cachedInputTokens = pickNonNegativeInt(totalUsage.cached_input_tokens) || 0;
  const outputTokens = pickNonNegativeInt(totalUsage.output_tokens) || 0;
  const reasoningTokens = pickNonNegativeInt(totalUsage.reasoning_output_tokens) || 0;
  const totalTokens = pickNonNegativeInt(totalUsage.total_tokens) || (inputTokens + outputTokens);

  return {
    timestamp: record.timestamp,
    timestampMs,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    contextTokens: pickNonNegativeInt(lastUsage.input_tokens),
    contextWindowTokens: pickNonNegativeInt(info.model_context_window),
    secondaryUsedPercent: pickFiniteNumber(record.payload?.rate_limits?.secondary?.used_percent),
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

function appendBreakdown(map, key, value) {
  const normalizedKey = trimString(key) || '(unknown)';
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + value);
}

function sortBreakdown(map, totalTokens, limit = Infinity) {
  return [...map.entries()]
    .map(([key, value]) => ({ key, totalTokens: value, share: totalTokens > 0 ? value / totalTokens : 0 }))
    .sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens;
      return left.key.localeCompare(right.key);
    })
    .slice(0, limit);
}

function sessionIdFromPath(filePath) {
  const name = basename(filePath, '.jsonl');
  const parts = name.split('-');
  return parts[parts.length - 1] || name;
}

async function collectJsonlFiles(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  const children = [];

  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      children.push(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }

  for (const child of children.sort((left, right) => left.localeCompare(right))) {
    files.push(...await collectJsonlFiles(child));
  }

  return files;
}

export function getCodexUsageRoots(options = {}) {
  const codexHomeDir = trimString(options.codexHomeDir) || resolveCodexHomeDir();
  return [{
    id: 'machine',
    label: 'machine (~/.codex)',
    path: join(codexHomeDir, 'sessions'),
  }];
}

async function readSessionWindowUsage(filePath, sourceInfo, startMs, endMs) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const session = {
    sessionId: sessionIdFromPath(filePath),
    filePath,
    source: sourceInfo.id,
    sourceLabel: sourceInfo.label,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    usageEventCount: 0,
    model: '',
    effort: '',
    cwd: '',
    promptPreview: '',
    latestTimestamp: null,
    latestTimestampMs: null,
    latestSecondaryUsedPercent: null,
    latestSecondaryTimestamp: null,
    peakContextTokens: null,
    contextWindowTokens: null,
    dailyTotals: new Map(),
  };

  let previousTotals = null;
  let currentContext = { cwd: '', model: '', effort: '' };
  let currentUserMessage = '';

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

      const turnContext = readTurnContext(record);
      if (turnContext) {
        currentContext = {
          cwd: turnContext.cwd || currentContext.cwd,
          model: turnContext.model || currentContext.model,
          effort: turnContext.effort || currentContext.effort,
        };
        continue;
      }

      const userMessage = readUserMessageText(record);
      if (userMessage) {
        currentUserMessage = userMessage;
        continue;
      }

      const usage = readTokenUsage(record);
      if (!usage) continue;

      const delta = diffUsageTotals(usage, previousTotals);
      previousTotals = usage;

      if (usage.timestampMs < startMs || usage.timestampMs > endMs) {
        continue;
      }

      if (delta.totalTokens <= 0 && delta.inputTokens <= 0 && delta.outputTokens <= 0) {
        continue;
      }

      session.totalTokens += delta.totalTokens;
      session.inputTokens += delta.inputTokens;
      session.cachedInputTokens += delta.cachedInputTokens;
      session.outputTokens += delta.outputTokens;
      session.reasoningTokens += delta.reasoningTokens;
      session.usageEventCount += 1;
      session.model = currentContext.model || session.model;
      session.effort = currentContext.effort || session.effort;
      session.cwd = currentContext.cwd || session.cwd;
      session.promptPreview = currentUserMessage || session.promptPreview;
      session.latestTimestamp = usage.timestamp;
      session.latestTimestampMs = usage.timestampMs;

      if (Number.isFinite(usage.secondaryUsedPercent)) {
        session.latestSecondaryUsedPercent = usage.secondaryUsedPercent;
        session.latestSecondaryTimestamp = usage.timestamp;
      }

      if (Number.isInteger(usage.contextTokens)) {
        session.peakContextTokens = Number.isInteger(session.peakContextTokens)
          ? Math.max(session.peakContextTokens, usage.contextTokens)
          : usage.contextTokens;
      }

      if (Number.isInteger(usage.contextWindowTokens)) {
        session.contextWindowTokens = usage.contextWindowTokens;
      }

      appendBreakdown(session.dailyTotals, formatLocalDay(usage.timestampMs), delta.totalTokens);
    }
  } finally {
    input.close();
    stream.close();
  }

  return session.totalTokens > 0 ? session : null;
}

export async function collectCodexUsageSummary(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = pickNonNegativeInt(options.days) || 7;
  const startMs = Number.isFinite(options.startMs) ? options.startMs : (nowMs - (days * DAY_MS));
  const endMs = Number.isFinite(options.endMs) ? options.endMs : nowMs;
  const top = pickNonNegativeInt(options.top) || 10;
  const roots = getCodexUsageRoots(options);

  const summary = {
    startMs,
    endMs,
    days,
    top,
    source: 'machine',
    sessionsScanned: 0,
    sessionsWithUsage: 0,
    usageEventCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    latestSecondaryUsedPercent: null,
    latestSecondaryTimestamp: null,
    latestSecondarySource: '',
    bySource: new Map(),
    byEffort: new Map(),
    byModel: new Map(),
    byCwd: new Map(),
    byDay: new Map(),
    sessions: [],
  };

  for (const root of roots) {
    const files = await collectJsonlFiles(root.path);
    for (const filePath of files) {
      summary.sessionsScanned += 1;
      const session = await readSessionWindowUsage(filePath, root, startMs, endMs);
      if (!session) continue;

      summary.sessionsWithUsage += 1;
      summary.usageEventCount += session.usageEventCount;
      summary.totalTokens += session.totalTokens;
      summary.inputTokens += session.inputTokens;
      summary.cachedInputTokens += session.cachedInputTokens;
      summary.outputTokens += session.outputTokens;
      summary.reasoningTokens += session.reasoningTokens;

      appendBreakdown(summary.bySource, session.sourceLabel, session.totalTokens);
      appendBreakdown(summary.byEffort, session.effort || '(none)', session.totalTokens);
      appendBreakdown(summary.byModel, session.model || '(unknown)', session.totalTokens);
      appendBreakdown(summary.byCwd, session.cwd || '(unknown)', session.totalTokens);

      for (const [day, totalTokens] of session.dailyTotals.entries()) {
        appendBreakdown(summary.byDay, day, totalTokens);
      }

      if (Number.isFinite(session.latestSecondaryUsedPercent)
        && (!summary.latestSecondaryTimestamp || Date.parse(session.latestSecondaryTimestamp) > Date.parse(summary.latestSecondaryTimestamp))) {
        summary.latestSecondaryUsedPercent = session.latestSecondaryUsedPercent;
        summary.latestSecondaryTimestamp = session.latestSecondaryTimestamp;
        summary.latestSecondarySource = session.sourceLabel;
      }

      summary.sessions.push(session);
    }
  }

  summary.sessions.sort((left, right) => {
    if (right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens;
    return (right.latestTimestampMs || 0) - (left.latestTimestampMs || 0);
  });

  return {
    ...summary,
    bySource: sortBreakdown(summary.bySource, summary.totalTokens),
    byEffort: sortBreakdown(summary.byEffort, summary.totalTokens),
    byModel: sortBreakdown(summary.byModel, summary.totalTokens),
    byCwd: sortBreakdown(summary.byCwd, summary.totalTokens, top),
    byDay: sortBreakdown(summary.byDay, summary.totalTokens, top),
    topSessions: summary.sessions.slice(0, top).map((session) => ({
      sessionId: session.sessionId,
      filePath: session.filePath,
      source: session.source,
      sourceLabel: session.sourceLabel,
      totalTokens: session.totalTokens,
      inputTokens: session.inputTokens,
      cachedInputTokens: session.cachedInputTokens,
      outputTokens: session.outputTokens,
      reasoningTokens: session.reasoningTokens,
      usageEventCount: session.usageEventCount,
      model: session.model,
      effort: session.effort,
      cwd: session.cwd,
      promptPreview: session.promptPreview,
      latestTimestamp: session.latestTimestamp,
      latestTimestampMs: session.latestTimestampMs,
      latestSecondaryUsedPercent: session.latestSecondaryUsedPercent,
      latestSecondaryTimestamp: session.latestSecondaryTimestamp,
      peakContextTokens: session.peakContextTokens,
      contextWindowTokens: session.contextWindowTokens,
    })),
  };
}

export function renderCodexUsageSummary(summary) {
  const lines = [];
  lines.push(`Codex usage summary (${summary.days}d, machine)`);
  lines.push(`Window: ${formatLocalTimestamp(summary.startMs)} → ${formatLocalTimestamp(summary.endMs)}`);
  lines.push(`Sessions with usage: ${formatInteger(summary.sessionsWithUsage)} / ${formatInteger(summary.sessionsScanned)}`);
  lines.push(`Usage events: ${formatInteger(summary.usageEventCount)}`);
  lines.push(`Total tokens: ${formatInteger(summary.totalTokens)}`);
  lines.push(`Input: ${formatInteger(summary.inputTokens)} (${formatPercent(summary.inputTokens, summary.totalTokens)})`);
  lines.push(`Cached input: ${formatInteger(summary.cachedInputTokens)} (${formatPercent(summary.cachedInputTokens, summary.inputTokens)} of input)`);
  lines.push(`Output: ${formatInteger(summary.outputTokens)} (${formatPercent(summary.outputTokens, summary.totalTokens)})`);
  lines.push(`Reasoning: ${formatInteger(summary.reasoningTokens)} (${formatPercent(summary.reasoningTokens, summary.outputTokens || summary.totalTokens)})`);

  if (Number.isFinite(summary.latestSecondaryUsedPercent) && summary.latestSecondaryTimestamp) {
    lines.push(
      `Latest weekly snapshot: ${summary.latestSecondaryUsedPercent.toFixed(1)}% at ${formatLocalTimestamp(Date.parse(summary.latestSecondaryTimestamp))} (${summary.latestSecondarySource})`,
    );
  }

  if (summary.bySource.length) {
    lines.push('', 'By source:');
    for (const entry of summary.bySource) {
      lines.push(`  ${entry.key} — ${formatInteger(entry.totalTokens)} (${formatPercent(entry.totalTokens, summary.totalTokens)})`);
    }
  }

  if (summary.byEffort.length) {
    lines.push('', 'By effort:');
    for (const entry of summary.byEffort.slice(0, summary.top)) {
      lines.push(`  ${entry.key} — ${formatInteger(entry.totalTokens)} (${formatPercent(entry.totalTokens, summary.totalTokens)})`);
    }
  }

  if (summary.byModel.length) {
    lines.push('', 'By model:');
    for (const entry of summary.byModel.slice(0, summary.top)) {
      lines.push(`  ${entry.key} — ${formatInteger(entry.totalTokens)} (${formatPercent(entry.totalTokens, summary.totalTokens)})`);
    }
  }

  if (summary.byCwd.length) {
    lines.push('', 'Top directories:');
    for (const entry of summary.byCwd) {
      lines.push(`  ${entry.key} — ${formatInteger(entry.totalTokens)} (${formatPercent(entry.totalTokens, summary.totalTokens)})`);
    }
  }

  if (summary.byDay.length) {
    lines.push('', 'Top days:');
    for (const entry of summary.byDay) {
      lines.push(`  ${entry.key} — ${formatInteger(entry.totalTokens)} (${formatPercent(entry.totalTokens, summary.totalTokens)})`);
    }
  }

  if (summary.topSessions.length) {
    lines.push('', 'Top sessions:');
    for (const session of summary.topSessions) {
      const header = [
        formatLocalTimestamp(session.latestTimestampMs || summary.endMs),
        session.sourceLabel,
        session.model || '(unknown)',
        session.effort || '(none)',
        formatInteger(session.totalTokens),
        session.cwd || '(unknown)',
      ].join(' | ');
      lines.push(`  ${header}`);
      if (session.promptPreview) {
        lines.push(`    ${session.promptPreview}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

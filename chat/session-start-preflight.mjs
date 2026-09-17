import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR } from '../lib/config.mjs';
import { writeDurableJson } from '../lib/durable-records.mjs';

const POLICY_VERSION = 1;
const EVENT_VERSION = 1;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const MAX_ATTEMPTS = 10;
const DEFAULT_TIME_ZONE = 'UTC';
const DEFAULT_PROMPT = '这是 RemoteLab 启动前置预检。不要联网、不要调用工具。只回答：你所知的最新 Gemini 主版本是 X.X？仅输出版本号。';
const DEFAULT_RESTART_ANSWERS = ['2.5'];

export const SESSION_START_PREFLIGHT_CONFIG_FILE = join(CONFIG_DIR, 'session-start-preflight.json');
export const SESSION_START_PREFLIGHT_EVENTS_DIR = join(CONFIG_DIR, 'session-start-preflight-events');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => trimString(entry))
      .filter(Boolean),
  )];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function validTimeZone(value) {
  const candidate = trimString(value) || trimString(process.env.TZ) || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function normalizePolicy(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prompt = trimString(raw.prompt) || DEFAULT_PROMPT;
  const restartAnswers = normalizeStringList(raw.restartAnswers);
  return {
    version: POLICY_VERSION,
    enabled: raw.enabled === true,
    prompt,
    restartAnswers: restartAnswers.length > 0 ? restartAnswers : [...DEFAULT_RESTART_ANSWERS],
    retryDelayMs: boundedInteger(raw.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0, MAX_RETRY_DELAY_MS),
    maxAttempts: boundedInteger(raw.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS),
    timeZone: validTimeZone(raw.timeZone),
    tools: normalizeStringList(raw.tools),
    runtimeFamilies: normalizeStringList(raw.runtimeFamilies),
    models: normalizeStringList(raw.models),
    includeInternalOperations: raw.includeInternalOperations === true,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function matchesOptionalList(list, value) {
  return list.length === 0 || list.includes(trimString(value));
}

export async function readSessionStartPreflightPolicy(options = {}) {
  const policy = normalizePolicy(await readJson(options.configFile || SESSION_START_PREFLIGHT_CONFIG_FILE));
  if (!policy?.enabled) return null;
  if (options.freshProviderSession !== true) return null;
  if (trimString(options.internalOperation) && !policy.includeInternalOperations) return null;
  if (!matchesOptionalList(policy.tools, options.tool)) return null;
  if (!matchesOptionalList(policy.runtimeFamilies, options.runtimeFamily)) return null;
  if (!matchesOptionalList(policy.models, options.model)) return null;
  return policy;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function classifySessionStartPreflightAnswer(answer, policy = {}) {
  const normalized = trimString(answer).replace(/\s+/g, ' ');
  if (!normalized) {
    return { status: 'error', answer: '', reason: 'empty_answer' };
  }
  const restartAnswers = normalizeStringList(policy.restartAnswers);
  const matchedAnswer = (restartAnswers.length > 0 ? restartAnswers : DEFAULT_RESTART_ANSWERS)
    .find((candidate) => new RegExp(`(^|[^0-9])${escapeRegExp(candidate)}([^0-9]|$)`, 'i').test(normalized));
  if (matchedAnswer) {
    return {
      status: 'restart_required',
      answer: normalized.slice(0, 240),
      matchedAnswer,
      reason: 'stale_version_answer',
    };
  }
  return { status: 'loaded', answer: normalized.slice(0, 240), reason: 'accepted_answer' };
}

function assistantTextParts(event, runtimeFamily) {
  if (!event || typeof event !== 'object') return [];
  if (runtimeFamily === 'codex-json') {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      return [trimString(event.item.text)].filter(Boolean);
    }
    return [];
  }
  if (runtimeFamily === 'claude-stream-json') {
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
    return event.message.content
      .filter((block) => block?.type === 'text')
      .map((block) => trimString(block.text))
      .filter(Boolean);
  }
  if (runtimeFamily === 'pi-json') {
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') return [];
    const content = event.message?.content;
    if (typeof content === 'string') return [trimString(content)].filter(Boolean);
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block?.type === 'text')
      .map((block) => trimString(block.text))
      .filter(Boolean);
  }
  return [];
}

export function createSessionStartPreflightCapture(runtimeFamily) {
  const parts = [];
  let providerIdentityEvent = null;
  return {
    observe(event) {
      if (!event || typeof event !== 'object') return;
      parts.push(...assistantTextParts(event, runtimeFamily));
      if (runtimeFamily === 'codex-json' && event.type === 'thread.started' && event.thread_id) {
        providerIdentityEvent = { type: 'thread.started', thread_id: event.thread_id };
      } else if (runtimeFamily === 'claude-stream-json' && event.session_id && !providerIdentityEvent) {
        providerIdentityEvent = { type: 'system', subtype: 'init', session_id: event.session_id };
      }
    },
    answer() {
      return parts.join('\n').trim();
    },
    providerIdentityEvent() {
      return providerIdentityEvent ? { ...providerIdentityEvent } : null;
    },
  };
}

export function formatSessionStartPreflightDay(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function appendSessionStartPreflightEvent(event, options = {}) {
  const timestamp = trimString(event?.timestamp) || new Date().toISOString();
  const timeZone = validTimeZone(options.timeZone || event?.timeZone);
  const day = trimString(options.day || event?.day)
    || formatSessionStartPreflightDay(timestamp, timeZone);
  const directory = join(options.eventsDir || SESSION_START_PREFLIGHT_EVENTS_DIR, day);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = {
    version: EVENT_VERSION,
    id: trimString(event?.id) || randomUUID(),
    timestamp,
    day,
    timeZone,
    ...event,
  };
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z]+/g, '-');
  await writeDurableJson(join(directory, `${safeTimestamp}-${record.id}.json`), record);
  return record;
}

async function readDayEvents(eventsDir, day) {
  const directory = join(eventsDir, day);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const events = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(join(directory, name))));
  return events.filter(Boolean).sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

function roundRate(value) {
  return Math.round(value * 10_000) / 10_000;
}

function emptyMetrics() {
  return {
    triggered: 0,
    resolved: 0,
    normalLoads: 0,
    neededNewSession: 0,
    loadedAfterRestart: 0,
    exhausted: 0,
    errors: 0,
    cancelled: 0,
    incomplete: 0,
    attempts: 0,
    restartAttempts: 0,
    normalLoadRate: 0,
    neededNewSessionRate: 0,
  };
}

function finalizeMetrics(metrics) {
  metrics.incomplete = Math.max(0, metrics.triggered - metrics.resolved);
  metrics.normalLoadRate = metrics.triggered > 0
    ? roundRate(metrics.normalLoads / metrics.triggered)
    : 0;
  metrics.neededNewSessionRate = metrics.triggered > 0
    ? roundRate(metrics.neededNewSession / metrics.triggered)
    : 0;
  return metrics;
}

function aggregateRunEvents(events) {
  const started = events.find((event) => event.type === 'started');
  const attempts = events.filter((event) => event.type === 'attempt');
  const completed = events.findLast((event) => event.type === 'completed');
  if (!started && attempts.length === 0 && !completed) return null;
  const restartAttempts = attempts.filter((event) => event.status === 'restart_required').length;
  return {
    tool: trimString(started?.tool || completed?.tool || attempts[0]?.tool) || 'unknown',
    model: trimString(started?.model || completed?.model || attempts[0]?.model) || 'default',
    completed,
    attempts: attempts.length,
    restartAttempts,
    neededNewSession: restartAttempts > 0,
  };
}

function addRunMetrics(metrics, run) {
  metrics.triggered += 1;
  metrics.attempts += run.attempts;
  metrics.restartAttempts += run.restartAttempts;
  if (run.neededNewSession) metrics.neededNewSession += 1;
  if (!run.completed) return;
  metrics.resolved += 1;
  switch (run.completed.outcome) {
    case 'loaded_first_attempt': metrics.normalLoads += 1; break;
    case 'loaded_after_restart': metrics.loadedAfterRestart += 1; break;
    case 'exhausted': metrics.exhausted += 1; break;
    case 'cancelled': metrics.cancelled += 1; break;
    default: metrics.errors += 1; break;
  }
}

function aggregateEvents(events) {
  const byRun = new Map();
  for (const event of events) {
    const runId = trimString(event.runId);
    if (!runId) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push(event);
  }
  const totals = emptyMetrics();
  const breakdown = new Map();
  for (const runEvents of byRun.values()) {
    const run = aggregateRunEvents(runEvents);
    if (!run) continue;
    addRunMetrics(totals, run);
    const key = `${run.tool}\0${run.model}`;
    if (!breakdown.has(key)) breakdown.set(key, { tool: run.tool, model: run.model, ...emptyMetrics() });
    addRunMetrics(breakdown.get(key), run);
  }
  return {
    totals: finalizeMetrics(totals),
    breakdown: [...breakdown.values()]
      .map(finalizeMetrics)
      .sort((left, right) => right.triggered - left.triggered || left.tool.localeCompare(right.tool) || left.model.localeCompare(right.model)),
  };
}

function enumerateDays(days, now, timeZone) {
  const result = [];
  const seen = new Set();
  for (let offset = 0; result.length < days; offset += 1) {
    const candidate = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const day = formatSessionStartPreflightDay(candidate, timeZone);
    if (seen.has(day)) continue;
    seen.add(day);
    result.push(day);
  }
  return result;
}

export async function collectSessionStartPreflightStats(options = {}) {
  const days = boundedInteger(options.days, 7, 1, 366);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const rawPolicy = normalizePolicy(await readJson(options.configFile || SESSION_START_PREFLIGHT_CONFIG_FILE));
  const timeZone = validTimeZone(options.timeZone || rawPolicy?.timeZone);
  const eventsDir = options.eventsDir || SESSION_START_PREFLIGHT_EVENTS_DIR;
  const dayKeys = enumerateDays(days, now, timeZone);
  const daily = [];
  const allEvents = [];
  for (const day of dayKeys) {
    const events = await readDayEvents(eventsDir, day);
    allEvents.push(...events);
    daily.push({ day, ...aggregateEvents(events) });
  }
  return {
    generatedAt: new Date().toISOString(),
    timeZone,
    window: { days, fromDay: dayKeys.at(-1), toDay: dayKeys[0] },
    policy: rawPolicy,
    totals: aggregateEvents(allEvents).totals,
    daily,
  };
}

export function renderSessionStartPreflightStats(summary) {
  const percent = (value) => `${(Number(value || 0) * 100).toFixed(2)}%`;
  const lines = [
    `Session start preflight (${summary.window.fromDay} to ${summary.window.toDay}, ${summary.timeZone})`,
    `- Triggered: ${summary.totals.triggered}`,
    `- Loaded normally on first attempt: ${summary.totals.normalLoads} (${percent(summary.totals.normalLoadRate)})`,
    `- Needed a new provider session: ${summary.totals.neededNewSession} (${percent(summary.totals.neededNewSessionRate)})`,
    `- Loaded after restart: ${summary.totals.loadedAfterRestart}`,
    `- Exhausted / errors / cancelled / incomplete: ${summary.totals.exhausted} / ${summary.totals.errors} / ${summary.totals.cancelled} / ${summary.totals.incomplete}`,
    `- Probe attempts: ${summary.totals.attempts} (${summary.totals.restartAttempts} restart-triggering)`,
    '',
    'Daily:',
  ];
  for (const day of summary.daily) {
    lines.push(`- ${day.day}: triggered ${day.totals.triggered}; normal ${day.totals.normalLoads}; new session ${day.totals.neededNewSession} (${percent(day.totals.neededNewSessionRate)}); after restart ${day.totals.loadedAfterRestart}; incomplete ${day.totals.incomplete}`);
  }
  return `${lines.join('\n')}\n`;
}

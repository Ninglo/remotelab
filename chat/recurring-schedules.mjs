import { normalizeScheduledSessionTemplate as normalizeSessionTemplate } from '../lib/scheduled-session.mjs';
import { scheduledRuntimeIntent, patchScheduledRuntime } from '../lib/scheduled-runtime-policy.mjs';
import { createHash, randomBytes } from 'crypto';
import { spawn } from 'child_process';

import { CHAT_RECURRING_SCHEDULES_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, readJson, statOrNull, writeJsonAtomic } from './fs-utils.mjs';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_OPEN_OCCURRENCES = 1;
const MIN_INTERVAL_SECONDS = 10;
const DEFAULT_GATE_TIMEOUT_SECONDS = 5;
const MAX_GATE_TIMEOUT_SECONDS = 30;
const MAX_GATE_SOURCE_BYTES = 64 * 1024;
const MAX_GATE_OUTPUT_BYTES = 16 * 1024;
const MAX_CRON_SEARCH_MINUTES = 5 * 366 * 24 * 60;

let schedulesCache = null;
let schedulesCacheMtimeMs = 0;
let schedulerTimer = null;
let schedulerTickPromise = null;
const scheduleMutationQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function nowIso(value = Date.now()) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCadence(raw, { strict = false } = {}) {
  const cadence = raw?.cadence && typeof raw.cadence === 'object' ? raw.cadence : {};
  const type = trimString(cadence.type || raw?.scheduleType).toLowerCase();
  if (strict && type && !['cron', 'interval'].includes(type)) {
    throw new Error('cadence.type must be cron or interval');
  }
  const intervalValue = cadence.everySeconds ?? raw?.everySeconds ?? raw?.intervalSeconds;
  if (type === 'interval' || intervalValue !== undefined) {
    const everySeconds = positiveInteger(intervalValue);
    if (everySeconds < MIN_INTERVAL_SECONDS) {
      if (strict) throw new Error(`everySeconds must be at least ${MIN_INTERVAL_SECONDS}`);
      throw new Error('Invalid interval cadence');
    }
    return { type: 'interval', everySeconds };
  }
  return {
    type: 'cron',
    cron: parseCronExpression(raw?.cron).expression,
    timezone: validateTimezone(raw?.timezone),
  };
}

function normalizeLifetime(value, { strict = false } = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requestedMode = trimString(raw.mode).toLowerCase();
  const hasBound = raw.maxExecutions !== undefined || raw.maxChecks !== undefined || trimString(raw.endsAt);
  const mode = requestedMode || (hasBound ? 'bounded' : 'continuous');
  if (!['continuous', 'bounded'].includes(mode)) throw new Error('lifetime.mode must be continuous or bounded');
  if (mode === 'continuous') {
    if (strict && hasBound) throw new Error('continuous lifetime cannot include bounded limits');
    return { mode };
  }
  const maxExecutions = positiveInteger(raw.maxExecutions);
  const maxChecks = positiveInteger(raw.maxChecks);
  const endsAt = normalizeTimestamp(raw.endsAt);
  if (strict) {
    if (raw.maxExecutions !== undefined && !maxExecutions) throw new Error('lifetime.maxExecutions must be a positive integer');
    if (raw.maxChecks !== undefined && !maxChecks) throw new Error('lifetime.maxChecks must be a positive integer');
    if (trimString(raw.endsAt) && !endsAt) throw new Error('lifetime.endsAt must be a valid timestamp');
  }
  if (!maxExecutions && !maxChecks && !endsAt) {
    throw new Error('bounded lifetime requires maxExecutions, maxChecks, or endsAt');
  }
  return {
    mode,
    ...(maxExecutions ? { maxExecutions } : {}),
    ...(maxChecks ? { maxChecks } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

function normalizeGate(value, { strict = false } = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = trimString(raw.mode).toLowerCase() || 'direct';
  if (!['direct', 'script'].includes(mode)) throw new Error('gate.mode must be direct or script');
  if (mode === 'direct') return { mode };
  const runtime = trimString(raw.runtime || raw.language).toLowerCase() || 'bash';
  if (!['bash', 'python', 'node'].includes(runtime)) throw new Error('gate.runtime must be bash, python, or node');
  const source = typeof raw.source === 'string'
    ? raw.source
    : typeof raw.script?.source === 'string'
      ? raw.script.source
      : '';
  if (!source.trim()) throw new Error('gate.source is required for script gates');
  if (Buffer.byteLength(source, 'utf8') > MAX_GATE_SOURCE_BYTES) {
    throw new Error(`gate.source must not exceed ${MAX_GATE_SOURCE_BYTES} bytes`);
  }
  const requestedTimeout = raw.timeoutSeconds ?? raw.script?.timeoutSeconds;
  const timeoutSeconds = requestedTimeout === undefined
    ? DEFAULT_GATE_TIMEOUT_SECONDS
    : positiveInteger(requestedTimeout);
  if (!timeoutSeconds || timeoutSeconds > MAX_GATE_TIMEOUT_SECONDS) {
    throw new Error(`gate.timeoutSeconds must be between 1 and ${MAX_GATE_TIMEOUT_SECONDS}`);
  }
  const cooldownSeconds = raw.cooldownSeconds === undefined ? 0 : Number(raw.cooldownSeconds);
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    if (strict) throw new Error('gate.cooldownSeconds must be a non-negative integer');
    throw new Error('Invalid gate cooldown');
  }
  return {
    mode,
    runtime,
    source,
    snapshotSha256: createHash('sha256').update(source).digest('hex'),
    timeoutSeconds,
    cooldownSeconds,
  };
}

function normalizeAlerts(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = trimString(raw.mode).toLowerCase() || 'remotelab';
  if (!['none', 'remotelab'].includes(mode)) {
    throw new Error('alerts.mode must be none or remotelab');
  }
  const on = Array.isArray(raw.on)
    ? [...new Set(raw.on.map((entry) => trimString(entry).toLowerCase()).filter((entry) => (
      ['gate_error', 'execution_failure', 'completed'].includes(entry)
    )))]
    : ['gate_error', 'execution_failure'];
  return { mode, on };
}


function createScheduleId() {
  return `sch_${randomBytes(12).toString('hex')}`;
}

function parseInteger(value, fieldName) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${fieldName} value: ${value}`);
  return Number.parseInt(value, 10);
}

function normalizeCronNumber(value, fieldName, min, max, { sundaySeven = false } = {}) {
  const parsed = parseInteger(value, fieldName);
  if (sundaySeven && parsed === 7) return 0;
  if (parsed < min || parsed > max) throw new Error(`Invalid ${fieldName} value: ${value}`);
  return parsed;
}

function parseCronField(rawValue, fieldName, min, max, options = {}) {
  const raw = trimString(rawValue);
  if (!raw) throw new Error(`${fieldName} is required`);
  const values = new Set();
  for (const segment of raw.split(',')) {
    const [rangePart, stepPart] = segment.split('/');
    if (!rangePart || segment.split('/').length > 2) throw new Error(`Invalid ${fieldName} segment: ${segment}`);
    const step = stepPart === undefined ? 1 : parseInteger(stepPart, `${fieldName} step`);
    if (step <= 0) throw new Error(`Invalid ${fieldName} step: ${stepPart}`);
    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) throw new Error(`Invalid ${fieldName} range: ${rangePart}`);
      start = parseInteger(bounds[0], fieldName);
      end = parseInteger(bounds[1], fieldName);
      if (start < min || start > max || end < min || end > max) {
        throw new Error(`Invalid ${fieldName} range: ${rangePart}`);
      }
      if (start > end) throw new Error(`Invalid ${fieldName} range: ${rangePart}`);
    } else {
      start = normalizeCronNumber(rangePart, fieldName, min, max, options);
      end = start;
    }
    for (let value = start; value <= end; value += step) {
      values.add(options.sundaySeven && value === 7 ? 0 : value);
    }
  }
  const expectedSize = options.sundaySeven ? 7 : (max - min + 1);
  return { raw, wildcard: values.size === expectedSize, values };
}

export function parseCronExpression(expression) {
  const fields = trimString(expression).split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new Error('cron must contain exactly five fields');
  return {
    expression: fields.join(' '),
    minute: parseCronField(fields[0], 'minute', 0, 59),
    hour: parseCronField(fields[1], 'hour', 0, 23),
    dayOfMonth: parseCronField(fields[2], 'day of month', 1, 31),
    month: parseCronField(fields[3], 'month', 1, 12),
    dayOfWeek: parseCronField(fields[4], 'day of week', 0, 7, { sundaySeven: true }),
  };
}

function validateTimezone(timezone) {
  const normalized = trimString(timezone) || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${normalized}`);
  }
  return normalized;
}

const formatterCache = new Map();

function getTimezoneFormatter(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }));
  }
  return formatterCache.get(timezone);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getZonedParts(timestampMs, timezone) {
  const parts = Object.fromEntries(
    getTimezoneFormatter(timezone)
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: WEEKDAYS[parts.weekday],
  };
}

function cronMatches(parsed, parts) {
  if (!parsed.minute.values.has(parts.minute)) return false;
  if (!parsed.hour.values.has(parts.hour)) return false;
  if (!parsed.month.values.has(parts.month)) return false;
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(parts.dayOfWeek);
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dayOfWeekMatch;
  if (parsed.dayOfWeek.wildcard) return dayOfMonthMatch;
  return dayOfMonthMatch || dayOfWeekMatch;
}

export function getNextCronOccurrence(expression, timezone = DEFAULT_TIMEZONE, after = Date.now()) {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const normalizedTimezone = validateTimezone(timezone);
  const afterMs = typeof after === 'string' ? Date.parse(after) : Number(after);
  if (!Number.isFinite(afterMs)) throw new Error('after must be a valid timestamp');
  let candidateMs = Math.floor(afterMs / 60000) * 60000 + 60000;
  for (let index = 0; index < MAX_CRON_SEARCH_MINUTES; index += 1, candidateMs += 60000) {
    if (cronMatches(parsed, getZonedParts(candidateMs, normalizedTimezone))) {
      return new Date(candidateMs).toISOString();
    }
  }
  throw new Error('Unable to find next cron occurrence within five years');
}

function getLatestCronOccurrenceAtOrBefore(expression, timezone, at) {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const normalizedTimezone = validateTimezone(timezone);
  const atMs = typeof at === 'string' ? Date.parse(at) : Number(at);
  if (!Number.isFinite(atMs)) throw new Error('at must be a valid timestamp');
  let candidateMs = Math.floor(atMs / 60000) * 60000;
  for (let index = 0; index < MAX_CRON_SEARCH_MINUTES; index += 1, candidateMs -= 60000) {
    if (cronMatches(parsed, getZonedParts(candidateMs, normalizedTimezone))) {
      return new Date(candidateMs).toISOString();
    }
  }
  throw new Error('Unable to find previous cron occurrence within five years');
}

function getNextScheduleOccurrence(schedule, after) {
  if (schedule.cadence?.type === 'interval') {
    const afterMs = typeof after === 'string' ? Date.parse(after) : Number(after);
    if (!Number.isFinite(afterMs)) throw new Error('after must be a valid timestamp');
    return new Date(afterMs + schedule.cadence.everySeconds * 1000).toISOString();
  }
  return getNextCronOccurrence(schedule.cron, schedule.timezone, after);
}

function normalizeStoredSchedule(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceSessionId = trimString(raw.sourceSessionId) || trimString(raw.sessionId);
  const text = trimString(raw.text);
  const sessionTemplate = normalizeSessionTemplate(raw.sessionTemplate, raw.tool, raw);
  if (!text || !sourceSessionId || !sessionTemplate) return null;
  const cadence = normalizeCadence(raw);
  const cron = cadence.type === 'cron' ? cadence.cron : '';
  const timezone = cadence.type === 'cron' ? cadence.timezone : '';
  const lifetime = normalizeLifetime(raw.lifetime);
  const gate = normalizeGate(raw.gate);
  const createdAt = normalizeTimestamp(raw.createdAt) || nowIso();
  const requestedStatus = trimString(raw.status).toLowerCase();
  let status = 'active';
  if (requestedStatus === 'paused') status = 'paused';
  else if (requestedStatus === 'cancelled') status = 'cancelled';
  else if (requestedStatus === 'completed') status = 'completed';
  else if (raw.enabled === false) status = 'cancelled';
  const enabled = status === 'active';
  return {
    id: /^sch_[a-f0-9]{24}$/.test(trimString(raw.id)) ? trimString(raw.id) : createScheduleId(),
    status,
    enabled,
    sourceSessionId,
    sessionTemplate,
    title: trimString(raw.title),
    text,
    cadence,
    cron,
    timezone,
    lifetime,
    gate,
    alerts: normalizeAlerts(raw.alerts),
    misfirePolicy: 'latest_once',
    overlapPolicy: 'latest_once',
    maxOpenOccurrences: Math.max(1, Number.parseInt(raw.maxOpenOccurrences, 10) || DEFAULT_MAX_OPEN_OCCURRENCES),
    ...scheduledRuntimeIntent(raw),
    nextRunAt: normalizeTimestamp(raw.nextRunAt),
    lastScheduledAt: normalizeTimestamp(raw.lastScheduledAt),
    missedCount: Math.max(0, Number.parseInt(raw.missedCount, 10) || 0),
    skippedCount: Math.max(0, Number.parseInt(raw.skippedCount, 10) || 0),
    checkCount: Math.max(0, Number.parseInt(raw.checkCount, 10) || 0),
    matchCount: Math.max(0, Number.parseInt(raw.matchCount, 10) || 0),
    gateSkipCount: Math.max(0, Number.parseInt(raw.gateSkipCount, 10) || 0),
    gateErrorCount: Math.max(0, Number.parseInt(raw.gateErrorCount, 10) || 0),
    deduplicatedCount: Math.max(0, Number.parseInt(raw.deduplicatedCount, 10) || 0),
    lastCheckAt: normalizeTimestamp(raw.lastCheckAt),
    lastMatchedAt: normalizeTimestamp(raw.lastMatchedAt),
    lastGateMatched: raw.lastGateMatched === true,
    lastGateReason: trimString(raw.lastGateReason),
    lastError: trimString(raw.lastError),
    lastErrorAt: normalizeTimestamp(raw.lastErrorAt),
    createdAt,
    updatedAt: normalizeTimestamp(raw.updatedAt) || createdAt,
    cancelledAt: normalizeTimestamp(raw.cancelledAt),
    completedAt: normalizeTimestamp(raw.completedAt),
  };
}

async function saveSchedulesUnlocked(schedules) {
  schedulesCache = Array.isArray(schedules) ? schedules : [];
  await writeJsonAtomic(CHAT_RECURRING_SCHEDULES_FILE, schedulesCache);
  const stat = await statOrNull(CHAT_RECURRING_SCHEDULES_FILE);
  schedulesCacheMtimeMs = stat?.mtimeMs || Date.now();
}

async function loadSchedules() {
  const stat = await statOrNull(CHAT_RECURRING_SCHEDULES_FILE);
  const mtimeMs = stat?.mtimeMs || 0;
  if (schedulesCache && schedulesCacheMtimeMs === mtimeMs) return schedulesCache;
  const raw = await readJson(CHAT_RECURRING_SCHEDULES_FILE, []);
  const schedules = [];
  let changed = !Array.isArray(raw);
  for (const entry of Array.isArray(raw) ? raw : []) {
    try {
      const normalized = normalizeStoredSchedule(entry);
      if (!normalized) {
        changed = true;
        continue;
      }
      if (JSON.stringify(normalized) !== JSON.stringify(entry)) changed = true;
      schedules.push(normalized);
    } catch {
      changed = true;
    }
  }
  schedulesCache = schedules;
  if (changed) await saveSchedulesUnlocked(schedules);
  else schedulesCacheMtimeMs = mtimeMs;
  return schedulesCache;
}

async function withScheduleMutation(mutator) {
  return scheduleMutationQueue(async () => {
    const schedules = await loadSchedules();
    return mutator(schedules, saveSchedulesUnlocked);
  });
}

export async function listRecurringSchedules(options = {}) {
  const sessionId = trimString(options.sessionId);
  const schedules = await loadSchedules();
  return schedules
    .filter((entry) => !sessionId || entry.sourceSessionId === sessionId)
    .sort((left, right) => (Date.parse(left.nextRunAt) || Infinity) - (Date.parse(right.nextRunAt) || Infinity))
    .map(clone);
}

export async function getRecurringSchedule(scheduleId) {
  const id = trimString(scheduleId);
  const schedules = await loadSchedules();
  return clone(schedules.find((entry) => entry.id === id) || null);
}

export async function createRecurringSchedule(input = {}, options = {}) {
  const sourceSessionId = trimString(input.sourceSessionId);
  const text = trimString(input.text);
  const sessionTemplate = normalizeSessionTemplate(input.sessionTemplate, input.tool, input);
  if (!sourceSessionId) throw new Error('sourceSessionId is required');
  if (!sessionTemplate) {
    throw new Error('sessionTemplate with folder and tool is required');
  }
  if (!text) throw new Error('text is required');
  const cadence = normalizeCadence(input, { strict: true });
  const lifetime = normalizeLifetime(input.lifetime, { strict: true });
  const gate = normalizeGate(input.gate, { strict: true });
  const alerts = normalizeAlerts(input.alerts);
  const createdAt = nowIso(options.now);
  const seed = {
    cadence,
    cron: cadence.type === 'cron' ? cadence.cron : '',
    timezone: cadence.type === 'cron' ? cadence.timezone : '',
  };
  const schedule = normalizeStoredSchedule({
    id: createScheduleId(),
    status: input.enabled === false ? 'cancelled' : 'active',
    enabled: input.enabled !== false,
    sourceSessionId,
    sessionTemplate,
    title: input.title,
    text,
    ...seed,
    lifetime,
    gate,
    alerts,
    tool: input.tool,
    runtimePolicy: input.runtimePolicy,
    model: input.model,
    effort: input.effort,
    thinking: input.thinking,
    maxOpenOccurrences: input.maxOpenOccurrences,
    nextRunAt: getNextScheduleOccurrence(seed, createdAt),
    createdAt,
    updatedAt: createdAt,
  });
  await withScheduleMutation(async (schedules, save) => {
    schedules.push(schedule);
    await save(schedules);
  });
  return clone(schedule);
}

export async function updateRecurringSchedule(scheduleId, patch = {}) {
  const id = trimString(scheduleId);
  let result = null;
  await withScheduleMutation(async (schedules, save) => {
    const index = schedules.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const current = schedules[index];
    const updatedAt = nowIso();
    const sourceSessionId = Object.prototype.hasOwnProperty.call(patch, 'sourceSessionId')
      ? trimString(patch.sourceSessionId)
      : current.sourceSessionId;
    const text = Object.prototype.hasOwnProperty.call(patch, 'text')
      ? trimString(patch.text)
      : current.text;
    const sessionTemplate = normalizeSessionTemplate(
      Object.hasOwn(patch, 'sessionTemplate') ? patch.sessionTemplate : current.sessionTemplate,
      patch.tool || current.tool, patch);
    if (!sourceSessionId) throw new Error('sourceSessionId is required');
    if (!sessionTemplate) throw new Error('sessionTemplate with folder and tool is required');
    if (sourceSessionId !== current.sourceSessionId) {
      throw new Error('sourceSessionId cannot be changed; create a new schedule instead');
    }
    if (!text) throw new Error('text is required');
    if (Object.prototype.hasOwnProperty.call(patch, 'thinking') && typeof patch.thinking !== 'boolean') {
      throw new Error('thinking must be a boolean');
    }
    const hasRequestedStatus = Object.prototype.hasOwnProperty.call(patch, 'status');
    const requestedStatus = hasRequestedStatus
      ? trimString(patch.status).toLowerCase()
      : '';
    if (hasRequestedStatus && !['active', 'paused', 'cancelled'].includes(requestedStatus)) {
      throw new Error('status must be active, paused, or cancelled');
    }
    if (hasRequestedStatus && Object.prototype.hasOwnProperty.call(patch, 'enabled')
        && patch.enabled !== (requestedStatus === 'active')) {
      throw new Error('enabled conflicts with status');
    }
    if (requestedStatus === 'active' && ['cancelled', 'completed'].includes(current.status)) {
      throw new Error(`${current.status === 'completed' ? 'Completed' : 'Cancelled'} schedules cannot be resumed`);
    }
    const nextStatus = requestedStatus || (Object.prototype.hasOwnProperty.call(patch, 'enabled')
      ? (patch.enabled === true ? 'active' : 'cancelled')
      : current.status);
    const enabled = nextStatus === 'active';
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    const cadencePatchRequested = ['cadence', 'scheduleType', 'everySeconds', 'intervalSeconds', 'cron', 'timezone']
      .some((field) => Object.prototype.hasOwnProperty.call(patch, field));
    let cadence = current.cadence;
    if (cadencePatchRequested) {
      const patchCadence = patch.cadence && typeof patch.cadence === 'object' ? patch.cadence : null;
      const explicitlyInterval = trimString(patchCadence?.type || patch.scheduleType).toLowerCase() === 'interval'
        || Object.hasOwn(patch, 'everySeconds') || Object.hasOwn(patch, 'intervalSeconds');
      const explicitlyCron = trimString(patchCadence?.type || patch.scheduleType).toLowerCase() === 'cron'
        || Object.hasOwn(patch, 'cron');
      cadence = normalizeCadence({
        ...current,
        ...patch,
        ...(explicitlyInterval ? { cron: undefined } : {}),
        cadence: patchCadence || (explicitlyCron
          ? { type: 'cron' }
          : explicitlyInterval
            ? { type: 'interval' }
            : current.cadence),
      }, { strict: true });
    }
    const cron = cadence.type === 'cron' ? cadence.cron : '';
    const timezone = cadence.type === 'cron' ? cadence.timezone : '';
    const lifetime = Object.hasOwn(patch, 'lifetime')
      ? normalizeLifetime(patch.lifetime, { strict: true })
      : current.lifetime;
    const gate = Object.hasOwn(patch, 'gate')
      ? normalizeGate(patch.gate, { strict: true })
      : current.gate;
    const alerts = Object.hasOwn(patch, 'alerts') ? normalizeAlerts(patch.alerts) : current.alerts;
    const cadenceChanged = JSON.stringify(cadence) !== JSON.stringify(current.cadence);
    const next = normalizeStoredSchedule({
      ...current,
      ...patch,
      ...patchScheduledRuntime(current, patch),
      sourceSessionId,
      sessionTemplate,
      text,
      cadence,
      cron,
      timezone,
      lifetime,
      gate,
      alerts,
      enabled,
      status: nextStatus,
      cancelledAt: nextStatus === 'cancelled' ? (current.cancelledAt || updatedAt) : '',
      completedAt: nextStatus === 'completed' ? (current.completedAt || updatedAt) : '',
      nextRunAt: enabled && (!current.enabled || cadenceChanged)
        ? getNextScheduleOccurrence({ cadence, cron, timezone }, updatedAt)
        : current.nextRunAt,
      updatedAt,
    });
    schedules[index] = next;
    await save(schedules);
    result = clone(next);
  });
  return result;
}

export async function deleteRecurringSchedule(scheduleId) {
  const id = trimString(scheduleId);
  let result = null;
  await withScheduleMutation(async (schedules, save) => {
    const index = schedules.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    result = clone(schedules[index]);
    schedules.splice(index, 1);
    await save(schedules);
  });
  return result;
}

function collectDueOccurrences(schedule, nowMs) {
  if (schedule.cadence?.type === 'interval') {
    const firstMs = Date.parse(schedule.nextRunAt);
    const stepMs = schedule.cadence.everySeconds * 1000;
    if (!Number.isFinite(firstMs) || firstMs > nowMs) {
      return { dueCount: 0, latestAt: '', nextRunAt: schedule.nextRunAt };
    }
    const dueCount = Math.floor((nowMs - firstMs) / stepMs) + 1;
    const latestMs = firstMs + ((dueCount - 1) * stepMs);
    return {
      dueCount,
      latestAt: new Date(latestMs).toISOString(),
      nextRunAt: new Date(latestMs + stepMs).toISOString(),
    };
  }
  const due = [];
  let cursor = schedule.nextRunAt;
  for (let index = 0; index < 10000 && cursor && Date.parse(cursor) <= nowMs; index += 1) {
    due.push(cursor);
    cursor = getNextScheduleOccurrence(schedule, cursor);
  }
  if (cursor && Date.parse(cursor) <= nowMs) {
    due[due.length - 1] = getLatestCronOccurrenceAtOrBefore(schedule.cron, schedule.timezone, nowMs);
    cursor = getNextScheduleOccurrence(schedule, nowMs);
  }
  return { dueCount: due.length, latestAt: due.at(-1) || '', nextRunAt: cursor };
}

export function parseGateOutput(value) {
  const output = trimString(value);
  if (/^yes$/i.test(output)) return { trigger: true, reason: '', dedupeKey: '' };
  if (/^no$/i.test(output)) return { trigger: false, reason: '', dedupeKey: '' };
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Gate output must be yes, no, or one JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.trigger !== 'boolean') {
    throw new Error('Gate JSON must contain a boolean trigger field');
  }
  return {
    trigger: parsed.trigger,
    reason: trimString(parsed.reason).slice(0, 500),
    dedupeKey: trimString(parsed.dedupeKey).slice(0, 500),
  };
}

function gateCommand(runtime) {
  if (runtime === 'python') return { command: 'python3', args: ['-'] };
  if (runtime === 'node') return { command: process.execPath, args: ['-'] };
  return { command: '/bin/bash', args: ['--noprofile', '--norc', '-s'] };
}

export async function runScheduleGate(schedule, scheduledAt) {
  if (schedule.gate?.mode !== 'script') return { trigger: true, reason: '', dedupeKey: '' };
  const { command, args } = gateCommand(schedule.gate.runtime);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: schedule.sessionTemplate?.folder || process.cwd(),
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        REMOTELAB_TASK_ID: schedule.id,
        REMOTELAB_TASK_CHECK_AT: scheduledAt,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Gate timed out after ${schedule.gate.timeoutSeconds}s`));
    }, schedule.gate.timeoutSeconds * 1000);
    child.on('error', (error) => finish(reject, error));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GATE_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error(`Gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = trimString(stderr);
        finish(reject, new Error(`Gate exited with ${signal || code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        finish(resolve, parseGateOutput(stdout));
      } catch (error) {
        finish(reject, error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(schedule.gate.source);
  });
}

function lifetimeCompletionReason(schedule, nowMs, counts = {}) {
  if (schedule.lifetime?.mode !== 'bounded') return '';
  if (schedule.lifetime.endsAt && nowMs >= Date.parse(schedule.lifetime.endsAt)) return 'end_time_reached';
  if (schedule.lifetime.maxChecks && schedule.checkCount >= schedule.lifetime.maxChecks) return 'check_limit_reached';
  if (schedule.lifetime.maxExecutions
      && Number(counts.admittedExecutions || 0) >= schedule.lifetime.maxExecutions) {
    return 'execution_limit_reached';
  }
  return '';
}

async function completeSchedule(scheduleId, reason, now) {
  await withScheduleMutation(async (schedules, save) => {
    const index = schedules.findIndex((entry) => entry.id === scheduleId);
    if (index === -1 || schedules[index].status !== 'active') return;
    const current = schedules[index];
    current.status = 'completed';
    current.enabled = false;
    current.nextRunAt = '';
    current.completedAt = now;
    current.lastGateReason = reason;
    current.updatedAt = now;
    schedules[index] = normalizeStoredSchedule(current);
    await save(schedules);
  });
}

export async function materializeDueRecurringSchedulesNow(options = {}) {
  const now = nowIso(options.now);
  const nowMs = Date.parse(now);
  const createScheduledTrigger = options.createScheduledTrigger;
  const countOpenScheduleTriggers = options.countOpenScheduleTriggers || (async () => 0);
  const getScheduleTriggerCounts = options.getScheduleTriggerCounts || (async () => ({
    admittedExecutions: 0,
    pendingAdmissions: 0,
  }));
  const executeGate = options.runGate || runScheduleGate;
  if (typeof createScheduledTrigger !== 'function') throw new Error('createScheduledTrigger is required');
  let materialized = 0;
  let skipped = 0;
  let failed = 0;
  let schedules = await listRecurringSchedules();
  for (const schedule of schedules.filter((entry) => entry.status === 'active' && entry.lifetime?.mode === 'bounded')) {
    const counts = schedule.lifetime.maxExecutions ? await getScheduleTriggerCounts(schedule.id) : {};
    const reason = lifetimeCompletionReason(schedule, nowMs, counts);
    if (reason) await completeSchedule(schedule.id, reason, now);
  }
  schedules = await listRecurringSchedules();
  const candidates = schedules.filter((entry) => (
    entry.enabled && entry.nextRunAt && Date.parse(entry.nextRunAt) <= nowMs
  ));
  for (const candidate of candidates) {
    try {
      const occurrences = collectDueOccurrences(candidate, nowMs);
      if (!occurrences.latestAt) continue;
      const counts = await getScheduleTriggerCounts(candidate.id);
      const reservedExecutions = Number(counts.admittedExecutions || 0) + Number(counts.pendingAdmissions || 0);
      const atExecutionCapacity = candidate.lifetime?.maxExecutions
        && reservedExecutions >= candidate.lifetime.maxExecutions;
      const openCount = await countOpenScheduleTriggers(candidate.id);
      let gateResult = { trigger: true, reason: '', dedupeKey: '' };
      let gateError = null;
      if (!atExecutionCapacity && openCount < candidate.maxOpenOccurrences) {
        const cooldownUntil = Date.parse(candidate.lastMatchedAt || '')
          + (candidate.gate?.cooldownSeconds || 0) * 1000;
        if (candidate.gate?.cooldownSeconds && Number.isFinite(cooldownUntil) && nowMs < cooldownUntil) {
          gateResult = { trigger: false, reason: 'cooldown_active', dedupeKey: '' };
        } else {
          try {
            gateResult = await executeGate(candidate, occurrences.latestAt);
          } catch (error) {
            gateError = error;
          }
        }
      }
      await withScheduleMutation(async (schedules, save) => {
        const index = schedules.findIndex((entry) => entry.id === candidate.id);
        if (index === -1) return;
        const current = schedules[index];
        if (!current.enabled || !current.nextRunAt || Date.parse(current.nextRunAt) > nowMs) return;
        const currentOccurrences = collectDueOccurrences(current, nowMs);
        if (!currentOccurrences.latestAt || currentOccurrences.latestAt !== occurrences.latestAt) return;
        if (atExecutionCapacity || openCount >= current.maxOpenOccurrences) {
          current.skippedCount += 1;
          skipped += 1;
        } else if (gateError) {
          current.checkCount += 1;
          current.gateErrorCount += 1;
          current.lastCheckAt = occurrences.latestAt;
          current.lastGateMatched = false;
          current.lastGateReason = 'gate_error';
          current.lastError = gateError.message || 'Gate execution failed';
          current.lastErrorAt = now;
          failed += 1;
        } else if (!gateResult.trigger) {
          current.checkCount += 1;
          current.gateSkipCount += 1;
          current.lastCheckAt = occurrences.latestAt;
          current.lastGateMatched = false;
          current.lastGateReason = gateResult.reason || 'condition_not_met';
          current.lastError = '';
          current.lastErrorAt = '';
        } else {
          const dedupeSuffix = gateResult.dedupeKey
            ? `gate:${createHash('sha256').update(gateResult.dedupeKey).digest('hex')}`
            : occurrences.latestAt;
          const createdTrigger = await createScheduledTrigger({
            sourceSessionId: current.sourceSessionId,
            sessionTemplate: current.sessionTemplate,
            title: current.title,
            text: current.text,
            scheduledAt: occurrences.latestAt,
            tool: current.tool,
            runtimePolicy: current.runtimePolicy,
            model: current.model,
            effort: current.effort,
            thinking: current.thinking,
            scheduleId: current.id,
            occurrenceId: `${current.id}:${dedupeSuffix}`,
          });
          current.checkCount += 1;
          current.matchCount += 1;
          current.lastCheckAt = occurrences.latestAt;
          current.lastMatchedAt = occurrences.latestAt;
          current.lastGateMatched = true;
          current.lastGateReason = gateResult.reason || 'condition_met';
          current.lastError = '';
          current.lastErrorAt = '';
          if (createdTrigger?.deduplicated) {
            current.deduplicatedCount += 1;
            current.lastGateReason = gateResult.reason || 'deduplicated';
            skipped += 1;
          } else {
            current.lastScheduledAt = occurrences.latestAt;
            materialized += 1;
          }
        }
        current.missedCount += Math.max(0, occurrences.dueCount - 1);
        current.nextRunAt = occurrences.nextRunAt;
        current.updatedAt = now;
        const completionReason = lifetimeCompletionReason(current, nowMs, counts);
        if (completionReason) {
          current.status = 'completed';
          current.enabled = false;
          current.nextRunAt = '';
          current.completedAt = now;
        }
        schedules[index] = normalizeStoredSchedule(current);
        await save(schedules);
      });
    } catch (error) {
      failed += 1;
      await withScheduleMutation(async (schedules, save) => {
        const current = schedules.find((entry) => entry.id === candidate.id);
        if (!current) return;
        current.lastError = error.message || 'Failed to materialize schedule';
        current.lastErrorAt = now;
        current.updatedAt = now;
        await save(schedules);
      });
      console.error(`[recurring-schedules] failed to materialize ${candidate.id}: ${error.message}`);
    }
  }
  return { due: candidates.length, materialized, skipped, failed };
}

export function startRecurringScheduleScheduler(options = {}) {
  if (schedulerTimer) return schedulerTimer;
  const pollMs = Math.max(250, Number.parseInt(options.pollMs || process.env.REMOTELAB_SCHEDULE_POLL_MS, 10) || DEFAULT_POLL_MS);
  const tick = () => {
    if (schedulerTickPromise) return schedulerTickPromise;
    schedulerTickPromise = materializeDueRecurringSchedulesNow(options)
      .then(async (result) => {
        if (result.materialized > 0 && typeof options.onMaterialized === 'function') {
          await options.onMaterialized(result);
        }
        return result;
      })
      .catch((error) => {
        console.error(`[recurring-schedules] scheduler tick failed: ${error.message}`);
      })
      .finally(() => {
        schedulerTickPromise = null;
      });
    return schedulerTickPromise;
  };
  schedulerTimer = setInterval(() => void tick(), pollMs);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  void tick();
  return schedulerTimer;
}

export function stopRecurringScheduleScheduler() {
  if (!schedulerTimer) return false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  return true;
}

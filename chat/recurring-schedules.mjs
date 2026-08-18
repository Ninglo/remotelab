import { randomBytes } from 'crypto';

import { CHAT_RECURRING_SCHEDULES_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, readJson, statOrNull, writeJsonAtomic } from './fs-utils.mjs';
import { normalizeSourceDeliveryPlan } from './source-deliveries.mjs';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_POLL_MS = 15000;
const DEFAULT_MAX_OPEN_OCCURRENCES = 10;
const EXECUTION_MODE_EXISTING_SESSION = 'existing_session';
const EXECUTION_MODE_FRESH_SESSION = 'fresh_session';
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

function normalizeExecutionMode(value) {
  return trimString(value) === EXECUTION_MODE_FRESH_SESSION
    ? EXECUTION_MODE_FRESH_SESSION
    : EXECUTION_MODE_EXISTING_SESSION;
}

function normalizeSessionTemplate(value, fallbackTool = '') {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const template = {
    folder: trimString(raw.folder),
    tool: trimString(raw.tool) || trimString(fallbackTool),
    name: trimString(raw.name),
    group: trimString(raw.group),
    description: trimString(raw.description),
    systemPrompt: trimString(raw.systemPrompt),
    internalRole: trimString(raw.internalRole) || 'scheduled_execution',
  };
  return template.folder && template.tool ? template : null;
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

function normalizeStoredSchedule(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const executionMode = normalizeExecutionMode(raw.executionMode);
  const sessionId = trimString(raw.sessionId);
  const text = trimString(raw.text);
  const sessionTemplate = normalizeSessionTemplate(raw.sessionTemplate, raw.tool);
  if (!text || (executionMode === EXECUTION_MODE_EXISTING_SESSION && !sessionId)
    || (executionMode === EXECUTION_MODE_FRESH_SESSION && !sessionTemplate)) return null;
  const cron = parseCronExpression(raw.cron).expression;
  const timezone = validateTimezone(raw.timezone);
  const createdAt = normalizeTimestamp(raw.createdAt) || nowIso();
  const enabled = raw.enabled !== false && trimString(raw.status) !== 'cancelled';
  return {
    id: /^sch_[a-f0-9]{24}$/.test(trimString(raw.id)) ? trimString(raw.id) : createScheduleId(),
    status: enabled ? 'active' : 'cancelled',
    enabled,
    executionMode,
    sessionId,
    sessionTemplate,
    title: trimString(raw.title),
    text,
    cron,
    timezone,
    misfirePolicy: 'latest_once',
    overlapPolicy: 'queue',
    maxOpenOccurrences: Math.max(1, Number.parseInt(raw.maxOpenOccurrences, 10) || DEFAULT_MAX_OPEN_OCCURRENCES),
    tool: trimString(raw.tool),
    model: trimString(raw.model),
    effort: trimString(raw.effort),
    thinking: raw.thinking === true,
    sourceDelivery: normalizeSourceDeliveryPlan(raw.sourceDelivery),
    nextRunAt: normalizeTimestamp(raw.nextRunAt),
    lastScheduledAt: normalizeTimestamp(raw.lastScheduledAt),
    missedCount: Math.max(0, Number.parseInt(raw.missedCount, 10) || 0),
    skippedCount: Math.max(0, Number.parseInt(raw.skippedCount, 10) || 0),
    lastError: trimString(raw.lastError),
    lastErrorAt: normalizeTimestamp(raw.lastErrorAt),
    createdAt,
    updatedAt: normalizeTimestamp(raw.updatedAt) || createdAt,
    cancelledAt: normalizeTimestamp(raw.cancelledAt),
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
    .filter((entry) => !sessionId || entry.sessionId === sessionId)
    .sort((left, right) => (Date.parse(left.nextRunAt) || Infinity) - (Date.parse(right.nextRunAt) || Infinity))
    .map(clone);
}

export async function getRecurringSchedule(scheduleId) {
  const id = trimString(scheduleId);
  const schedules = await loadSchedules();
  return clone(schedules.find((entry) => entry.id === id) || null);
}

export async function createRecurringSchedule(input = {}, options = {}) {
  const executionMode = normalizeExecutionMode(input.executionMode);
  const sessionId = trimString(input.sessionId);
  const text = trimString(input.text);
  const sessionTemplate = normalizeSessionTemplate(input.sessionTemplate, input.tool);
  if (executionMode === EXECUTION_MODE_EXISTING_SESSION && !sessionId) throw new Error('sessionId is required');
  if (executionMode === EXECUTION_MODE_FRESH_SESSION && !sessionTemplate) {
    throw new Error('sessionTemplate with folder and tool is required for fresh_session schedules');
  }
  if (!text) throw new Error('text is required');
  const cron = parseCronExpression(input.cron).expression;
  const timezone = validateTimezone(input.timezone);
  const createdAt = nowIso(options.now);
  const schedule = normalizeStoredSchedule({
    id: createScheduleId(),
    status: input.enabled === false ? 'cancelled' : 'active',
    enabled: input.enabled !== false,
    executionMode,
    sessionId,
    sessionTemplate,
    title: input.title,
    text,
    cron,
    timezone,
    tool: input.tool,
    model: input.model,
    effort: input.effort,
    thinking: input.thinking,
    sourceDelivery: input.sourceDelivery,
    maxOpenOccurrences: input.maxOpenOccurrences,
    nextRunAt: getNextCronOccurrence(cron, timezone, createdAt),
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
    const sessionId = Object.prototype.hasOwnProperty.call(patch, 'sessionId')
      ? trimString(patch.sessionId)
      : current.sessionId;
    const text = Object.prototype.hasOwnProperty.call(patch, 'text')
      ? trimString(patch.text)
      : current.text;
    const executionMode = Object.prototype.hasOwnProperty.call(patch, 'executionMode')
      ? normalizeExecutionMode(patch.executionMode)
      : current.executionMode;
    const sessionTemplate = Object.prototype.hasOwnProperty.call(patch, 'sessionTemplate')
      ? normalizeSessionTemplate(patch.sessionTemplate, patch.tool || current.tool)
      : current.sessionTemplate;
    if (executionMode === EXECUTION_MODE_EXISTING_SESSION && !sessionId) throw new Error('sessionId is required');
    if (executionMode === EXECUTION_MODE_FRESH_SESSION && !sessionTemplate) {
      throw new Error('sessionTemplate with folder and tool is required for fresh_session schedules');
    }
    if (sessionId !== current.sessionId) throw new Error('sessionId cannot be changed; create a new schedule instead');
    if (!text) throw new Error('text is required');
    if (Object.prototype.hasOwnProperty.call(patch, 'thinking') && typeof patch.thinking !== 'boolean') {
      throw new Error('thinking must be a boolean');
    }
    const enabled = Object.prototype.hasOwnProperty.call(patch, 'enabled')
      ? patch.enabled === true
      : current.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    const cron = Object.prototype.hasOwnProperty.call(patch, 'cron')
      ? parseCronExpression(patch.cron).expression
      : current.cron;
    const timezone = Object.prototype.hasOwnProperty.call(patch, 'timezone')
      ? validateTimezone(patch.timezone)
      : current.timezone;
    const next = normalizeStoredSchedule({
      ...current,
      ...patch,
      sessionId,
      executionMode,
      sessionTemplate,
      text,
      cron,
      timezone,
      enabled,
      status: enabled ? 'active' : 'cancelled',
      cancelledAt: enabled ? '' : updatedAt,
      nextRunAt: enabled && (!current.enabled || cron !== current.cron || timezone !== current.timezone)
        ? getNextCronOccurrence(cron, timezone, updatedAt)
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
  const due = [];
  let cursor = schedule.nextRunAt;
  for (let index = 0; index < 10000 && cursor && Date.parse(cursor) <= nowMs; index += 1) {
    due.push(cursor);
    cursor = getNextCronOccurrence(schedule.cron, schedule.timezone, cursor);
  }
  if (cursor && Date.parse(cursor) <= nowMs) {
    due[due.length - 1] = getLatestCronOccurrenceAtOrBefore(schedule.cron, schedule.timezone, nowMs);
    cursor = getNextCronOccurrence(schedule.cron, schedule.timezone, nowMs);
  }
  return { due, nextRunAt: cursor };
}

export async function materializeDueRecurringSchedulesNow(options = {}) {
  const now = nowIso(options.now);
  const nowMs = Date.parse(now);
  const createScheduledTrigger = options.createScheduledTrigger;
  const countOpenScheduleTriggers = options.countOpenScheduleTriggers || (async () => 0);
  if (typeof createScheduledTrigger !== 'function') throw new Error('createScheduledTrigger is required');
  let materialized = 0;
  let skipped = 0;
  let failed = 0;
  const candidates = (await listRecurringSchedules()).filter((entry) => (
    entry.enabled && entry.nextRunAt && Date.parse(entry.nextRunAt) <= nowMs
  ));
  for (const candidate of candidates) {
    try {
      await withScheduleMutation(async (schedules, save) => {
        const index = schedules.findIndex((entry) => entry.id === candidate.id);
        if (index === -1) return;
        const current = schedules[index];
        if (!current.enabled || !current.nextRunAt || Date.parse(current.nextRunAt) > nowMs) return;
        const occurrences = collectDueOccurrences(current, nowMs);
        if (occurrences.due.length === 0) return;
        const latestAt = occurrences.due.at(-1);
        const openCount = await countOpenScheduleTriggers(current.id);
        if (openCount >= current.maxOpenOccurrences) {
          current.skippedCount += 1;
          skipped += 1;
        } else {
          await createScheduledTrigger({
            executionMode: current.executionMode,
            sessionId: current.sessionId,
            sessionTemplate: current.sessionTemplate,
            title: current.title,
            text: current.text,
            scheduledAt: latestAt,
            tool: current.tool,
            model: current.model,
            effort: current.effort,
            thinking: current.thinking,
            scheduleId: current.id,
            occurrenceId: `${current.id}:${latestAt}`,
            sourceDelivery: current.sourceDelivery,
          });
          current.lastScheduledAt = latestAt;
          materialized += 1;
        }
        current.missedCount += Math.max(0, occurrences.due.length - 1);
        current.nextRunAt = occurrences.nextRunAt;
        current.lastError = '';
        current.lastErrorAt = '';
        current.updatedAt = now;
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
  const pollMs = Math.max(250, Number.parseInt(options.pollMs, 10) || DEFAULT_POLL_MS);
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

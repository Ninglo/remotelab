import { randomBytes } from 'crypto';

import { CHAT_TRIGGERS_FILE } from '../lib/config.mjs';
import { appendEvent } from './history.mjs';
import { statusEvent } from './normalizer.mjs';
import { createSerialTaskQueue, readJson, statOrNull, writeJsonAtomic } from './fs-utils.mjs';
import { getSession, getSessionSourceContext, submitHttpMessage } from './session-manager.mjs';
import { buildSourceDeliveryPlan, normalizeSourceDeliveryPlan } from './source-deliveries.mjs';
import { getRun, isTerminalRunState, requestRunCancel } from './runs.mjs';

const DEFAULT_TRIGGER_POLL_MS = 15000;
const MIN_TRIGGER_POLL_MS = 250;
const DELIVERY_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const TRIGGER_STATUS_PENDING = 'pending';
const TRIGGER_STATUS_DELIVERING = 'delivering';
const TRIGGER_STATUS_DELIVERED = 'delivered';
const TRIGGER_STATUS_FAILED = 'failed';
const TRIGGER_STATUS_CANCELLED = 'cancelled';
const TRIGGER_TYPE_AT_TIME = 'at_time';
const TRIGGER_ACTION_SESSION_MESSAGE = 'session_message';

let triggersCache = null;
let triggersCacheMtimeMs = 0;
let triggerSchedulerTimer = null;
let triggerTickPromise = null;

const triggerMutationQueue = createSerialTaskQueue();

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function validTriggerId(value) {
  return /^trg_[a-f0-9]{24}$/.test(trimString(value));
}

function createTriggerId() {
  return `trg_${randomBytes(12).toString('hex')}`;
}

function buildTriggerRequestId(triggerId) {
  return `trigger:${triggerId}`;
}

function normalizeTimestamp(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

function requireTimestamp(value, fieldName) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return normalized;
}

function normalizeTriggerStatus(value, fallback = TRIGGER_STATUS_PENDING) {
  const normalized = trimString(value).toLowerCase();
  if ([
    TRIGGER_STATUS_PENDING,
    TRIGGER_STATUS_DELIVERING,
    TRIGGER_STATUS_DELIVERED,
    TRIGGER_STATUS_FAILED,
    TRIGGER_STATUS_CANCELLED,
  ].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTriggerPollMs(value = process.env.REMOTELAB_TRIGGER_POLL_MS) {
  return Math.max(MIN_TRIGGER_POLL_MS, parsePositiveInteger(value, DEFAULT_TRIGGER_POLL_MS));
}

function normalizeStoredTrigger(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const scheduledAt = normalizeTimestamp(raw.scheduledAt);
  const sessionId = trimString(raw.sessionId);
  const text = trimString(raw.text);
  if (!scheduledAt || !sessionId || !text) {
    return null;
  }

  const status = normalizeTriggerStatus(raw.status, TRIGGER_STATUS_PENDING);
  const enabled = normalizeBoolean(
    raw.enabled,
    status !== TRIGGER_STATUS_DELIVERED && status !== TRIGGER_STATUS_CANCELLED,
  );
  const createdAt = normalizeTimestamp(raw.createdAt) || nowIso();
  const updatedAt = normalizeTimestamp(raw.updatedAt) || createdAt;
  const id = validTriggerId(raw.id) ? raw.id : createTriggerId();
  const requestId = trimString(raw.requestId) || buildTriggerRequestId(id);

  return {
    id,
    triggerType: TRIGGER_TYPE_AT_TIME,
    actionType: TRIGGER_ACTION_SESSION_MESSAGE,
    status,
    enabled,
    title: trimString(raw.title),
    sessionId,
    scheduledAt,
    text,
    tool: trimString(raw.tool),
    model: trimString(raw.model),
    effort: trimString(raw.effort),
    thinking: normalizeBoolean(raw.thinking, false),
    requestId,
    createdAt,
    updatedAt,
    claimedAt: normalizeTimestamp(raw.claimedAt),
    lastAttemptAt: normalizeTimestamp(raw.lastAttemptAt),
    nextAttemptAt: normalizeTimestamp(raw.nextAttemptAt),
    deliveredAt: normalizeTimestamp(raw.deliveredAt),
    lastErrorAt: normalizeTimestamp(raw.lastErrorAt),
    lastError: trimString(raw.lastError),
    deliveryAttempts: Math.max(0, parsePositiveInteger(raw.deliveryAttempts, 0)),
    runId: trimString(raw.runId),
    deliveryMode: trimString(raw.deliveryMode),
    scheduleId: trimString(raw.scheduleId),
    occurrenceId: trimString(raw.occurrenceId),
    sourceDelivery: normalizeSourceDeliveryPlan(raw.sourceDelivery),
  };
}

function normalizeStoredTriggers(entries) {
  const list = [];
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeStoredTrigger(entry);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (JSON.stringify(normalized) !== JSON.stringify(entry)) {
      changed = true;
    }
    list.push(normalized);
  }
  return { list, changed };
}

async function saveTriggersUnlocked(triggers) {
  triggersCache = Array.isArray(triggers) ? triggers : [];
  await writeJsonAtomic(CHAT_TRIGGERS_FILE, triggersCache);
  const stats = await statOrNull(CHAT_TRIGGERS_FILE);
  triggersCacheMtimeMs = stats?.mtimeMs || Date.now();
}

async function loadTriggers() {
  const stats = await statOrNull(CHAT_TRIGGERS_FILE);
  const mtimeMs = stats?.mtimeMs || 0;
  if (triggersCache && triggersCacheMtimeMs === mtimeMs) {
    return triggersCache;
  }

  const parsed = await readJson(CHAT_TRIGGERS_FILE, []);
  const normalized = normalizeStoredTriggers(parsed);
  triggersCache = normalized.list;
  if (normalized.changed) {
    await saveTriggersUnlocked(triggersCache);
  } else {
    triggersCacheMtimeMs = mtimeMs;
  }
  return triggersCache;
}

async function withTriggerMutation(mutator) {
  return triggerMutationQueue(async () => {
    const triggers = await loadTriggers();
    return mutator(triggers, saveTriggersUnlocked);
  });
}

function cloneTrigger(trigger) {
  return trigger ? JSON.parse(JSON.stringify(trigger)) : null;
}

function sortTriggers(triggers) {
  return [...(Array.isArray(triggers) ? triggers : [])].sort((left, right) => {
    const leftState = left?.status === TRIGGER_STATUS_PENDING ? 0 : 1;
    const rightState = right?.status === TRIGGER_STATUS_PENDING ? 0 : 1;
    if (leftState !== rightState) return leftState - rightState;
    const leftTime = Date.parse(left?.scheduledAt || left?.updatedAt || left?.createdAt || 0) || 0;
    const rightTime = Date.parse(right?.scheduledAt || right?.updatedAt || right?.createdAt || 0) || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

function isClaimStale(trigger, nowMs = Date.now()) {
  if (trigger?.status !== TRIGGER_STATUS_DELIVERING) return false;
  const claimedAtMs = Date.parse(trigger?.claimedAt || '');
  if (!Number.isFinite(claimedAtMs)) return true;
  return (nowMs - claimedAtMs) >= DELIVERY_CLAIM_TIMEOUT_MS;
}

function isDueTrigger(trigger, nowMs = Date.now()) {
  if (!trigger?.enabled) return false;
  if (trigger?.triggerType !== TRIGGER_TYPE_AT_TIME) return false;
  if (trigger?.actionType !== TRIGGER_ACTION_SESSION_MESSAGE) return false;
  if (![TRIGGER_STATUS_PENDING, TRIGGER_STATUS_DELIVERING].includes(trigger?.status)) return false;
  if (trigger?.status === TRIGGER_STATUS_DELIVERING && !isClaimStale(trigger, nowMs)) return false;
  const scheduledAtMs = Date.parse(trigger?.scheduledAt || '');
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs > nowMs) return false;
  const nextAttemptAtMs = Date.parse(trigger?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > nowMs) return false;
  return true;
}

function isTriggerTerminal(trigger) {
  return [TRIGGER_STATUS_DELIVERED, TRIGGER_STATUS_FAILED, TRIGGER_STATUS_CANCELLED].includes(trigger?.status);
}

function buildTriggerStatusText(trigger, { queued = false } = {}) {
  const prefix = queued ? 'scheduled trigger queued' : 'scheduled trigger fired';
  const title = trimString(trigger?.title);
  return title ? `${prefix}: ${title}` : `${prefix}: ${trigger?.id || 'unknown trigger'}`;
}

function resolveRetryDelayMs(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attempts - 1));
  return RETRY_DELAYS_MS[index] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

function isPermanentTriggerError(error) {
  return error?.code === 'SESSION_NOT_FOUND' || error?.code === 'SESSION_ARCHIVED';
}

async function assertWritableTargetSession(sessionId) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) {
    throw new Error('sessionId is required');
  }
  const session = await getSession(normalizedSessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  if (session.archived) {
    const error = new Error('Session is archived');
    error.code = 'SESSION_ARCHIVED';
    throw error;
  }
  return session;
}

function resetTriggerDeliveryState(trigger) {
  delete trigger.claimedAt;
  delete trigger.deliveredAt;
  delete trigger.lastError;
  delete trigger.lastErrorAt;
  delete trigger.nextAttemptAt;
  delete trigger.runId;
  delete trigger.deliveryMode;
  trigger.deliveryAttempts = 0;
}

export async function listTriggers(options = {}) {
  const triggers = await loadTriggers();
  const normalizedSessionId = trimString(options.sessionId);
  const filtered = normalizedSessionId
    ? triggers.filter((trigger) => trigger.sessionId === normalizedSessionId)
    : triggers;
  return sortTriggers(filtered).map(cloneTrigger);
}

export async function getTrigger(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const triggers = await loadTriggers();
  return cloneTrigger(triggers.find((trigger) => trigger.id === normalizedTriggerId) || null);
}

export async function createTrigger(input = {}) {
  const session = await assertWritableTargetSession(input.sessionId);
  const scheduledAt = requireTimestamp(input.scheduledAt, 'scheduledAt');
  const text = trimString(input.text);
  if (!text) {
    throw new Error('text is required');
  }

  const id = createTriggerId();
  const createdAt = nowIso();
  const enabled = normalizeBoolean(input.enabled, true);
  let sourceDelivery = normalizeSourceDeliveryPlan(input.sourceDelivery);
  if (!sourceDelivery && trimString(input.deliverTo).toLowerCase() === 'session_source') {
    const sourceContext = await getSessionSourceContext(session.id, {
      requestId: trimString(input.sourceRequestId),
    });
    sourceDelivery = buildSourceDeliveryPlan(sourceContext);
  }
  const trigger = {
    id,
    triggerType: TRIGGER_TYPE_AT_TIME,
    actionType: TRIGGER_ACTION_SESSION_MESSAGE,
    status: enabled ? TRIGGER_STATUS_PENDING : TRIGGER_STATUS_CANCELLED,
    enabled,
    title: trimString(input.title),
    sessionId: session.id,
    scheduledAt,
    text,
    tool: trimString(input.tool),
    model: trimString(input.model),
    effort: trimString(input.effort),
    thinking: input.thinking === true,
    requestId: buildTriggerRequestId(id),
    createdAt,
    updatedAt: createdAt,
    deliveryAttempts: 0,
    scheduleId: trimString(input.scheduleId),
    occurrenceId: trimString(input.occurrenceId),
    sourceDelivery,
  };

  let createdTrigger = trigger;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    if (trigger.occurrenceId) {
      const existing = triggers.find((entry) => entry.occurrenceId === trigger.occurrenceId);
      if (existing) {
        createdTrigger = existing;
        return;
      }
    }
    triggers.push(trigger);
    await saveTriggers(triggers);
  });
  return cloneTrigger(createdTrigger);
}

export async function createScheduledTrigger(input = {}) {
  return createTrigger(input);
}

export async function countOpenScheduleTriggers(scheduleId) {
  const normalizedScheduleId = trimString(scheduleId);
  if (!normalizedScheduleId) return 0;
  const triggers = await loadTriggers();
  return triggers.filter((trigger) => (
    trigger.scheduleId === normalizedScheduleId
    && !isTriggerTerminal(trigger)
  )).length;
}

export async function cancelScheduleTriggers(scheduleId, options = {}) {
  const normalizedScheduleId = trimString(scheduleId);
  if (!normalizedScheduleId) return { cancelledPending: 0, cancelledActive: 0 };
  let cancelledPending = 0;
  let activeRunIds = [];
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const updatedAt = nowIso();
    activeRunIds = triggers
      .filter((trigger) => trigger.scheduleId === normalizedScheduleId && trimString(trigger.runId))
      .map((trigger) => trigger.runId);
    for (const trigger of triggers) {
      if (trigger.scheduleId !== normalizedScheduleId) continue;
      if (![TRIGGER_STATUS_PENDING, TRIGGER_STATUS_DELIVERING].includes(trigger.status)) continue;
      trigger.status = TRIGGER_STATUS_CANCELLED;
      trigger.enabled = false;
      trigger.claimedAt = '';
      trigger.nextAttemptAt = '';
      trigger.updatedAt = updatedAt;
      cancelledPending += 1;
    }
    if (cancelledPending > 0) await saveTriggers(triggers);
  });

  let cancelledActive = 0;
  if (options.includeActive === true) {
    for (const runId of new Set(activeRunIds)) {
      const run = await getRun(runId);
      if (!run || isTerminalRunState(run.state)) continue;
      if (await requestRunCancel(runId)) cancelledActive += 1;
    }
  }
  return { cancelledPending, cancelledActive };
}

export async function updateTrigger(triggerId, patch = {}) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;

  const nextSessionId = Object.prototype.hasOwnProperty.call(patch, 'sessionId')
    ? trimString(patch.sessionId)
    : '';
  if (nextSessionId) {
    await assertWritableTargetSession(nextSessionId);
  }

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) {
      updatedTrigger = null;
      return;
    }

    const current = triggers[index];
    if (current.status === TRIGGER_STATUS_DELIVERING && !isClaimStale(current)) {
      throw new Error('Trigger is currently delivering');
    }

    const affectsDelivery = [
      'scheduledAt',
      'text',
      'tool',
      'model',
      'effort',
      'thinking',
      'sessionId',
      'enabled',
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));

    if (current.status === TRIGGER_STATUS_DELIVERED && affectsDelivery) {
      throw new Error('Delivered triggers cannot be modified; create a new trigger instead');
    }

    const next = { ...current };
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      const title = trimString(patch.title);
      if (title !== current.title) {
        next.title = title;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'sessionId')) {
      const sessionId = nextSessionId;
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (sessionId !== current.sessionId) {
        next.sessionId = sessionId;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'scheduledAt')) {
      const scheduledAt = requireTimestamp(patch.scheduledAt, 'scheduledAt');
      if (scheduledAt !== current.scheduledAt) {
        next.scheduledAt = scheduledAt;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
      const text = trimString(patch.text);
      if (!text) {
        throw new Error('text is required');
      }
      if (text !== current.text) {
        next.text = text;
        changed = true;
      }
    }

    for (const field of ['tool', 'model', 'effort']) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      const value = trimString(patch[field]);
      if (value !== current[field]) {
        next[field] = value;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'thinking')) {
      if (typeof patch.thinking !== 'boolean') {
        throw new Error('thinking must be a boolean');
      }
      if (patch.thinking !== current.thinking) {
        next.thinking = patch.thinking;
        changed = true;
      }
    }

    let nextEnabled = current.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        throw new Error('enabled must be a boolean');
      }
      nextEnabled = patch.enabled;
      if (nextEnabled !== current.enabled) {
        next.enabled = nextEnabled;
        changed = true;
      }
    }

    if (!changed) {
      updatedTrigger = cloneTrigger(current);
      return;
    }

    if (affectsDelivery) {
      if (!nextEnabled) {
        next.status = TRIGGER_STATUS_CANCELLED;
      } else if (current.status === TRIGGER_STATUS_FAILED || current.status === TRIGGER_STATUS_CANCELLED || current.status === TRIGGER_STATUS_DELIVERING) {
        next.status = TRIGGER_STATUS_PENDING;
      }
      if (!isTriggerTerminal(current) || next.status === TRIGGER_STATUS_PENDING || next.status === TRIGGER_STATUS_CANCELLED) {
        resetTriggerDeliveryState(next);
      }
    }

    next.updatedAt = nowIso();
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

export async function deleteTrigger(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;

  let deletedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) {
      deletedTrigger = null;
      return;
    }
    deletedTrigger = cloneTrigger(triggers[index]);
    triggers.splice(index, 1);
    await saveTriggers(triggers);
  });

  return deletedTrigger;
}

async function claimTriggerForDelivery(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const claimAt = nowIso();
  const claimAtMs = Date.parse(claimAt);

  let claimedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    if (!isDueTrigger(current, claimAtMs)) return;
    const next = {
      ...current,
      status: TRIGGER_STATUS_DELIVERING,
      claimedAt: claimAt,
      lastAttemptAt: claimAt,
      nextAttemptAt: '',
      deliveryAttempts: Math.max(0, Number(current.deliveryAttempts) || 0) + 1,
      updatedAt: claimAt,
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    claimedTrigger = cloneTrigger(next);
  });

  return claimedTrigger;
}

async function markTriggerDelivered(triggerId, deliveryResult) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const deliveredAt = nowIso();

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    const next = {
      ...current,
      status: TRIGGER_STATUS_DELIVERED,
      enabled: false,
      deliveredAt,
      updatedAt: deliveredAt,
      claimedAt: '',
      nextAttemptAt: '',
      lastError: '',
      lastErrorAt: '',
      runId: trimString(deliveryResult?.runId),
      deliveryMode: deliveryResult?.queued ? 'queued' : 'run',
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

async function markTriggerDeliveryFailure(triggerId, error, attemptCount = 1) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const failedAt = nowIso();
  const exhausted = isPermanentTriggerError(error) || attemptCount >= MAX_DELIVERY_ATTEMPTS;
  const retryDelayMs = resolveRetryDelayMs(attemptCount);

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    const next = {
      ...current,
      status: exhausted ? TRIGGER_STATUS_FAILED : TRIGGER_STATUS_PENDING,
      enabled: exhausted ? false : current.enabled,
      claimedAt: '',
      updatedAt: failedAt,
      lastError: trimString(error?.message) || 'Trigger delivery failed',
      lastErrorAt: failedAt,
      nextAttemptAt: exhausted ? '' : new Date(Date.now() + retryDelayMs).toISOString(),
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

async function releaseTriggerForBusy(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const releasedAt = nowIso();
  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    const next = {
      ...current,
      status: TRIGGER_STATUS_PENDING,
      claimedAt: '',
      lastAttemptAt: '',
      nextAttemptAt: new Date(Date.now() + 1000).toISOString(),
      deliveryAttempts: Math.max(0, Number(current.deliveryAttempts) || 0) - 1,
      deliveryMode: 'waiting_for_session',
      updatedAt: releasedAt,
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });
  return updatedTrigger;
}

async function appendTriggerStatusEvent(trigger, outcome) {
  try {
    const event = statusEvent(buildTriggerStatusText(trigger, { queued: outcome?.queued === true }));
    event.requestId = trigger.requestId;
    if (trimString(outcome?.runId)) {
      event.runId = trimString(outcome.runId);
    }
    await appendEvent(trigger.sessionId, event);
  } catch (error) {
    console.error(`[triggers] failed to append status event for ${trigger.id}: ${error.message}`);
  }
}

async function deliverTrigger(trigger) {
  const session = await assertWritableTargetSession(trigger.sessionId);
  const outcome = await submitHttpMessage(session.id, trigger.text, [], {
    requestId: trigger.requestId,
    tool: trigger.tool || undefined,
    model: trigger.model || undefined,
    effort: trigger.effort || undefined,
    thinking: trigger.thinking === true,
    internalOperation: 'trigger_delivery',
    queueIfBusy: false,
    requireIdle: true,
    skipDispatch: true,
    sourceDelivery: trigger.sourceDelivery || undefined,
    triggerId: trigger.id,
    scheduleId: trigger.scheduleId || undefined,
    occurrenceId: trigger.occurrenceId || undefined,
  });

  if (!outcome.duplicate) {
    await appendTriggerStatusEvent(trigger, {
      queued: outcome.queued === true,
      runId: trimString(outcome?.run?.id),
    });
  }

  await markTriggerDelivered(trigger.id, {
    queued: outcome.queued === true,
    runId: trimString(outcome?.run?.id),
  });
}

async function attemptTriggerDelivery(triggerId) {
  const trigger = await claimTriggerForDelivery(triggerId);
  if (!trigger) return null;

  try {
    await deliverTrigger(trigger);
    return await getTrigger(trigger.id);
  } catch (error) {
    if (error?.code === 'SESSION_BUSY') {
      await releaseTriggerForBusy(trigger.id);
      return await getTrigger(trigger.id);
    }
    await markTriggerDeliveryFailure(trigger.id, error, trigger.deliveryAttempts || 1);
    console.error(`[triggers] failed to deliver ${trigger.id}: ${error.message}`);
    return await getTrigger(trigger.id);
  }
}

export async function processDueTriggersNow() {
  if (triggerTickPromise) return triggerTickPromise;

  triggerTickPromise = (async () => {
    const nowMs = Date.now();
    const triggers = await loadTriggers();
    const due = sortTriggers(triggers).filter((trigger) => isDueTrigger(trigger, nowMs));
    for (const trigger of due) {
      await attemptTriggerDelivery(trigger.id);
    }
    return due.length;
  })().finally(() => {
    if (triggerTickPromise) {
      triggerTickPromise = null;
    }
  });

  return triggerTickPromise;
}

export function startTriggerScheduler(options = {}) {
  if (triggerSchedulerTimer) return triggerSchedulerTimer;
  const pollMs = resolveTriggerPollMs(options.pollMs);
  triggerSchedulerTimer = setInterval(() => {
    void processDueTriggersNow();
  }, pollMs);
  if (typeof triggerSchedulerTimer.unref === 'function') {
    triggerSchedulerTimer.unref();
  }
  void processDueTriggersNow();
  return triggerSchedulerTimer;
}

export function stopTriggerScheduler() {
  if (!triggerSchedulerTimer) return false;
  clearInterval(triggerSchedulerTimer);
  triggerSchedulerTimer = null;
  return true;
}

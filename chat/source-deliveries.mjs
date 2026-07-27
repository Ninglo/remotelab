import { randomBytes } from 'crypto';

import { CHAT_SOURCE_DELIVERIES_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, readJson, statOrNull, writeJsonAtomic } from './fs-utils.mjs';

const DELIVERY_STATES = new Set(['pending', 'sending', 'delivered', 'delivery_failed', 'cancelled']);
const DEFAULT_LEASE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 30000, 2 * 60 * 1000, 10 * 60 * 1000];

let deliveriesCache = null;
let deliveriesCacheMtimeMs = 0;
const deliveryMutationQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function normalizeSourceRouteId(value) {
  const normalized = trimString(value);
  return !normalized || normalized === 'unknown' ? 'default' : normalized;
}

function nowIso(value = Date.now()) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function createId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function normalizeTarget(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const target = {};
  for (const field of [
    'chatId',
    'chatType',
    'conversationKind',
    'messageId',
    'topicId',
    'threadId',
    'rootId',
    'parentId',
    'groupMessageType',
    'chatMode',
  ]) {
    const normalized = trimString(raw[field]);
    if (normalized) target[field] = normalized;
  }
  if (!target.messageId && (target.topicId || target.threadId || target.rootId)) {
    target.messageId = target.rootId || target.topicId || target.threadId;
  }
  return target;
}

export function normalizeSourceDeliveryPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const connector = trimString(value.connector).toLowerCase();
  if (connector !== 'feishu') return null;
  const target = normalizeTarget(value.target);
  if (!target.chatId) return null;
  return {
    connector,
    sourceRouteId: normalizeSourceRouteId(value.sourceRouteId),
    target,
  };
}

export function buildSourceDeliveryPlan(sourceContext) {
  if (!sourceContext || typeof sourceContext !== 'object' || Array.isArray(sourceContext)) return null;
  const session = sourceContext.session && typeof sourceContext.session === 'object'
    ? sourceContext.session
    : {};
  const message = sourceContext.message && typeof sourceContext.message === 'object'
    ? sourceContext.message
    : {};
  const connector = trimString(message.connector || session.connector).toLowerCase();
  if (connector !== 'feishu') return null;
  const target = normalizeTarget({ ...session, ...message });
  if (!target.chatId) return null;
  return {
    connector,
    sourceRouteId: normalizeSourceRouteId(message.sourceRouteId || session.sourceRouteId),
    target,
  };
}

function normalizeStoredDelivery(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceDelivery = normalizeSourceDeliveryPlan({
    connector: raw.connector,
    sourceRouteId: raw.sourceRouteId,
    target: raw.target,
  });
  const responseId = trimString(raw.responseId);
  const text = trimString(raw.text);
  if (!sourceDelivery || !responseId || !text) return null;
  const state = DELIVERY_STATES.has(trimString(raw.state)) ? trimString(raw.state) : 'pending';
  const createdAt = normalizeTimestamp(raw.createdAt) || nowIso();
  return {
    id: /^srcd_[a-f0-9]{24}$/.test(trimString(raw.id)) ? trimString(raw.id) : createId('srcd'),
    responseId,
    runId: trimString(raw.runId),
    sessionId: trimString(raw.sessionId),
    triggerId: trimString(raw.triggerId),
    scheduleId: trimString(raw.scheduleId),
    occurrenceId: trimString(raw.occurrenceId),
    connector: sourceDelivery.connector,
    sourceRouteId: sourceDelivery.sourceRouteId,
    target: sourceDelivery.target,
    kind: trimString(raw.kind) || 'content',
    text,
    state,
    attempts: Math.max(0, Number.parseInt(raw.attempts, 10) || 0),
    availableAt: normalizeTimestamp(raw.availableAt) || createdAt,
    claimedAt: normalizeTimestamp(raw.claimedAt),
    leaseId: trimString(raw.leaseId),
    deliveredAt: normalizeTimestamp(raw.deliveredAt),
    externalId: trimString(raw.externalId),
    lastError: trimString(raw.lastError),
    lastErrorAt: normalizeTimestamp(raw.lastErrorAt),
    createdAt,
    updatedAt: normalizeTimestamp(raw.updatedAt) || createdAt,
  };
}

async function saveDeliveriesUnlocked(deliveries) {
  deliveriesCache = Array.isArray(deliveries) ? deliveries : [];
  await writeJsonAtomic(CHAT_SOURCE_DELIVERIES_FILE, deliveriesCache);
  const stat = await statOrNull(CHAT_SOURCE_DELIVERIES_FILE);
  deliveriesCacheMtimeMs = stat?.mtimeMs || Date.now();
}

async function loadDeliveries() {
  const stat = await statOrNull(CHAT_SOURCE_DELIVERIES_FILE);
  const mtimeMs = stat?.mtimeMs || 0;
  if (deliveriesCache && deliveriesCacheMtimeMs === mtimeMs) return deliveriesCache;
  const raw = await readJson(CHAT_SOURCE_DELIVERIES_FILE, []);
  const deliveries = [];
  let changed = !Array.isArray(raw);
  for (const entry of Array.isArray(raw) ? raw : []) {
    const normalized = normalizeStoredDelivery(entry);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (JSON.stringify(normalized) !== JSON.stringify(entry)) changed = true;
    deliveries.push(normalized);
  }
  deliveriesCache = deliveries;
  if (changed) await saveDeliveriesUnlocked(deliveries);
  else deliveriesCacheMtimeMs = mtimeMs;
  return deliveriesCache;
}

async function withDeliveryMutation(mutator) {
  return deliveryMutationQueue(async () => {
    const deliveries = await loadDeliveries();
    return mutator(deliveries, saveDeliveriesUnlocked);
  });
}

export async function listSourceDeliveries(options = {}) {
  const connector = trimString(options.connector).toLowerCase();
  const sourceRouteId = trimString(options.sourceRouteId);
  const state = trimString(options.state);
  const sessionId = trimString(options.sessionId);
  const deliveries = await loadDeliveries();
  return deliveries
    .filter((entry) => !connector || entry.connector === connector)
    .filter((entry) => !sourceRouteId || entry.sourceRouteId === sourceRouteId)
    .filter((entry) => !state || entry.state === state)
    .filter((entry) => !sessionId || entry.sessionId === sessionId)
    .map(clone);
}

export async function getSourceDelivery(deliveryId) {
  const id = trimString(deliveryId);
  if (!id) return null;
  const deliveries = await loadDeliveries();
  return clone(deliveries.find((entry) => entry.id === id) || null);
}

export async function enqueueSourceDelivery(input = {}) {
  const sourceDelivery = normalizeSourceDeliveryPlan(input.sourceDelivery);
  const responseId = trimString(input.responseId);
  const text = trimString(input.text);
  if (!sourceDelivery) throw new Error('Valid sourceDelivery is required');
  if (!responseId) throw new Error('responseId is required');
  if (!text) throw new Error('text is required');
  let result = null;
  await withDeliveryMutation(async (deliveries, save) => {
    const existing = deliveries.find((entry) => (
      entry.responseId === responseId
      && entry.connector === sourceDelivery.connector
      && entry.sourceRouteId === sourceDelivery.sourceRouteId
      && JSON.stringify(entry.target) === JSON.stringify(sourceDelivery.target)
    ));
    if (existing) {
      result = clone(existing);
      return;
    }
    const createdAt = nowIso(input.now);
    const delivery = normalizeStoredDelivery({
      id: createId('srcd'),
      responseId,
      runId: input.runId,
      sessionId: input.sessionId,
      triggerId: input.triggerId,
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      connector: sourceDelivery.connector,
      sourceRouteId: sourceDelivery.sourceRouteId,
      target: sourceDelivery.target,
      kind: input.kind,
      text,
      state: 'pending',
      attempts: 0,
      availableAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    deliveries.push(delivery);
    await save(deliveries);
    result = clone(delivery);
  });
  return result;
}

function sendingLeaseExpired(entry, nowMs, leaseTimeoutMs) {
  if (entry.state !== 'sending') return false;
  const claimedAtMs = Date.parse(entry.claimedAt || '');
  return !Number.isFinite(claimedAtMs) || nowMs - claimedAtMs >= leaseTimeoutMs;
}

export async function claimSourceDelivery(options = {}) {
  const connector = trimString(options.connector).toLowerCase();
  const sourceRouteId = trimString(options.sourceRouteId) || 'default';
  if (!connector) throw new Error('connector is required');
  const claimedAt = nowIso(options.now);
  const nowMs = Date.parse(claimedAt);
  const leaseTimeoutMs = Number.isFinite(Number(options.leaseTimeoutMs))
    ? Math.max(1, Number(options.leaseTimeoutMs))
    : DEFAULT_LEASE_TIMEOUT_MS;
  let result = null;
  await withDeliveryMutation(async (deliveries, save) => {
    const due = deliveries
      .filter((entry) => entry.connector === connector && entry.sourceRouteId === sourceRouteId)
      .filter((entry) => entry.state === 'pending' || sendingLeaseExpired(entry, nowMs, leaseTimeoutMs))
      .filter((entry) => (Date.parse(entry.availableAt || '') || 0) <= nowMs)
      .sort((left, right) => (Date.parse(left.availableAt) || 0) - (Date.parse(right.availableAt) || 0))[0];
    if (!due) return;
    const leaseId = createId('lease');
    due.state = 'sending';
    due.claimedAt = claimedAt;
    due.leaseId = leaseId;
    due.updatedAt = claimedAt;
    await save(deliveries);
    result = { delivery: clone(due), leaseId };
  });
  return result;
}

export async function completeSourceDelivery(deliveryId, leaseId, input = {}) {
  const id = trimString(deliveryId);
  const lease = trimString(leaseId);
  let result = null;
  await withDeliveryMutation(async (deliveries, save) => {
    const entry = deliveries.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (entry.state === 'delivered') {
      result = clone(entry);
      return;
    }
    if (entry.state !== 'sending' || entry.leaseId !== lease) {
      throw new Error('Source delivery lease mismatch');
    }
    const deliveredAt = nowIso(input.now);
    entry.state = 'delivered';
    entry.deliveredAt = deliveredAt;
    entry.externalId = trimString(input.externalId);
    entry.claimedAt = '';
    entry.leaseId = '';
    entry.lastError = '';
    entry.lastErrorAt = '';
    entry.updatedAt = deliveredAt;
    await save(deliveries);
    result = clone(entry);
  });
  return result;
}

export async function failSourceDelivery(deliveryId, leaseId, error, options = {}) {
  const id = trimString(deliveryId);
  const lease = trimString(leaseId);
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  let result = null;
  await withDeliveryMutation(async (deliveries, save) => {
    const entry = deliveries.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (entry.state !== 'sending' || entry.leaseId !== lease) {
      throw new Error('Source delivery lease mismatch');
    }
    const failedAt = nowIso(options.now);
    const attempts = entry.attempts + 1;
    const exhausted = attempts >= maxAttempts;
    const configuredDelay = Number(options.retryDelayMs);
    const retryDelayMs = Number.isFinite(configuredDelay)
      ? Math.max(0, configuredDelay)
      : DEFAULT_RETRY_DELAYS_MS[Math.min(attempts - 1, DEFAULT_RETRY_DELAYS_MS.length - 1)];
    entry.state = exhausted ? 'delivery_failed' : 'pending';
    entry.attempts = attempts;
    entry.availableAt = exhausted ? '' : new Date(Date.parse(failedAt) + retryDelayMs).toISOString();
    entry.claimedAt = '';
    entry.leaseId = '';
    entry.lastError = trimString(error?.message || error) || 'Source delivery failed';
    entry.lastErrorAt = failedAt;
    entry.updatedAt = failedAt;
    await save(deliveries);
    result = clone(entry);
  });
  return result;
}

export async function cancelSourceDeliveriesForSchedule(scheduleId) {
  const normalizedScheduleId = trimString(scheduleId);
  if (!normalizedScheduleId) return 0;
  let cancelled = 0;
  await withDeliveryMutation(async (deliveries, save) => {
    const updatedAt = nowIso();
    for (const entry of deliveries) {
      if (entry.scheduleId !== normalizedScheduleId || !['pending', 'sending'].includes(entry.state)) continue;
      entry.state = 'cancelled';
      entry.claimedAt = '';
      entry.leaseId = '';
      entry.updatedAt = updatedAt;
      cancelled += 1;
    }
    if (cancelled > 0) await save(deliveries);
  });
  return cancelled;
}

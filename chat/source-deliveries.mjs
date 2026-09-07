import { randomBytes } from 'node:crypto';
import { requests, requestKey } from './requests.mjs';
import { serialQueue } from '../lib/durable-records.mjs';
const queue = serialQueue();
const trimString = value => typeof value === 'string' ? value.trim() : '';
const terminal = state => ['delivered', 'delivery_failed', 'cancelled'].includes(state);
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
    'chatMode', 'eventType', 'fileType', 'fileToken', 'commentId', 'replyId', 'sourceKind', 'messageType',
  ]) {
    const normalized = trimString(raw[field]);
    if (normalized) target[field] = normalized;
  }
  if (raw.replyInThread === true) target.replyInThread = true;
  if (raw.forkCommand === true) target.forkCommand = true;
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
  if (!target.chatId && !target.commentId) return null;
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
  if (!target.chatId && !target.commentId) return null;
  return {
    connector,
    sourceRouteId: normalizeSourceRouteId(message.sourceRouteId || session.sourceRouteId),
    target,
  };
}


export function buildReplyDeliveries(plan, payload) {
  if (!plan) return [];
  const parts = [];
  if (payload.text) parts.push({ ...plan, kind: 'content', text: payload.text });
  for (const attachment of payload.attachments || []) parts.push({ ...plan, kind: 'attachment', text: '', attachment });
  return parts;
}

export async function listSourceDeliveries(options = {}) {
  const deliveries = (await requests.active()).flatMap(record => record.deliveries);
  return deliveries.filter(entry => ['connector', 'sourceRouteId', 'state', 'sessionId'].every(field => !options[field] || entry[field] === options[field]));
}

function parseId(id) {
  const match = /^srcd_([a-f0-9]{24})_(\d+)$/.exec(id || '');
  if (!match) throw new Error('Invalid delivery id');
  return { key: match[1], index: Number(match[2]) };
}

export async function getSourceDelivery(id) {
  const { key, index } = parseId(id);
  return (await requests.get(key))?.deliveries[index] || null;
}

export async function enqueueSourceDelivery(input = {}) {
  const plan = normalizeSourceDeliveryPlan(input.sourceDelivery);
  if (!plan || !input.responseId || (!input.text && !input.attachments?.length)) throw new Error('Delivery requires target, responseId and content');
  const sessionId = input.sessionId || 'outbound';
  const requestId = `outbound:${input.responseId}:${requestKey(plan.sourceRouteId, JSON.stringify(plan.target))}`;
  // This producer has no AI execution; it uses the same committed outbox aggregate.
  const { record } = await requests.accept({ sessionId, requestId, text: input.text || '[attachment]',
    options: { deliveryOnly: true, responseId: input.responseId },
    result: { state: 'completed', payload: { text: input.text || '', attachments: input.attachments || [] } },
    plans: buildReplyDeliveries(plan, { text: input.text, attachments: input.attachments }).map(part => ({ ...part, triggerId: input.triggerId || '', scheduleId: input.scheduleId || '', occurrenceId: input.occurrenceId || '' })),
  });
  return record.deliveries[0];
}

const targetKey = entry => JSON.stringify([entry.connector, entry.sourceRouteId, entry.target.chatId || entry.target.fileToken, entry.target.topicId || entry.target.threadId || entry.target.commentId || '']);

async function mutateDelivery(id, update) {
  const { key, index } = parseId(id);
  const record = await requests.mutate(key, current => {
    if (!current?.deliveries[index]) throw new Error('Delivery not found');
    const deliveries = current.deliveries.slice();
    deliveries[index] = update({ ...deliveries[index] });
    return { ...current, deliveries };
  });
  await requests.archiveFinished(key);
  return record.deliveries[index];
}

export async function claimSourceDelivery(options = {}) {
  return queue(async () => {
    const now = nowIso(options.now);
    const timeout = options.leaseTimeoutMs || 120_000;
    const entries = await listSourceDeliveries({ connector: options.connector, sourceRouteId: options.sourceRouteId || 'default' });
    const blocked = new Set();
    for (let entry of entries) {
      if (terminal(entry.state)) continue;
      const key = targetKey(entry);
      if (entry.state === 'sending' && Date.parse(now) - Date.parse(entry.claimedAt) >= timeout) {
        entry = await mutateDelivery(entry.id, current => ({ ...current, state: 'unknown', lastError: 'Sender lease expired without a receipt' }));
      }
      if (blocked.has(key)) continue;
      blocked.add(key);
      if (entry.state !== 'pending' || Date.parse(entry.availableAt) > Date.parse(now)) continue;
      const leaseId = createId('lease');
      const delivery = await mutateDelivery(entry.id, current => ({ ...current, state: 'sending', leaseId, claimedAt: now, attempts: current.attempts + 1 }));
      return { delivery, leaseId };
    }
    return null;
  });
}

function requireLease(entry, leaseId) {
  if (entry.state !== 'sending' || !leaseId || entry.leaseId !== leaseId) throw new Error('Source delivery lease mismatch');
}

export async function completeSourceDelivery(id, leaseId, input = {}) {
  return queue(() => mutateDelivery(id, entry => {
    // Repeating the acknowledgement after an HTTP disconnect is harmless.
    if (entry.state === 'delivered' && entry.receiptLeaseId === leaseId) return entry;
    if (!['sending', 'unknown'].includes(entry.state) || !leaseId || entry.leaseId !== leaseId) throw new Error('Source delivery lease mismatch');
    return { ...entry, state: 'delivered', externalId: trimString(input.externalId), receiptLeaseId: leaseId,
      deliveredAt: nowIso(input.now), leaseId: '', lastError: '' };
  }));
}

export async function failSourceDelivery(id, leaseId, error, options = {}) {
  return queue(() => mutateDelivery(id, entry => {
    requireLease(entry, leaseId);
    const retryable = options.safeToRetry === true && entry.attempts < (options.maxAttempts || 5);
    const state = retryable ? 'pending' : (options.definiteFailure === true || options.safeToRetry === true) ? 'delivery_failed' : 'unknown';
    return { ...entry, state,
      leaseId: state === 'unknown' ? entry.leaseId : '', lastError: String(error?.message || error),
      availableAt: new Date(Date.parse(nowIso(options.now)) + (options.retryDelayMs ?? 5000)).toISOString() };
  }));
}

export async function resolveSourceDelivery(id, resolution) {
  return queue(() => mutateDelivery(id, entry => {
    if (!['unknown', 'delivery_failed'].includes(entry.state)) throw new Error('Only an unresolved delivery can be resolved');
    if (!['delivered', 'pending', 'cancelled'].includes(resolution.state)) throw new Error('Invalid delivery resolution');
    return { ...entry, state: resolution.state, externalId: resolution.externalId || entry.externalId,
      availableAt: nowIso(), leaseId: '', resolution: resolution.reason || 'operator resolution' };
  }));
}

export async function cancelSourceDeliveriesForSchedule(scheduleId) {
  let count = 0;
  for (const entry of await listSourceDeliveries()) {
    if (entry.scheduleId !== scheduleId || terminal(entry.state)) continue;
    await queue(() => mutateDelivery(entry.id, current => ({ ...current, state: 'cancelled', leaseId: '' })));
    count++;
  }
  return count;
}

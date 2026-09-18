import { buildReplyDeliveries } from '../lib/reply-deliveries.mjs';
export { buildReplyDeliveries } from '../lib/reply-deliveries.mjs';
import { refineConversation, sameConversation } from '../lib/conversation-target.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { updateSessionConversation } from './session-conversations.mjs';
import { normalizeConversation as normalizeSourceDeliveryPlan, normalizeConversationTarget as normalizeTarget, normalizeConversationRouteId as normalizeSourceRouteId } from '../lib/conversation-target.mjs';
export { normalizeConversation as normalizeSourceDeliveryPlan } from '../lib/conversation-target.mjs';
import { randomBytes } from 'node:crypto';
import { requests, requestKey, appendDeliveries } from './requests.mjs';
import { serialQueue } from '../lib/durable-records.mjs';
import { broadcastOwners } from './ws-clients.mjs';
import { buildDeliveryNotice, deliveryIssue, DELIVERY_LEASE_MS } from './source-delivery-issues.mjs';
import {
  getSourceDeliverySignalVersion,
  waitForSourceDeliverySignal,
} from './source-delivery-signals.mjs';
const queue = serialQueue();
export const MAX_SOURCE_DELIVERY_WAIT_MS = 25_000;
const trimString = value => typeof value === 'string' ? value.trim() : '';
const terminal = state => ['delivered', 'delivery_failed', 'cancelled'].includes(state);

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


export function buildSourceDeliveryPlan(sourceContext) {
  if (!sourceContext || typeof sourceContext !== 'object' || Array.isArray(sourceContext)) return null;
  const session = sourceContext.session && typeof sourceContext.session === 'object'
    ? sourceContext.session
    : {};
  const message = sourceContext.message && typeof sourceContext.message === 'object'
    ? sourceContext.message
    : {};
  const connector = trimString(message.connector || session.connector).toLowerCase();
  const target = normalizeTarget({ ...session, ...message });
  if (connector === 'feishu') {
    if (!target.chatId && !target.commentId) return null;
  } else if (connector === 'wechat') {
    if (!target.accountId || !target.peerUserId) return null;
  } else if (connector === 'email') {
    if (!target.to) return null;
  } else {
    return null;
  }
  return {
    connector,
    sourceRouteId: normalizeSourceRouteId(message.sourceRouteId || session.sourceRouteId),
    target,
  };
}


export async function listSourceDeliveries(options = {}) {
  const deliveries = (await requests.active()).flatMap(record => record.deliveries);
  return deliveries.filter(entry => ['connector', 'sourceRouteId', 'state', 'sessionId'].every(field => !options[field] || entry[field] === options[field]));
}

export async function listSourceDeliveryIssues(options = {}) {
  return (await listSourceDeliveries(options)).map(entry => deliveryIssue(entry, options.now ?? Date.now())).filter(Boolean);
}

// Optional transport feedback (e.g. native typing) observes durable requests,
// never a per-message waiter or a connector-imposed execution deadline.
export async function listSourceDeliveryActivity(options = {}) {
  const activity = [];
  for (const record of await requests.active()) {
    if (record.result || record.options.deliveryOnly || record.options.internalOperation) continue;
    const plan = normalizeSourceDeliveryPlan(record.deliveryPlan || record.options.sourceDelivery);
    if (!plan || ['connector', 'sourceRouteId'].some(field => options[field] && plan[field] !== options[field])) continue;
    if (options.sessionId && record.sessionId !== options.sessionId) continue;
    activity.push({ ...plan, sessionId: record.sessionId, requestId: record.requestId, responseId: record.responseId });
  }
  return activity;
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

const targetKey = entry => {
  const t = entry.target || {};
  if (entry.connector === 'wechat') {
    // Serialise per account+peer so messages to different WeChat users never block each other.
    return JSON.stringify(['wechat', entry.sourceRouteId, `${t.accountId || ''}:${t.peerUserId || ''}`, '']);
  }
  if (entry.connector === 'email') {
    // Serialise per recipient+thread so each email thread is independently ordered.
    return JSON.stringify(['email', entry.sourceRouteId, t.to || '', t.threadId || t.inReplyTo || '']);
  }
  // Feishu (and any future unknown connector): existing key.
  return JSON.stringify([entry.connector, entry.sourceRouteId, t.chatId || t.fileToken || '', t.rootId || t.topicId || t.threadId || t.commentId || (t.replyInThread ? t.messageId : '') || '']);
};

async function mutateDelivery(id, update) {
  const { key, index } = parseId(id);
  const record = await requests.mutate(key, current => {
    if (!current?.deliveries[index]) throw new Error('Delivery not found');
    const deliveries = current.deliveries.slice();
    deliveries[index] = update({ ...deliveries[index] });
    let next = { ...current, deliveries };
    const entry = deliveries[index];
    if (entry.connector === 'feishu' && entry.kind !== 'delivery_notice'
      && ['unknown', 'delivery_failed'].includes(entry.state)
      && !deliveries.some(part => part.kind === 'delivery_notice')) {
      next = { ...next, deliveries: appendDeliveries(next, [buildDeliveryNotice(entry)]) };
    }
    if (next.deliveries.filter(part => part.kind !== 'delivery_notice')
      .every(part => ['delivered', 'cancelled'].includes(part.state))) {
      next.deliveries = next.deliveries.map(part => part.kind === 'delivery_notice' && part.state === 'pending'
        ? { ...part, state: 'cancelled', resolution: 'Issue resolved before notification' } : part);
    }
    return next;
  });
  await requests.archiveFinished(key);
  broadcastOwners({ type: 'session_invalidated', sessionId: record.sessionId });
  return record.deliveries[index];
}

async function inspectAndClaimSourceDelivery(options = {}) {
  return queue(async () => {
    const now = nowIso(options.now);
    const nowMs = Date.parse(now);
    const timeout = options.leaseTimeoutMs || DELIVERY_LEASE_MS;
    const entries = await listSourceDeliveries({ connector: options.connector, sourceRouteId: options.sourceRouteId || 'default' });
    const blocked = new Set();
    let nextCheckAt = Infinity;
    for (let entry of entries) {
      if (terminal(entry.state)) continue;
      const session = await findSessionMeta(entry.sessionId);
      const refined = refineConversation(entry, session?.conversation);
      const openingTopic = session?.conversation?.connector === 'feishu' && !sameConversation(session.conversation, session.conversation);
      const key = openingTopic ? `session:${entry.sessionId}` : targetKey(refined || entry);
      const claimedAt = Date.parse(entry.claimedAt);
      if (entry.state === 'sending' && (!Number.isFinite(claimedAt) || nowMs - claimedAt >= timeout)) {
        entry = await mutateDelivery(entry.id, current => ({ ...current, state: 'unknown', lastError: 'Sender lease expired without a receipt' }));
      }
      // Fence this uncertain operation, not the whole conversation. A later
      // receipt can still settle its original lease without resending it.
      if (entry.state === 'unknown') {
        if (openingTopic) blocked.add(key); // Do not create a second root after an ambiguous first send.
        continue;
      }
      if (blocked.has(key)) continue;
      blocked.add(key);
      if (entry.state === 'sending') {
        if (Number.isFinite(claimedAt)) nextCheckAt = Math.min(nextCheckAt, claimedAt + timeout);
        continue;
      }
      const availableAt = Date.parse(entry.availableAt);
      if (entry.state !== 'pending' || (Number.isFinite(availableAt) && availableAt > nowMs)) {
        if (entry.state === 'pending' && Number.isFinite(availableAt)) nextCheckAt = Math.min(nextCheckAt, availableAt);
        continue;
      }
      const leaseId = createId('lease');
      const delivery = await mutateDelivery(entry.id, current => ({ ...current, ...(refined ? { target: refined.target } : {}), state: 'sending', leaseId, claimedAt: now, attempts: current.attempts + 1 }));
      return { claim: { delivery, leaseId }, nextCheckAt };
    }
    return { claim: null, nextCheckAt };
  });
}

export async function claimSourceDelivery(options = {}) {
  return (await inspectAndClaimSourceDelivery(options)).claim;
}

export async function claimSourceDeliveryWithWait(options = {}) {
  const waitMs = Math.min(MAX_SOURCE_DELIVERY_WAIT_MS, Math.max(0, Number.parseInt(options.waitMs, 10) || 0));
  const deadline = Date.now() + waitMs;
  while (true) {
    const afterVersion = getSourceDeliverySignalVersion(options);
    const { claim, nextCheckAt } = await inspectAndClaimSourceDelivery(options);
    if (claim || !waitMs || options.signal?.aborted) return claim;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const untilStateChange = Number.isFinite(nextCheckAt) ? Math.max(1, nextCheckAt - Date.now()) : remaining;
    const wake = await waitForSourceDeliverySignal({
      ...options,
      afterVersion,
      timeoutMs: Math.min(remaining, untilStateChange),
    });
    if (wake.reason === 'aborted') return null;
  }
}

export async function completeSourceDelivery(id, leaseId, input = {}) {
  return queue(async () => {
    const { key, index } = parseId(id);
    const record = await requests.get(key);
    const entry = record?.deliveries[index];
    if (!entry) throw new Error('Delivery not found');
    const duplicate = entry.state === 'delivered' && entry.receiptLeaseId === leaseId;
    if (!duplicate && (!['sending', 'unknown'].includes(entry.state) || !leaseId || entry.leaseId !== leaseId)) throw new Error('Source delivery lease mismatch');
    if (!duplicate && input.messageId && await findSessionMeta(entry.sessionId)) {
      await updateSessionConversation(entry.sessionId, entry, { receipt: input });
    }
    return mutateDelivery(id, entry => {
    // Repeating the acknowledgement after an HTTP disconnect is harmless.
    if (entry.state === 'delivered' && entry.receiptLeaseId === leaseId) return entry;
    if (!['sending', 'unknown'].includes(entry.state) || !leaseId || entry.leaseId !== leaseId) throw new Error('Source delivery lease mismatch');
    return { ...entry, state: 'delivered', externalId: trimString(input.externalId), receiptLeaseId: leaseId,
      deliveredAt: nowIso(input.now), leaseId: '', lastError: '' };
    });
  });
}

export async function failSourceDelivery(id, leaseId, error, options = {}) {
  return queue(() => mutateDelivery(id, entry => {
    // A durable failure receipt may arrive after lease expiry or after its
    // acknowledgement was committed but the HTTP response was lost.
    if (leaseId && entry.failureLeaseId === leaseId) return entry;
    if (!['sending', 'unknown'].includes(entry.state) || !leaseId || entry.leaseId !== leaseId) throw new Error('Source delivery lease mismatch');
    const retryable = options.safeToRetry === true && entry.attempts < (options.maxAttempts || 5);
    const state = retryable ? 'pending' : (options.definiteFailure === true || options.safeToRetry === true) ? 'delivery_failed' : 'unknown';
    return { ...entry, state, failureLeaseId: leaseId,
      leaseId: state === 'unknown' ? entry.leaseId : '', lastError: String(error?.message || error),
      availableAt: new Date(Date.parse(nowIso(options.now)) + (options.retryDelayMs ?? 5000)).toISOString() };
  }));
}

export async function resolveSourceDelivery(id, resolution) {
  return queue(async () => {
    const current = await getSourceDelivery(id);
    if (!current || !['unknown', 'delivery_failed'].includes(current.state)) throw new Error('Only an unresolved delivery can be resolved');
    if (resolution.state === 'delivered') {
      const session = await findSessionMeta(current.sessionId);
      if (session?.conversation?.connector === 'feishu'
          && !sameConversation(session.conversation, session.conversation) && !resolution.messageId) {
        throw new Error('Resolving a new topic delivery requires its actual messageId');
      }
      if (session && resolution.messageId) await updateSessionConversation(current.sessionId, current, { receipt: resolution });
    }
    return mutateDelivery(id, entry => {
    if (!['unknown', 'delivery_failed'].includes(entry.state)) throw new Error('Only an unresolved delivery can be resolved');
    if (!['delivered', 'pending', 'cancelled'].includes(resolution.state)) throw new Error('Invalid delivery resolution');
    return { ...entry, state: resolution.state, externalId: resolution.externalId || entry.externalId,
      availableAt: nowIso(), leaseId: '', resolution: resolution.reason || 'operator resolution' };
    });
  });
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

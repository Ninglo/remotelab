import { createHash } from 'node:crypto';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';

export const INBOX_FAILURE_ALERT_INTERVAL_MS = 3 * 60 * 60 * 1000;

export function inboxFailureAlertKey(route, entry) {
  const source = entry.summary || {};
  const error = String(entry.lastError || entry.admissionFailure || 'retry_exhausted')
    .replace(/[a-f0-9]{24,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, '<id>');
  return createHash('sha256').update(JSON.stringify([
    route, source.tenantKey, source.chatId, source.sourceKind || source.eventType || 'message',
    source.sender?.openId, error,
  ])).digest('hex').slice(0, 24);
}

// Source events retain separate inbox records. Group reminders share one durable
// incident and survive reconnects; an uncertain enqueue retries the same ID.
export function createInboxFailureAlerts(root, { now = Date.now } = {}) {
  const store = createRecordStore(root);
  const serial = serialQueue();
  return (route, entry, enqueue) => serial(async () => {
    const key = inboxFailureAlertKey(route, entry);
    let record = await store.get(key);
    const timestamp = now();
    if (record?.lastAlertAt != null && timestamp - record.lastAlertAt < INBOX_FAILURE_ALERT_INTERVAL_MS) {
      return { suppressed: true, reason: 'same_incident_within_three_hours', incidentKey: key };
    }
    if (!record?.pending) record = await store.mutate(key, current => ({
      ...current, pending: { startedAt: timestamp, responseId: `feishu-inbox-incident:${key}:${timestamp}` },
    }));
    const result = await enqueue(record.pending.responseId);
    await store.mutate(key, current => ({ ...current, lastAlertAt: record.pending.startedAt,
      pending: null, deliveryId: result.deliveryId || '' }));
    return result;
  });
}

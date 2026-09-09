import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';

export const DELIVERY_LEASE_MS = 120_000;
const elapsed = (now, stamp) => !Number.isFinite(Date.parse(stamp)) || now - Date.parse(stamp) >= DELIVERY_LEASE_MS;

export function deliveryIssue(entry, now = Date.now()) {
  if (entry.kind === 'delivery_notice') return null;
  let state = entry.state;
  if (state === 'sending' && elapsed(now, entry.claimedAt)) state = 'unknown';
  if (state === 'pending') {
    state = entry.attempts > 0 ? 'retrying' : elapsed(now, entry.createdAt) ? 'delayed' : '';
  }
  if (!['unknown', 'delivery_failed', 'retrying', 'delayed'].includes(state)) return null;
  return {
    id: entry.id, sessionId: entry.sessionId, connector: entry.connector, state,
    filename: String(entry.attachment?.originalName || entry.attachment?.filename || '').slice(0, 255),
    createdAt: entry.createdAt, attempts: entry.attempts,
    lastError: String(entry.lastError || '').slice(0, 2000),
  };
}

export function buildDeliveryNotice(entry) {
  const unknown = entry.state === 'unknown';
  const url = buildSessionNavigationHref(entry.sessionId, { requireAbsolute: true });
  return {
    connector: entry.connector, sourceRouteId: entry.sourceRouteId, target: entry.target,
    kind: 'delivery_notice', text: [
      unknown ? '这轮有消息无法确认是否送达，请核对飞书里是否收到。' : '这轮有消息或附件发送失败。',
      '内容仍保存在 RemoteLab，后续消息会继续发送。可在会话中查看原因，并让我处理补发。',
      url,
    ].filter(Boolean).join('\n'),
  };
}

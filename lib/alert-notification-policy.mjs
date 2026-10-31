import { appendAlertHistory } from './alert-card-history.mjs';

export const ALERT_MERGE_MS = 3 * 60 * 60_000;
export const ALERT_PERSIST_MS = 10 * 60_000;

// Identity excludes timestamps, process invocations, measurements and wording.
export const alertIdentity = item => `${item.kind}:${item.kind === 'serviceCrash' ? item.unit : item.id || item.subject}`;

export function recentAlertBatch(state, item, now) {
  return Object.values(state.batches).filter(batch =>
    ['sent', 'needs_review', 'sending', 'updating'].includes(batch.status)
    && now >= Date.parse(batch.startedAt) && now - Date.parse(batch.startedAt) < ALERT_MERGE_MS
    && Object.values(batch.events || {}).some(event => alertIdentity(event) === alertIdentity(item)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
}

// Check with a fresh observation, not merely elapsed wall time. An improvement
// restarts the ten-minute interval; historical crash evidence is not a new crash.
export function observePersistentAlert(owner, item, { now, since, fresh = true } = {}) {
  const at = new Date(now).toISOString();
  const prior = owner.persistence;
  const rank = { info: 0, warning: 1, critical: 2 };
  const improved = prior && ((rank[item.severity] ?? 0) < (rank[prior.severity] ?? 0)
    || item.kind === 'disk' && Number.isFinite(item.availableBytes) && item.availableBytes > prior.availableBytes
    || item.continuity && Number.isFinite(item.continuity.remainingPercent)
      && item.continuity.remainingPercent > prior.remainingPercent
    || item.kind === 'metric' && Number.isFinite(item.ratio) && item.ratio < prior.ratio);
  if (!fresh) return;
  if (item.recovered) {
    delete owner.persistence;
    delete owner.persistentWarningAt;
    return;
  }
  if (!prior || improved) {
    owner.persistence = { since: improved ? at : since || at };
    delete owner.persistentWarningAt;
  }
  Object.assign(owner.persistence, { severity: item.severity, availableBytes: item.availableBytes,
    remainingPercent: item.continuity?.remainingPercent, ratio: item.ratio });
  const start = Date.parse(owner.persistence.since);
  const lastCrash = Date.parse(item.lastOccurredAt);
  const ongoing = item.kind !== 'serviceCrash' || item.signals?.unavailable === true
    || item.crashCount > 1 && lastCrash > start && now - lastCrash <= 180_000;
  if (!owner.persistentWarningAt && Number.isFinite(start) && now - start >= ALERT_PERSIST_MS && ongoing) {
    owner.persistentWarningAt = at;
    appendAlertHistory(owner, { at, label: '持续告警', summary: '连续10分钟未见改善，继续在本卡更新处理进展。' });
  }
}

// Adopt the first real receipt of a legacy crash loop. Keep all old records and
// receipts for audit; only the canonical card receives further updates.
export function adoptCrashReceipt(state, item, key) {
  if (item.kind !== 'serviceCrash' || !item.eventIds?.length) return;
  const ids = new Set(item.eventIds);
  const members = Object.entries(state.incidents).filter(([, i]) => i.kind === 'serviceCrash'
    && (i.event?.id === item.id || ids.has(i.event?.id)) && !i.supersededBy);
  const batches = Object.values(state.batches).filter(b => b.messageId
    && members.some(([k]) => b.keys.includes(k))).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const anchor = batches[0];
  if (!anchor) return;
  const original = members.find(([, i]) => i.messageId === anchor.messageId)?.[1];
  if (!original) return;
  if (!state.incidents[key] || state.incidents[key].supersededBy) state.incidents[key] = structuredClone(original);
  delete state.incidents[key].supersededBy;
  state.incidents[key].messageId = anchor.messageId;
  if (!anchor.keys.includes(key)) anchor.keys.push(key);
  for (const [k, incident] of members) if (k !== key) {
    incident.active = false;
    incident.supersededBy = key;
  }
  for (const batch of batches) if (batch !== anchor && batch.keys.every(k => state.incidents[k]?.supersededBy)) {
    batch.status = 'superseded'; batch.supersededBy = anchor.messageId; batch.dirty = false;
  }
}

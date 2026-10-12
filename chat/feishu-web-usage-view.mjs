// Display-only projections. Never copy account credentials or other Sessions.
export const QUOTA_MAX_AGE_MS = 10 * 60_000;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const timestamp = value => {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

export function contextFromEvents(events = []) {
  const event = [...events].reverse().find(e => e.type === 'usage'
    && nonnegative(e.contextTokens) && e.contextTokens > 0);
  if (!event) return null;
  return {
    tokens: event.contextTokens,
    windowTokens: nonnegative(event.contextWindowTokens) && event.contextWindowTokens > 0
      ? event.contextWindowTokens : null,
    updatedAt: timestamp(event.timestamp || event.at),
    sourceSeq: event.seq,
  };
}

export function totalsBySession(result = {}) {
  return new Map((result.bySession || []).filter(e => e.sessionId
    && nonnegative(e.totalTokens) && nonnegative(e.runCount) && e.runCount > 0)
    .map(e => [e.sessionId, {
      totalTokens: e.totalTokens, runCount: e.runCount,
      updatedAt: timestamp(result.generatedAt),
    }]));
}

export function quotaFromSources(auth, usage, now = Date.now()) {
  const checkedAt = timestamp(usage?.checkedAt);
  const age = checkedAt ? now - Date.parse(checkedAt) : Infinity;
  const ready = auth?.loggedIn === true && auth.accountRevision
    && auth.accountRevision === usage?.accountRevision && usage?.status === 'ready'
    && age >= -60_000 && age < QUOTA_MAX_AGE_MS;
  const windows = ready ? (usage.buckets || []).filter(b => b.id === 'codex')
    .flatMap(b => [b.primary, b.secondary]).filter(w => w
      && Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100
      && Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
      && (!w.resetsAt || Date.parse(w.resetsAt) > now))
    .map(w => ({ remainingPercent: w.remainingPercent, windowDurationMins: w.windowDurationMins,
      resetsAt: timestamp(w.resetsAt) })) : [];
  return { status: windows.length ? 'ready' : 'unavailable', checkedAt, windows };
}

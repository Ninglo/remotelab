// Volatile scheduler state is a projection of the store. Both boot and notifications use tick().
export function createRequestRuntime({ store, prepare, observe, reconcile, forward = async () => {}, postCompletion = async () => {}, onError, intervalMs = 1000 }) {
  const records = new Map();
  const sessions = new Map();
  const completions = new Map();
  const notified = new Set();
  let timer = null;
  let loading = null;
  let stopped = false;
  const pending = sessionId => [...records.values()].filter(r => r.sessionId === sessionId && !r.releasedAt && !r.options.deliveryOnly)
    .sort((a, b) => a.sequence - b.sequence);
  const active = sessionId => pending(sessionId).filter(r => !r.nativeDispatchRunId);
  const refresh = async key => {
    const record = await store.get(key);
    if (record?.releasedAt && !record.postCompletionPending) records.delete(key);
    else if (record) records.set(key, record);
    return record;
  };
  const load = () => loading ||= store.active().then(items => { for (const item of items) records.set(item.key, item); });
  const tick = sessionId => {
    if (stopped) return Promise.resolve();
    if (sessions.has(sessionId)) { notified.add(sessionId); return sessions.get(sessionId); }
    const task = (async () => {
      await load();
      for (const record of pending(sessionId).filter(r => r.nativeDispatchRunId)) await forward(record);
      const head = active(sessionId)[0];
      if (!head) return;
      const current = await refresh(head.key);
      if (current.releasedAt) return;
      await prepare(current);
      for (const record of active(sessionId).slice(1)) await forward(record, current);
      observe(current.sessionId, current.runId);
      await reconcile(current.sessionId, current.runId);
      await refresh(current.key);
    })().catch(error => onError(error, sessionId)).finally(() => { sessions.delete(sessionId); if (notified.delete(sessionId) && !stopped) setImmediate(() => void tick(sessionId)); });
    sessions.set(sessionId, task);
    return task;
  };
  const sweep = async () => {
    await load();
    for (const record of records.values()) {
      if (!record.releasedAt || !record.postCompletionPending || completions.has(record.key)) continue;
      const task = Promise.resolve().then(() => postCompletion(record))
        .then(() => refresh(record.key)).catch(error => onError(error, record.sessionId))
        .finally(() => completions.delete(record.key));
      completions.set(record.key, task);
    }
    await Promise.all([...new Set([...records.values()].filter(r => !r.releasedAt && !r.options.deliveryOnly).map(r => r.sessionId))].map(tick));
  };
  return {
    active, refresh, tick,
    async removeQueued(sessionId, requestId) {
      await load();
      // Share the scheduler's per-session lock: a stale click must never race
      // preparation/launch or cancel the next request after the head advances.
      while (sessions.has(sessionId)) await sessions.get(sessionId);
      const task = Promise.resolve().then(async () => {
        const record = await store.byRequest(sessionId, requestId);
        if (!record) throw Object.assign(new Error('Queued message not found'), { code: 'REQUEST_NOT_FOUND' });
        if (record.queueRemovedAt) return record;
        if (record.result || record.preparedAt || !active(sessionId).slice(1).some(item => item.key === record.key)) {
          throw Object.assign(new Error('Message is no longer queued'), { code: 'REQUEST_NOT_QUEUED' });
        }
        const now = new Date().toISOString();
        await store.mutate(record.key, current => ({ ...current,
          result: { state: 'cancelled', payload: null, error: null },
          queueRemovedAt: now, cancelRequestedAt: now, settledAt: now, releasedAt: now,
          postCompletionPending: false,
          deliveries: current.deliveries.map(delivery => delivery.state === 'pending'
            ? { ...delivery, state: 'cancelled', updatedAt: now } : delivery),
        }));
        const removed = await refresh(record.key);
        await store.archiveFinished(record.key);
        return removed;
      });
      // Scheduler observers await completion, while the caller owns API errors.
      sessions.set(sessionId, task.catch(() => {}));
      try { return await task; } finally { sessions.delete(sessionId); }
    },
    async accept(input) {
      await load();
      const outcome = await store.accept(input);
      records.set(outcome.record.key, outcome.record);
      stopped = false;
      this.start();
      setImmediate(() => void tick(input.sessionId));
      return outcome;
    },
    start() {
      stopped = false;
      if (!timer) { timer = setInterval(() => void sweep(), intervalMs); timer.unref?.(); }
    },
    async recover() { this.start(); await sweep(); },
    stop() { stopped = true; clearInterval(timer); timer = null; },
    async idle() { await Promise.all(sessions.values()); await Promise.all(completions.values()); await store.idle(); },
  };
}

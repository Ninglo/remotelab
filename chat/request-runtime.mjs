// Volatile scheduler state is a projection of the store. Both boot and notifications use tick().
export function createRequestRuntime({ store, prepare, observe, reconcile, forward = async () => {}, postCompletion = async () => {}, onError, intervalMs = 30_000 }) {
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
    const previous = records.get(key);
    const record = await store.get(key);
    if (record?.releasedAt && !record.postCompletionPending) records.delete(key);
    else if (record) records.set(key, record);
    if (record?.releasedAt && !previous?.releasedAt) {
      setImmediate(() => { if (!stopped) { void tick(record.sessionId); complete(record); } });
    }
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
      const claimed = current.executionClaimedAt ? current : await store.mutate(current.key,
        latest => latest.releasedAt || latest.executionClaimedAt ? latest
          : { ...latest, executionClaimedAt: new Date().toISOString() });
      if (claimed.releasedAt) return;
      await prepare(claimed);
      for (const record of active(sessionId).slice(1)) await forward(record, current);
      observe(current.sessionId, current.runId);
      await reconcile(current.sessionId, current.runId);
      await refresh(current.key);
    })().catch(error => onError(error, sessionId)).finally(() => { sessions.delete(sessionId); if (notified.delete(sessionId) && !stopped) setImmediate(() => void tick(sessionId)); });
    sessions.set(sessionId, task);
    return task;
  };
  const complete = record => {
    if (!record.releasedAt || !record.postCompletionPending || completions.has(record.key)) return;
    const task = Promise.resolve().then(() => postCompletion(record))
      .then(() => refresh(record.key)).catch(error => onError(error, record.sessionId))
      .finally(() => completions.delete(record.key));
    completions.set(record.key, task);
  };
  const sweep = async (waitForTicks = false) => {
    await load();
    for (const record of records.values()) complete(record);
    const ticks = [...new Set([...records.values()].filter(r => !r.releasedAt && !r.options.deliveryOnly)
      .map(r => r.sessionId))].map(tick);
    if (waitForTicks) await Promise.all(ticks);
  };
  return {
    active, refresh, tick,
    async removeQueued(sessionId, requestId) {
      await load();
      // Compete only at the durable state transition, never behind preparation
      // or network IO. A scheduler claim makes stale removals fail immediately.
      const task = Promise.resolve().then(async () => {
        const record = await store.byRequest(sessionId, requestId);
        if (!record) throw Object.assign(new Error('Queued message not found'), { code: 'REQUEST_NOT_FOUND' });
        if (record.queueRemovedAt) return record;
        if (record.result || record.preparedAt || record.executionClaimedAt || record.nativeDispatchRunId || !active(sessionId).slice(1).some(item => item.key === record.key)) {
          throw Object.assign(new Error('Message is no longer queued'), { code: 'REQUEST_NOT_QUEUED' });
        }
        const now = new Date().toISOString();
        await store.mutate(record.key, current => {
          if (current.queueRemovedAt) return current;
          if (current.result || current.preparedAt || current.executionClaimedAt || current.nativeDispatchRunId
              || !active(sessionId).slice(1).some(item => item.key === current.key)) {
            throw Object.assign(new Error('Message is no longer queued'), { code: 'REQUEST_NOT_QUEUED' });
          }
          return { ...current,
            result: { state: 'cancelled', payload: null, error: null },
            queueRemovedAt: now, cancelRequestedAt: now, settledAt: now, releasedAt: now,
            postCompletionPending: false,
            deliveries: current.deliveries.map(delivery => delivery.state === 'pending'
              ? { ...delivery, state: 'cancelled', updatedAt: now } : delivery),
          };
        });
        const removed = await refresh(record.key);
        await store.archiveFinished(record.key);
        return removed;
      });
      return task;
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
      if (!timer) { timer = setInterval(() => {
        if (records.size) void sweep().catch(error => onError(error));
      }, intervalMs); timer.unref?.(); }
    },
    async recover({ wait = true } = {}) { this.start(); await sweep(wait); },
    stop() { stopped = true; clearInterval(timer); timer = null; },
    async idle() { await Promise.all(sessions.values()); await Promise.all(completions.values()); await store.idle(); },
  };
}

// Volatile scheduler state is a projection of the store. Both boot and notifications use tick().
export function createRequestRuntime({ store, prepare, observe, reconcile, postCompletion = async () => {}, onError, intervalMs = 1000 }) {
  const records = new Map();
  const sessions = new Map();
  const completions = new Map();
  let timer = null;
  let loading = null;
  let stopped = false;
  const active = sessionId => [...records.values()].filter(r => r.sessionId === sessionId && !r.releasedAt && !r.options.deliveryOnly)
    .sort((a, b) => a.sequence - b.sequence);
  const refresh = async key => {
    const record = await store.get(key);
    if (record?.releasedAt && !record.postCompletionPending) records.delete(key);
    else if (record) records.set(key, record);
    return record;
  };
  const load = () => loading ||= store.active().then(items => { for (const item of items) records.set(item.key, item); });
  const tick = sessionId => {
    if (stopped) return Promise.resolve();
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const task = (async () => {
      await load();
      const head = active(sessionId)[0];
      if (!head) return;
      const current = await refresh(head.key);
      if (current.releasedAt) return;
      await prepare(current);
      observe(current.sessionId, current.runId);
      await reconcile(current.sessionId, current.runId);
      await refresh(current.key);
    })().catch(error => onError(error, sessionId)).finally(() => sessions.delete(sessionId));
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

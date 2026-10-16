// Independent completion effects own their receipts and in-flight operations.
// A stalled integration cannot hold the execution slot or another effect's retry.
export function createRequestCompletion({ store, now = Date.now, retryMs = 30_000,
  onError = error => console.error(`[request-completion] ${error.message}`) }) {
  const running = new Map();
  const complete = async (record, effects, { wait = true } = {}) => {
    const current = await store.get(record.key);
    if (!current?.postCompletionPending) return;
    const names = Object.keys(effects);
    const tasks = [];
    for (const [name, effect] of Object.entries(effects)) {
      const key = `${record.key}:${name}`;
      if (running.has(key)) { tasks.push(running.get(key)); continue; }
      const receipt = current.completionEffects?.[name];
      if (receipt?.state === 'done' || receipt?.retryAt > now()) continue;
      const task = (async () => {
        let outcome;
        try {
          await effect();
          outcome = { state: 'done', completedAt: new Date(now()).toISOString() };
        } catch (error) {
          outcome = { state: 'failed', error: String(error?.message || error), retryAt: now() + retryMs };
        }
        await store.mutate(record.key, latest => {
          const completionEffects = { ...latest.completionEffects, [name]: outcome };
          return { ...latest, completionEffects,
            postCompletionPending: !names.every(effectName => completionEffects[effectName]?.state === 'done') };
        });
        await store.archiveFinished(record.key);
      })().catch(onError).finally(() => running.delete(key));
      running.set(key, task);
      tasks.push(task);
    }
    if (wait) await Promise.all(tasks);
  };
  complete.idle = async () => {
    while (running.size) await Promise.allSettled(running.values());
  };
  return complete;
}

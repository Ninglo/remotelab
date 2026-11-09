// Independent completion effects own their receipts and in-flight operations.
// A stalled integration cannot hold the execution slot or another effect's retry.
export function createRequestCompletion({ store, now = Date.now, retryMs = 30_000,
  memoryMaxAttempts = 6, onError = error => console.error(`[request-completion] ${error.message}`) }) {
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
      if (['done', 'exhausted'].includes(receipt?.state) || receipt?.retryAt > now()) continue;
      const task = (async () => {
        const attempts = (receipt?.attempts || 0) + 1;
        const bounded = name === 'memoryWriteback';
        const interruptions = (receipt?.interruptions || 0) + (receipt?.state === 'running' ? 1 : 0);
        const delay = bounded ? Math.min(300_000, retryMs * 2 ** Math.min(attempts - 1, 8)) : retryMs;
        // Persist before invoking the model so a crash consumes an attempt too.
        await store.mutate(record.key, latest => ({ ...latest, completionEffects: {
          ...latest.completionEffects, [name]: { state: 'running', attempts, interruptions, startedAt: new Date(now()).toISOString(), retryAt: now() + delay },
        } }));
        let outcome;
        try {
          if (bounded && interruptions >= 2) throw new Error('Memory review interrupted twice; manual recovery required');
          if (bounded && attempts > memoryMaxAttempts) throw new Error(receipt?.error || 'Memory review attempt limit reached');
          await effect();
          outcome = { state: 'done', attempts, interruptions, completedAt: new Date(now()).toISOString() };
        } catch (error) {
          const message = String(error?.message || error);
          const limit = /no valid updates array/.test(message) ? Math.min(2, memoryMaxAttempts) : memoryMaxAttempts;
          const exhausted = bounded && (attempts >= limit || interruptions >= 2);
          outcome = { state: exhausted ? 'exhausted' : 'failed', attempts, interruptions, error: message,
            ...(exhausted ? { exhaustedAt: new Date(now()).toISOString() } : { retryAt: now() + delay }) };
          if (exhausted) onError(new Error(`Memory review stopped after ${attempts} attempts: ${message}`));
        }
        await store.mutate(record.key, latest => {
          const completionEffects = { ...latest.completionEffects, [name]: outcome };
          return { ...latest, completionEffects,
            postCompletionPending: !names.every(effectName => ['done', 'exhausted'].includes(completionEffects[effectName]?.state)) };
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

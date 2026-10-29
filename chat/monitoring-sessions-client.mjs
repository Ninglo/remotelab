import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./monitoring-sessions-worker.mjs', import.meta.url);

// The core keeps only this small request queue. The worker is started on
// demand, has its own heap limit, and exits after an idle period so its scan
// caches are returned to the operating system.
export function createSessionMonitoringClient({ idleMs = 10 * 60_000, timeoutMs = 120_000,
  heapMb = Number(process.env.REMOTELAB_MONITORING_WORKER_HEAP_MB) || 2048, createWorker } = {}) {
  let worker = null, idleTimer = null, nextId = 0;
  const pending = new Map();
  const failAll = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  const stopWorker = () => {
    clearTimeout(idleTimer); idleTimer = null;
    const current = worker; worker = null;
    if (current) void current.terminate().catch(() => {});
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!pending.size) { idleTimer = setTimeout(stopWorker, idleMs); idleTimer.unref?.(); }
  };
  const ensureWorker = () => {
    if (worker) return worker;
    const current = createWorker ? createWorker() : new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    worker = current;
    current.unref?.();
    current.on('message', ({ id, data, error }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id); clearTimeout(request.timer);
      if (error) request.reject(new Error(error)); else request.resolve(data);
      armIdle();
    });
    const lost = reason => {
      if (worker !== current) return;
      worker = null; clearTimeout(idleTimer);
      failAll(new Error(`Session monitoring worker stopped: ${reason}`));
    };
    current.on('error', error => lost(error?.message || 'error'));
    current.on('exit', code => lost(`exit ${code}`));
    return current;
  };
  function read({ days, dashboard = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      clearTimeout(idleTimer);
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error('Session monitoring worker timed out'));
        // A stuck scan cannot block later reads; the next request starts fresh.
        stopWorker(); failAll(new Error('Session monitoring worker restarted after a timeout'));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      ensureWorker().postMessage({ id, days, dashboard });
    });
  }
  return { read, stop: () => { failAll(new Error('Session monitoring client stopped')); stopWorker(); } };
}

export const sessionMonitoringClient = createSessionMonitoringClient();

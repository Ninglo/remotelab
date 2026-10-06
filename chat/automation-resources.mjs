import { loadavg, availableParallelism, freemem, totalmem } from 'node:os';
import { onAutomationActivityHint, notifyAutomationWake } from '../lib/automation-events.mjs';

function busy(session) {
  const a = session?.activity;
  if (!a?.run?.state || !Number.isInteger(a.queue?.count) || !a.compact?.state) throw new Error('Incomplete resource state');
  return a.run.state !== 'idle' || a.queue.count > 0 || a.compact.state !== 'idle';
}

export function createAutomationResources({ listResources, getResource, subscribe = onAutomationActivityHint,
  onIdle = cause => notifyAutomationWake('foreground_idle', cause), coalesceMs = 250, quietMs = 1000,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => console.warn('[automation-resources] Resource observation failed; fail closed') } = {}) {
  const sessions = new Map(), pending = new Set();
  let ready = false, stopped = true, full = false, flushing = null, timer, idleTimer, unsubscribe, starting;
  let lastIdle = false, idlePending = false, generatedAt = '';
  let generation = 0;
  const isIdle = () => ready && ![...sessions.values()].some(busy);
  function cancelIdle() { clearTimer(idleTimer); idleTimer = null; }
  function armIdle(cause) {
    cancelIdle();
    idlePending = true;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!stopped && isIdle() && !flushing && !pending.size && !full) { idlePending = false; onIdle(cause); }
    }, quietMs);
    idleTimer.unref?.();
  }
  async function flush() {
    if (stopped || flushing) return flushing;
    clearTimer(timer); timer = null;
    const observedGeneration = generation;
    flushing = (async () => {
      try {
        const reloadAll = full; full = false;
        const ids = [...pending]; pending.clear();
        if (reloadAll) {
          const rows = await listResources();
          if (stopped || generation !== observedGeneration) return;
          if (!Array.isArray(rows)) throw new Error('Resource list unavailable');
          const next = new Map();
          for (const row of rows) { busy(row); next.set(row.id, row); }
          sessions.clear(); for (const [id, row] of next) sessions.set(id, row);
        } else {
          for (const id of ids) {
            const row = await getResource(id);
            if (stopped || generation !== observedGeneration) return;
            if (row) { busy(row); sessions.set(id, row); } else sessions.delete(id);
          }
        }
        const recovered = !ready;
        ready = true; generatedAt = new Date().toISOString();
        const idle = isIdle();
        if (idle && (!lastIdle || recovered || idlePending)) armIdle(recovered ? 'resource_recovery' : 'foreground_idle');
        else if (!idle) { cancelIdle(); idlePending = false; }
        lastIdle = idle;
      } catch {
        if (stopped || generation !== observedGeneration) return;
        ready = false; lastIdle = false; idlePending = false; cancelIdle(); onError();
      }
    })().finally(() => {
      flushing = null;
      if (!stopped && (pending.size || full)) scheduleFlush();
    });
    return flushing;
  }
  function scheduleFlush() {
    if (stopped || timer || flushing) return;
    timer = setTimer(() => { void flush(); }, coalesceMs); timer.unref?.();
  }
  function hint(id) {
    if (stopped) return;
    cancelIdle();
    if (!ready || !id) full = true; else pending.add(id);
    scheduleFlush();
  }
  async function start() {
    if (!stopped) return starting;
    stopped = false; generation += 1; full = true; unsubscribe = subscribe(hint);
    starting = (async () => { if (flushing) await flushing; await flush(); })(); await starting;
  }
  function stop() {
    stopped = true; generation += 1; ready = false; unsubscribe?.(); unsubscribe = null;
    clearTimer(timer); timer = null; cancelIdle(); idlePending = false; pending.clear(); full = false;
  }
  function snapshot() {
    const known = !stopped && ready && !flushing && !full && !pending.size;
    return { status: known ? 'ready' : 'observing', generatedAt, knownSessionCount: sessions.size,
      sessions: known ? [...sessions.values()].filter(busy) : [],
      host: { loadPerCpu: loadavg()[0] / availableParallelism(), freeMemoryRatio: freemem() / totalmem() } };
  }
  function reconsiderIdle(cause = 'registration') { if (!stopped && isIdle()) armIdle(cause); }
  async function refresh() {
    if (!ready) full = true;
    if (flushing) await flushing;
    if (full || pending.size) await flush();
    return snapshot();
  }
  return { start, stop, snapshot, hint, flush, refresh, reconsiderIdle };
}

let resources, initializing, taskDemand = false;
export async function startAutomationResourceObserver({ wakeCause = '' } = {}) {
  if (wakeCause) taskDemand = true;
  if (!resources) {
    initializing ||= import('./session-manager.mjs').then(manager => {
      resources = createAutomationResources({ listResources: manager.listSessionResources, getResource: manager.getSessionResource,
        onIdle: cause => {
          if (taskDemand) notifyAutomationWake('foreground_idle', cause);
          else resources.stop();
        } });
    }).finally(() => { initializing = null; });
    await initializing;
  }
  await resources.start();
  if (wakeCause) resources.reconsiderIdle(wakeCause);
  return resources.snapshot();
}
export async function getAutomationResourceSnapshot() {
  await startAutomationResourceObserver();
  return resources.refresh();
}
export function stopAutomationResourceObserver() { resources?.stop(); }
export function releaseAutomationResourceObserver() {
  taskDemand = false;
  // Keep observing an active Run's guard until work settles, then release the
  // subscription. A later API read or opted-in task can lazily rebuild it.
  resources?.reconsiderIdle('unused');
}

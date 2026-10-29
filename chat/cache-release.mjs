import { sweepIdleHistoryCaches } from './history.mjs';
import { sweepIdleRunCaches } from './runs.mjs';
import { sweepIdleSessionListViews } from './router-session-main-routes.mjs';

const minutes = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value * 60_000 : fallback * 60_000;
};

// Scheduled release of read-through caches. Budgets cap peak size; this sweep
// returns memory held by data no request has touched within the idle window,
// so hot sessions keep their cache and background scans do not stay resident.
export function startCacheRelease({ intervalMs = minutes('REMOTELAB_CACHE_SWEEP_MINUTES', 5),
  idleMs = minutes('REMOTELAB_CACHE_IDLE_MINUTES', 30),
  listIdleMs = minutes('REMOTELAB_SESSION_LIST_IDLE_MINUTES', 10), log = console.log } = {}) {
  const sweep = () => {
    try {
      const now = Date.now();
      const released = { ...sweepIdleHistoryCaches(idleMs, now), ...sweepIdleRunCaches(idleMs, now),
        listViews: sweepIdleSessionListViews(listIdleMs, now) };
      if (Object.values(released).some(Boolean)) log(`[cache-release] ${JSON.stringify(released)}`);
      return released;
    } catch (error) {
      console.error('[cache-release]', error.message);
      return null;
    }
  };
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { sweep, stop: () => clearInterval(timer) };
}

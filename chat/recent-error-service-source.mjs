import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { recentErrors, recentErrorsConfig } from '../lib/recent-errors.mjs';

// Reuse the local crash observer's bounded projection (not a second journal
// reader). Keep the observation cursor only after every selected event commits;
// SQLite occurrence identity makes restart/replay harmless.
export function startRecentErrorServiceSource({
  file = join(CONFIG_DIR, 'service-incidents', 'state.json'), intervalMs = 60_000,
  config = recentErrorsConfig, monitor = recentErrors,
} = {}) {
  let stopped = false, timer, fileVersion;
  let seen = new Set();
  async function sync() {
    try {
      const options = await config();
      if (options?.enabled !== true || !Array.isArray(options.serviceUnits) || !options.serviceUnits.length) return;
      const size = await stat(file);
      const signature = `${size.ino}:${size.mtimeMs}:${size.size}:${options.serviceUnits.join(',')}`;
      if (signature === fileVersion) return;
      if (size.size > 4 * 1024 * 1024) throw new Error('Unbounded service incident projection');
      const state = await readRecord(file);
      if (!Array.isArray(state?.events) || state.events.length > 256) throw new Error('Service incidents unavailable');
      const activeIds = new Set();
      for (const event of state.events) {
        if (stopped) return;
        if (!options.serviceUnits.includes(event.unit) || !/^[a-f0-9]{64}$/.test(event.id || '')
          || !['javascript_heap_oom', 'os_oom', 'abnormal_exit', 'fatal_error'].includes(event.reason)) continue;
        activeIds.add(event.id);
        if (seen.has(event.id)) continue;
        await monitor.record('service-exit', { operation: event.id, component: event.unit,
          at: event.at, error: event.reason, reference: event.id });
      }
      seen = activeIds;
      fileVersion = signature;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[recent-errors] service-exit source unavailable');
    } finally {
      if (!stopped) { timer = setTimeout(sync, intervalMs); timer.unref(); }
    }
  }
  void sync();
  return () => { stopped = true; clearTimeout(timer); };
}

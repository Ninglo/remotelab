import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { writeDurableJson } from '../lib/durable-records.mjs';

// Small local telemetry only. No transcript, environment, credentials or heap dump.
export function startRuntimeHealth({ file = join(CONFIG_DIR, 'runtime-health.json'), intervalMs = 10_000 } = {}) {
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  let gcMs = 0, gcCount = 0, writing = false;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { gcMs += entry.duration; gcCount++; }
  });
  observer.observe({ entryTypes: ['gc'] });
  const sample = async () => {
    if (writing) return;
    writing = true;
    const value = { version: 1, pid: process.pid, observedAt: new Date().toISOString(), uptimeSeconds: process.uptime(),
      ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit,
      eventLoopP99Ms: Number.isFinite(lag.percentile(99)) ? lag.percentile(99) / 1e6 : null,
      gcMs, gcCount };
    gcMs = 0; gcCount = 0; lag.reset();
    try { await writeDurableJson(file, value); }
    catch (error) { console.error('[runtime-health]', error.code || error.message); }
    finally { writing = false; }
  };
  void sample();
  const timer = setInterval(sample, intervalMs); timer.unref();
  return () => { clearInterval(timer); observer.disconnect(); lag.disable(); };
}

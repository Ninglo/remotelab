import { setTimeout as delay } from 'node:timers/promises';
import { serialQueue } from './durable-records.mjs';

// Concurrency alone does not bound QPS when reads finish quickly. Share this
// pacer across document comment pages and replies in one connector runtime.
export function createFeishuReadPacer({ intervalMs = 400, now = Date.now, wait = delay } = {}) {
  const queue = serialQueue();
  let interval = intervalMs, nextAt = 0;
  const limited = result => {
    const code = Number(result?.code ?? result?.response?.data?.code);
    const status = result?.httpStatus ?? result?.response?.status;
    if (code !== 99991400 && status !== 429) return;
    interval = Math.min(4000, Math.max(400, interval * 2));
    nextAt = now() + Math.max(5000, Math.min(3_600_000, Number(result?.retryAfterMs) || 0));
  };
  return task => queue(async () => {
    const remaining = nextAt - now();
    if (remaining > 0) await wait(remaining);
    nextAt = now() + interval;
    try { const result = await task(); limited(result); return result; }
    catch (error) { limited(error); throw error; }
  });
}

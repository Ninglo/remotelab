import { watch } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from './durable-records.mjs';

export async function notifyCodexAllocation(root) {
  await writeFile(join(root, 'allocation-change'), randomUUID());
}

export async function readCodexAllocationWaiters(root) {
  const directory = join(root, 'waiting');
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter(name => /^[\da-f-]+\.json$/.test(name))) {
    const path = join(directory, name);
    const record = await readRecord(path);
    if (!record) continue;
    let alive = Number.isInteger(record.pid) && record.pid > 0;
    if (alive) try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
    if (alive && record.deadline > Date.now()) records.push(record);
    else await rm(path, { force: true });
  }
  return records;
}

// Cross-process notifications cover release and config/quota changes. A bounded
// liveness check also recovers slots when a runner dies without releasing them.
// Install the watcher before testing capacity, so releases cannot be lost
// between the failed admission and entering the wait.
export async function acquireWithCodexCapacityWait(pool, options, acquire) {
  const configured = Number(process.env.REMOTELAB_CODEX_CAPACITY_WAIT_MS);
  const timeoutMs = options.waitTimeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : 600_000);
  const deadline = Date.now() + timeoutMs;
  await mkdir(pool.root, { recursive: true });
  let version = 0, wake = null, waitingPath = null, watcherError = null;
  const watcher = watch(pool.root, (_, name) => {
    if (!name || ['accounts.json', 'allocation-change'].includes(String(name))) { version++; wake?.(); }
  });
  watcher.on('error', error => { watcherError = error; wake?.(); });
  try {
    for (;;) {
      if (watcherError) throw watcherError;
      if (await options.isCancelled?.()) throw Object.assign(new Error('已取消等待 Codex 账号名额'), { code: 'PROVIDER_RUNTIME_QUEUE_CANCELLED' });
      const observed = version;
      try {
        const slot = await acquire();
        try {
          if (waitingPath) await options.onReady?.(slot);
          return slot;
        } catch (error) { await slot.lease.release(); throw error; }
      } catch (error) {
        if (error.code !== 'CODEX_ACCOUNT_CAPACITY_WAIT' || options.wait === false) throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error('等待 Codex 账号名额超时；可调整账号并发上限或稍后重试'),
          { code: 'CODEX_ACCOUNT_WAIT_TIMEOUT', routingReasons: error.routingReasons });
        if (!waitingPath) {
          waitingPath = join(pool.root, 'waiting', randomUUID() + '.json');
          await writeDurableJson(waitingPath, { pid: process.pid, runId: options.runId || '',
            sessionId: options.sessionId || '', queuedAt: new Date().toISOString(), deadline });
          await options.onWait?.({ reasons: error.routingReasons, deadline: new Date(deadline).toISOString() });
        }
        if (version !== observed) continue;
        await new Promise(resolve => {
          const timer = setTimeout(done, Math.max(1, Math.min(2000, deadline - Date.now(),
            Number.isFinite(error.retryAt) ? error.retryAt - Date.now() : Infinity)));
          function done() { clearTimeout(timer); wake = null; resolve(); }
          wake = done;
          if (version !== observed || watcherError) done();
        });
      }
    }
  } finally {
    watcher.close();
    if (waitingPath) await rm(waitingPath, { force: true });
  }
}

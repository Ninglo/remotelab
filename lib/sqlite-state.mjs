import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

let worker, sequence = 0;
const pending = new Map();
function startWorker() {
  const current = new Worker(new URL('./sqlite-state-worker.mjs', import.meta.url), {
    execArgv: [], // Parent CLI/test-runner flags are not worker startup options.
  });
  worker = current;
  function failed(error) {
    if (worker !== current) return;
    worker = null;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  current.on('error', failed);
  current.on('exit', code => failed(new Error(`SQLite worker exited (${code})`)));
  current.on('message', ({ id, result, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) {
      const failure = error.name === 'SyntaxError' ? new SyntaxError(error.message) : new Error(error.message);
      Object.assign(failure, error); request.reject(failure);
    } else request.resolve(result);
    if (!pending.size) current.unref();
  });
  return current;
}

// The existing JSON pathname stays the public identifier; SQLite is adjacent.
export function sqliteState(pathname, operation, args = {}) {
  const current = worker || startWorker();
  current.ref();
  return new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveRequest, reject });
    current.postMessage({ id, pathname: resolve(pathname), operation, args });
  });
}

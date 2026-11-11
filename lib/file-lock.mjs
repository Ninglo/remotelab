import { fork } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

let broker = null, sequence = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function lockBroker() {
  if (broker) return broker;
  // Fork once while this helper stays small. Spawning flock from a multi-GB
  // chat process for every history write blocks the parent's event loop.
  const child = fork(new URL('./file-lock-broker.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const current = { child, pending: new Map() };
  broker = current;
  const failed = error => {
    if (broker === current) broker = null;
    for (const request of current.pending.values()) {
      request.acquired.reject(error); request.released.reject(error);
    }
    current.pending.clear();
  };
  child.on('error', failed);
  child.on('exit', (code, signal) => failed(new Error(`FILE_LOCK_BROKER_EXITED: ${signal || code}`)));
  child.on('disconnect', () => failed(new Error('FILE_LOCK_BROKER_DISCONNECTED')));
  child.on('message', ({ id, state, error }) => {
    const request = current.pending.get(id);
    if (!request) return;
    if (error) {
      const failure = new Error(`FILE_LOCK_UNAVAILABLE: ${error}`);
      request.acquired.reject(failure); request.released.reject(failure);
    } else if (state === 'acquired') request.acquired.resolve();
    else if (state === 'released') request.released.resolve();
  });
  return current;
}

// Same kernel flock and pathname as offline/older writers. Independent files
// acquire concurrently; the helper does not serialize unrelated work.
export async function withFileLock(file, operation) {
  await mkdir(dirname(file), { recursive: true });
  const current = lockBroker(), id = ++sequence;
  const request = { acquired: deferred(), released: deferred() };
  current.pending.set(id, request);
  current.child.ref(); current.child.channel?.ref();
  const send = message => current.child.send(message, error => {
    if (error) { request.acquired.reject(error); request.released.reject(error); }
  });
  try {
    send({ id, action: 'acquire', file: resolve(file) });
    await request.acquired.promise;
    try { return await operation(); }
    finally {
      send({ id, action: 'release' });
      await request.released.promise;
    }
  } finally {
    current.pending.delete(id);
    if (!current.pending.size) { current.child.unref(); current.child.channel?.unref(); }
  }
}

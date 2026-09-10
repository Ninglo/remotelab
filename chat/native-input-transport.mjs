import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson, readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const address = directory => join(tmpdir(), `remotelab-native-${process.getuid?.() ?? 'user'}`, `${digest(resolve(directory))}.sock`);
const receiptPath = (directory, id) => join(directory, 'native-inputs', `${digest(id)}.json`);
const fault = (message, code) => Object.assign(new Error(message), { code });
export const readNativeInputReceipt = (directory, id) => readRecord(receiptPath(directory, id));

function replay(receipt, input) {
  if (receipt.fingerprint !== canonicalJson(input)) throw fault('Native input id already has different content', 'NATIVE_CONFLICT');
  if (receipt.state === 'accepted') return receipt.result;
  if (receipt.state === 'rejected') throw fault(receipt.error, 'NATIVE_REJECTED');
  throw fault('Native input dispatch outcome is not yet known; it must not be replayed', 'NATIVE_UNCERTAIN');
}

// This journal records transport outcomes, never schedules model turns. The
// sidecar survives controller restart and is the only writer of these receipts.
export async function createNativeInputServer({ directory, submit, isAccepting, onIdle = () => {} }) {
  const socketPath = address(directory);
  const parent = join(socketPath, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const owner = await lstat(parent);
  if (!owner.isDirectory() || (owner.mode & 0o077) || (process.getuid && owner.uid !== process.getuid())) {
    throw new Error('Native control socket directory must be private and owned by this user');
  }
  const inFlight = new Map();
  const connections = new Set();
  let closed = false;
  const dispatch = async input => {
    if (typeof input?.id !== 'string' || !input.id || typeof input.text !== 'string') throw new Error('Native input requires id and text');
    const fingerprint = canonicalJson(input);
    const pending = inFlight.get(input.id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw fault('Native input id already has different content', 'NATIVE_CONFLICT');
      return pending.promise;
    }
    // Reserve this identity before the first asynchronous read or eligibility
    // check. A slow cancellation check must not outlive a peer's completed
    // handoff and then dispatch that same input again.
    const task = (async () => {
      const existing = await readNativeInputReceipt(directory, input.id);
      if (existing) return replay(existing, input);
      if (closed || !(await isAccepting())) return { accepted: false, reason: 'settled' };
      const receipt = { id: input.id, fingerprint, state: 'dispatching', dispatchedAt: new Date().toISOString() };
      await writeDurableJson(receiptPath(directory, input.id), receipt);
      try {
        const result = await submit(input);
        await writeDurableJson(receiptPath(directory, input.id), { ...receipt, state: 'accepted', result, acceptedAt: new Date().toISOString() });
        return result;
      } catch (error) {
        // Uncertain failures cannot be reclassified as a rejection: repeating
        // a tool-producing prompt could repeat external side effects.
        if (error.code === 'NATIVE_REJECTED') await writeDurableJson(receiptPath(directory, input.id), { ...receipt, state: 'rejected', error: error.message });
        throw error;
      }
    })();
    inFlight.set(input.id, { fingerprint, promise: task });
    try { return await task; } finally { inFlight.delete(input.id); onIdle(); }
  };
  const server = createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      void Promise.resolve().then(() => dispatch(JSON.parse(buffer.slice(0, end))))
        .then(result => socket.end(`${JSON.stringify({ result })}\n`), error => socket.end(`${JSON.stringify({ error: error.message, code: error.code || 'NATIVE_UNCERTAIN' })}\n`));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return {
    get pending() { return inFlight.size; },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...inFlight.values()].map(entry => entry.promise));
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(socketPath, { force: true });
    },
  };
}

export async function submitNativeInput(directory, input, { timeoutMs = 30_000 } = {}) {
  const receipt = await readNativeInputReceipt(directory, input.id);
  if (receipt?.state === 'accepted' || receipt?.state === 'rejected') return replay(receipt, input);
  return new Promise((resolve, reject) => {
    const socket = createConnection(address(directory));
    let connected = false;
    let settled = false;
    let buffer = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(fault('Native input acknowledgement timed out', 'NATIVE_UNCERTAIN')));
    socket.once('connect', () => { connected = true; socket.write(`${JSON.stringify(input)}\n`); });
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      try { const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); finish(reply.error ? fault(reply.error, reply.code) : null, reply.result); }
      catch (error) { finish(fault(error.message, 'NATIVE_UNCERTAIN')); }
    });
    socket.once('error', error => finish(fault(error.message, !connected && !receipt ? 'NATIVE_UNAVAILABLE' : 'NATIVE_UNCERTAIN')));
    socket.once('close', () => finish(fault('Native input channel closed before acknowledgement', 'NATIVE_UNCERTAIN')));
  });
}

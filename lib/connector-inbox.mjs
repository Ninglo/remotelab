import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, createRecordStore, readRecord, serialQueue, writeDurableJson } from './durable-records.mjs';

export function createConnectorInbox(root, { process, conversationKey, onError = console.error }) {
  const store = createRecordStore(root);
  const admission = serialQueue();
  const dispatch = serialQueue();
  const running = new Map();
  let timer = null;
  let pendingTicks = 0;
  const wake = () => { if (timer) void tick(true).catch(onError); };
  const consume = async record => {
    try {
      const receipt = await process(record, patch => store.mutate(record.key, current => ({ ...current, ...patch })));
      await store.mutate(record.key, current => ({ ...current, receipt: receipt || {}, complete: true }));
      await store.archive(record.key);
    } catch (error) {
      await store.mutate(record.key, current => ({ ...current, lastError: error.message, nextAttemptAt: Date.now() + 5000 }));
      onError(error);
    }
  };
  const tick = (automatic = false) => {
    pendingTicks++;
    return dispatch(async () => {
      if (automatic && !timer) return;
      const seen = new Set();
      for (const snapshot of await store.active()) {
        const key = conversationKey(snapshot);
        if (seen.has(key)) continue;
        if (running.has(key)) { seen.add(key); continue; }
        // A previous consumer can finish while the directory scan is reading.
        // Recheck the durable receipt before starting work from that snapshot.
        const record = await store.get(snapshot.key);
        if (!record) continue;
        if (record.complete) { await store.archive(record.key); continue; }
        seen.add(key);
        if (record.nextAttemptAt > Date.now()) continue;
        if (automatic && !timer) return;
        const promise = consume(record).catch(onError).finally(() => {
          running.delete(key);
          wake();
        });
        running.set(key, promise);
      }
    }).finally(() => { pendingTicks--; });
  };
  return {
    store, tick,
    accept: (id, envelope) => admission(async () => {
      if (!id) throw new Error('Upstream event id is required');
      const key = createHash('sha256').update(id).digest('hex').slice(0, 24);
      const fingerprint = canonicalJson(envelope.summary || envelope);
      const existing = await store.get(key);
      if (existing) {
        // Legacy handled receipts predate complete event fingerprints. They reserve
        // the upstream ID without executing a replay with newly added fields.
        if (existing.id === id && existing.complete && existing.legacyReceiptImported
          && existing.receipt?.legacyHandledMessageId === id) return existing;
        if (existing.fingerprint !== fingerprint) throw new Error('Upstream event id already accepted with different content');
        if (!existing.complete) wake();
        return existing;
      }
      const counter = join(root, 'sequence.json');
      const sequence = ((await readRecord(counter))?.value || 0) + 1;
      await writeDurableJson(counter, { value: sequence });
      const record = await store.mutate(key, () => ({ ...envelope, fingerprint, sequence, id, complete: false, nextAttemptAt: 0 }));
      wake();
      return record;
    }),
    // The interval recovers missed wakeups and due retries; new input and
    // completed HTTP handoffs do not wait for it or for any model response.
    start() { if (!timer) { timer = setInterval(wake, 1000); wake(); } },
    stop() { clearInterval(timer); timer = null; },
    async idle() {
      await admission.idle();
      do {
        await dispatch.idle();
        await Promise.all(running.values());
        await store.idle();
      } while (pendingTicks || running.size);
    },
  };
}

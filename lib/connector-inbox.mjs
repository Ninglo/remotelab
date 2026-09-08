import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, createRecordStore, readRecord, serialQueue, writeDurableJson } from './durable-records.mjs';

export function createConnectorInbox(root, { process, conversationKey, onError = console.error }) {
  const store = createRecordStore(root);
  const admission = serialQueue();
  const running = new Map();
  let timer = null;
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
  const tick = async () => {
    const seen = new Set();
    for (const record of await store.active()) {
      if (record.complete) { await store.archive(record.key); continue; }
      const key = conversationKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      if (running.has(key) || record.nextAttemptAt > Date.now()) continue;
      const promise = consume(record).finally(() => running.delete(key));
      running.set(key, promise);
    }
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
        return existing;
      }
      const counter = join(root, 'sequence.json');
      const sequence = ((await readRecord(counter))?.value || 0) + 1;
      await writeDurableJson(counter, { value: sequence });
      return store.mutate(key, () => ({ ...envelope, fingerprint, sequence, id, complete: false, nextAttemptAt: 0 }));
    }),
    start() { if (!timer) { timer = setInterval(() => void tick().catch(onError), 1000); void tick().catch(onError); } },
    stop() { clearInterval(timer); timer = null; },
    async idle() { await admission.idle(); await Promise.all(running.values()); await store.idle(); },
  };
}

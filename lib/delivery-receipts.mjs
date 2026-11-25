import { createHash } from 'node:crypto';
import { createRecordStore } from './durable-records.mjs';

// The sender keeps evidence until the control plane acknowledges it. Replaying
// this journal only repeats a local acknowledgement, never an external send.
export function createDeliveryReceipts(root) {
  const store = createRecordStore(root);
  const keyOf = receipt => createHash('sha256').update(`${receipt.deliveryId}:${receipt.leaseId}`).digest('hex').slice(0, 24);
  const record = receipt => store.mutate(keyOf(receipt), existing => existing || { ...receipt, sequence: Date.now() });
  const busy = new Set();
  async function acknowledgeOne(key, acknowledge, options) {
    if (busy.has(key)) return;
    busy.add(key);
    try {
      const receipt = await store.getActive(key);
      const now = options.now ?? Date.now();
      if (!receipt || receipt.nextAttemptAt > now) return;
      try {
        const result = await acknowledge(receipt);
        await store.archive(key);
        return result;
      } catch (error) {
        if (!options.continueOnError) throw error;
        await store.mutate(key, current => ({ ...current,
          lastError: String(error?.message || error).slice(0, 2000), nextAttemptAt: now + 30_000,
        }));
        options.onError?.(error, receipt);
      }
    } finally { busy.delete(key); }
  }
  return {
    record,
    acknowledge: (receipt, acknowledge, options = {}) =>
      acknowledgeOne(keyOf(receipt), acknowledge, options),
    async flush(acknowledge, options = {}) {
      const now = options.now ?? Date.now();
      const started = Date.now();
      let attempted = 0;
      for (const receipt of await store.active()) {
        if (receipt.nextAttemptAt > now || busy.has(receipt.key) || options.skip?.(receipt)) continue;
        if (attempted >= (options.limit ?? Infinity) || Date.now() - started >= (options.budgetMs ?? Infinity)) break;
        attempted++;
        await acknowledgeOne(receipt.key, acknowledge, { ...options, now });
      }
    },
  };
}

import { createHash } from 'node:crypto';
import { createRecordStore } from './durable-records.mjs';

// The sender keeps evidence until the control plane acknowledges it. Replaying
// this journal only repeats a local acknowledgement, never an external send.
export function createDeliveryReceipts(root) {
  const store = createRecordStore(root);
  return {
    record: receipt => store.mutate(createHash('sha256').update(`${receipt.deliveryId}:${receipt.leaseId}`).digest('hex').slice(0, 24),
      existing => existing || { ...receipt, sequence: Date.now() }),
    async flush(acknowledge, options = {}) {
      const now = options.now ?? Date.now();
      const started = Date.now();
      let attempted = 0;
      for (const receipt of await store.active()) {
        if (receipt.nextAttemptAt > now) continue;
        if (attempted >= (options.limit ?? Infinity) || Date.now() - started >= (options.budgetMs ?? Infinity)) break;
        attempted++;
        try {
          await acknowledge(receipt);
          await store.archive(receipt.key);
        } catch (error) {
          if (!options.continueOnError) throw error;
          await store.mutate(receipt.key, current => ({ ...current,
            lastError: String(error?.message || error).slice(0, 2000), nextAttemptAt: now + 30_000,
          }));
          options.onError?.(error, receipt);
        }
      }
    },
  };
}

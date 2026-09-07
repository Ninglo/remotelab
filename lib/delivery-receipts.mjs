import { createHash } from 'node:crypto';
import { createRecordStore } from './durable-records.mjs';

// The sender keeps evidence until the control plane acknowledges it. Replaying
// this journal only repeats a local acknowledgement, never an external send.
export function createDeliveryReceipts(root) {
  const store = createRecordStore(root);
  return {
    record: receipt => store.mutate(createHash('sha256').update(`${receipt.deliveryId}:${receipt.leaseId}`).digest('hex').slice(0, 24),
      existing => existing || { ...receipt, sequence: Date.now() }),
    async flush(acknowledge) {
      for (const receipt of await store.active()) {
        await acknowledge(receipt);
        await store.archive(receipt.key);
      }
    },
  };
}

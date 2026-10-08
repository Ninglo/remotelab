import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore } from '../../lib/durable-records.mjs';

const keyFor = messageId => createHash('sha256').update(messageId).digest('hex').slice(0, 24);

// Keep the Bot's temporary reaction ID until the final reaction has replaced it.
// The same store survives connector restarts and event redelivery.
export function createFeishuReadReactionStore(root) {
  const records = createRecordStore(join(root, 'read-reactions'));
  return {
    active: records.active,
    async add(messageId, create, source = null) {
      const key = keyFor(messageId);
      const previous = await records.get(key);
      if (previous?.reactionId) return { reactionId: previous.reactionId };
      const receipt = await create();
      if (!receipt?.reactionId) return receipt;
      await records.mutate(key, current => current || {
        messageId, reactionId: receipt.reactionId, removed: false, sequence: Date.now(),
        ...(source ? { source } : {}),
      });
      return receipt;
    },
    async remove(messageId, removeReaction) {
      if (!messageId) return false;
      const key = keyFor(messageId);
      const receipt = await records.get(key);
      if (!receipt?.reactionId || receipt.removed) return false;
      try {
        await removeReaction(messageId, receipt.reactionId);
      } catch (error) {
        // A prior DELETE may have succeeded before its local receipt was saved.
        // The ID came from this Bot's successful create call, so invalid ID now
        // means the temporary reaction is already gone.
        if (Number(error?.code || error?.response?.data?.code) !== 231011) throw error;
      }
      await records.mutate(key, current => ({ ...current, removed: true }));
      await records.archive(key);
      return true;
    },
  };
}

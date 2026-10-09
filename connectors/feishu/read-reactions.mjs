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

// Track only IDs created by this connector/Bot. Replace its own outcome after
// the new create receipt is durable; cleanup retries through delivery receipts.
export function createFeishuOutcomeReactionStore(root) {
  const records = createRecordStore(join(root, 'outcome-reactions'));
  const queues = new Map();
  const serial = async (messageId, fn) => {
    const key = keyFor(messageId);
    const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(() => fn(key));
    queues.set(key, task);
    try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
  };
  return {
    apply(messageId, emojiType, create, { stage = 1 } = {}) {
      return serial(messageId, async key => {
        const previous = await records.get(key);
        if ((previous?.stage || 1) > stage) return { reactionId: previous.reactionId, superseded: true };
        const receipt = previous?.emojiType === emojiType && previous.reactionId
          ? { reactionId: previous.reactionId } : await create();
        if (!receipt?.reactionId) return receipt;
        const pending = new Set(previous?.pendingRemoval || []);
        if (previous?.reactionId && previous.reactionId !== receipt.reactionId) pending.add(previous.reactionId);
        pending.delete(receipt.reactionId);
        await records.mutate(key, () => ({ messageId, emojiType, reactionId: receipt.reactionId,
          stage, pendingRemoval: [...pending], sequence: previous?.sequence || Date.now() }));
        return receipt;
      });
    },
    clean(messageId, remove) {
      if (!messageId) return Promise.resolve();
      return serial(messageId, async key => {
        const current = await records.get(key);
        for (const id of current?.pendingRemoval || []) {
          try { await remove(messageId, id); }
          catch (error) { if (Number(error?.code || error?.response?.data?.code) !== 231011) throw error; }
          await records.mutate(key, value => ({ ...value,
            pendingRemoval: value.pendingRemoval.filter(pending => pending !== id) }));
        }
      });
    },
  };
}

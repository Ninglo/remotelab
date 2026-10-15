import { submitNativeInput } from './native-input-transport.mjs';
import { requiresFeishuReplyPlacement } from './ambient-feishu-reply.mjs';

// One structural transport error, delivered only to the still-active native
// execution. This does not classify the task, review prose, or start a Run.
export async function notifyMissingFeishuReplyPlacement(record, { store, run, manifest, directory,
  submit = submitNativeInput } = {}) {
  const current = await store.get(record.key);
  if (!requiresFeishuReplyPlacement(current) || !current.replyPlacementMissing || current.replyPlacement
      || current.replyPlacementFeedback || current.result || current.cancelRequestedAt
      || current.routingHandoff || current.options?.suppressSourceDelivery
      || manifest?.inputMode !== 'native' || run?.cancelRequested
      || ['completed', 'failed', 'cancelled'].includes(run?.state)) return;
  let claimed = false;
  await store.mutate(record.key, value => {
    if (value.replyPlacementFeedback || value.replyPlacement || value.result || value.cancelRequestedAt) return value;
    claimed = true;
    return { ...value, replyPlacementFeedback: { state: 'attempted', at: new Date().toISOString() } };
  });
  if (!claimed) return;
  const input = {
    id: `feishu-placement:${run.id}`, continuationOnly: true, referenceOnly: true,
    text: 'RemoteLab delivery protocol error (not a new human request): your reply has no explicit Feishu placement and has not been sent. In this same execution, select <private>feishu-reply:inline</private> for a brief group answer or <private>feishu-reply:thread</private> for a distinct substantive discussion, after any optional reaction directive and before the next visible reply. Reuse completed work and incorporate related supplementary inputs; do not rerun tools or repeat business actions. No other model has chosen the location for you.',
  };
  let feedback;
  try {
    const receipt = await submit(directory, input, { timeoutMs: 5000 });
    feedback = { state: receipt?.accepted ? 'accepted' : 'unavailable', receipt };
  } catch (error) {
    feedback = { state: 'unavailable', error: error.message, code: error.code || '' };
  }
  await store.mutate(record.key, value => ({ ...value,
    replyPlacementFeedback: { ...value.replyPlacementFeedback, ...feedback } }));
}

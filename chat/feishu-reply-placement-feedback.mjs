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
    text: current.options?.sourceContext?.feishuThreadSessionVersion === 1
      ? 'RemoteLab reply has not been sent: a new thread requires its own Session. Use work route mode:new for this accepted input before further business work; supply the original task, necessary context and any work already completed so it is not repeated. The new Session owns the thread and reply. For a brief mainline answer, use feishu-response replyMode:inline instead. Do not repeat tools or external actions.'
      : 'RemoteLab delivery protocol error (not a new human request): your reply has no explicit Feishu placement and has not been sent. In this same execution, use the hidden feishu-response decision with replyMode inline for a brief group answer or thread for a distinct substantive discussion before the next visible reply. Keep optional reaction and answered requestIds in that same decision. Reuse completed work and incorporate related supplementary inputs; do not rerun tools or repeat business actions. No other model has chosen the location for you.',
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

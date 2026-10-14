import { normalizeConversation, sameConversation } from '../lib/conversation-target.mjs';
import { requests } from './requests.mjs';
import { getRun, getRunManifest } from './runs.mjs';

export function hasDeliveredFeishuThread(record, value) {
  const conversation = normalizeConversation(value);
  return conversation?.connector === 'feishu' && conversation.target.conversationKind === 'thread'
    && Boolean(record?.deliveries?.some(part => part.state === 'delivered'
      && ['content', 'attachment'].includes(part.kind)
      && part.target?.sourceKind === 'ambient_thread_open'
      && sameConversation({ ...part, target: { ...part.target,
        ...(part.deliveredThreadId ? { threadId: part.deliveredThreadId } : {}) } }, conversation)));
}

// A delivered thread is a reply surface of its still-running execution. Use
// the existing Request/outbox as evidence, never a permanent second binding.
export async function findActiveFeishuThreadExecution(value, {
  store = requests, readRun = getRun, readManifest = getRunManifest,
} = {}) {
  const conversation = normalizeConversation(value);
  if (conversation?.connector !== 'feishu' || conversation.target.conversationKind !== 'thread') return null;
  const candidates = await store.projectActive(records => records.filter(record =>
    !record.result && !record.releasedAt && !record.cancelRequestedAt && !record.nativeDispatchRunId
    && !record.options?.deliveryOnly && !record.options?.internalOperation
    && hasDeliveredFeishuThread(record, conversation)));
  // Conflicting evidence cannot pick an execution on the user's behalf.
  if (candidates.length !== 1) return null;
  const record = candidates[0];
  const [run, manifest] = await Promise.all([readRun(record.runId), readManifest(record.runId)]);
  if (!run || run.cancelRequested || ['completed', 'cancelled', 'failed'].includes(run.state)
      || manifest?.inputMode !== 'native' || manifest.options?.feishuThreadContinuationVersion !== 1) return null;
  return { sessionId: record.sessionId, continuationRunId: record.runId };
}

export const THREAD_CONTINUATION_EXPIRED = 'THREAD_CONTINUATION_EXPIRED';
export const threadContinuationExpired = () => Object.assign(new Error(
  '原执行已结束或正在停止，这条追加消息不能启动另一个执行。'), { code: THREAD_CONTINUATION_EXPIRED });

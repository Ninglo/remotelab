import { threadContinuationExpired, sameFeishuConversation } from './feishu-thread-continuation.mjs';
import { submitNativeInput, readNativeInputReceipt } from './native-input-transport.mjs';
import { nativeQuestionReplyText } from './native-user-questions.mjs';
import { hasFeishuInputReplyContract } from '../lib/feishu-response-decision.mjs';

const terminal = run => ['completed', 'failed', 'cancelled'].includes(run?.state);
const endedContinuation = error => /Original execution ended|continuation cannot (?:re)?start/.test(String(error || ''));
const now = () => new Date().toISOString();

// Admission and dispatch must agree on whether this request may join the
// current execution. Internal work stays sequential on either side of the pair.
export function canForwardNativeRequest(record, head) {
  if (!record || !head || record.key === head.key || record.preparedAt || record.executionClaimedAt
      || record.options?.freshThread || head.cancelRequestedAt
      || record.options?.internalOperation || record.options?.routingRethink
      || head.options?.routingRethink || record.options?.reviewFeedback || record.options?.workPlanReview || head.options?.workPlanReview) return false;
  if (!record.options?.nativeQuestionId && (record.options?.confirmedHandoff || head.options?.confirmedHandoff || head.options?.reviewFeedback)) return false;
  if (record.nativeDeclinedRunIds?.includes(head.runId)) return false;
  if (!record.options?.nativeQuestionId
      && (record.options?.sourceContext?.feishuThreadSessionVersion || 0)
        !== (head.options?.sourceContext?.feishuThreadSessionVersion || 0)) return false;
  const origin = record.options?.sourceContext?.feishuThreadOriginRunId;
  const headOrigin = head.options?.sourceContext?.feishuThreadOriginRunId;
  if (!record.options?.nativeQuestionId && (origin || headOrigin)) {
    if (origin !== head.runId && record.options?.sourceContext?.feishuContinuationRunId !== head.runId && (!origin || origin !== headOrigin)) return false;
    if (headOrigin && !sameFeishuConversation(record.options?.sourceDelivery, head.options?.sourceDelivery)) return false;
  }
  const recordSource = record.options?.sourceDelivery, headSource = head.options?.sourceDelivery;
  if (!record.options?.nativeQuestionId && !origin && !headOrigin
      && record.options?.sourceContext?.feishuResponseProtocolVersion === 1 && recordSource?.connector === 'feishu' && headSource?.connector === 'feishu'
      && (recordSource.target?.conversationKind === 'thread' || headSource.target?.conversationKind === 'thread')
      && !sameFeishuConversation(recordSource, headSource)) return false;
  if (!origin && record.options?.sourceContext?.feishuContinuationRunId
      && record.options.sourceContext.feishuContinuationRunId !== head.runId) return false;
  if (!record.options?.nativeQuestionId && (record.options?.sourceContext?.documentBinding
      || head.options?.sourceContext?.documentBinding || head.options?.internalOperation)) return false;
  if (!record.options?.nativeQuestionId && !origin
      && (record.options?.messageRoutingPolicy?.mechanism || 'legacy')
        !== (head.options?.messageRoutingPolicy?.mechanism || 'legacy')) return false;
  // A pre-upgrade turn does not know the per-input reply contract. Preserve its
  // accepted behavior; only two new-protocol pilot inputs may share execution.
  if (!record.options?.nativeQuestionId && (hasFeishuInputReplyContract(record) || hasFeishuInputReplyContract(head))
      && !(hasFeishuInputReplyContract(record) && hasFeishuInputReplyContract(head))) return false;
  if (!record.options?.nativeQuestionId && !origin && !record.options?.sourceContext?.feishuContinuationRunId
      && record.options?.sourceContext?.connector === 'feishu' && head.options?.sourceContext?.connector === 'feishu'
      && (record.options.sourceContext.feishuReplyPlacementVersion || 0)
        !== (head.options.sourceContext.feishuReplyPlacementVersion || 0)) return false;
  const a = record.runtimeSelection || {};
  const b = head.runtimeSelection || {};
  return ['tool', 'model', 'effort', 'thinking'].every(key => (a[key] || '') === (b[key] || ''));
}

// Each pending promise waits only for a native input receipt. It never prevents
// the next input from reaching the same Harness, including Claude's delayed ack.
export function createNativeRequestDispatcher({ store, getRun, getManifest, runDirectory, prepareInput, recordInput, settle, changed, onError, reject: rejectInput }) {
  const tasks = new Map();
  const reject = rejectInput || (async (record, error) => {
    await store.settle(record.key, { state: 'failed', payload: null, error });
    await store.mutate(record.key, current => ({ ...current, releasedAt: now(), postCompletionPending: false }));
  });
  const clear = record => record.options?.sourceContext?.feishuContinuationRunId && !record.options.sourceContext.feishuThreadOriginRunId
    ? reject(record, threadContinuationExpired().message)
    : store.mutate(record.key, current => ({ ...current, nativeDeclinedRunIds: [...new Set([...(current.nativeDeclinedRunIds || []), current.nativeDispatchRunId].filter(Boolean))], nativeDispatchRunId: null, nativeInput: null, nativeReceipt: null, nativeContextDelivery: null, nativeRuleContextDelivery: null }));
  const send = async record => {
    const rootId = record.nativeDispatchRunId;
    const run = await getRun(rootId);
    const receipt = await readNativeInputReceipt(runDirectory(rootId), record.requestId);
    if (record.nativeReceipt || receipt?.state === 'accepted') {
      if (!record.nativeReceipt) record = await store.mutate(record.key, current => ({ ...current, nativeReceipt: receipt.result, preparedAt: current.preparedAt || now() }));
      await settle(record, run);
      return;
    }
    const expiredQuestion = () => reject(record, '这道问题已结束，这条回答未应用；请说明要修改哪项选择。');
    if ((run?.cancelRequested || run?.state === 'cancelled') && !receipt) {
      if (record.nativeInput?.questionId) await expiredQuestion();
      else await reject(record, '原执行已停止，这条尚未送入的追加消息已保留，不会自动重新开工。');
      return;
    }
    if (record.options?.sourceContext?.feishuThreadOriginRunId && receipt?.state === 'rejected'
        && endedContinuation(receipt.error) && !run?.cancelRequested && run?.state !== 'cancelled') { await clear(record); return; }
    if (terminal(run)) {
      if (!receipt) { if (record.nativeInput?.questionId) await expiredQuestion(); else await clear(record); return; }
      await reject(record, receipt.error || 'Native input acknowledgement was lost; automatic replay was suppressed.');
      return;
    }
    try {
      const result = await submitNativeInput(runDirectory(rootId), record.nativeInput);
      if (!result?.accepted) { if (record.nativeInput?.questionId) await expiredQuestion(); else await clear(record); return; }
      record = await store.mutate(record.key, current => ({ ...current, nativeReceipt: result, preparedAt: current.preparedAt || now() }));
      await settle(record, await getRun(rootId));
    } catch (error) {
      // A missing endpoint is normal while a detached runner initializes. A
      // receipt with unknown outcome remains attached and can only be queried,
      // never converted into a fresh model run.
      if (error.code === 'NATIVE_REJECTED' && endedContinuation(error.message) && record.options?.sourceContext?.feishuThreadOriginRunId) {
        const latest = await getRun(rootId);
        if (!latest?.cancelRequested && latest?.state !== 'cancelled') { await clear(record); return; }
      }
      if (error.code === 'NATIVE_REJECTED' || error.code === 'NATIVE_CONFLICT') { await reject(record, error.message); return; }
      if (!['NATIVE_UNAVAILABLE', 'NATIVE_UNCERTAIN'].includes(error.code)) throw error;
    }
  };
  return {
    async forward(record, head) {
      if (record.releasedAt || record.result || tasks.has(record.key)) return;
      if (!record.nativeDispatchRunId) {
        if (!canForwardNativeRequest(record, head)) return;
        const manifest = await getManifest(head.runId);
        if (manifest?.inputMode !== 'native') return;
        if ((await getRun(head.runId))?.cancelRequested) return;
        const prepared = await prepareInput(record, manifest);
        const text = typeof prepared === 'string' ? prepared : prepared.text;
        const context = typeof prepared === 'string' ? '' : prepared.context || '';
        record = await store.mutate(record.key, current => current.releasedAt || current.executionClaimedAt ? current : ({ ...current,
          nativeDispatchRunId: head.runId, liveReplyPublicationVersion: 1, nativeInput: { id: record.requestId, text,
            ...((record.options?.sourceContext?.feishuContinuationRunId || record.options?.sourceContext?.feishuThreadOriginRunId) ? { continuationOnly: true } : {}),
            ...(record.options?.workReference ? { referenceOnly: true } : {}),
            ...(!record.options?.nativeQuestionId && !record.options?.workReference
              && !record.options?.routingSource && record.options?.recordUserMessage !== false
              ? { supersedeQuestions: true } : {}),
            ...(record.options?.nativeQuestionId ? { questionId: record.options.nativeQuestionId, answerText: nativeQuestionReplyText(record) } : {}),
            ...(record.options?.nativeQuestionId && prepared.systemOutcome ? { systemOutcome: prepared.systemOutcome } : {}),
          }, nativeContext: context,
          nativeContextDelivery: prepared.contextDelivery || null,
          nativeRuleContextDelivery: prepared.ruleContextDelivery || null,
          nativeInputBaseSeq: current.nativeInputBaseSeq ?? manifest.forkBaseSeq ?? 0,
        }));
        await changed(record.key);
        if (record.releasedAt || !record.nativeDispatchRunId) return;
      }
      await recordInput(record, { managerTurnContext: record.nativeContext || '' });
      const task = send(record).catch(error => onError(error, record.sessionId))
        .finally(async () => { await changed(record.key); tasks.delete(record.key); });
      tasks.set(record.key, task);
    },
    async idle() { await Promise.all(tasks.values()); },
  };
}

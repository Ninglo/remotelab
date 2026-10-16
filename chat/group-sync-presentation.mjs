import { normalizeConversation } from '../lib/conversation-target.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { resolveAmbientFeishuReplyPlan } from './ambient-feishu-reply.mjs';

// A confirmation callback is a new input, but not a new placement decision.
// Consult the draft's actual execution, never the Session's newest discussion.
export async function groupSyncReturnPlan(record, proposal, store) {
  const origin = record.deliveryPlan || record.options?.sourceDelivery;
  if (origin?.target?.replyInThread || origin?.target?.conversationKind === 'thread') return origin;
  const source = await store.byRequest(proposal.sourceSessionId, proposal.sourceRequestId);
  const root = source?.nativeDispatchRunId ? await store.byRunId(source.nativeDispatchRunId) : source;
  if (!root) return origin;
  if (!root.replyPlacement && !root.deliveries?.some(part => part.connector === 'feishu'
      && ['content', 'attachment'].includes(part.kind) && part.surfaceKind !== 'placement_error')) return origin;
  const selected = resolveAmbientFeishuReplyPlan(root, source.deliveryPlan || source.options?.sourceDelivery);
  return selected?.connector === origin?.connector && selected.sourceRouteId === origin.sourceRouteId
    && selected.target?.chatId === origin.target?.chatId ? selected : origin;
}

export function groupWorkHref(plan, sessionId) {
  const target = normalizeConversation(plan)?.target || {};
  // rootId anchors a message reply, not a Feishu open_thread_id. Until the
  // provider has returned the actual topic ID, use the working Session entry.
  const thread = target.threadId || (target.topicId?.startsWith('omt_') ? target.topicId : '');
  if (target.chatId && thread && (target.replyInThread || target.conversationKind === 'thread')) {
    return `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(target.chatId)}&open_thread_id=${encodeURIComponent(thread)}`;
  }
  return buildSessionNavigationHref(sessionId, { requireAbsolute: true });
}

export function syncResultPresentation(packet, result, { failed = false } = {}) {
  // This is a reading preview, not a semantic summary or a placement heuristic.
  // Keep the entire original in the panel/file, including unanswered questions.
  const paragraph = result.trim().split(/\n\s*\n/)[0] || '未返回可用结论，请查看原工作话题。';
  const preview = Array.from(paragraph).slice(0, 180).join('');
  return { title: failed ? '同步复核未完成' : '同步复核结果', failed,
    summary: failed ? result : `来自：${packet.targetName}\n\n${preview}${preview.length < paragraph.length ? '…（展开查看全文）' : ''}`,
    url: groupWorkHref(packet.targetPlan, packet.targetSessionId) };
}

export function syncDecisionOutcome(proposal) {
  if (proposal.state === 'rejected') return '已取消本条同步。';
  if (proposal.state === 'return-queued') return proposal.resultState === 'completed'
    ? '复核结果已排入原对话，请查看结果卡。' : '复核未完成，原因已排入原对话，请查看结果卡。';
  return `已提交到「${proposal.targetName}」复核，结论会回到这里；这不表示已经完成。`;
}

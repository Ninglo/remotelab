const trimString = value => typeof value === 'string' ? value.trim() : '';

export function summarizeFeishuReactionFeedback(data, outbound, { feedbackChats = null } = {}) {
  const event = data?.event && typeof data.event === 'object' ? data.event : data;
  const emojiType = trimString(event?.reaction_type?.emoji_type).toUpperCase();
  const messageId = trimString(event?.message_id);
  const actor = event?.user_id || {};
  const openId = trimString(actor.open_id);
  const operatorType = trimString(event?.operator_type).toLowerCase();
  if (!emojiType || !messageId || !openId
      || (operatorType && operatorType !== 'user')
      || outbound?.direction !== 'outbound' || outbound.messageId !== messageId
      || !trimString(outbound.chatId) || !trimString(outbound.sessionId)
      || outbound.sessionId === 'outbound') return null;
  if (emojiType !== 'SHHH' && feedbackChats && !feedbackChats.has(outbound.chatId)) return null;
  const eventId = trimString(event.event_id || data?.header?.event_id)
    || `reaction:${messageId}:${openId}:${trimString(event.action_time)}`;
  const isThread = outbound.conversationKind === 'thread'
    || (outbound.conversationKind !== 'main' && outbound.conversationId
      && !outbound.conversationId.startsWith('feishu:'));
  return {
    sourceKind: emojiType === 'SHHH' ? 'reaction_mute' : 'reaction_feedback',
    eventId,
    eventType: 'im.message.reaction.created_v1',
    messageId,
    reactionType: emojiType,
    tenantKey: trimString(event.tenant_key || data?.header?.tenant_key || outbound.accountId),
    chatId: outbound.chatId,
    chatType: 'group',
    ...(isThread ? { threadId: trimString(outbound.conversationId), rootId: trimString(outbound.rootId || outbound.conversationId) } : {}),
    messageType: 'reaction',
    sender: { openId, userId: trimString(actor.user_id), unionId: trimString(actor.union_id), senderType: 'user' },
    feedbackSessionId: outbound.sessionId,
    sourceMessageId: trimString(outbound.sourceMessageId),
  };
}

export function summarizeFeishuMuteReaction(data, outbound) {
  const summary = summarizeFeishuReactionFeedback(data, outbound);
  return summary?.sourceKind === 'reaction_mute' ? summary : null;
}

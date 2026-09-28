const trimString = value => typeof value === 'string' ? value.trim() : '';

export function summarizeFeishuMuteReaction(data, outbound) {
  const event = data?.event && typeof data.event === 'object' ? data.event : data;
  const emojiType = trimString(event?.reaction_type?.emoji_type).toUpperCase();
  const messageId = trimString(event?.message_id);
  const actor = event?.user_id || {};
  const openId = trimString(actor.open_id);
  const operatorType = trimString(event?.operator_type).toLowerCase();
  if (emojiType !== 'SHHH' || !messageId || !openId
      || (operatorType && operatorType !== 'user')
      || outbound?.direction !== 'outbound' || outbound.messageId !== messageId
      || !trimString(outbound.chatId) || !trimString(outbound.sessionId)
      || outbound.sessionId === 'outbound') return null;
  const eventId = trimString(event.event_id || data?.header?.event_id)
    || `reaction:${messageId}:${openId}:${trimString(event.action_time)}`;
  const isThread = outbound.conversationKind === 'thread'
    || (outbound.conversationKind !== 'main' && outbound.conversationId
      && !outbound.conversationId.startsWith('feishu:'));
  return {
    sourceKind: 'reaction_mute',
    eventId,
    eventType: 'im.message.reaction.created_v1',
    messageId,
    reactionType: 'SHHH',
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

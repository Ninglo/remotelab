// One address shape for Session bindings and durable delivery snapshots.
const trimString = value => typeof value === 'string' ? value.trim() : '';
export function normalizeConversationRouteId(value) {
  const normalized = trimString(value);
  return !normalized || normalized === 'unknown' ? 'default' : normalized;
}

export function normalizeConversationTarget(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const target = {};
  for (const field of [
    // Feishu fields
    'chatId', 'tenantKey',
    'chatType',
    'conversationKind',
    'messageId',
    'topicId',
    'threadId',
    'rootId',
    'parentId',
    'groupMessageType',
    'chatMode', 'eventType', 'fileType', 'fileToken', 'commentId', 'replyId', 'sourceKind', 'messageType',
    // WeChat fields
    'accountId',
    'peerUserId',
    'contextToken',
    // Email fields (preserve the bound mailbox alias used for replies).
    'to',
    'from',
    'subject',
    'inReplyTo',
  ]) {
    const normalized = trimString(raw[field]);
    if (normalized) target[field] = normalized;
  }
  // Email references: stored as array of strings
  if (Array.isArray(raw.references) && raw.references.length > 0) {
    const refs = raw.references.map(r => trimString(r)).filter(Boolean);
    if (refs.length > 0) target.references = refs;
  } else if (typeof raw.references === 'string') {
    const ref = trimString(raw.references);
    if (ref) target.references = [ref];
  }
  if (raw.replyInThread === true) target.replyInThread = true;
  if (raw.forkCommand === true) target.forkCommand = true;
  if (!target.messageId && (target.topicId || target.threadId || target.rootId)) {
    target.messageId = target.rootId || target.topicId || target.threadId;
  }
  return target;
}

export function normalizeConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const connector = trimString(value.connector).toLowerCase();
  const target = normalizeConversationTarget(value.target);
  if (connector === 'feishu') {
    if (!target.chatId && !target.commentId) return null;
  } else if (connector === 'wechat') {
    if (!target.accountId || !target.peerUserId) return null;
  } else if (connector === 'email') {
    if (!target.to) return null;
  } else {
    return null;
  }
  return {
    connector,
    sourceRouteId: normalizeConversationRouteId(value.sourceRouteId),
    target,
  };
}


function topicIds(target) {
  const ids = [target.threadId, target.topicId, target.rootId];
  if (target.replyInThread || ['topic', 'thread'].includes(target.conversationKind)
      || ['topic', 'thread'].includes(target.chatMode) || ['topic', 'thread'].includes(target.groupMessageType)) ids.push(target.messageId);
  return ids.filter(Boolean);
}

export function sameConversation(left, right) {
  const a = normalizeConversation(left), b = normalizeConversation(right);
  if (!a || !b || a.connector !== b.connector || a.sourceRouteId !== b.sourceRouteId) return false;
  const x = a.target, y = b.target;
  if (a.connector === 'feishu') {
    if (x.chatId !== y.chatId || (x.tenantKey && y.tenantKey && x.tenantKey !== y.tenantKey)) return false;
    if (x.commentId || y.commentId) return x.fileToken === y.fileToken && x.commentId === y.commentId;
    if (['p2p', 'private'].includes(x.chatType) && ['p2p', 'private'].includes(y.chatType)) return true;
    const ids = new Set(topicIds(x));
    return topicIds(y).some(id => ids.has(id));
  }
  if (a.connector === 'wechat') return x.accountId === y.accountId && x.peerUserId === y.peerUserId;
  return x.to === y.to && Boolean(x.threadId) && x.threadId === y.threadId;
}

export function conversationAfterReceipt(value, receipt = {}) {
  const conversation = normalizeConversation(value);
  if (!conversation || !trimString(receipt.messageId)) return null;
  const target = conversation.target;
  if (conversation.connector !== 'feishu' || target.commentId || ['p2p', 'private'].includes(target.chatType)) return conversation;
  const rootId = target.rootId || (topicIds(target).length ? target.messageId : '') || receipt.messageId;
  return normalizeConversation({ ...conversation, target: { ...target, rootId, messageId: rootId,
    ...(trimString(receipt.threadId) ? { threadId: receipt.threadId } : {}), replyInThread: true } });
}

// A first group publication may learn its topic later. Pending replies may
// adopt that refinement, but never move from one established topic to another.
export function refineConversation(snapshot, current) {
  const a = normalizeConversation(snapshot), b = normalizeConversation(current);
  if (!a || !b) return a;
  if (sameConversation(a, b)) return b;
  if (a.connector === 'feishu' && b.connector === a.connector && a.sourceRouteId === b.sourceRouteId
      && a.target.chatId === b.target.chatId && !a.target.commentId && !topicIds(a.target).length
      && (!a.target.tenantKey || !b.target.tenantKey || a.target.tenantKey === b.target.tenantKey)) return b;
  return a;
}

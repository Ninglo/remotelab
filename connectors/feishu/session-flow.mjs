import {
  findConnectorMessageIndexRecord,
  upsertConnectorMessageIndexRecord,
} from '../../lib/connector-message-index.mjs';
import {
  FEISHU_CONNECTOR_ID,
  buildFeishuMessageIndexRecord,
  buildFeishuOutboundMessageIndexRecord,
  buildFeishuTopicId,
  collectFeishuTopicParentMessageCandidates,
  sanitizeIdPart,
  trimString,
} from './index.mjs';

function sourceContextReferencesMessage(sourceContext, messageId) {
  if (!sourceContext || typeof sourceContext !== 'object' || Array.isArray(sourceContext)) return false;
  if (trimString(sourceContext.messageId) === messageId) return true;
  return Array.isArray(sourceContext.queuedMessages)
    && sourceContext.queuedMessages.some((entry) => sourceContextReferencesMessage(entry?.sourceContext, messageId));
}

async function loadSession(requester, sessionId) {
  const result = await requester(`/api/sessions/${encodeURIComponent(sessionId)}`);
  return result.response?.ok && result.json?.session ? result.json.session : null;
}

async function loadEvents(requester, sessionId) {
  const result = await requester(`/api/sessions/${encodeURIComponent(sessionId)}/events?filter=all`);
  return result.response?.ok && Array.isArray(result.json?.events) ? result.json.events : [];
}

async function sessionReferencesMessage(requester, sessionId, summary, messageId) {
  const session = await loadSession(requester, sessionId);
  if (!session || trimString(session.sourceId) !== FEISHU_CONNECTOR_ID) return false;
  const chatId = trimString(summary?.chatId);
  const contextChatId = trimString(session?.sourceContext?.chatId);
  if (chatId && contextChatId && contextChatId !== chatId) return false;
  const events = await loadEvents(requester, sessionId);
  return events.some((event) => sourceContextReferencesMessage(event?.sourceContext, messageId));
}

function parseFeishuHandledFallbackUpdatedAt(metadata) {
  const updatedAt = Date.parse(trimString(metadata?.updatedAt) || '');
  if (Number.isFinite(updatedAt)) return updatedAt;
  const repliedAt = Date.parse(trimString(metadata?.repliedAt) || '');
  if (Number.isFinite(repliedAt)) return repliedAt;
  const handledAt = Date.parse(trimString(metadata?.handledAt) || '');
  if (Number.isFinite(handledAt)) return handledAt;
  return 0;
}

async function collectFeishuHandledTopicFallbackCandidates(runtime, summary, loadHandledMessages) {
  if (typeof loadHandledMessages !== 'function') return [];
  const handledPath = trimString(runtime?.storagePaths?.handledMessagesPath);
  if (!handledPath) return [];

  const state = await loadHandledMessages(handledPath);
  const messages = state?.messages && typeof state.messages === 'object' && !Array.isArray(state.messages)
    ? state.messages
    : {};
  const chatId = trimString(summary?.chatId);

  return Object.entries(messages)
    .filter(([sourceMessageId, metadata]) => {
      if (!metadata || typeof metadata !== 'object') return false;
      if (!['sent', 'confirmation_sent'].includes(trimString(metadata.status))) return false;
      if (!trimString(metadata?.sessionId)) return false;
      const metadataChatId = trimString(metadata.chatId);
      if (chatId && metadataChatId && metadataChatId !== chatId) return false;
      if (!trimString(metadata.responseMessageId) && trimString(sourceMessageId) === trimString(summary?.messageId)) return false;
      return true;
    })
    .map(([sourceMessageId, metadata]) => ({
      sessionId: trimString(metadata.sessionId),
      sourceMessageId: trimString(metadata.sourceMessageId) || trimString(sourceMessageId),
      responseMessageId: trimString(metadata.responseMessageId),
      chatId: trimString(metadata.chatId),
      updatedAt: parseFeishuHandledFallbackUpdatedAt(metadata),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function parseFeishuSessionRecency(value) {
  const timestamp = Date.parse(trimString(value) || '');
  if (Number.isFinite(timestamp)) return timestamp;
  return 0;
}

function getFeishuSessionRecency(session) {
  const candidates = [
    session?.updatedAt,
    session?.createdAt,
    session?.updatedTime,
    session?.createdTime,
    session?.startedAt,
    session?.startedTime,
    session?.latestEventAt,
    session?.lastUpdatedAt,
    session?.lastEventAt,
  ];
  for (const value of candidates) {
    const parsed = parseFeishuSessionRecency(value);
    if (parsed > 0) {
      return parsed;
    }
  }
  if (Number.isInteger(session?.latestSeq)) {
    return session.latestSeq;
  }
  return 0;
}

async function findFeishuRecentTopicSessionCandidates(requester, summary) {
  const result = await requester('/api/sessions?sourceId=feishu');
  if (!result.response?.ok || !Array.isArray(result.json?.sessions)) return [];

  const chatId = trimString(summary?.chatId);
  const chatPrefix = sanitizeIdPart(chatId);
  const summaryChatType = sanitizeIdPart(summary?.chatType || 'chat');
  return result.json.sessions
    .filter((session) => {
      if (!session || typeof session !== 'object') return false;
      if (!trimString(session.id)) return false;
      if (trimString(session?.sourceId) !== FEISHU_CONNECTOR_ID) return false;
      if (session.archived === true) return false;
      const sessionChatId = trimString(session?.sourceContext?.chatId);
      if (chatId && sessionChatId && sessionChatId !== chatId) return false;
      const context = session?.sourceContext;
      const contextConversationKind = trimString(context?.conversationKind).toLowerCase();
      const contextChatMode = trimString(context?.chatMode).toLowerCase();
      const contextGroupMessageType = trimString(context?.groupMessageType).toLowerCase();
      const trigger = trimString(session?.externalTriggerId);
      const matchesChatTrigger = chatPrefix
        ? trigger === `feishu:${summaryChatType}:${chatPrefix}` || trigger.startsWith(`feishu:${summaryChatType}:${chatPrefix}:`)
        : trigger.startsWith('feishu:');
      const isChatContext = (
        contextConversationKind === 'chat'
        || contextChatMode === 'chat'
        || contextGroupMessageType === 'chat'
      );
      const isTopicContext = (
        contextConversationKind === 'topic'
        || contextChatMode === 'topic'
        || contextGroupMessageType === 'topic'
      );
      const matchesTopicTrigger = chatPrefix
        ? trigger.startsWith(`feishu:topic:${chatPrefix}:`)
        : trigger.startsWith('feishu:topic:');
      return matchesChatTrigger || matchesTopicTrigger || isChatContext || isTopicContext;
    })
    .map((session) => ({
      id: trimString(session.id),
      recency: getFeishuSessionRecency(session),
    }))
    .sort((left, right) => {
      if (right.recency !== left.recency) return right.recency - left.recency;
      return left.id.localeCompare(right.id);
    });
}

async function findFeishuTopicFallbackParentSessionId(runtime, requester, summary, loadHandledMessages) {
  const recentTopicSessions = await findFeishuRecentTopicSessionCandidates(requester, summary);
  if (recentTopicSessions.length === 0) return '';

  const topicSessionIds = new Set(recentTopicSessions.map((entry) => entry.id).filter(Boolean));
  const fallbackHandled = await collectFeishuHandledTopicFallbackCandidates(runtime, summary, loadHandledMessages);
  const chatScopedFallback = fallbackHandled.filter((record) => (
    topicSessionIds.has(record.sessionId) && Boolean(record.sourceMessageId)
  ));

  for (const fallback of chatScopedFallback) {
    const verificationMessageId = fallback.sourceMessageId || fallback.responseMessageId;
    if (verificationMessageId && await sessionReferencesMessage(requester, fallback.sessionId, summary, verificationMessageId)) {
      return fallback.sessionId;
    }
  }

  const latestHandledSessionId = chatScopedFallback[0]?.sessionId;
  if (latestHandledSessionId) {
    return latestHandledSessionId;
  }

  return recentTopicSessions[0]?.id || '';
}

function sessionTriggerMatchesChat(session, summary) {
  const chatId = trimString(summary?.chatId);
  if (!chatId) return true;
  const triggerId = trimString(session?.externalTriggerId);
  return triggerId === `feishu:${sanitizeIdPart(summary?.chatType || 'chat')}:${sanitizeIdPart(chatId)}`
    || triggerId.startsWith(`feishu:topic:${sanitizeIdPart(chatId)}:`);
}

async function findParentFromFacts(requester, summary, messageId) {
  const result = await requester('/api/sessions?sourceId=feishu');
  if (!result.response?.ok || !Array.isArray(result.json?.sessions)) return '';
  const candidates = result.json.sessions.filter((session) => (
    trimString(session?.id)
    && trimString(session?.sourceId) === FEISHU_CONNECTOR_ID
    && session?.archived !== true
    && sessionTriggerMatchesChat(session, summary)
  ));
  for (const candidate of candidates) {
    if (await sessionReferencesMessage(requester, candidate.id, summary, messageId)) return candidate.id;
  }
  return '';
}

async function findParentFromHandledMessages(runtime, requester, summary, messageId, loadHandledMessages) {
  const handledPath = trimString(runtime?.storagePaths?.handledMessagesPath);
  if (!handledPath || typeof loadHandledMessages !== 'function') return null;
  const state = await loadHandledMessages(handledPath);
  const messages = state?.messages && typeof state.messages === 'object' && !Array.isArray(state.messages)
    ? state.messages
    : {};
  const chatId = trimString(summary?.chatId);
  for (const [sourceMessageId, metadata] of Object.entries(messages)) {
    if (trimString(metadata?.responseMessageId) !== messageId) continue;
    if (chatId && trimString(metadata?.chatId) && trimString(metadata.chatId) !== chatId) continue;
    const sessionId = trimString(metadata?.sessionId);
    if (!sessionId || !sourceMessageId) continue;
    if (await sessionReferencesMessage(requester, sessionId, summary, sourceMessageId)) {
      return { sessionId, sourceMessageId };
    }
  }
  return null;
}

export async function recordFeishuMessageSession(runtime, summary, sessionId) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const record = buildFeishuMessageIndexRecord(summary, sessionId);
  if (!pathname || !record) return null;
  return upsertConnectorMessageIndexRecord(pathname, record);
}

export async function recordFeishuOutboundMessageSession(runtime, summary, sessionId, outboundMessageId) {
  const pathname = trimString(runtime?.storagePaths?.messageIndexPath);
  const record = buildFeishuOutboundMessageIndexRecord(summary, sessionId, outboundMessageId);
  if (!pathname || !record) return null;
  return upsertConnectorMessageIndexRecord(pathname, record);
}

export async function resolveFeishuTopicForkParentSessionId(runtime, requester, summary, {
  loadHandledMessages,
} = {}) {
  if (!buildFeishuTopicId(summary)) return '';
  const parentMessageIds = collectFeishuTopicParentMessageCandidates(summary);
  if (parentMessageIds.length === 0) {
    return await findFeishuTopicFallbackParentSessionId(runtime, requester, summary, loadHandledMessages);
  }
  const indexPath = trimString(runtime?.storagePaths?.messageIndexPath);

  for (const parentMessageId of parentMessageIds) {
    if (indexPath) {
      const indexed = await findConnectorMessageIndexRecord(indexPath, {
        connector: FEISHU_CONNECTOR_ID,
        accountId: trimString(summary?.tenantKey || summary?.sender?.tenantKey),
        messageId: parentMessageId,
        chatId: trimString(summary?.chatId),
      });
      const verificationMessageId = trimString(indexed?.sourceMessageId) || parentMessageId;
      if (indexed && await sessionReferencesMessage(requester, indexed.sessionId, summary, verificationMessageId)) {
        return trimString(indexed.sessionId);
      }
    }

    const factSessionId = await findParentFromFacts(requester, summary, parentMessageId);
    if (factSessionId) {
      if (indexPath) {
        await upsertConnectorMessageIndexRecord(indexPath, {
          connector: FEISHU_CONNECTOR_ID,
          accountId: trimString(summary?.tenantKey || summary?.sender?.tenantKey),
          messageId: parentMessageId,
          sessionId: factSessionId,
          chatId: trimString(summary?.chatId),
          direction: 'inbound',
        });
      }
      return factSessionId;
    }

    const handledMatch = await findParentFromHandledMessages(runtime, requester, summary, parentMessageId, loadHandledMessages);
      if (handledMatch?.sessionId) {
        if (indexPath) {
          await upsertConnectorMessageIndexRecord(indexPath, {
            connector: FEISHU_CONNECTOR_ID,
            accountId: trimString(summary?.tenantKey || summary?.sender?.tenantKey),
          messageId: parentMessageId,
          sessionId: handledMatch.sessionId,
          chatId: trimString(summary?.chatId),
          sourceMessageId: handledMatch.sourceMessageId,
          direction: 'outbound',
        });
      }
      return handledMatch.sessionId;
    }
  }
  return await findFeishuTopicFallbackParentSessionId(runtime, requester, summary, loadHandledMessages);
}

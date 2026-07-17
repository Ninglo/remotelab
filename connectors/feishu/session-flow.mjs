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
  if (parentMessageIds.length === 0) return '';
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
  return '';
}

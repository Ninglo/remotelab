import { readFeishuEvents } from './feishu-event-log.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function loadReplayableSummariesByMessageIds(eventsLogPath, messageIds) {
  const requestedMessageIds = Array.from(new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .map((messageId) => trimString(messageId))
      .filter(Boolean),
  ));
  if (requestedMessageIds.length === 0) {
    return { summaries: [], missingMessageIds: [] };
  }

  const requested = new Set(requestedMessageIds);
  const summariesByMessageId = new Map();
  for await (const record of readFeishuEvents(eventsLogPath, { days: 30, since: Date.now() - 30 * 86400_000 })) {
    const messageId = trimString(record?.summary?.messageId);
    if (record?.allowed === false || !requested.has(messageId) || !trimString(record?.summary?.chatId)) {
      continue;
    }
    if (!summariesByMessageId.has(messageId)) summariesByMessageId.set(messageId, record.summary);
  }

  return {
    summaries: requestedMessageIds
      .map((messageId) => summariesByMessageId.get(messageId))
      .filter(Boolean),
    missingMessageIds: requestedMessageIds.filter((messageId) => !summariesByMessageId.has(messageId)),
  };
}

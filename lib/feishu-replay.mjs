import { readFile } from 'fs/promises';

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
  const raw = await readFile(eventsLogPath, 'utf8');
  for (const line of raw.split('\n')) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const messageId = trimString(record?.summary?.messageId);
    if (record?.allowed === false || !requested.has(messageId) || !trimString(record?.summary?.chatId)) {
      continue;
    }
    summariesByMessageId.set(messageId, record.summary);
  }

  return {
    summaries: requestedMessageIds
      .map((messageId) => summariesByMessageId.get(messageId))
      .filter(Boolean),
    missingMessageIds: requestedMessageIds.filter((messageId) => !summariesByMessageId.has(messageId)),
  };
}

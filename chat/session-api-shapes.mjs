function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stripSessionShape(session, {
  includeQueuedMessages = false,
} = {}) {
  if (!session || typeof session !== 'object') return null;
  const cloned = cloneJson(session);
  delete cloned.task;
  delete cloned.sourceContext;
  delete cloned.delegatedFromSessionId;
  delete cloned.delegatedAt;
  if (!includeQueuedMessages) {
    delete cloned.queuedMessages;
  }
  return cloned;
}

export function createSessionListItem(session) {
  return stripSessionShape(session, { includeQueuedMessages: false });
}

export function createSessionDetail(session) {
  return stripSessionShape(session, { includeQueuedMessages: true });
}

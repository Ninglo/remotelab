function mergeUniqueSessions(entries = []) {
  const merged = [];
  const seenIds = new Set();
  for (const entry of entries) {
    if (!entry?.id || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function applySessionListState(nextSessions, {
  archivedCount: nextArchivedCount = archivedSessionCount,
} = {}) {
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const activeSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const preservedArchived = sessions
    .filter((session) => session?.archived === true)
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const preservedCurrent = currentSessionId
    ? normalizeSessionRecord(previousMap.get(currentSessionId) || null, previousMap.get(currentSessionId) || null)
    : null;
  sessions = mergeUniqueSessions([
    ...activeSessions,
    ...preservedArchived,
    ...(preservedCurrent?.archived === true ? [preservedCurrent] : []),
  ]);
  sortSessionsInPlace();
  hasLoadedSessions = true;
  if (Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0) {
    archivedSessionCount = nextArchivedCount;
  }
  refreshAppCatalog();
  renderSessionList();
  if (currentSessionId && !sessions.some((session) => session.id === currentSessionId)) {
    currentSessionId = null;
    hasAttachedSession = false;
    clearMessages();
    showEmpty();
    restoreDraft();
  }
  return sessions;
}

function applyArchivedSessionListState(nextSessions, {
  archivedCount: nextArchivedCount = null,
} = {}) {
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const preservedActive = sessions
    .filter((session) => session?.archived !== true)
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const archivedSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  sessions = mergeUniqueSessions([...preservedActive, ...archivedSessions]);
  sortSessionsInPlace();
  archivedSessionsLoaded = true;
  archivedSessionsLoading = false;
  archivedSessionCount = Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
    ? nextArchivedCount
    : archivedSessions.length;
  refreshAppCatalog();
  renderSessionList();
  return archivedSessions;

}

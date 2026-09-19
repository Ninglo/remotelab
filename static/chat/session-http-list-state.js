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
  const previousArchivedCount = Number.isInteger(archivedSessionCount) && archivedSessionCount >= 0
    ? archivedSessionCount
    : 0;
  const previousCurrentSessionId = currentSessionId;
  const hadLoadedSessions = hasLoadedSessions === true;
  const previousSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: previousArchivedCount, sessions })
    : "";
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const activeSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  if (typeof replaceActiveChatSessionsState === "function") {
    replaceActiveChatSessionsState(activeSessions, {
      archivedCount: Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
        ? nextArchivedCount
        : archivedSessionCount,
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = mergeUniqueSessions(activeSessions);
    sortSessionsInPlace();
    hasLoadedSessions = true;
    if (Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0) {
      archivedSessionCount = nextArchivedCount;
    }
  }
  const nextSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: archivedSessionCount, sessions })
    : "";
  refreshSessionCatalog();
  if (!hadLoadedSessions || previousSignature !== nextSignature) {
    renderSessionList();
  }
  if (previousCurrentSessionId && !currentSessionId) {
    if (typeof resetAttachedSessionRenderState === "function") {
      resetAttachedSessionRenderState();
    }
    clearMessages();
    showEmpty();
    restoreDraft();
  }
  return sessions;
}

function applyArchivedSessionListState(nextSessions, {
  archivedCount: nextArchivedCount = null,
} = {}) {
  const previousArchivedCount = Number.isInteger(archivedSessionCount) && archivedSessionCount >= 0
    ? archivedSessionCount
    : 0;
  const hadArchivedSessionsLoaded = archivedSessionsLoaded === true;
  const previousSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: previousArchivedCount, sessions })
    : "";
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const archivedSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  if (typeof replaceArchivedChatSessionsState === "function") {
    replaceArchivedChatSessionsState(archivedSessions, {
      archivedCount: Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
        ? nextArchivedCount
        : archivedSessions.length,
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = mergeUniqueSessions(archivedSessions);
    sortSessionsInPlace();
    archivedSessionsLoaded = true;
    archivedSessionsLoading = false;
    archivedSessionCount = Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
      ? nextArchivedCount
      : archivedSessions.length;
  }
  const nextSignature = typeof getComparableSessionStateSignature === "function"
    ? getComparableSessionStateSignature({ archivedCount: archivedSessionCount, sessions })
    : "";
  refreshSessionCatalog();
  if (!hadArchivedSessionsLoaded || previousSignature !== nextSignature) {
    renderSessionList();
  }
  return archivedSessions;

}

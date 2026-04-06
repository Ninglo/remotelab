"use strict";

(function attachRemoteLabChatStore(root) {
  function normalizeSessionId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function mergeUniqueSessions(entries = []) {
    const merged = [];
    const seenIds = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !entry.id || seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      merged.push(entry);
    }
    return merged;
  }

  function sortSessions(entries = [], compareSessions = null) {
    const sorted = Array.isArray(entries) ? entries.slice() : [];
    if (typeof compareSessions === "function") {
      sorted.sort(compareSessions);
    }
    return sorted;
  }

  function createState(state = {}) {
    const currentSessionId = normalizeSessionId(state.currentSessionId);
    return {
      sessions: mergeUniqueSessions(Array.isArray(state.sessions) ? state.sessions : []),
      currentSessionId,
      hasAttachedSession: currentSessionId ? state.hasAttachedSession === true : false,
      hasLoadedSessions: state.hasLoadedSessions === true,
      archivedSessionCount: normalizeNonNegativeInteger(state.archivedSessionCount, 0),
      archivedSessionsLoaded: state.archivedSessionsLoaded === true,
      archivedSessionsLoading: state.archivedSessionsLoading === true,
      activeSourceFilter:
        typeof state.activeSourceFilter === "string" && state.activeSourceFilter.trim()
          ? state.activeSourceFilter.trim()
          : "__all__",
      activeTab: state.activeTab === "settings"
        ? "settings"
        : (state.activeTab === "agents" ? "agents" : "sessions"),
      sessionStatus: state.sessionStatus === "running" ? "running" : "idle",
    };
  }

  function hasCurrentSession(state, sessionId = state?.currentSessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return false;
    return Array.isArray(state?.sessions)
      && state.sessions.some((session) => session?.id === normalizedSessionId);
  }

  function clearMissingCurrentSession(state) {
    if (!state?.currentSessionId || hasCurrentSession(state)) {
      return state;
    }
    return createState({
      ...state,
      currentSessionId: null,
      hasAttachedSession: false,
    });
  }

  function replaceState(state, nextState = {}, {
    compareSessions = null,
    normalizeSourceFilter = null,
    normalizeTab = null,
  } = {}) {
    const mergedState = {
      ...state,
      ...nextState,
    };
    if (Array.isArray(nextState.sessions)) {
      mergedState.sessions = sortSessions(
        mergeUniqueSessions(nextState.sessions),
        compareSessions,
      );
    }
    if (Object.prototype.hasOwnProperty.call(nextState, "activeSourceFilter")
      && typeof normalizeSourceFilter === "function") {
      mergedState.activeSourceFilter = normalizeSourceFilter(nextState.activeSourceFilter);
    }
    if (Object.prototype.hasOwnProperty.call(nextState, "activeTab")
      && typeof normalizeTab === "function") {
      mergedState.activeTab = normalizeTab(nextState.activeTab);
    }
    return createState(mergedState);
  }

  function replaceActiveSessions(state, nextActiveSessions = [], {
    archivedCount = state?.archivedSessionCount,
    compareSessions = null,
  } = {}) {
    const preservedArchived = Array.isArray(state?.sessions)
      ? state.sessions.filter((session) => session?.archived === true)
      : [];
    const nextState = createState({
      ...state,
      sessions: sortSessions(
        mergeUniqueSessions([
          ...(Array.isArray(nextActiveSessions) ? nextActiveSessions : []),
          ...preservedArchived,
        ]),
        compareSessions,
      ),
      hasLoadedSessions: true,
      archivedSessionCount: normalizeNonNegativeInteger(
        archivedCount,
        normalizeNonNegativeInteger(state?.archivedSessionCount, 0),
      ),
    });
    return clearMissingCurrentSession(nextState);
  }

  function replaceArchivedSessions(state, nextArchivedSessions = [], {
    archivedCount = null,
    compareSessions = null,
  } = {}) {
    const preservedActive = Array.isArray(state?.sessions)
      ? state.sessions.filter((session) => session?.archived !== true)
      : [];
    return createState({
      ...state,
      sessions: sortSessions(
        mergeUniqueSessions([
          ...preservedActive,
          ...(Array.isArray(nextArchivedSessions) ? nextArchivedSessions : []),
        ]),
        compareSessions,
      ),
      archivedSessionsLoaded: true,
      archivedSessionsLoading: false,
      archivedSessionCount: normalizeNonNegativeInteger(
        archivedCount,
        Array.isArray(nextArchivedSessions) ? nextArchivedSessions.length : 0,
      ),
    });
  }

  function upsertSession(state, session, { compareSessions = null } = {}) {
    if (!session || typeof session !== "object" || !session.id) {
      return createState(state);
    }
    const sessions = Array.isArray(state?.sessions) ? state.sessions.slice() : [];
    const index = sessions.findIndex((entry) => entry?.id === session.id);
    const previous = index === -1 ? null : sessions[index];
    if (index === -1) {
      sessions.push(session);
    } else {
      sessions[index] = session;
    }
    let nextArchivedCount = normalizeNonNegativeInteger(state?.archivedSessionCount, 0);
    if (previous?.archived !== true && session.archived === true) {
      nextArchivedCount += 1;
    } else if (previous?.archived === true && session.archived !== true) {
      nextArchivedCount = Math.max(0, nextArchivedCount - 1);
    }
    return createState({
      ...state,
      sessions: sortSessions(mergeUniqueSessions(sessions), compareSessions),
      archivedSessionCount: nextArchivedCount,
    });
  }

  function removeSession(state, sessionId, { compareSessions = null } = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return createState(state);
    }
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    const removedSession = sessions.find((entry) => entry?.id === normalizedSessionId) || null;
    if (!removedSession) {
      return createState(state);
    }
    let nextArchivedCount = normalizeNonNegativeInteger(state?.archivedSessionCount, 0);
    if (removedSession.archived === true) {
      nextArchivedCount = Math.max(0, nextArchivedCount - 1);
    }
    const nextState = createState({
      ...state,
      sessions: sortSessions(
        sessions.filter((entry) => entry?.id !== normalizedSessionId),
        compareSessions,
      ),
      archivedSessionCount: nextArchivedCount,
      currentSessionId:
        state?.currentSessionId === normalizedSessionId ? null : state?.currentSessionId,
      hasAttachedSession:
        state?.currentSessionId === normalizedSessionId ? false : state?.hasAttachedSession,
    });
    return clearMissingCurrentSession(nextState);
  }

  function setCurrentSession(state, sessionId, { hasAttachedSession = null } = {}) {
    const nextSessionId = normalizeSessionId(sessionId);
    const nextHasAttachedSession = nextSessionId
      ? (hasAttachedSession === null
        ? state?.currentSessionId === nextSessionId && state?.hasAttachedSession === true
        : hasAttachedSession === true)
      : false;
    return createState({
      ...state,
      currentSessionId: nextSessionId,
      hasAttachedSession: nextHasAttachedSession,
    });
  }

  function setArchivedSessionsLoading(state, value) {
    return createState({
      ...state,
      archivedSessionsLoading: value === true,
    });
  }

  function setActiveSourceFilter(state, value, { normalizeSourceFilter = null } = {}) {
    const nextValue = typeof normalizeSourceFilter === "function"
      ? normalizeSourceFilter(value)
      : (typeof value === "string" && value.trim() ? value.trim() : "__all__");
    return createState({
      ...state,
      activeSourceFilter: nextValue,
    });
  }

  function setActiveTab(state, value, { normalizeTab = null } = {}) {
    const nextValue = typeof normalizeTab === "function"
      ? normalizeTab(value)
      : (value === "settings" ? "settings" : "sessions");
    return createState({
      ...state,
      activeTab: nextValue,
    });
  }

  function setSessionStatus(state, value) {
    return createState({
      ...state,
      sessionStatus: value === "running" ? "running" : "idle",
    });
  }

  function findSession(state, sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !Array.isArray(state?.sessions)) return null;
    return state.sessions.find((session) => session?.id === normalizedSessionId) || null;
  }

  function getCurrentSession(state) {
    return findSession(state, state?.currentSessionId);
  }

  function sameSessions(a = [], b = []) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  function areStatesEqual(a, b) {
    return sameSessions(a?.sessions, b?.sessions)
      && a?.currentSessionId === b?.currentSessionId
      && a?.hasAttachedSession === b?.hasAttachedSession
      && a?.hasLoadedSessions === b?.hasLoadedSessions
      && a?.archivedSessionCount === b?.archivedSessionCount
      && a?.archivedSessionsLoaded === b?.archivedSessionsLoaded
      && a?.archivedSessionsLoading === b?.archivedSessionsLoading
      && a?.activeSourceFilter === b?.activeSourceFilter
      && a?.activeTab === b?.activeTab
      && a?.sessionStatus === b?.sessionStatus;
  }

  function createStore(initialState = {}) {
    let state = createState(initialState);
    const listeners = new Set();

    function getState() {
      return state;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function dispatch(action = {}) {
      let nextState = state;
      switch (action.type) {
        case "replace-state":
          nextState = replaceState(state, action.state, action);
          break;
        case "replace-active-sessions":
          nextState = replaceActiveSessions(state, action.sessions, action);
          break;
        case "replace-archived-sessions":
          nextState = replaceArchivedSessions(state, action.sessions, action);
          break;
        case "upsert-session":
          nextState = upsertSession(state, action.session, action);
          break;
        case "remove-session":
          nextState = removeSession(state, action.sessionId, action);
          break;
        case "set-current-session":
          nextState = setCurrentSession(state, action.sessionId, action);
          break;
        case "set-archived-sessions-loading":
          nextState = setArchivedSessionsLoading(state, action.value);
          break;
        case "set-active-source-filter":
          nextState = setActiveSourceFilter(state, action.value, action);
          break;
        case "set-active-tab":
          nextState = setActiveTab(state, action.value, action);
          break;
        case "set-session-status":
          nextState = setSessionStatus(state, action.value);
          break;
        default:
          nextState = state;
          break;
      }
      if (areStatesEqual(state, nextState)) {
        return state;
      }
      const previousState = state;
      state = nextState;
      for (const listener of listeners) {
        listener(state, previousState, action);
      }
      return state;
    }

    return {
      getState,
      subscribe,
      dispatch,
    };
  }

  const api = {
    createState,
    createStore,
    mergeUniqueSessions,
    sortSessions,
    replaceState,
    replaceActiveSessions,
    replaceArchivedSessions,
    upsertSession,
    removeSession,
    setCurrentSession,
    setArchivedSessionsLoading,
    setActiveSourceFilter,
    setActiveTab,
    setSessionStatus,
    findSession,
    getCurrentSession,
  };
  root.RemoteLabChatStore = api;
  if (root.window && root.window !== root) {
    root.window.RemoteLabChatStore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
  const requestedTab = pendingNavigationState?.tab || currentTab;
  if (requestedTab !== currentTab) {
    switchTab(requestedTab, { syncState: false });
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(null, { hasAttachedSession: false });
    } else {
      currentSessionId = null;
      hasAttachedSession = false;
    }
    resetAttachedSessionRenderState();
    persistActiveSessionId(null);
    syncBrowserState({ sessionId: null, tab: getActiveSidebarTabValue() });
    showEmpty();
    restoreDraft();
    updateStatus("connected");
    pendingNavigationState = null;
    return;
  }

  if (!hasAttachedSession || currentSessionId !== targetSession.id) {
    attachSession(targetSession.id, targetSession);
  } else {
    syncBrowserState();
  }
  pendingNavigationState = null;
}

if (
  "serviceWorker" in navigator
  && typeof navigator.serviceWorker?.addEventListener === "function"
) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "remotelab:open-session") return;
    applyNavigationState(event.data);
    window.focus();
    return queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry",
    }).catch(() => {});
  });
}

function notifyCompletion(session) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  if (document.visibilityState === "visible") return;
  const folder = (session?.folder || "").split("/").pop() || "Session";
  const name = session?.name || folder;
  const n = new Notification("RemoteLab", {
    body: `${name} — task completed`,
    tag: "remotelab-done",
  });
  n.onclick = () => {
    window.focus();
    applyNavigationState({ sessionId: session?.id, tab: "sessions" });
    queueForegroundRefresh({
      forceFresh: true,
      viewportIntent: "session_entry",
    }).catch(() => {});
    n.close();
  };
}

const FOREGROUND_REFRESH_THROTTLE_MS = 1500;
const FOREGROUND_SESSION_LIST_STALE_MS = 15000;
const FOREGROUND_IDLE_SESSION_STALE_MS = 15000;
let foregroundRefreshPromise = null;
let foregroundRefreshHandlersReady = false;
let lastForegroundRefreshAt = 0;
let lastSessionsListRefreshAt = 0;
let lastArchivedSessionsRefreshAt = 0;
let lastCurrentSessionRefreshAt = 0;
let lastCurrentSessionRefreshSessionId = null;
let pendingCurrentSessionRefreshOptions = null;

function buildSessionRefreshRequestOptions(forceFresh = false) {
  return forceFresh
    ? { revalidate: false, cache: "no-store" }
    : {};
}

function mergeSessionRefreshOptions(current = {}, next = {}) {
  return {
    forceFresh: current.forceFresh === true || next.forceFresh === true,
    viewportIntent:
      normalizeSessionViewportIntent(current.viewportIntent) === "session_entry"
      || normalizeSessionViewportIntent(next.viewportIntent) === "session_entry"
        ? "session_entry"
        : "preserve",
  };
}

function canQueueForegroundRefresh() {
  if (
    (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode)
    || typeof document === "undefined"
  ) {
    return false;
  }
  if (document.visibilityState === "hidden") {
    return false;
  }
  if (visitorMode) {
    return Boolean(
      currentSessionId
      || (typeof visitorSessionId !== "undefined" && visitorSessionId),
    );
  }
  return true;
}

function isRefreshStale(lastRefreshAt, staleMs) {
  return !Number.isFinite(lastRefreshAt)
    || lastRefreshAt <= 0
    || Date.now() - lastRefreshAt >= staleMs;
}

function isArchiveSectionExpanded() {
  return typeof localStorage !== "undefined"
    && typeof localStorage.getItem === "function"
    && localStorage.getItem("archivedCollapsed") === "false";
}

function shouldRefreshForegroundSessionList({ forceFresh = false } = {}) {
  if (forceFresh) return true;
  if (!hasLoadedSessions) return true;
  if (pendingNavigationState) return true;
  if (currentSessionId && typeof findClientSessionRecord === "function" && !findClientSessionRecord(currentSessionId)) {
    return true;
  }
  return isRefreshStale(lastSessionsListRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundArchivedSessions({
  forceFresh = false,
  refreshedSessionsList = false,
} = {}) {
  if (!archivedSessionsLoaded || !isArchiveSectionExpanded()) return false;
  if (forceFresh) return true;
  if (refreshedSessionsList) return true;
  return isRefreshStale(lastArchivedSessionsRefreshAt, FOREGROUND_SESSION_LIST_STALE_MS);
}

function shouldRefreshForegroundCurrentSession({ forceFresh = false } = {}) {
  if (!currentSessionId) return false;
  if (forceFresh) return true;
  if (!hasAttachedSession) return true;
  if (pendingNavigationState) return true;
  const session = typeof findClientSessionRecord === "function"
    ? findClientSessionRecord(currentSessionId)
    : null;
  if (!session) return true;
  if (getSessionRunState(session) === "running") return true;
  if (!hasRenderedEventSnapshot(currentSessionId)) return true;
  if (lastCurrentSessionRefreshSessionId !== currentSessionId) return true;
  return isRefreshStale(lastCurrentSessionRefreshAt, FOREGROUND_IDLE_SESSION_STALE_MS);
}

async function runForegroundRefresh({ forceFresh = false, viewportIntent = "preserve" } = {}) {
  if (!canQueueForegroundRefresh()) return null;
  await refreshRealtimeViews({ forceFresh, viewportIntent, refreshMode: "foreground" });
  return currentSessionId || null;
}

function queueForegroundRefresh(options = {}) {
  const requestOptions = mergeSessionRefreshOptions(
    { forceFresh: false, viewportIntent: "preserve" },
    options,
  );
  if (!canQueueForegroundRefresh()) {
    return Promise.resolve(null);
  }
  if (foregroundRefreshPromise) {
    return foregroundRefreshPromise;
  }
  const now = Date.now();
  if (now - lastForegroundRefreshAt < FOREGROUND_REFRESH_THROTTLE_MS) {
    return Promise.resolve(null);
  }
  lastForegroundRefreshAt = now;
  foregroundRefreshPromise = (async () => {
    try {
      return await runForegroundRefresh(requestOptions);
    } finally {
      foregroundRefreshPromise = null;
    }
  })();
  return foregroundRefreshPromise;
}

function setupForegroundRefreshHandlers() {
  if (foregroundRefreshHandlersReady) return;
  foregroundRefreshHandlersReady = true;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return null;
      return queueForegroundRefresh().catch(() => {});
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", () => queueForegroundRefresh().catch(() => {}));
    window.addEventListener("pageshow", () => queueForegroundRefresh().catch(() => {}));
  }
}

const SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS = 1200;
const SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS = 90 * 1000;
const SESSION_LIST_ORGANIZER_INTERNAL_ROLE = "session_list_organizer";
const DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL = "Sort List";
let sessionListOrganizerInFlight = null;
let sessionListOrganizerLabelResetTimer = null;

const SESSION_LIST_ORGANIZER_SYSTEM_PROMPT = [
  "You are RemoteLab's hidden session-list organizer.",
  "Your job is to improve the owner's non-archived session sidebar structure using the provided metadata snapshot.",
  "Do not rename sessions, archive or unarchive them, change pin state, edit prompts, or ask the user follow-up questions.",
  "Only update existing sessions by calling the owner-authenticated RemoteLab API from this machine.",
  "Use `remotelab api GET /api/sessions` if you need to double-check current state.",
  "Use `remotelab api PATCH /api/sessions/<sessionId> --body ...` to update `group` and `sidebarOrder`.",
  "Only writable API fields for this task are `group` and `sidebarOrder`.",
  "Never send read-only snapshot keys such as `title`, `brief`, `existingGroup`, `existingSidebarOrder`, `currentGroup`, or `currentSidebarOrder` in PATCH bodies.",
  "Example PATCH body: {\"group\":\"RemoteLab\",\"sidebarOrder\":3}",
  "If `remotelab` is unavailable in PATH, use `node \"$REMOTELAB_PROJECT_ROOT/cli.js\" api ...` instead.",
  "`sidebarOrder` must be a positive integer; smaller numbers sort first.",
  "Assign unique contiguous `sidebarOrder` values across the current non-archived sessions you organize.",
  "Prefer a small number of clear, stable groups; avoid one giant catch-all group when the list is dense.",
  "Return only a brief plain-text summary of the grouping strategy you applied.",
].join("\n");

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setSortSessionListButtonState(label = DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy = false } = {}) {
  if (!sortSessionListBtn) return;
  sortSessionListBtn.textContent = label || DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL;
  sortSessionListBtn.disabled = busy;
}

function clipSessionListOrganizerText(value, maxChars = 240) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
    : normalized;
}

function scheduleSortSessionListButtonReset(delayMs = 1600) {
  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
  }
  sessionListOrganizerLabelResetTimer = window.setTimeout(() => {
    sessionListOrganizerLabelResetTimer = null;
    setSortSessionListButtonState(DEFAULT_SORT_SESSION_LIST_BUTTON_LABEL, { busy: false });
  }, delayMs);
}

function buildSessionListOrganizerSessionMetadata(session) {
  const brief = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  return {
    id: session?.id || "",
    title: clipSessionListOrganizerText(getSessionDisplayName(session), 160),
    brief: clipSessionListOrganizerText(brief, 280),
    existingGroup: typeof session?.group === "string" && session.group.trim()
      ? clipSessionListOrganizerText(session.group, 80)
      : null,
    existingSidebarOrder: Number.isInteger(session?.sidebarOrder) && session.sidebarOrder > 0
      ? session.sidebarOrder
      : null,
    pinned: session?.pinned === true,
    tool: clipSessionListOrganizerText(session?.tool || "", 40),
    sourceName: clipSessionListOrganizerText(session?.sourceName || "", 80),
    folder: clipSessionListOrganizerText(session?.folder || "", 180),
    workflowState: clipSessionListOrganizerText(session?.workflowState || "", 40),
    workflowPriority: clipSessionListOrganizerText(session?.workflowPriority || "", 40),
    messageCount: Number.isInteger(session?.messageCount) ? session.messageCount : 0,
    created: clipSessionListOrganizerText(session?.created || "", 40),
    updatedAt: clipSessionListOrganizerText(session?.updatedAt || "", 40),
    lastEventAt: clipSessionListOrganizerText(session?.lastEventAt || "", 40),
  };
}

function buildSessionListOrganizerPayload() {
  const activeSessions = getActiveSessions();
  return {
    tool: selectedTool || preferredTool || "codex",
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    thinking: thinkingEnabled === true,
    sessions: activeSessions.map(buildSessionListOrganizerSessionMetadata).filter((session) => session.id),
  };
}

function buildSessionListOrganizerTask(sessions) {
  const payload = {
    generatedAt: new Date().toISOString(),
    totalSessions: Array.isArray(sessions) ? sessions.length : 0,
    sessions: Array.isArray(sessions) ? sessions : [],
  };
  return [
    "Organize the current non-archived RemoteLab session list using the provided metadata snapshot.",
    "Choose clearer groups and a better sidebar ordering based on the current session density.",
    "Apply changes by calling the RemoteLab API from this machine; do not merely suggest them.",
    "Snapshot fields like `title`, `brief`, `existingGroup`, and `existingSidebarOrder` are read-only context.",
    "When patching a session, send only `group` and `sidebarOrder` in the API body.",
    "",
    "<session_list_organizer_input>",
    JSON.stringify(payload, null, 2),
    "</session_list_organizer_input>",
  ].join("\n");
}

async function createSessionListOrganizerRun(payload) {
  const sessionResponse = await fetchJsonOrRedirect("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder: "~",
      tool: payload?.tool || "codex",
      name: "sort session list",
      systemPrompt: SESSION_LIST_ORGANIZER_SYSTEM_PROMPT,
      internalRole: SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
    }),
  });
  const organizerSessionId = typeof sessionResponse?.session?.id === "string"
    ? sessionResponse.session.id.trim()
    : "";
  if (!organizerSessionId) {
    throw new Error("Failed to create the hidden session organizer");
  }

  const messageResponse = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(organizerSessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: buildSessionListOrganizerTask(payload?.sessions || []),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {}),
      ...(payload?.thinking ? { thinking: true } : {}),
    }),
  });

  return {
    session: sessionResponse?.session || null,
    run: messageResponse?.run || null,
  };
}

async function waitForSessionListOrganizerRun(runId) {
  const deadline = Date.now() + SESSION_LIST_ORGANIZER_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await fetchJsonOrRedirect(`/api/runs/${encodeURIComponent(runId)}`, {
      revalidate: false,
    });
    const state = typeof data?.run?.state === "string" ? data.run.state : "";
    if (["completed", "failed", "cancelled"].includes(state)) {
      return data.run || null;
    }
    await sleep(SESSION_LIST_ORGANIZER_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out while sorting the session list");
}


function getSessionRunState(session) {
  return session?.activity?.run?.state === "running" ? "running" : "idle";
}

function hasRenderedEventSnapshot(sessionId) {
  const sameSession = renderedEventState.sessionId === sessionId;
  return sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );
}

function shouldFetchSessionEventsForRefresh(sessionId, session) {
  const runState = getSessionRunState(session);
  if (runState !== "running") return true;
  if (!hasRenderedEventSnapshot(sessionId)) return true;
  if (renderedEventState.runState !== "running") return true;
  if (renderedEventState.runningBlockExpanded === true) return true;
  const latestSeq = Number.isInteger(session?.latestSeq) ? session.latestSeq : 0;
  return latestSeq > renderedEventState.latestSeq;
}

function getEventRenderPlan(sessionId, events) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const latestSeq = getLatestEventSeq(normalizedEvents);
  const nextBaseKeys = normalizedEvents.map((event) => getEventRenderBaseKey(event));
  const nextKeys = normalizedEvents.map((event) => getEventRenderKey(event));
  const sameSession = renderedEventState.sessionId === sessionId;
  const hasRenderedSnapshot = sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );

  if (!sameSession || !hasRenderedSnapshot) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (
    latestSeq < renderedEventState.latestSeq ||
    normalizedEvents.length < renderedEventState.eventCount
  ) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (eventKeyArraysEqual(nextKeys, renderedEventState.eventKeys || [])) {
    return { mode: "noop", events: [] };
  }

  if (
    renderedEventState.runningBlockExpanded === true
    && normalizedEvents.length > 0
    && normalizedEvents.length === renderedEventState.eventCount
    && eventKeyArraysEqual(nextBaseKeys, renderedEventState.eventBaseKeys || [])
  ) {
    const lastEvent = normalizedEvents[normalizedEvents.length - 1];
    if (
      isRunningThinkingBlockEvent(lastEvent)
      && Number.isInteger(lastEvent?.blockEndSeq)
      && lastEvent.blockEndSeq > renderedEventState.latestSeq
    ) {
      return { mode: "refresh_running_block", events: [lastEvent] };
    }
  }

  if (eventKeyPrefixMatches(renderedEventState.eventKeys || [], nextKeys)) {
    const appendedEvents = normalizedEvents.slice((renderedEventState.eventKeys || []).length);
    if (appendedEvents.length > 0) {
      return { mode: "append", events: appendedEvents };
    }
  }

  return { mode: "reset", events: normalizedEvents };
}

function reconcilePendingMessageState(event) {
  if (typeof reconcileComposerPendingSendWithEvent === "function") {
    reconcileComposerPendingSendWithEvent(event);
  }
}

const pendingSessionReviewSyncs = new Map();

function normalizeSessionReviewStamp(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : "";
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? new Date(numeric).toISOString() : "";
  }
  const time = new Date(trimmed).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function getSessionReviewStampTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionReviewStamp(session) {
  return normalizeSessionReviewStamp(session?.lastEventAt)
    || normalizeSessionReviewStamp(session?.updatedAt)
    || normalizeSessionReviewStamp(session?.created)
    || "";
}

function getEffectiveSessionReviewedAt(session) {
  const candidates = [
    normalizeSessionReviewStamp(session?.lastReviewedAt),
    normalizeSessionReviewStamp(session?.localReviewedAt),
    normalizeSessionReviewStamp(session?.reviewBaselineAt),
  ].filter(Boolean);
  let best = "";
  let bestTime = 0;
  for (const candidate of candidates) {
    const time = getSessionReviewStampTime(candidate);
    if (time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

function rememberSessionReviewedLocally(session, { render = false } = {}) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  if (!stamp) return "";
  if (getSessionReviewStampTime(stamp) <= getSessionReviewStampTime(getEffectiveSessionReviewedAt(session))) {
    return getEffectiveSessionReviewedAt(session);
  }
  const stored = typeof setLocalSessionReviewedAt === "function"
    ? setLocalSessionReviewedAt(session.id, stamp)
    : stamp;
  session.localReviewedAt = stored || stamp;
  if (render) {
    renderSessionList();
  }
  return session.localReviewedAt;
}

async function syncSessionReviewedToServer(session) {
  if (!session?.id || visitorMode) return session;
  const stamp = getSessionReviewStamp(session);
  if (!stamp) return session;
  if (getSessionReviewStampTime(stamp) <= getSessionReviewStampTime(normalizeSessionReviewStamp(session?.lastReviewedAt))) {
    return session;
  }
  const currentPending = pendingSessionReviewSyncs.get(session.id);
  if (getSessionReviewStampTime(currentPending) >= getSessionReviewStampTime(stamp)) {
    return session;
  }
  pendingSessionReviewSyncs.set(session.id, stamp);
  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastReviewedAt: stamp }),
    });
    return upsertSession(data.session) || data.session || session;
  } finally {
    if (pendingSessionReviewSyncs.get(session.id) === stamp) {
      pendingSessionReviewSyncs.delete(session.id);
    }
  }
}

function markSessionReviewed(session, { sync = false, render = true } = {}) {
  const stamp = rememberSessionReviewedLocally(session, { render });
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session);
}

function normalizeSessionRecord(session, previous = null) {
  const queueCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  const normalized = { ...session };
  if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
    if (queueCount > 0 && Array.isArray(previous?.queuedMessages)) {
      normalized.queuedMessages = previous.queuedMessages;
    } else {
      delete normalized.queuedMessages;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "model")) {
    if (typeof previous?.model === "string") {
      normalized.model = previous.model;
    } else {
      delete normalized.model;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "effort")) {
    if (typeof previous?.effort === "string") {
      normalized.effort = previous.effort;
    } else {
      delete normalized.effort;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "thinking")) {
    if (previous?.thinking === true) {
      normalized.thinking = true;
    } else {
      delete normalized.thinking;
    }
  }
  const localReviewedAt = normalizeSessionReviewStamp(
    normalized.localReviewedAt
    || previous?.localReviewedAt
    || (typeof getLocalSessionReviewedAt === "function" ? getLocalSessionReviewedAt(normalized.id) : ""),
  );
  if (localReviewedAt) {
    normalized.localReviewedAt = localReviewedAt;
  } else {
    delete normalized.localReviewedAt;
  }
  const reviewBaselineAt = normalizeSessionReviewStamp(
    normalized.reviewBaselineAt
    || previous?.reviewBaselineAt
    || (typeof getSessionReviewBaselineAt === "function" ? getSessionReviewBaselineAt() : ""),
  );
  if (reviewBaselineAt) {
    normalized.reviewBaselineAt = reviewBaselineAt;
  } else {
    delete normalized.reviewBaselineAt;
  }
  return normalized;
}

function upsertSession(session) {
  if (!session?.id) return null;
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : sessions.find((entry) => entry.id === session.id);
  const normalized = normalizeSessionRecord(session, previous);
  if (typeof upsertChatSessionState === "function") {
    upsertChatSessionState(normalized, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    const index = sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) {
      sessions.push(normalized);
    } else {
      sessions[index] = normalized;
    }
    sortSessionsInPlace();
  }
  refreshAppCatalog();
  return typeof getChatStoreSession === "function"
    ? getChatStoreSession(session.id)
    : normalized;
}


async function fetchSessionSidebar(sessionId) {
  const url = getSessionSidebarUrl(sessionId);
  const data = await fetchJsonOrRedirect(url);
  return upsertSession(data.session);
}

async function fetchArchivedSessions({ forceFresh = false } = {}) {
  if (visitorMode) return [];
  if (archivedSessionsRefreshPromise) {
    return archivedSessionsRefreshPromise;
  }
  if (!archivedSessionsLoaded && archivedSessionCount === 0) {
    if (typeof replaceChatState === "function") {
      replaceChatState({
        archivedSessionsLoaded: true,
        archivedSessionsLoading: false,
      });
    } else {
      archivedSessionsLoaded = true;
      archivedSessionsLoading = false;
    }
    lastArchivedSessionsRefreshAt = Date.now();
    renderSessionList();
    return [];
  }

  if (typeof setChatArchivedSessionsLoading === "function") {
    setChatArchivedSessionsLoading(true);
  } else {
    archivedSessionsLoading = true;
  }
  renderSessionList();
  const request = (async () => {
    try {
      const data = await fetchJsonOrRedirect(
        ARCHIVED_SESSION_LIST_URL,
        buildSessionRefreshRequestOptions(forceFresh),
      );
      const nextArchivedSessions = applyArchivedSessionListState(data.sessions || [], {
        archivedCount: Number.isInteger(data.archivedCount)
          ? data.archivedCount
          : (Array.isArray(data.sessions) ? data.sessions.length : 0),
      });
      lastArchivedSessionsRefreshAt = Date.now();
      return nextArchivedSessions;
    } catch (error) {
      if (typeof setChatArchivedSessionsLoading === "function") {
        setChatArchivedSessionsLoading(false);
      } else {
        archivedSessionsLoading = false;
      }
      renderSessionList();
      throw error;
    } finally {
      archivedSessionsRefreshPromise = null;
    }
  })();
  archivedSessionsRefreshPromise = request;
  return request;
}

async function updateSessionRecord(sessionId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (data.session) {
    const session = upsertSession(data.session) || data.session;
    renderSessionList();
    if (currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, session);
    } else if (typeof renderSettingsSessionPresentationPanel === "function") {
      renderSettingsSessionPresentationPanel();
    }
    return session;
  }
  if (currentSessionId === sessionId) {
    return refreshCurrentSession();
  }
  return refreshSidebarSession(sessionId);
}

async function fetchSessionsList({ forceFresh = false } = {}) {
  if (visitorMode) return [];
  const data = await fetchJsonOrRedirect(
    SESSION_LIST_URL,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  applySessionListState(data.sessions || [], {
    archivedCount: Number.isInteger(data.archivedCount) ? data.archivedCount : 0,
  });
  lastSessionsListRefreshAt = Date.now();
  if (typeof renderSettingsSessionPresentationPanel === "function") {
    renderSettingsSessionPresentationPanel();
  }
  return sessions;
}

async function organizeSessionListWithAgent({ closeSidebar = false } = {}) {
  if (visitorMode) return false;
  if (sessionListOrganizerInFlight) return sessionListOrganizerInFlight;

  const payload = buildSessionListOrganizerPayload();
  if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    setSortSessionListButtonState("Nothing to sort", { busy: false });
    scheduleSortSessionListButtonReset();
    return false;
  }

  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
    sessionListOrganizerLabelResetTimer = null;
  }
  setSortSessionListButtonState("Sorting…", { busy: true });

  const request = (async () => {
    try {
      const data = await createSessionListOrganizerRun(payload);
      const runId = typeof data?.run?.id === "string" ? data.run.id.trim() : "";
      if (runId) {
        const run = await waitForSessionListOrganizerRun(runId);
        if (run?.state !== "completed") {
          throw new Error(run?.failureReason || `Sort list ${run?.state || "failed"}`);
        }
      } else {
        throw new Error("Sort list did not start a run");
      }
      await fetchSessionsList();
      if (closeSidebar && !isDesktop) {
        closeSidebarFn();
      }
      setSortSessionListButtonState("Sorted", { busy: false });
      return true;
    } catch (error) {
      console.warn("[sessions] Failed to organize the session list:", error.message);
      setSortSessionListButtonState("Sort failed", { busy: false });
      return false;
    } finally {
      sessionListOrganizerInFlight = null;
      scheduleSortSessionListButtonReset();
    }
  })();

  sessionListOrganizerInFlight = request;
  return request;
}

function applyAttachedSessionState(id, session) {
  const attachedSessionRenderState = getAttachedSessionRenderState();
  const nextSignature = getComparableAttachedSessionStateSignature(session || null);
  const shouldRefreshUi = attachedSessionRenderState.sessionId !== id
    || attachedSessionRenderState.signature !== nextSignature;
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(id, { hasAttachedSession: true });
  } else {
    currentSessionId = id;
    hasAttachedSession = true;
  }
  if (!shouldRefreshUi) {
    syncBrowserState();
    syncForkButton();
    syncShareButton();
    return false;
  }
  currentTokens = 0;
  contextTokens.style.display = "none";
  compactBtn.style.display = "none";
  dropToolsBtn.style.display = "none";

  const displayName = getSessionDisplayName(session);
  headerTitle.textContent = displayName;
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) {
    const titleSuffix = getShareSnapshotViewValue("titleSuffix", "Shared Snapshot");
    document.title = `${displayName} · ${titleSuffix}`;
  }
  if (typeof reconcileComposerPendingSendWithSession === "function") {
    reconcileComposerPendingSendWithSession(session);
  }
  updateStatus("connected", session);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(session);
  }

  if (session?.tool) {
    const availableTools = typeof allToolsList !== "undefined" && Array.isArray(allToolsList)
      ? allToolsList
      : (Array.isArray(toolsList) ? toolsList : []);
    const toolAvailable = availableTools.some((tool) => tool.id === session.tool);
    if (toolAvailable || availableTools.length === 0) {
      if (toolAvailable && typeof refreshPrimaryToolPicker === "function") {
        refreshPrimaryToolPicker({ keepToolIds: [session.tool], selectedValue: session.tool });
      }
      inlineToolSelect.value = session.tool;
      selectedTool = session.tool;
    }
    if (toolAvailable) {
      Promise.resolve(loadModelsForCurrentTool()).catch(() => {});
    }
  }

  restoreDraft();
  renderSessionList();
  if (typeof renderSettingsSessionPresentationPanel === "function") {
    renderSettingsSessionPresentationPanel();
  }
  syncBrowserState();
  syncForkButton();
  syncShareButton();
  attachedSessionRenderState.sessionId = id;
  attachedSessionRenderState.signature = nextSignature;
  return true;
}

function getAttachedSessionRenderState() {
  if (!(globalThis.__attachedSessionRenderState && typeof globalThis.__attachedSessionRenderState === "object")) {
    globalThis.__attachedSessionRenderState = {
      sessionId: null,
      signature: "",
    };
  }
  return globalThis.__attachedSessionRenderState;
}

function resetAttachedSessionRenderState() {
  const attachedSessionRenderState = getAttachedSessionRenderState();
  attachedSessionRenderState.sessionId = null;
  attachedSessionRenderState.signature = "";
}

function buildComparableSessionState(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => buildComparableSessionState(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const nextValue = buildComparableSessionState(value[key]);
    if (typeof nextValue !== "undefined") {
      normalized[key] = nextValue;
    }
  }
  return normalized;
}

function getComparableSessionStateSignature(value) {
  return JSON.stringify(buildComparableSessionState(value));
}

function getComparableAttachedSessionStateSignature(session) {
  if (!session || typeof session !== "object") {
    return getComparableSessionStateSignature(session);
  }
  return getComparableSessionStateSignature({
    id: session.id || null,
    name: session.name || "",
    tool: session.tool || "",
    status: session.status || "",
    archived: session.archived === true,
    activity: session.activity || null,
    queuedMessages: Array.isArray(session.queuedMessages) ? session.queuedMessages : null,
    model: typeof session.model === "string" ? session.model : null,
    effort: typeof session.effort === "string" ? session.effort : null,
    thinking: session.thinking === true ? true : null,
  });
}

async function fetchSessionState(sessionId, { forceFresh = false } = {}) {
  if (isShareSnapshotReadOnlyMode()) {
    const snapshotSession = buildShareSnapshotSessionRecord();
    if (!snapshotSession || snapshotSession.id !== sessionId) {
      throw new Error("Session not found");
    }
    const normalized = upsertSession(snapshotSession);
    if (normalized && currentSessionId === sessionId) {
      applyAttachedSessionState(sessionId, normalized);
    }
    lastCurrentSessionRefreshAt = Date.now();
    lastCurrentSessionRefreshSessionId = sessionId;
    return normalized;
  }
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  const previous = typeof getChatStoreSession === "function"
    ? getChatStoreSession(sessionId)
    : (sessions.find((entry) => entry.id === sessionId) || null);
  const nextSession = normalizeSessionRecord(data.session, previous);
  const sessionChanged = !previous
    || getComparableSessionStateSignature(previous) !== getComparableSessionStateSignature(nextSession);
  const normalized = sessionChanged
    ? (upsertSession(nextSession) || nextSession)
    : previous;
  if (normalized && currentSessionId === sessionId) {
    rememberSessionReviewedLocally(normalized);
    applyAttachedSessionState(sessionId, normalized);
  }
  lastCurrentSessionRefreshAt = Date.now();
  lastCurrentSessionRefreshSessionId = sessionId;
  return normalized;
}

async function fetchSessionEvents(
  sessionId,
  { runState = "idle", viewportIntent = "preserve", forceFresh = false } = {},
) {
  const normalizedViewportIntent = normalizeSessionViewportIntent(viewportIntent);
  const hadRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  const shouldStickToBottom =
    !hadRenderedMessages ||
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const data = isShareSnapshotReadOnlyMode()
    ? { events: getShareSnapshotDisplayEvents() }
    : await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=visible`,
      buildSessionRefreshRequestOptions(forceFresh),
    );
  const events = data.events || [];
  if (currentSessionId !== sessionId) return events;
  const renderPlan = getEventRenderPlan(sessionId, events);

  if (renderPlan.mode === "refresh_running_block") {
    const [runningEvent] = renderPlan.events;
    if (
      runningEvent
      && typeof refreshExpandedRunningThinkingBlock === "function"
      && refreshExpandedRunningThinkingBlock(sessionId, runningEvent)
    ) {
      updateRenderedEventState(sessionId, events, { runState });
      return renderPlan.events;
    }
  }

  if (renderPlan.mode === "reset") {
    const preserveRunningBlockExpanded =
      renderedEventState.sessionId === sessionId
      && renderedEventState.runningBlockExpanded === true;
    clearMessages({ preserveRunningBlockExpanded });
    if (events.length === 0) {
      showEmpty();
    }
    for (const event of events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    if (messagesInner.children.length === 0) {
      showEmpty();
    }
    updateRenderedEventState(sessionId, events, { runState });
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent: normalizedViewportIntent })) {
      scrollCurrentSessionViewportToTop();
    } else if (
      normalizedViewportIntent === "session_entry"
      && shouldFocusLatestTurnStartOnSessionEntry(sessionId, latestTurnStart)
    ) {
      scrollNodeToTop(latestTurnStart);
    } else if (events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    return events;
  }

  if (renderPlan.mode === "append") {
    for (const event of renderPlan.events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events, { runState });
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent: normalizedViewportIntent })) {
      scrollCurrentSessionViewportToTop();
    } else if (
      normalizedViewportIntent === "session_entry"
      && shouldFocusLatestTurnStartOnSessionEntry(sessionId, latestTurnStart)
    ) {
      scrollNodeToTop(latestTurnStart);
    } else if (renderPlan.events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    return renderPlan.events;
  }

  updateRenderedEventState(sessionId, events, { runState });
  const latestTurnStart = applyFinishedTurnCollapseState();
  if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent: normalizedViewportIntent })) {
    scrollCurrentSessionViewportToTop();
  } else if (
    normalizedViewportIntent === "session_entry"
    && shouldFocusLatestTurnStartOnSessionEntry(sessionId, latestTurnStart)
  ) {
    scrollNodeToTop(latestTurnStart);
  }
  return events;
}

async function runCurrentSessionRefresh(
  sessionId,
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
  } = {},
) {
  const session = await fetchSessionState(sessionId, { forceFresh });
  if (currentSessionId !== sessionId) return session;
  const runState = getSessionRunState(session);
  if (shouldFetchSessionEventsForRefresh(sessionId, session)) {
    await fetchSessionEvents(sessionId, { runState, viewportIntent, forceFresh });
    return session;
  }
  renderedEventState.sessionId = sessionId;
  renderedEventState.runState = runState;
  return session;
}

async function refreshCurrentSession(
  {
    viewportIntent = hasAttachedSession ? "preserve" : "session_entry",
    forceFresh = false,
  } = {},
) {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  const requestOptions = mergeSessionRefreshOptions(
    { forceFresh: false, viewportIntent: hasAttachedSession ? "preserve" : "session_entry" },
    { forceFresh, viewportIntent },
  );
  if (currentSessionRefreshPromise) {
    pendingCurrentSessionRefresh = true;
    pendingCurrentSessionRefreshOptions = mergeSessionRefreshOptions(
      pendingCurrentSessionRefreshOptions || requestOptions,
      requestOptions,
    );
    return currentSessionRefreshPromise;
  }
  currentSessionRefreshPromise = (async () => {
    try {
      return await runCurrentSessionRefresh(sessionId, requestOptions);
    } finally {
      currentSessionRefreshPromise = null;
      if (pendingCurrentSessionRefresh) {
        const pendingOptions = pendingCurrentSessionRefreshOptions || requestOptions;
        pendingCurrentSessionRefresh = false;
        pendingCurrentSessionRefreshOptions = null;
        refreshCurrentSession(pendingOptions).catch(() => {});
      }
    }
  })();
  return currentSessionRefreshPromise;
}

async function refreshSidebarSession(sessionId) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession();
  }
  if (sidebarSessionRefreshPromises.has(sessionId)) {
    pendingSidebarSessionRefreshes.add(sessionId);
    return sidebarSessionRefreshPromises.get(sessionId);
  }
  const request = (async () => {
    try {
      const session = await fetchSessionSidebar(sessionId);
      if (session) {
        renderSessionList();
      }
      return session;
    } catch (error) {
      if (error?.message === "Session not found") {
        const nextSessions = sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length !== sessions.length) {
          if (typeof removeChatSessionState === "function") {
            removeChatSessionState(sessionId, {
              compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
            });
          } else {
            sessions = nextSessions;
          }
          refreshAppCatalog();
          renderSessionList();
        }
        return null;
      }
      throw error;
    } finally {
      sidebarSessionRefreshPromises.delete(sessionId);
      if (pendingSidebarSessionRefreshes.delete(sessionId)) {
        refreshSidebarSession(sessionId).catch(() => {});
      }
    }
  })();
  sidebarSessionRefreshPromises.set(sessionId, request);
  return request;
}

async function refreshRealtimeViews({
  viewportIntent = "preserve",
  forceFresh = false,
  refreshMode = "full",
} = {}) {
  if (visitorMode) {
    if (currentSessionId) {
      await refreshCurrentSession({ viewportIntent, forceFresh }).catch(() => {});
    }
    return;
  }

  const useForegroundPlan = refreshMode === "foreground";
  const shouldRefreshSessionsList = useForegroundPlan
    ? shouldRefreshForegroundSessionList({ forceFresh })
    : true;
  if (shouldRefreshSessionsList) {
    await fetchSessionsList({ forceFresh }).catch(() => {});
  }
  if (pendingNavigationState) {
    restoreOwnerSessionSelection();
  }
  const shouldRefreshCurrent = useForegroundPlan
    ? shouldRefreshForegroundCurrentSession({ forceFresh })
    : Boolean(currentSessionId);
  if (currentSessionId && shouldRefreshCurrent) {
    await refreshCurrentSession({ viewportIntent, forceFresh }).catch(() => {});
  }
  const shouldRefreshArchived = useForegroundPlan
    ? shouldRefreshForegroundArchivedSessions({
      forceFresh,
      refreshedSessionsList: shouldRefreshSessionsList,
    })
    : (typeof archivedSessionsLoaded !== "undefined" && archivedSessionsLoaded);
  if (shouldRefreshArchived) {
    await fetchArchivedSessions({ forceFresh }).catch(() => {});
  }
}

function startParallelCurrentSessionBootstrap() {
  if (visitorMode || !currentSessionId) return;
  refreshCurrentSession({ viewportIntent: "session_entry" }).catch((error) => {
    if (error?.message === "Session not found") return;
    console.warn(
      "[sessions] Failed to bootstrap the current session in parallel:",
      error?.message || error,
    );
  });
}

async function bootstrapViaHttp({ deferOwnerRestore = false } = {}) {
  if (visitorMode && visitorSessionId) {
    if (typeof setChatCurrentSession === "function") {
      setChatCurrentSession(visitorSessionId, { hasAttachedSession: false });
    } else {
      currentSessionId = visitorSessionId;
    }
    attachSession(visitorSessionId, { id: visitorSessionId, name: "Session", status: "idle" });
    await refreshCurrentSession();
    return;
  }
  if (deferOwnerRestore) {
    startParallelCurrentSessionBootstrap();
  }
  await fetchSessionsList();
  if (!deferOwnerRestore) {
    restoreOwnerSessionSelection();
  }
}

async function bootstrapShareSnapshotView() {
  const session = buildShareSnapshotSessionRecord();
  if (!session) {
    showEmpty();
    return null;
  }
  const normalizedSession = normalizeSessionRecord(
    session,
    typeof getChatStoreSession === "function"
      ? getChatStoreSession(session.id)
      : (sessions.find((entry) => entry.id === session.id) || null),
  );
  if (typeof replaceChatState === "function") {
    replaceChatState({
      sessions: [normalizedSession],
      hasLoadedSessions: true,
      archivedSessionCount: 0,
      archivedSessionsLoaded: false,
      archivedSessionsLoading: false,
      currentSessionId: session.id,
      hasAttachedSession: false,
    }, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = [normalizedSession];
    hasLoadedSessions = true;
    archivedSessionCount = 0;
    archivedSessionsLoaded = false;
    currentSessionId = session.id;
  }
  visitorSessionId = session.id;
  attachSession(session.id, normalizedSession);
  return normalizedSession;
}

async function setupPushNotifications() {
  if (visitorMode) return;
  if (!("PushManager" in window)) return;
  try {
    const persistSubscription = async (subscription) => {
      const payload = subscription?.toJSON ? subscription.toJSON() : subscription;
      if (!payload?.endpoint) return;
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    };
    const reg = await ensureServiceWorkerRegistration();
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await persistSubscription(existing);
      return;
    }
    const res = await fetch("/api/push/vapid-public-key");
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await persistSubscription(sub);
    console.log("[push] Subscribed to web push");
  } catch (err) {
    console.warn("[push] Setup failed:", err.message);
  }
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(
      `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`,
      { updateViaCache: "none" },
    );
    await reg.update().catch(() => {});
    reg.installing?.postMessage({ type: "remotelab:clear-caches" });
    reg.waiting?.postMessage({ type: "remotelab:clear-caches" });
    reg.active?.postMessage({ type: "remotelab:clear-caches" });
    await navigator.serviceWorker.ready.catch(() => {});
    return reg;
  } catch (err) {
    console.warn("[sw] Setup failed:", err.message);
    return null;
  }
}

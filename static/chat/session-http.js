function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const currentTab = typeof getActiveSidebarTabValue === "function"
    ? getActiveSidebarTabValue()
    : activeTab;
  const requestedTab = pendingNavigationState?.tab || currentTab;
  if (requestedTab !== currentTab) {
    switchTab(requestedTab, { syncState: false });
  }

  if (
    typeof isNewSessionDraftActive === "function"
    && isNewSessionDraftActive()
    && !pendingNavigationState?.sessionId
  ) {
    syncBrowserState({ sessionId: null, tab: getActiveSidebarTabValue() });
    return;
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    if (currentSessionId && typeof settleAttachedSessionSidebarState === "function") {
      Promise.resolve(settleAttachedSessionSidebarState({
        sessionId: currentSessionId,
        sync: true,
        render: false,
      })).catch(() => {});
    }
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

function canOrganizeSessionListFromUi() {
  return typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
}

function isOwnerPushFeatureEnabled() {
  return typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
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
let sessionsListRequestSequence = 0;
let sessionListMutationEpoch = 0;

function bumpSessionListMutationEpoch() {
  sessionListMutationEpoch += 1;
  return sessionListMutationEpoch;
}
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
const SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE = typeof SOURCE_FILTER_CHAT_VALUE !== "undefined" ? SOURCE_FILTER_CHAT_VALUE : "chat_ui";
const SESSION_HTTP_SOURCE_FILTER_FEISHU_VALUE = typeof SOURCE_FILTER_FEISHU_VALUE !== "undefined" ? SOURCE_FILTER_FEISHU_VALUE : "feishu";
const SESSION_HTTP_SOURCE_FILTER_EMAIL_VALUE = typeof SOURCE_FILTER_EMAIL_VALUE !== "undefined" ? SOURCE_FILTER_EMAIL_VALUE : "email";
const SESSION_HTTP_SOURCE_FILTER_BOT_VALUE = typeof SOURCE_FILTER_BOT_VALUE !== "undefined" ? SOURCE_FILTER_BOT_VALUE : "bot";
const SESSION_HTTP_SOURCE_FILTER_AUTOMATION_VALUE = typeof SOURCE_FILTER_AUTOMATION_VALUE !== "undefined" ? SOURCE_FILTER_AUTOMATION_VALUE : "automation";
const SESSION_HTTP_FILTER_ALL_VALUE = typeof FILTER_ALL_VALUE !== "undefined" ? FILTER_ALL_VALUE : "all";
const SESSION_LIST_ORGANIZER_SOURCE_LABELS = {
  [SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE]: "Chat UI",
  [SESSION_HTTP_SOURCE_FILTER_FEISHU_VALUE]: "Feishu",
  [SESSION_HTTP_SOURCE_FILTER_EMAIL_VALUE]: "Email",
  [SESSION_HTTP_SOURCE_FILTER_BOT_VALUE]: "Bot",
  [SESSION_HTTP_SOURCE_FILTER_AUTOMATION_VALUE]: "Automation",
  [SESSION_HTTP_FILTER_ALL_VALUE]: "All origins",
};
let sessionListOrganizerInFlight = null;
let sessionListOrganizerLabelResetTimer = null;

const SESSION_LIST_ORGANIZER_SYSTEM_PROMPT = [
  "You are RemoteLab's hidden session-list organizer.",
  "Build the smallest stable hierarchy that helps one account resume related work from its scoped non-archived Sessions.",
  "",
  "Hierarchy:",
  "- A Session is one concrete conversation.",
  "- A Project is a durable workstream the user would reasonably return to across related Sessions.",
  "- A Space is a broad working-context switch that normally contains multiple Projects.",
  "",
  "Method:",
  "1. Cluster Sessions into Projects by shared goal, context, materials, decisions, and likely next actions.",
  "2. Merge one-off steps and narrow feature slices into the nearest durable Project; let Session titles carry the specific subtask.",
  "3. Only after Projects are coherent, cluster them into Spaces.",
  "4. A Space containing only one Project is normally redundant. Fold it into the closest broader Space unless it is a deliberate durable boundary expected to hold multiple Projects.",
  "Preserve coherent labels; otherwise reuse and merge before creating new ones. Use `Loose` for genuinely temporary or ambiguous work.",
  "Prefer a compact, readable sidebar over taxonomic purity and use the dominant language of the scoped catalog.",
  "Use `sidebarOrder` for stable hierarchy order; keep each Project's Sessions contiguous. The UI handles transient running and attention priority separately.",
  "",
  "Boundaries:",
  "- Account scope is strict: never inspect, infer, or patch another account's taxonomy.",
  "- Update only Sessions in the snapshot. Do not rename, archive, unarchive, pin, edit prompts, or ask follow-up questions.",
  "- Only writable API fields for this task are `space`, `group`, and `sidebarOrder`. Use unique contiguous positive orders within the snapshot.",
  "- Apply changes with `remotelab api PATCH /api/sessions/<sessionId> --body ...`; if unavailable, use `node \"$REMOTELAB_PROJECT_ROOT/cli.js\" api ...`.",
  "- Never send read-only snapshot fields such as `title`, `brief`, or any `existing*` field in PATCH bodies.",
  "If an important decision is unsupported, inspect only the ambiguous Sessions with `remotelab api GET /api/sessions` instead of doing broad archaeology.",
  "Return only a brief plain-text summary after applying the changes.",
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
    existingSpace: typeof session?.space === "string" && session.space.trim()
      ? clipSessionListOrganizerText(session.space, 60)
      : null,
    existingGroup: typeof session?.group === "string" && session.group.trim()
      ? clipSessionListOrganizerText(session.group, 80)
      : null,
    existingSidebarOrder: Number.isInteger(session?.sidebarOrder) && session.sidebarOrder > 0
      ? session.sidebarOrder
      : null,
    pinned: session?.pinned === true,
    tool: clipSessionListOrganizerText(session?.tool || "", 40),
    sourceId: clipSessionListOrganizerText(
      typeof getEffectiveSessionSourceId === "function"
        ? getEffectiveSessionSourceId(session)
        : (session?.sourceId || ""),
      80,
    ),
    sourceCategory: clipSessionListOrganizerText(
      typeof getSessionSourceCategory === "function"
        ? getSessionSourceCategory(session)
        : "",
      40,
    ),
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

function getSessionListOrganizerSourceLabel(sourceFilter) {
  return SESSION_LIST_ORGANIZER_SOURCE_LABELS[sourceFilter] || SESSION_LIST_ORGANIZER_SOURCE_LABELS[FILTER_ALL_VALUE];
}

function getSessionListOrganizerScope() {
  const currentSourceFilter = typeof getActiveSourceFilterValue === "function"
    ? normalizeSourceFilter(getActiveSourceFilterValue())
    : normalizeSourceFilter(activeSourceFilter);
  const defaultedToChatUi = currentSourceFilter === FILTER_ALL_VALUE;
  const organizerSourceFilter = defaultedToChatUi ? SESSION_HTTP_SOURCE_FILTER_CHAT_VALUE : currentSourceFilter;
  const scopedSessions = getActiveSessions().filter((session) => (
    typeof matchesSourceFilter === "function"
      ? matchesSourceFilter(session, organizerSourceFilter)
      : organizerSourceFilter === FILTER_ALL_VALUE
  ));
  return {
    currentSourceFilter,
    organizerSourceFilter,
    defaultedToChatUi,
    sourceLabel: getSessionListOrganizerSourceLabel(organizerSourceFilter),
    sessions: scopedSessions,
  };
}

function buildSessionListOrganizerPayload() {
  const scope = getSessionListOrganizerScope();
  const sessions = scope.sessions.map(buildSessionListOrganizerSessionMetadata).filter((session) => session.id);
  return {
    tool: selectedTool || preferredTool || "codex",
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    scope: {
      currentSourceFilter: scope.currentSourceFilter,
      organizerSourceFilter: scope.organizerSourceFilter,
      sourceLabel: scope.sourceLabel,
      defaultedToChatUi: scope.defaultedToChatUi,
    },
    sessions,
  };
}

function buildSessionListOrganizerTask(input) {
  const normalizedInput = Array.isArray(input)
    ? { sessions: input }
    : (input && typeof input === "object" ? input : {});
  const sessions = Array.isArray(normalizedInput.sessions) ? normalizedInput.sessions : [];
  const scope = normalizedInput.scope && typeof normalizedInput.scope === "object"
    ? normalizedInput.scope
    : {};
  const payload = {
    generatedAt: new Date().toISOString(),
    totalSessions: sessions.length,
    scope,
    sessions,
  };
  return [
    "Organize the scoped non-archived Sessions in the snapshot using the hierarchy and write boundaries from the system prompt.",
    scope?.sourceLabel
      ? `Source scope: ${scope.sourceLabel}${scope.defaultedToChatUi ? " (All origins defaults to Chat UI for daily organization)." : "."}`
      : "",
    "Apply the organization now; do not merely propose it.",
    "Patch only Sessions present in the snapshot and send only `space`, `group`, and `sidebarOrder`.",
    "Treat `title`, `brief`, and every `existing*` field as read-only context.",
    "",
    "<session_list_organizer_input>",
    JSON.stringify(payload, null, 2),
    "</session_list_organizer_input>",
  ].filter((line) => line !== "").join("\n");
}

async function createSessionListOrganizerRun(payload) {
  const sessionResponse = await fetchJsonOrRedirect("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder: typeof window.remotelabGetDefaultSessionFolder === "function"
        ? window.remotelabGetDefaultSessionFolder()
        : "~",
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
      text: buildSessionListOrganizerTask(payload || {}),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {}),
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
let heldSidebarSessionState = null;
const optimisticSessionArchiveMutations = new Map();
let sessionArchiveMutationEpoch = 0;

function normalizeSessionArchiveMutationId(sessionId) {
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : "";
}

function getSessionArchiveMutationEpoch() {
  return sessionArchiveMutationEpoch;
}

function isSessionArchiveMutationEpochCurrent(epoch) {
  return epoch === sessionArchiveMutationEpoch;
}

function bumpSessionArchiveMutationEpoch() {
  sessionArchiveMutationEpoch += 1;
  return sessionArchiveMutationEpoch;
}

function beginSessionArchiveOptimisticMutation(sessionId, archived) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  const shouldArchive = archived === true;
  const existing = optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
  const mutation = {
    sessionId: normalizedSessionId,
    archived: shouldArchive,
    archivedAt: shouldArchive
      ? (existing?.archivedAt || new Date().toISOString())
      : "",
    epoch: bumpSessionArchiveMutationEpoch(),
  };
  optimisticSessionArchiveMutations.set(normalizedSessionId, mutation);
  return mutation;
}

function finishSessionArchiveOptimisticMutation(sessionId) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  const existing = optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
  if (!existing) return null;
  optimisticSessionArchiveMutations.delete(normalizedSessionId);
  bumpSessionArchiveMutationEpoch();
  return existing;
}

function getSessionArchiveOptimisticMutation(sessionId) {
  const normalizedSessionId = normalizeSessionArchiveMutationId(sessionId);
  if (!normalizedSessionId) return null;
  return optimisticSessionArchiveMutations.get(normalizedSessionId) || null;
}

function applySessionArchiveOptimisticMutation(session) {
  if (!session?.id) return session;
  const mutation = getSessionArchiveOptimisticMutation(session.id);
  if (!mutation) return session;
  const next = { ...session };
  if (mutation.archived) {
    next.archived = true;
    next.archivedAt = next.archivedAt || mutation.archivedAt || new Date().toISOString();
    delete next.pinned;
    return next;
  }
  delete next.archived;
  delete next.archivedAt;
  return next;
}

function adjustArchivedCountForSessionArchiveOptimisticMutations(
  archivedCount,
  responseSessions = [],
  { listKind = "active" } = {},
) {
  let nextCount = Number.isInteger(archivedCount) && archivedCount >= 0
    ? archivedCount
    : 0;
  if (optimisticSessionArchiveMutations.size === 0) return nextCount;
  const responseIds = new Set(
    (Array.isArray(responseSessions) ? responseSessions : [])
      .map((session) => session?.id)
      .filter(Boolean),
  );
  const isArchivedList = listKind === "archived";
  for (const mutation of optimisticSessionArchiveMutations.values()) {
    const responseHasSession = responseIds.has(mutation.sessionId);
    if (mutation.archived) {
      if ((isArchivedList && !responseHasSession) || (!isArchivedList && responseHasSession)) {
        nextCount += 1;
      }
    } else if ((isArchivedList && responseHasSession) || (!isArchivedList && !responseHasSession)) {
      nextCount = Math.max(0, nextCount - 1);
    }
  }
  return nextCount;
}

function cloneSessionForSidebarHold(session) {
  if (!session || typeof session !== "object") return null;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(session);
    } catch {}
  }
  try {
    return JSON.parse(JSON.stringify(session));
  } catch {
    return { ...session };
  }
}

function getHeldSidebarSessionState(sessionId = currentSessionId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) return null;
  if (!heldSidebarSessionState || heldSidebarSessionState.sessionId !== normalizedSessionId) {
    return null;
  }
  return heldSidebarSessionState;
}

function getSessionSidebarListSnapshot(session) {
  if (!session?.id || session.id !== currentSessionId) return session;
  const heldState = getHeldSidebarSessionState(session.id);
  return heldState?.snapshot || session;
}

function holdAttachedSessionSidebarState(session) {
  if (!session?.id) return null;
  const existing = getHeldSidebarSessionState(session.id);
  heldSidebarSessionState = {
    sessionId: session.id,
    snapshot: cloneSessionForSidebarHold(session) || { ...session },
    pendingReviewAt: existing?.pendingReviewAt || "",
  };
  return heldSidebarSessionState;
}

function clearHeldSidebarSessionState(sessionId = currentSessionId) {
  const heldState = getHeldSidebarSessionState(sessionId);
  if (!heldState) return null;
  heldSidebarSessionState = null;
  return heldState;
}

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

function applySessionReviewedStampLocally(session, stamp, { render = false } = {}) {
  if (!session?.id) return "";
  const normalizedStamp = normalizeSessionReviewStamp(stamp);
  if (!normalizedStamp) return "";
  if (getSessionReviewStampTime(normalizedStamp) <= getSessionReviewStampTime(getEffectiveSessionReviewedAt(session))) {
    return getEffectiveSessionReviewedAt(session);
  }
  const stored = typeof setLocalSessionReviewedAt === "function"
    ? setLocalSessionReviewedAt(session.id, normalizedStamp)
    : normalizedStamp;
  session.localReviewedAt = stored || normalizedStamp;
  if (render) {
    renderSessionList();
  }
  return session.localReviewedAt;
}

function rememberSessionReviewedLocally(session, { render = false } = {}) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  return applySessionReviewedStampLocally(session, stamp, { render });
}

function stageSessionReviewedForAttachedSession(session) {
  if (!session?.id) return "";
  const stamp = getSessionReviewStamp(session);
  if (!stamp) return "";
  const heldState = holdAttachedSessionSidebarState(session);
  if (!heldState) return "";
  if (getSessionReviewStampTime(stamp) > getSessionReviewStampTime(heldState.pendingReviewAt)) {
    heldState.pendingReviewAt = stamp;
  }
  return heldState.pendingReviewAt;
}

async function syncSessionReviewedToServer(session, stampOverride = "") {
  if (!session?.id || visitorMode) return session;
  const stamp = normalizeSessionReviewStamp(stampOverride) || getSessionReviewStamp(session);
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

function settleAttachedSessionSidebarState({
  sessionId = currentSessionId,
  sync = true,
  render = true,
} = {}) {
  const heldState = clearHeldSidebarSessionState(sessionId);
  const liveSession = heldState?.sessionId
    ? (typeof getChatStoreSession === "function"
      ? getChatStoreSession(heldState.sessionId)
      : (sessions.find((session) => session.id === heldState.sessionId) || null))
    : null;
  const session = liveSession || heldState?.snapshot || null;
  if (!heldState) {
    if (render) renderSessionList();
    return Promise.resolve(session);
  }

  const stamp = normalizeSessionReviewStamp(heldState.pendingReviewAt) || getSessionReviewStamp(session);
  if (stamp) {
    applySessionReviewedStampLocally(session, stamp, { render });
  } else if (render) {
    renderSessionList();
  }
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session, stamp);
}

function markSessionReviewed(session, { sync = false, render = true } = {}) {
  const stamp = rememberSessionReviewedLocally(session, { render });
  if (!stamp || !sync) {
    return Promise.resolve(session);
  }
  return syncSessionReviewedToServer(session);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const flushHeldSidebarSessionState = () => {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: currentSessionId,
      sync: false,
      render: false,
    })).catch(() => {});
  };
  window.addEventListener("pagehide", flushHeldSidebarSessionState);
  window.addEventListener("beforeunload", flushHeldSidebarSessionState);
}

function normalizeSessionRecord(session, previous = null) {
  const queueCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  const sessionWithOptimisticArchive = typeof applySessionArchiveOptimisticMutation === "function"
    ? applySessionArchiveOptimisticMutation(session)
    : session;
  const normalized = { ...sessionWithOptimisticArchive };
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


async function fetchSessionSidebar(sessionId, { forceFresh = false } = {}) {
  const url = getSessionSidebarUrl(sessionId);
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(url, buildSessionRefreshRequestOptions(forceFresh));
  if (
    typeof isSessionArchiveMutationEpochCurrent === "function"
    && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
  ) {
    return typeof getChatStoreSession === "function"
      ? getChatStoreSession(sessionId)
      : (sessions.find((session) => session.id === sessionId) || null);
  }
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
      const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
        ? getSessionArchiveMutationEpoch()
        : 0;
      const data = await fetchJsonOrRedirect(
        ARCHIVED_SESSION_LIST_URL,
        buildSessionRefreshRequestOptions(forceFresh),
      );
      if (
        typeof isSessionArchiveMutationEpochCurrent === "function"
        && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
      ) {
        if (typeof setChatArchivedSessionsLoading === "function") {
          setChatArchivedSessionsLoading(false);
        } else {
          archivedSessionsLoading = false;
        }
        renderSessionList();
        return typeof getArchivedSessions === "function"
          ? getArchivedSessions()
          : sessions.filter((session) => session?.archived === true);
      }
      const archivedSessionsPayload = data.sessions || [];
      const nextArchivedSessions = applyArchivedSessionListState(archivedSessionsPayload, {
        archivedCount: typeof adjustArchivedCountForSessionArchiveOptimisticMutations === "function"
          ? adjustArchivedCountForSessionArchiveOptimisticMutations(
            Number.isInteger(data.archivedCount)
              ? data.archivedCount
              : (Array.isArray(data.sessions) ? data.sessions.length : 0),
            archivedSessionsPayload,
            { listKind: "archived" },
          )
          : (Number.isInteger(data.archivedCount)
            ? data.archivedCount
            : (Array.isArray(data.sessions) ? data.sessions.length : 0)),
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
  const requestSequence = ++sessionsListRequestSequence;
  const requestMutationEpoch = sessionListMutationEpoch;
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(
    SESSION_LIST_URL,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  if (
    requestSequence !== sessionsListRequestSequence
    || requestMutationEpoch !== sessionListMutationEpoch
    || (
      typeof isSessionArchiveMutationEpochCurrent === "function"
      && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
    )
  ) {
    return sessions;
  }
  const sessionsPayload = data.sessions || [];
  applySessionListState(data.sessions || [], {
    archivedCount: typeof adjustArchivedCountForSessionArchiveOptimisticMutations === "function"
      ? adjustArchivedCountForSessionArchiveOptimisticMutations(
        Number.isInteger(data.archivedCount) ? data.archivedCount : 0,
        sessionsPayload,
        { listKind: "active" },
      )
      : (Number.isInteger(data.archivedCount) ? data.archivedCount : 0),
  });
  lastSessionsListRefreshAt = Date.now();
  if (typeof renderSettingsSessionPresentationPanel === "function") {
    renderSettingsSessionPresentationPanel();
  }
  return sessions;
}

async function restoreOwnerBootstrapSessions() {
  if (visitorMode) return null;
  const data = await fetchJsonOrRedirect('/api/bootstrap/owner-sessions/restore', {
    method: 'POST',
  });
  await fetchSessionsList({ forceFresh: true });
  const welcomeSessionId = typeof data?.welcomeSessionId === 'string'
    ? data.welcomeSessionId.trim()
    : '';
  if (welcomeSessionId) {
    const welcomeSession = findClientSessionRecord(welcomeSessionId);
    if (welcomeSession) {
      applyNavigationState({ sessionId: welcomeSessionId, tab: getActiveSidebarTabValue() });
      attachSession(welcomeSessionId, welcomeSession);
      return data;
    }
  }
  restoreOwnerSessionSelection();
  return data;
}

async function organizeSessionListWithAgent({ closeSidebar = false } = {}) {
  const allowOrganize = typeof canOrganizeSessionList === "function"
    ? canOrganizeSessionList()
    : !visitorMode;
  if (visitorMode || !allowOrganize) return false;
  if (sessionListOrganizerInFlight) return sessionListOrganizerInFlight;

  const payload = buildSessionListOrganizerPayload();
  if (!Array.isArray(payload.sessions) || payload.sessions.length === 0) {
    setSortSessionListButtonState("Nothing to sort", { busy: false });
    scheduleSortSessionListButtonReset();
    return false;
  }

  const sortScopeLabel = payload?.scope?.sourceLabel || "sessions";
  if (sessionListOrganizerLabelResetTimer) {
    window.clearTimeout(sessionListOrganizerLabelResetTimer);
    sessionListOrganizerLabelResetTimer = null;
  }
  setSortSessionListButtonState(`Sorting ${sortScopeLabel}…`, { busy: true });

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
      setSortSessionListButtonState(`Sorted ${sortScopeLabel}`, { busy: false });
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
  if (typeof renderHeaderSessionTitle === "function") {
    renderHeaderSessionTitle(displayName);
  } else {
    headerTitle.textContent = displayName;
  }
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

  const effectiveSessionTool = session?.tool === "micro-agent" ? "codex" : session?.tool;
  if (effectiveSessionTool) {
    const availableTools = typeof allToolsList !== "undefined" && Array.isArray(allToolsList)
      ? allToolsList
      : (Array.isArray(toolsList) ? toolsList : []);
    const toolAvailable = availableTools.some((tool) => tool.id === effectiveSessionTool);
    if (toolAvailable || availableTools.length === 0) {
      if (toolAvailable && typeof refreshPrimaryToolPicker === "function") {
        refreshPrimaryToolPicker({ keepToolIds: [effectiveSessionTool], selectedValue: effectiveSessionTool });
      }
      inlineToolSelect.value = effectiveSessionTool;
      selectedTool = effectiveSessionTool;
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
  const archiveMutationEpoch = typeof getSessionArchiveMutationEpoch === "function"
    ? getSessionArchiveMutationEpoch()
    : 0;
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    buildSessionRefreshRequestOptions(forceFresh),
  );
  if (
    typeof isSessionArchiveMutationEpochCurrent === "function"
    && !isSessionArchiveMutationEpochCurrent(archiveMutationEpoch)
  ) {
    return typeof getChatStoreSession === "function"
      ? getChatStoreSession(sessionId)
      : (sessions.find((entry) => entry.id === sessionId) || null);
  }
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
    stageSessionReviewedForAttachedSession(normalized);
    applyAttachedSessionState(sessionId, normalized);
  }
  lastCurrentSessionRefreshAt = Date.now();
  lastCurrentSessionRefreshSessionId = sessionId;
  return normalized;
}

function captureSessionMessageViewport(reason = "session-render") {
  const viewportController = window.RemoteLabTranscriptViewport;
  if (typeof viewportController?.capture === "function") {
    return viewportController.capture({ reason });
  }
  const hadRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  return {
    followBottom:
      !hadRenderedMessages
      || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120,
    scrollTop: messagesEl.scrollTop || 0,
    anchor: null,
  };
}

function restoreSessionMessageViewport(snapshot, reason = "session-render") {
  if (!snapshot) return;
  const viewportController = window.RemoteLabTranscriptViewport;
  if (typeof viewportController?.restore === "function") {
    viewportController.restore(snapshot, { reason });
    return;
  }
  if (snapshot.followBottom) {
    scrollToBottom();
    return;
  }
  messagesEl.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
}

function applySessionViewportAfterRender({
  sessionId,
  viewportIntent,
  snapshot,
  reason,
} = {}) {
  if (shouldOpenCurrentSessionFromTop({ sessionId, viewportIntent })) {
    scrollCurrentSessionViewportToTop();
    return;
  }
  if (normalizeSessionViewportIntent(viewportIntent) === "session_entry") {
    const latestUserTurnStart = typeof findLatestUserTurnStart === "function"
      ? findLatestUserTurnStart()
      : null;
    if (latestUserTurnStart) {
      if (shouldFocusLatestTurnStartOnSessionEntry(sessionId, latestUserTurnStart)) {
        scrollNodeToTop(latestUserTurnStart, { margin: 10 });
      }
      return;
    }
    scrollCurrentSessionViewportToTop();
    return;
  }
  restoreSessionMessageViewport(snapshot, reason);
}

async function fetchSessionEvents(
  sessionId,
  { runState = "idle", viewportIntent = "preserve", forceFresh = false } = {},
) {
  const normalizedViewportIntent = normalizeSessionViewportIntent(viewportIntent);
  const data = isShareSnapshotReadOnlyMode()
    ? { events: getShareSnapshotDisplayEvents() }
    : await fetchJsonOrRedirect(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=visible`,
      buildSessionRefreshRequestOptions(forceFresh),
    );
  const events = data.events || [];
  if (currentSessionId !== sessionId) return events;
  const renderPlan = getEventRenderPlan(sessionId, events);
  const viewportSnapshot = captureSessionMessageViewport(
    `session-render:${renderPlan.mode}`,
  );

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
      && renderedEventState.runState === "running"
        ? renderedEventState.runningBlockExpanded === true
        : null;
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
    applySessionViewportAfterRender({
      sessionId,
      viewportIntent: normalizedViewportIntent,
      snapshot: viewportSnapshot,
      reason: "session-render:reset",
    });
    return events;
  }

  if (renderPlan.mode === "append") {
    for (const event of renderPlan.events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events, { runState });
    applySessionViewportAfterRender({
      sessionId,
      viewportIntent: normalizedViewportIntent,
      snapshot: viewportSnapshot,
      reason: "session-render:append",
    });
    return renderPlan.events;
  }

  updateRenderedEventState(sessionId, events, { runState });
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

async function refreshSidebarSession(sessionId, { forceFresh = false } = {}) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession({ forceFresh });
  }
  if (sidebarSessionRefreshPromises.has(sessionId)) {
    pendingSidebarSessionRefreshes.add(sessionId);
    return sidebarSessionRefreshPromises.get(sessionId);
  }
  const request = (async () => {
    try {
      const session = await fetchSessionSidebar(sessionId, { forceFresh });
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
        refreshSidebarSession(sessionId, { forceFresh }).catch(() => {});
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

let pushNotificationSetupState = { status: "idle", error: "" };
let pushNotificationSetupPromise = null;

function getPushNotificationSetupState() {
  return { ...pushNotificationSetupState };
}

function updatePushNotificationSetupState(status, error = "") {
  pushNotificationSetupState = { status, error };
  window.dispatchEvent(new CustomEvent("remotelab:pushstatechange"));
  return getPushNotificationSetupState();
}

async function setupPushNotifications() {
  const ownerPushFeaturesEnabled = typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
  if (!ownerPushFeaturesEnabled) return updatePushNotificationSetupState("disabled");
  if (!("PushManager" in window) || !navigator.serviceWorker || !("Notification" in window)) {
    return updatePushNotificationSetupState("unsupported");
  }
  // Permission requests belong to the explicit user gesture, never background setup.
  if (Notification.permission !== "granted") return updatePushNotificationSetupState("idle");
  if (pushNotificationSetupPromise) return pushNotificationSetupPromise;
  pushNotificationSetupPromise = (async () => {
    updatePushNotificationSetupState("registering");
    try {
      const persistSubscription = async (subscription) => {
        const payload = subscription?.toJSON ? subscription.toJSON() : subscription;
        if (!payload?.endpoint) throw new Error("Browser returned an invalid push subscription");
        const subscribeUrl = typeof window.remotelabResolveProductPath === "function"
          ? window.remotelabResolveProductPath("/api/push/subscribe")
          : "/api/push/subscribe";
        const response = await fetch(subscribeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok || response.redirected) {
          throw new Error(`Saving push subscription failed (HTTP ${response.status})`);
        }
        const result = await response.json();
        if (result?.ok !== true) throw new Error("Server did not confirm push subscription");
      };
      const reg = await ensureServiceWorkerRegistration();
      if (!reg?.pushManager) throw new Error("Push service worker is unavailable");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const vapidPublicKeyUrl = typeof window.remotelabResolveProductPath === "function"
          ? window.remotelabResolveProductPath("/api/push/vapid-public-key")
          : "/api/push/vapid-public-key";
        const res = await fetch(vapidPublicKeyUrl);
        if (!res.ok || res.redirected) throw new Error(`Loading push key failed (HTTP ${res.status})`);
        const { publicKey } = await res.json();
        if (typeof publicKey !== "string" || !publicKey) throw new Error("Server returned an invalid push key");
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      await persistSubscription(sub);
      console.log("[push] Subscribed to web push");
      return updatePushNotificationSetupState("subscribed");
    } catch (err) {
      console.warn("[push] Setup failed:", err.message);
      return updatePushNotificationSetupState("failed", err.message);
    }
  })().finally(() => {
    pushNotificationSetupPromise = null;
  });
  return pushNotificationSetupPromise;
}

async function ensureServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const serviceWorkerUrl = typeof window.remotelabResolveProductPath === "function"
      ? window.remotelabResolveProductPath(`/sw.js?v=${encodeURIComponent(buildAssetVersion)}`)
      : `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`;
    const reg = await navigator.serviceWorker.register(
      serviceWorkerUrl,
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

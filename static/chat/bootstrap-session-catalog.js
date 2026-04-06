function createEmptySessionStatus() {
  return sessionStateModel.createEmptyStatus();
}

function getSessionActivity(session) {
  return sessionStateModel.normalizeSessionActivity(session);
}

function isSessionBusy(session) {
  return sessionStateModel.isSessionBusy(session);
}

function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
  return sessionStateModel.getSessionStatusSummary(session, { includeToolFallback });
}

function getSessionVisualStatus(session, options = {}) {
  return getSessionStatusSummary(session, options).primary;
}

function refreshSessionAttentionUi(sessionId = currentSessionId) {
  if (typeof renderSessionList === "function") {
    renderSessionList();
  }
  if (
    sessionId
    && sessionId === currentSessionId
    && typeof updateStatus === "function"
    && typeof getCurrentSession === "function"
  ) {
    const session = getCurrentSession();
    updateStatus("connected", session);
  }
}

// Thinking block state
let currentThinkingBlock = null; // { el, body, tools: Set }
let inThinkingBlock = false;

let activeSourceFilter = normalizeSourceFilter(
  (typeof getActiveSourceFilterValue === "function" ? getActiveSourceFilterValue() : "")
  || localStorage.getItem(ACTIVE_SOURCE_FILTER_STORAGE_KEY)
  || localStorage.getItem(LEGACY_ACTIVE_SOURCE_FILTER_STORAGE_KEY)
  || FILTER_ALL_VALUE,
);

if (typeof setChatActiveSourceFilter === "function") {
  setChatActiveSourceFilter(activeSourceFilter, {
    normalizeSourceFilter,
  });
  activeSourceFilter = typeof getActiveSourceFilterValue === "function"
    ? normalizeSourceFilter(getActiveSourceFilterValue())
    : activeSourceFilter;
} else if (typeof dispatchChatStore === "function") {
  dispatchChatStore({
    type: "set-active-source-filter",
    value: activeSourceFilter,
    normalizeSourceFilter,
  });
}

function registerHiddenMarkdownExtensions() {
  const hiddenTagStart = /<(private|hide)\b/i;
  const hiddenBlockPattern = /^(?: {0,3})<(private|hide)\b[^>]*>[\s\S]*?<\/\1>(?:\n+|$)/i;
  const hiddenInlinePattern = /^<(private|hide)\b[^>]*>[\s\S]*?<\/\1>/i;
  marked.use({
    extensions: [
      {
        name: "hiddenUiBlock",
        level: "block",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenBlockPattern);
          if (!match) return undefined;
          return { type: "hiddenUiBlock", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
      {
        name: "hiddenUiInline",
        level: "inline",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenInlinePattern);
          if (!match) return undefined;
          return { type: "hiddenUiInline", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
    ],
  });
}

const POST_INSTALL_NOTIFICATION_STORAGE_KEY = "remotelab.mobileInstall.requestNotifications";

function isStandaloneContext() {
  return !!(
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
    || navigator.standalone === true
  );
}

function shouldPromptForInstalledNotifications() {
  if (!isStandaloneContext()) return false;
  try {
    return localStorage.getItem(POST_INSTALL_NOTIFICATION_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function clearInstalledNotificationPromptFlag() {
  try {
    localStorage.removeItem(POST_INSTALL_NOTIFICATION_STORAGE_KEY);
  } catch {}
}

function isOwnerPushFeatureEnabled() {
  return typeof shouldEnableOwnerPushFeatures === "function"
    ? shouldEnableOwnerPushFeatures()
    : !visitorMode;
}

function shouldPersistNavigationState() {
  return typeof shouldPersistOwnerNavigationState === "function"
    ? shouldPersistOwnerNavigationState()
    : !visitorMode;
}

function isAgentScopedUiMode() {
  return typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
}

function initializePushNotifications(options = {}) {
  if (!isOwnerPushFeatureEnabled() || !("Notification" in window)) return;
  const shouldPrompt = options.prompt === true;
  if (Notification.permission === "default") {
    if (!shouldPrompt) return;
    Notification.requestPermission().then((perm) => {
      clearInstalledNotificationPromptFlag();
      if (perm === "granted" && isOwnerPushFeatureEnabled()) setupPushNotifications();
    });
  } else if (Notification.permission === "granted") {
    if (shouldPrompt) clearInstalledNotificationPromptFlag();
    setupPushNotifications();
  } else if (shouldPrompt) {
    clearInstalledNotificationPromptFlag();
  }
}

registerHiddenMarkdownExtensions();

function persistActiveSessionId(sessionId) {
  if (!shouldPersistNavigationState()) return;
  if (sessionId) {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }
}

function persistActiveSidebarTab(tab) {
  if (!shouldPersistNavigationState()) return;
  localStorage.setItem(
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY,
    normalizeSidebarTab(tab),
  );
}

function buildNavigationUrl(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined
      ? (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab)
      : state.tab,
  );
  const url = new URL(window.location.href);
  url.searchParams.delete("visitor");
  url.searchParams.delete("source");
  if (nextSessionId) url.searchParams.set("session", nextSessionId);
  else url.searchParams.delete("session");
  if (nextTab === "settings") {
    url.searchParams.set("tab", nextTab);
  } else {
    url.searchParams.delete("tab");
  }
  return `${url.pathname}${url.search}`;
}

function syncBrowserState(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined
      ? (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab)
      : state.tab,
  );
  if (shouldPersistNavigationState()) {
    persistActiveSessionId(nextSessionId);
    persistActiveSidebarTab(nextTab);
  }
  const nextUrl = buildNavigationUrl({
    sessionId: nextSessionId,
    tab: nextTab,
  });
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    history.replaceState(null, "", nextUrl);
  }
}

function normalizeSourceId(sourceId, { fallbackDefault = false } = {}) {
  const trimmed = typeof sourceId === "string" ? sourceId.trim() : "";
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : "";
  }
  const normalizedDefault = trimmed.toLowerCase();
  if (normalizedDefault === DEFAULT_APP_ID) return DEFAULT_APP_ID;
  return trimmed;
}

function normalizeSourceFilter(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return [
    SOURCE_FILTER_CHAT_VALUE,
    SOURCE_FILTER_BOT_VALUE,
    SOURCE_FILTER_AUTOMATION_VALUE,
  ].includes(normalized)
    ? normalized
    : FILTER_ALL_VALUE;
}

function persistActiveSourceFilter(value) {
  if (!shouldPersistNavigationState()) return;
  localStorage.setItem(ACTIVE_SOURCE_FILTER_STORAGE_KEY, normalizeSourceFilter(value));
}

function formatSourceNameFromId(sourceId) {
  const normalized = normalizeSourceId(sourceId);
  if (!normalized) return DEFAULT_APP_NAME;
  if (normalized === DEFAULT_APP_ID) return DEFAULT_APP_NAME;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getEffectiveSessionSourceId(session) {
  return normalizeSourceId(session?.sourceId, { fallbackDefault: true });
}

function getEffectiveSessionSourceName(session) {
  const explicitSourceName = typeof session?.sourceName === "string"
    ? session.sourceName.trim()
    : "";
  if (explicitSourceName) return explicitSourceName;

  return formatSourceNameFromId(getEffectiveSessionSourceId(session));
}

function getSessionSourceCategory(session) {
  const sourceId = getEffectiveSessionSourceId(session);
  if (sourceId === DEFAULT_APP_ID) return SOURCE_FILTER_CHAT_VALUE;
  if (sourceId === "automation" || sourceId.startsWith("automation")) {
    return SOURCE_FILTER_AUTOMATION_VALUE;
  }
  return SOURCE_FILTER_BOT_VALUE;
}

function refreshAppCatalog() {
  renderSourceFilterOptions();
}

function getFilteredActiveSessions({ ignoreSource = false } = {}) {
  return getActiveSessions().filter((session) => (
    ignoreSource || matchesSourceFilter(session, activeSourceFilter)
  ));
}

function matchesSourceFilter(session, sourceFilter = activeSourceFilter) {
  if (sourceFilter === FILTER_ALL_VALUE) return true;
  return getSessionSourceCategory(session) === sourceFilter;
}

function matchesSearchQuery(session) {
  if (!sessionSearchQuery) return true;
  const query = sessionSearchQuery.toLowerCase();
  const name = (session?.name || "").toLowerCase();
  const group = (session?.group || "").toLowerCase();
  const description = (session?.description || "").toLowerCase();
  return name.includes(query) || group.includes(query) || description.includes(query);
}

function matchesCurrentFilters(session) {
  return matchesSourceFilter(session, activeSourceFilter) && matchesSearchQuery(session);
}

function getVisibleActiveSessions() {
  return getActiveSessions().filter((session) => !session.pinned && matchesCurrentFilters(session));
}

function getVisiblePinnedSessions() {
  return getActiveSessions().filter((session) => session.pinned === true && matchesCurrentFilters(session));
}

function getVisibleArchivedSessions() {
  return getArchivedSessions().filter((session) => matchesCurrentFilters(session));
}

function getSessionCountForSourceFilter(sourceFilter) {
  const activeSessions = getFilteredActiveSessions({ ignoreSource: true });
  if (sourceFilter === FILTER_ALL_VALUE) return activeSessions.length;
  return activeSessions.filter((session) => getSessionSourceCategory(session) === sourceFilter).length;
}

function isSidebarFilterControlVisible(control) {
  if (!control) return false;
  if (control.hidden === true) return false;
  return control.style?.display !== "none";
}

function getVisibleSourceFilterOptions() {
  return [
    [SOURCE_FILTER_CHAT_VALUE, t("sidebar.filter.source.chat")],
    [SOURCE_FILTER_BOT_VALUE, t("sidebar.filter.source.bots")],
    [SOURCE_FILTER_AUTOMATION_VALUE, t("sidebar.filter.source.automation")],
  ].filter(([value]) => getSessionCountForSourceFilter(value) > 0);
}

function syncSidebarFiltersVisibility(showingSessions = null) {
  if (!sidebarFilters) return;
  const resolvedShowingSessions = typeof showingSessions === "boolean"
    ? showingSessions
    : ((typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : activeTab) === "sessions");
  const agentScopedMode = typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
  const controls = [sourceFilterSelect].filter(Boolean);
  const hasVisibleControls = controls.length === 0
    ? true
    : controls.some((control) => isSidebarFilterControlVisible(control));
  const visible = resolvedShowingSessions && !visitorMode && !agentScopedMode && hasVisibleControls;
  sidebarFilters.classList.toggle("hidden", !visible);
}

function renderSourceFilterOptions() {
  const agentScopedMode = typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
  if (!sourceFilterSelect || visitorMode || agentScopedMode) {
    if (sourceFilterSelect) sourceFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  const options = getVisibleSourceFilterOptions();
  if (
    activeSourceFilter !== FILTER_ALL_VALUE
    && options.length > 0
    && !options.some(([value]) => value === activeSourceFilter)
  ) {
    activeSourceFilter = FILTER_ALL_VALUE;
    if (typeof setChatActiveSourceFilter === "function") {
      setChatActiveSourceFilter(activeSourceFilter, {
        normalizeSourceFilter,
      });
    } else if (typeof dispatchChatStore === "function") {
      dispatchChatStore({
        type: "set-active-source-filter",
        value: activeSourceFilter,
        normalizeSourceFilter,
      });
    }
    persistActiveSourceFilter(activeSourceFilter);
  }

  if (options.length <= 1) {
    sourceFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  sourceFilterSelect.style.display = "";
  sourceFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = FILTER_ALL_VALUE;
  allOption.textContent = t("sidebar.filter.allOrigins", {
    count: getSessionCountForSourceFilter(FILTER_ALL_VALUE),
  });
  sourceFilterSelect.appendChild(allOption);

  for (const [value, name] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${name} (${getSessionCountForSourceFilter(value)})`;
    sourceFilterSelect.appendChild(option);
  }
  sourceFilterSelect.value = normalizeSourceFilter(activeSourceFilter);
  syncSidebarFiltersVisibility();
}

if (sourceFilterSelect) {
  sourceFilterSelect.addEventListener("change", () => {
    activeSourceFilter = normalizeSourceFilter(sourceFilterSelect.value);
    if (typeof setChatActiveSourceFilter === "function") {
      setChatActiveSourceFilter(activeSourceFilter, {
        normalizeSourceFilter,
      });
      activeSourceFilter = typeof getActiveSourceFilterValue === "function"
        ? normalizeSourceFilter(getActiveSourceFilterValue())
        : activeSourceFilter;
    } else if (typeof dispatchChatStore === "function") {
      dispatchChatStore({
        type: "set-active-source-filter",
        value: activeSourceFilter,
        normalizeSourceFilter,
      });
    }
    persistActiveSourceFilter(activeSourceFilter);
    renderSourceFilterOptions();
    renderSessionList();
  });
}

refreshAppCatalog();

function getSessionSortTime(session) {
  if (typeof sessionStateModel.getSessionSortTime === "function") {
    return sessionStateModel.getSessionSortTime(session);
  }
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionPinSortRank(session) {
  return session?.pinned === true ? 1 : 0;
}

function compareSessionListSessions(a, b) {
  const displayA = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(a) || a)
    : a;
  const displayB = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(b) || b)
    : b;
  if (typeof sessionStateModel.compareSessionListSessions === "function") {
    return sessionStateModel.compareSessionListSessions(displayA, displayB);
  }
  return getSessionSortTime(displayB) - getSessionSortTime(displayA);
}

function compareClientSessions(a, b) {
  const displayA = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(a) || a)
    : a;
  const displayB = typeof getSessionSidebarListSnapshot === "function"
    ? (getSessionSidebarListSnapshot(b) || b)
    : b;
  return getSessionPinSortRank(displayB) - getSessionPinSortRank(displayA)
    || compareSessionListSessions(displayA, displayB);
}

function sortSessionsInPlace() {
  const compare = typeof compareClientSessions === "function"
    ? compareClientSessions
    : ((a, b) => getSessionPinSortRank(b) - getSessionPinSortRank(a)
      || compareSessionListSessions(a, b));
  sessions.sort(compare);
}

function getArchivedSessionSortTime(session) {
  const stamp = session?.archivedAt || session?.lastEventAt || session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getActiveSessions() {
  return sessions
    .map((session) => (
      typeof getSessionSidebarListSnapshot === "function"
        ? (getSessionSidebarListSnapshot(session) || session)
        : session
    ))
    .filter((session) => session && !session.archived);
}

function getArchivedSessions() {
  return sessions
    .map((session) => (
      typeof getSessionSidebarListSnapshot === "function"
        ? (getSessionSidebarListSnapshot(session) || session)
        : session
    ))
    .filter((session) => session && session.archived)
    .slice()
    .sort((a, b) => getArchivedSessionSortTime(b) - getArchivedSessionSortTime(a));
}

function getLatestSession() {
  return sessions[0] || null;
}

function getLatestActiveSession() {
  return sessions.find((session) => !session.archived) || null;
}

function getLatestSessionForCurrentFilters() {
  return sessions.find((session) => matchesCurrentFilters(session)) || null;
}

function getLatestActiveSessionForCurrentFilters() {
  return sessions.find(
    (session) => !session.archived && matchesCurrentFilters(session),
  ) || null;
}

function resolveRestoreTargetSession() {
  if (pendingNavigationState?.sessionId) {
    const requested = sessions.find(
      (session) => session.id === pendingNavigationState.sessionId,
    );
    if (requested) return requested;
  }
  if (currentSessionId) {
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current && matchesCurrentFilters(current)) return current;
  }
  return getLatestActiveSessionForCurrentFilters()
    || getLatestSessionForCurrentFilters()
    || getLatestActiveSession()
    || getLatestSession();
}

function applyNavigationState(rawState) {
  const next = normalizeNavigationState(rawState);
  if (next.tab) {
    switchTab(next.tab, { syncState: false });
  }
  pendingNavigationState = next.sessionId ? next : null;
  if (next.sessionId) {
    const target = sessions.find((session) => session.id === next.sessionId);
    if (target) {
      attachSession(target.id, target);
      pendingNavigationState = null;
    } else {
      dispatchAction({ action: "list" });
    }
    syncBrowserState({
      sessionId: next.sessionId,
      tab: next.tab || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab),
    });
    return;
  }
  syncBrowserState({
    tab: next.tab || (typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : activeTab),
  });
}
function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

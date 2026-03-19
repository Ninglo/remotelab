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

function getSessionBoardColumns(sessionList = getActiveSessions()) {
  return typeof sessionStateModel.getBoardColumns === "function"
    ? sessionStateModel.getBoardColumns(null, sessionList)
    : [];
}

function getSessionBoardColumn(session, sessionList = getActiveSessions()) {
  return typeof sessionStateModel.getSessionBoardColumn === "function"
    ? sessionStateModel.getSessionBoardColumn(session, null, sessionList)
    : {
      key: "open",
      label: "Open",
      title: "Sessions that are ready for more work.",
      emptyText: "No open sessions",
    };
}

function getSessionBoardPriority(session) {
  return typeof sessionStateModel.getSessionBoardPriority === "function"
    ? sessionStateModel.getSessionBoardPriority(session)
    : {
      key: "medium",
      label: "Medium",
      rank: 2,
      className: "board-priority-medium",
      title: "Worth checking soon, but not urgent.",
    };
}

function compareBoardSessions(a, b) {
  return typeof sessionStateModel.compareBoardSessions === "function"
    ? sessionStateModel.compareBoardSessions(a, b)
    : 0;
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
  localStorage.getItem(ACTIVE_SOURCE_FILTER_STORAGE_KEY)
  || localStorage.getItem(LEGACY_ACTIVE_SOURCE_FILTER_STORAGE_KEY)
  || FILTER_ALL_VALUE,
);
let activeSessionAppFilter = normalizeSessionAppFilter(
  localStorage.getItem(ACTIVE_SESSION_APP_FILTER_STORAGE_KEY) || FILTER_ALL_VALUE,
);
let activeUserFilter = normalizeUserFilter(
  localStorage.getItem(ACTIVE_USER_FILTER_STORAGE_KEY) || ADMIN_USER_FILTER_VALUE,
);

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

function initializePushNotifications() {
  if (visitorMode || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted" && !visitorMode) setupPushNotifications();
    });
  } else if (Notification.permission === "granted") {
    setupPushNotifications();
  }
}

registerHiddenMarkdownExtensions();

function normalizeSidebarTab(tab) {
  if (tab === "board" || tab === "progress") return "board";
  if (tab === "settings") return "settings";
  return "sessions";
}

function normalizeNavigationState(raw) {
  let sessionId = null;
  let tab = null;

  if (raw && typeof raw === "object") {
    if (typeof raw.sessionId === "string") sessionId = raw.sessionId;
    if (typeof raw.tab === "string") tab = raw.tab;
    if (raw.url) {
      try {
        const url = new URL(raw.url, window.location.origin);
        if (!sessionId) sessionId = url.searchParams.get("session") || null;
        if (!tab) tab = url.searchParams.get("tab") || null;
      } catch {}
    }
  }

  return {
    sessionId:
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null,
    tab: tab ? normalizeSidebarTab(tab) : null,
  };
}

function readNavigationStateFromLocation() {
  return normalizeNavigationState({
    sessionId: new URLSearchParams(window.location.search).get("session"),
    tab: new URLSearchParams(window.location.search).get("tab"),
  });
}

function persistActiveSessionId(sessionId) {
  if (visitorMode) return;
  if (sessionId) {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }
}

function persistActiveSidebarTab(tab) {
  if (visitorMode) return;
  localStorage.setItem(
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY,
    normalizeSidebarTab(tab),
  );
}

function buildNavigationUrl(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined ? activeTab : state.tab,
  );
  const url = new URL(window.location.href);
  url.searchParams.delete("visitor");
  url.searchParams.delete("source");
  if (nextSessionId) url.searchParams.set("session", nextSessionId);
  else url.searchParams.delete("session");
  if (nextTab === "settings" || nextTab === "board") {
    url.searchParams.set("tab", nextTab);
  } else {
    url.searchParams.delete("tab");
  }
  return `${url.pathname}${url.search}`;
}

function syncBrowserState(state = {}) {
  if (visitorMode) return;
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined ? activeTab : state.tab,
  );
  persistActiveSessionId(nextSessionId);
  persistActiveSidebarTab(nextTab);
  const nextUrl = buildNavigationUrl({
    sessionId: nextSessionId,
    tab: nextTab,
  });
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    history.replaceState(null, "", nextUrl);
  }
}

function normalizeAppId(appId, { fallbackDefault = false } = {}) {
  const trimmed = typeof appId === "string" ? appId.trim() : "";
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

function isTemplateAppScopeId(appId) {
  const normalized = normalizeAppId(appId);
  return /^app[_-]/i.test(normalized);
}

function normalizeSessionAppFilter(appId) {
  const normalized = normalizeAppId(appId);
  return normalized && isTemplateAppScopeId(normalized)
    ? normalized
    : FILTER_ALL_VALUE;
}

function normalizeUserFilter(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === USER_FILTER_ALL_VALUE) return USER_FILTER_ALL_VALUE;
  return normalized || ADMIN_USER_FILTER_VALUE;
}

function persistActiveSourceFilter(value) {
  if (visitorMode) return;
  localStorage.setItem(ACTIVE_SOURCE_FILTER_STORAGE_KEY, normalizeSourceFilter(value));
}

function persistActiveSessionAppFilter(appId) {
  if (visitorMode) return;
  localStorage.setItem(
    ACTIVE_SESSION_APP_FILTER_STORAGE_KEY,
    normalizeSessionAppFilter(appId),
  );
}

function persistActiveUserFilter(value) {
  if (visitorMode) return;
  localStorage.setItem(ACTIVE_USER_FILTER_STORAGE_KEY, normalizeUserFilter(value));
}

function formatAppNameFromId(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return DEFAULT_APP_NAME;
  if (normalized === DEFAULT_APP_ID) return DEFAULT_APP_NAME;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getEffectiveSessionAppId(session) {
  return normalizeAppId(session?.appId, { fallbackDefault: true });
}

function getEffectiveSessionSourceId(session) {
  const explicitSourceId = normalizeAppId(session?.sourceId);
  if (explicitSourceId) return explicitSourceId;

  const legacyAppId = normalizeAppId(session?.appId, { fallbackDefault: true });
  if (!legacyAppId || isTemplateAppScopeId(legacyAppId)) {
    return DEFAULT_APP_ID;
  }
  return legacyAppId;
}

function getEffectiveSessionSourceName(session) {
  const explicitSourceName = typeof session?.sourceName === "string"
    ? session.sourceName.trim()
    : "";
  if (explicitSourceName) return explicitSourceName;

  const sourceId = getEffectiveSessionSourceId(session);
  if (
    typeof session?.appName === "string"
    && session.appName.trim()
    && !isTemplateAppScopeId(session?.appId)
    && normalizeAppId(session?.appId) === sourceId
  ) {
    return session.appName.trim();
  }

  return formatAppNameFromId(sourceId);
}

function getEffectiveSessionTemplateAppId(session) {
  const explicitTemplateId = normalizeAppId(session?.templateAppId || session?.appId);
  if (isTemplateAppScopeId(explicitTemplateId)) {
    return explicitTemplateId;
  }
  return BASIC_CHAT_APP_ID;
}

function getSessionSourceCategory(session) {
  const sourceId = getEffectiveSessionSourceId(session);
  if (sourceId === DEFAULT_APP_ID) return SOURCE_FILTER_CHAT_VALUE;
  if (sourceId === "automation" || sourceId.startsWith("automation")) {
    return SOURCE_FILTER_AUTOMATION_VALUE;
  }
  return SOURCE_FILTER_BOT_VALUE;
}

function sortTemplateAppCatalogEntries(a, b) {
  const rank = (app) => {
    if (app?.id === BASIC_CHAT_APP_ID) return 0;
    if (app?.id === "app_create_app") return 1;
    return 2;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function createTemplateAppCatalogEntry(app) {
  const id = normalizeAppId(app?.id);
  if (!id || !isTemplateAppScopeId(id)) return null;
  const name =
    typeof app?.appName === "string" && app.appName.trim()
      ? app.appName.trim()
      : typeof app?.name === "string" && app.name.trim()
        ? app.name.trim()
        : formatAppNameFromId(id);
  return {
    ...app,
    id,
    name,
  };
}

function getSessionAppCatalogEntry(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return null;
  return (
    sessionAppCatalog.find((entry) => entry.id === normalized)
    || createTemplateAppCatalogEntry({ id: normalized })
  );
}

function getTemplateApps() {
  return availableApps.filter((app) => (
    isTemplateAppScopeId(app?.id)
    && app?.templateSelectable !== false
  ));
}

function getShareableTemplateApps() {
  return getTemplateApps().filter((app) => app?.shareEnabled !== false);
}

function getCurrentUserRecord() {
  if (activeUserFilter === USER_FILTER_ALL_VALUE || activeUserFilter === ADMIN_USER_FILTER_VALUE) {
    return null;
  }
  return availableUsers.find((user) => user.id === activeUserFilter) || null;
}

function getSessionAppFilterCatalog() {
  const allTemplateApps = getTemplateApps().map((app) => createTemplateAppCatalogEntry(app)).filter(Boolean);
  const user = getCurrentUserRecord();
  const filteredApps = user
    ? allTemplateApps.filter((app) => user.appIds.includes(app.id))
    : allTemplateApps;
  return filteredApps.sort(sortTemplateAppCatalogEntries);
}

function refreshAppCatalog(apps = availableApps) {
  const nextSessionApps = new Map();

  for (const app of apps) {
    const entry = createTemplateAppCatalogEntry(app);
    if (entry) nextSessionApps.set(entry.id, entry);
  }

  for (const session of sessions) {
    const entry = createTemplateAppCatalogEntry({ id: session?.appId, appName: session?.appName });
    if (entry && !nextSessionApps.has(entry.id)) {
      nextSessionApps.set(entry.id, entry);
    }
  }

  sessionAppCatalog = [...nextSessionApps.values()].filter(Boolean).sort(sortTemplateAppCatalogEntries);

  const availableFilterAppIds = new Set(getSessionAppFilterCatalog().map((app) => app.id));
  if (
    hasLoadedSessions
    && activeSessionAppFilter !== FILTER_ALL_VALUE
    && !availableFilterAppIds.has(activeSessionAppFilter)
  ) {
    activeSessionAppFilter = FILTER_ALL_VALUE;
    persistActiveSessionAppFilter(activeSessionAppFilter);
  }

  renderSourceFilterOptions();
  renderSessionAppFilterOptions();
  renderUserFilterOptions();
}

function getFilteredActiveSessions({ ignoreSource = false, ignoreTemplateApp = false, ignoreUser = false } = {}) {
  return getActiveSessions().filter((session) => (
    (ignoreSource || matchesSourceFilter(session, activeSourceFilter))
    && (ignoreTemplateApp || matchesSessionAppFilter(session, activeSessionAppFilter))
    && (ignoreUser || matchesUserFilter(session, activeUserFilter))
  ));
}

function matchesSourceFilter(session, sourceFilter = activeSourceFilter) {
  if (sourceFilter === FILTER_ALL_VALUE) return true;
  return getSessionSourceCategory(session) === sourceFilter;
}

function matchesSessionAppFilter(session, appFilter = activeSessionAppFilter) {
  if (appFilter === FILTER_ALL_VALUE) return true;
  return getEffectiveSessionTemplateAppId(session) === appFilter;
}

function matchesUserFilter(session, scope = activeUserFilter) {
  if (scope === USER_FILTER_ALL_VALUE) return true;
  if (scope === ADMIN_USER_FILTER_VALUE) {
    return !session?.userId && !session?.visitorId;
  }
  return session?.userId === scope;
}

function matchesCurrentFilters(session) {
  return matchesUserFilter(session, activeUserFilter)
    && matchesSourceFilter(session, activeSourceFilter)
    && matchesSessionAppFilter(session, activeSessionAppFilter);
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

function getSessionCountForTemplateApp(appId) {
  const activeSessions = getFilteredActiveSessions({ ignoreTemplateApp: true });
  if (appId === FILTER_ALL_VALUE) return activeSessions.length;
  return activeSessions.filter((session) => getEffectiveSessionTemplateAppId(session) === appId).length;
}

function getSessionCountForUser(scope = activeUserFilter) {
  const activeSessions = getFilteredActiveSessions({ ignoreUser: true });
  if (scope === USER_FILTER_ALL_VALUE) return activeSessions.length;
  if (scope === ADMIN_USER_FILTER_VALUE) {
    return activeSessions.filter((session) => !session?.userId && !session?.visitorId).length;
  }
  return activeSessions.filter((session) => session?.userId === scope).length;
}

function syncSidebarFiltersVisibility(showingSessions = null) {
  if (!sidebarFilters) return;
  const resolvedShowingSessions = typeof showingSessions === "boolean"
    ? showingSessions
    : (typeof activeTab === "string" ? activeTab === "sessions" : true);
  const visible = resolvedShowingSessions && !visitorMode;
  sidebarFilters.classList.toggle("hidden", !visible);
}

function renderSourceFilterOptions() {
  if (!sourceFilterSelect || visitorMode) {
    if (sourceFilterSelect) sourceFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  sourceFilterSelect.style.display = "";
  sourceFilterSelect.innerHTML = "";

  const options = [
    [FILTER_ALL_VALUE, `All Origins (${getSessionCountForSourceFilter(FILTER_ALL_VALUE)})`],
    [SOURCE_FILTER_CHAT_VALUE, `Chat UI (${getSessionCountForSourceFilter(SOURCE_FILTER_CHAT_VALUE)})`],
    [SOURCE_FILTER_BOT_VALUE, `Bots (${getSessionCountForSourceFilter(SOURCE_FILTER_BOT_VALUE)})`],
    [SOURCE_FILTER_AUTOMATION_VALUE, `Automation (${getSessionCountForSourceFilter(SOURCE_FILTER_AUTOMATION_VALUE)})`],
  ];
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sourceFilterSelect.appendChild(option);
  }
  sourceFilterSelect.value = normalizeSourceFilter(activeSourceFilter);
  syncSidebarFiltersVisibility();
}

function renderSessionAppFilterOptions() {
  if (!sessionAppFilterSelect || visitorMode) {
    if (sessionAppFilterSelect) sessionAppFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  sessionAppFilterSelect.style.display = "";

  const catalog = getSessionAppFilterCatalog();
  const previousValue = normalizeSessionAppFilter(sessionAppFilterSelect.value || activeSessionAppFilter);
  const selectedValue = catalog.some((app) => app.id === previousValue)
    ? previousValue
    : catalog.some((app) => app.id === activeSessionAppFilter)
      ? activeSessionAppFilter
      : FILTER_ALL_VALUE;

  sessionAppFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = FILTER_ALL_VALUE;
  allOption.textContent = `All Apps (${getSessionCountForTemplateApp(FILTER_ALL_VALUE)})`;
  sessionAppFilterSelect.appendChild(allOption);

  for (const app of catalog) {
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = `${app.name} (${getSessionCountForTemplateApp(app.id)})`;
    sessionAppFilterSelect.appendChild(option);
  }

  sessionAppFilterSelect.value = normalizeSessionAppFilter(selectedValue);
  syncSidebarFiltersVisibility();
}

function renderUserFilterOptions() {
  if (!userFilterSelect || visitorMode) {
    if (userFilterSelect) userFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  const availableUserIds = new Set(availableUsers.map((user) => user.id));
  if (
    activeUserFilter !== USER_FILTER_ALL_VALUE
    && activeUserFilter !== ADMIN_USER_FILTER_VALUE
    && !availableUserIds.has(activeUserFilter)
  ) {
    activeUserFilter = ADMIN_USER_FILTER_VALUE;
    persistActiveUserFilter(activeUserFilter);
  }

  userFilterSelect.style.display = "";
  userFilterSelect.innerHTML = "";

  const adminOption = document.createElement("option");
  adminOption.value = ADMIN_USER_FILTER_VALUE;
  adminOption.textContent = `Admin (${getSessionCountForUser(ADMIN_USER_FILTER_VALUE)})`;
  userFilterSelect.appendChild(adminOption);

  const customUsers = availableUsers.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  for (const user of customUsers) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.name || "User"} (${getSessionCountForUser(user.id)})`;
    userFilterSelect.appendChild(option);
  }

  const allOption = document.createElement("option");
  allOption.value = USER_FILTER_ALL_VALUE;
  allOption.textContent = `All Users (${getSessionCountForUser(USER_FILTER_ALL_VALUE)})`;
  userFilterSelect.appendChild(allOption);

  userFilterSelect.value = normalizeUserFilter(activeUserFilter);
  syncSidebarFiltersVisibility();
}

if (sourceFilterSelect) {
  sourceFilterSelect.addEventListener("change", () => {
    activeSourceFilter = normalizeSourceFilter(sourceFilterSelect.value);
    persistActiveSourceFilter(activeSourceFilter);
    renderSourceFilterOptions();
    renderUserFilterOptions();
    renderSessionAppFilterOptions();
    renderSessionList();
  });
}

if (sessionAppFilterSelect) {
  sessionAppFilterSelect.addEventListener("change", () => {
    activeSessionAppFilter = normalizeSessionAppFilter(sessionAppFilterSelect.value);
    persistActiveSessionAppFilter(activeSessionAppFilter);
    renderSourceFilterOptions();
    renderSessionAppFilterOptions();
    renderUserFilterOptions();
    renderSessionList();
  });
}

if (userFilterSelect) {
  userFilterSelect.addEventListener("change", () => {
    activeUserFilter = normalizeUserFilter(userFilterSelect.value);
    persistActiveUserFilter(activeUserFilter);
    renderSourceFilterOptions();
    renderSessionAppFilterOptions();
    renderUserFilterOptions();
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
  if (typeof sessionStateModel.compareSessionListSessions === "function") {
    return sessionStateModel.compareSessionListSessions(a, b);
  }
  return getSessionSortTime(b) - getSessionSortTime(a);
}

function sortSessionsInPlace() {
  sessions.sort((a, b) => (
    getSessionPinSortRank(b) - getSessionPinSortRank(a)
    || compareSessionListSessions(a, b)
  ));
}

function getArchivedSessionSortTime(session) {
  const stamp = session?.archivedAt || session?.lastEventAt || session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getActiveSessions() {
  return sessions.filter((session) => !session.archived);
}

function getArchivedSessions() {
  return sessions
    .filter((session) => session.archived)
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
      tab: next.tab || activeTab,
    });
    return;
  }
  syncBrowserState({ tab: next.tab || activeTab });
}

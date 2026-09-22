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

// The Store owns the origin selection; localStorage only restores it on startup.
function getCurrentSourceFilter() {
  return normalizeSourceFilter(getActiveSourceFilterValue());
}

setChatActiveSourceFilter(getCurrentSourceFilter(), { normalizeSourceFilter });

const PERSON_FILTER_UNASSIGNED_VALUE = "__unassigned__";

function getCurrentPersonFilter() {
  const value = getActivePersonFilterValue();
  if (value === FILTER_ALL_VALUE || value === PERSON_FILTER_UNASSIGNED_VALUE) return value;
  return getPeopleDirectory().some((person) => person.id === value) ? value : FILTER_ALL_VALUE;
}

setChatActivePersonFilter(getCurrentPersonFilter());

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

function isPushFeatureEnabled() {
  return typeof shouldEnablePushFeatures === "function"
    ? shouldEnablePushFeatures()
    : true;
}

function isNavigationPersistenceEnabled() {
  return typeof shouldPersistNavigationState === "function"
    ? shouldPersistNavigationState()
    : true;
}

function initializePushNotifications(options = {}) {
  if (!isPushFeatureEnabled() || !("Notification" in window)) return;
  const shouldPrompt = options.prompt === true;
  if (Notification.permission === "default") {
    if (!shouldPrompt) return;
    Notification.requestPermission().then((perm) => {
      clearInstalledNotificationPromptFlag();
      if (perm === "granted" && isPushFeatureEnabled()) setupPushNotifications();
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
  if (!isNavigationPersistenceEnabled()) return;
  if (sessionId) {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }
}

function persistActiveSidebarTab(tab) {
  if (!isNavigationPersistenceEnabled()) return;
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
  url.searchParams.delete("source");
  if (nextSessionId) url.searchParams.set("session", nextSessionId);
  else url.searchParams.delete("session");
  if (nextTab !== "sessions") {
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
  if (isNavigationPersistenceEnabled()) {
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
  return getSourceFilterValues().includes(normalized)
    ? normalized
    : FILTER_ALL_VALUE;
}

function getSourceFilterDefinitions() {
  return typeof SOURCE_FILTER_DEFINITIONS !== "undefined" && Array.isArray(SOURCE_FILTER_DEFINITIONS)
    ? SOURCE_FILTER_DEFINITIONS
    : [
      [SOURCE_FILTER_CHAT_VALUE, "sidebar.filter.source.chat"],
      [SOURCE_FILTER_BOT_VALUE, "sidebar.filter.source.bots"],
      [SOURCE_FILTER_AUTOMATION_VALUE, "sidebar.filter.source.automation"],
    ];
}

function getSourceFilterValues() {
  return getSourceFilterDefinitions().map(([value]) => value);
}

function persistActiveSourceFilter(value) {
  if (!isNavigationPersistenceEnabled()) return;
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

function sourceIdMatchesFilterRule(sourceId, rule) {
  const normalizedSourceId = normalizeSourceId(sourceId).toLowerCase();
  if (!normalizedSourceId || !rule || typeof rule !== "object") return false;
  const exactValues = Array.isArray(rule.exact) ? rule.exact : [];
  if (exactValues.some((value) => normalizedSourceId === String(value || "").toLowerCase())) {
    return true;
  }
  const prefixes = Array.isArray(rule.prefixes) ? rule.prefixes : [];
  return prefixes.some((prefix) => {
    const normalizedPrefix = String(prefix || "").toLowerCase();
    return normalizedPrefix && normalizedSourceId.startsWith(normalizedPrefix);
  });
}

function getSessionSourceCategory(session) {
  const sourceId = getEffectiveSessionSourceId(session);
  if (sourceId === DEFAULT_APP_ID) return SOURCE_FILTER_CHAT_VALUE;
  const rules = typeof SOURCE_FILTER_SOURCE_ID_RULES !== "undefined" && Array.isArray(SOURCE_FILTER_SOURCE_ID_RULES)
    ? SOURCE_FILTER_SOURCE_ID_RULES
    : [];
  for (const rule of rules) {
    if (sourceIdMatchesFilterRule(sourceId, rule)) {
      return rule.category || SOURCE_FILTER_BOT_VALUE;
    }
  }
  return SOURCE_FILTER_BOT_VALUE;
}

function refreshSessionCatalog() {
  renderSourceFilterOptions();
  renderPersonFilterOptions();
}

function getFilteredActiveSessions({ ignoreSource = false, ignorePerson = false } = {}) {
  return getActiveSessions().filter((session) => (
    (ignoreSource || matchesSourceFilter(session))
    && (ignorePerson || matchesPersonFilter(session))
  ));
}

function matchesSourceFilter(session, sourceFilter = getCurrentSourceFilter()) {
  if (sourceFilter === FILTER_ALL_VALUE) return true;
  return getSessionSourceCategory(session) === sourceFilter;
}

function getSessionPersonId(session) {
  const identityId = typeof session?.initiatedByIdentityId === "string"
    ? session.initiatedByIdentityId.trim()
    : "";
  if (!identityId) return PERSON_FILTER_UNASSIGNED_VALUE;
  const person = getPeopleDirectory().find((entry) => entry.identities.some(
    (identity) => identity.id === identityId,
  ));
  return person?.id || PERSON_FILTER_UNASSIGNED_VALUE;
}

function matchesPersonFilter(session, personFilter = getCurrentPersonFilter()) {
  if (personFilter === FILTER_ALL_VALUE) return true;
  return getSessionPersonId(session) === personFilter;
}

function matchesSearchQuery(session) {
  if (!sessionSearchQuery) return true;
  const query = sessionSearchQuery.toLowerCase();
  const name = (session?.name || "").toLowerCase();
  const space = (session?.space || "").toLowerCase();
  const group = (session?.group || "").toLowerCase();
  const description = (session?.description || "").toLowerCase();
  return name.includes(query) || space.includes(query) || group.includes(query) || description.includes(query);
}

function getSessionSpaceValue(session) {
  const space = typeof session?.space === "string" ? session.space.trim() : "";
  if (space.toLowerCase() === "loose") return SESSION_SPACE_LOOSE_VALUE;
  return space || SESSION_SPACE_LOOSE_VALUE;
}

function matchesSessionSpace(session, spaceFilter = activeSessionSpace) {
  if (!spaceFilter || spaceFilter === SESSION_SPACE_ALL_VALUE) return true;
  return getSessionSpaceValue(session) === spaceFilter;
}

function matchesCurrentFilters(session) {
  return matchesSourceFilter(session)
    && matchesPersonFilter(session)
    && matchesSessionSpace(session, activeSessionSpace)
    && matchesSearchQuery(session);
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

function getSessionCountForPersonFilter(personFilter) {
  const activeSessions = getFilteredActiveSessions({ ignorePerson: true });
  if (personFilter === FILTER_ALL_VALUE) return activeSessions.length;
  return activeSessions.filter((session) => getSessionPersonId(session) === personFilter).length;
}

function isSidebarFilterControlVisible(control) {
  if (!control) return false;
  if (control.hidden === true) return false;
  return control.style?.display !== "none";
}

function getVisibleSourceFilterOptions() {
  return getSourceFilterDefinitions()
    .map(([value, labelKey]) => [value, t(labelKey)])
    .filter(([value]) => getSessionCountForSourceFilter(value) > 0 || value === getCurrentSourceFilter());
}

function syncSidebarFiltersVisibility(showingSessions = null) {
  if (!sidebarFilters) return;
  const resolvedShowingSessions = typeof showingSessions === "boolean"
    ? showingSessions
    : ((typeof getActiveSidebarTabValue === "function"
      ? getActiveSidebarTabValue()
      : activeTab) === "sessions");
  const controls = [personFilterSelect, sourceFilterSelect].filter(Boolean);
  const hasVisibleControls = controls.length === 0
    ? true
    : controls.some((control) => isSidebarFilterControlVisible(control));
  const visible = resolvedShowingSessions && hasVisibleControls;
  sidebarFilters.classList.toggle("hidden", !visible);
}

function renderPersonFilterOptions() {
  if (!personFilterSelect || document.activeElement === personFilterSelect) return;
  const selected = getCurrentPersonFilter();
  const people = getPeopleDirectory();
  const entries = [[
    FILTER_ALL_VALUE,
    `${t("sidebar.filter.allPeople")} (${getSessionCountForPersonFilter(FILTER_ALL_VALUE)})`,
  ]];
  for (const person of people) {
    const count = getSessionCountForPersonFilter(person.id);
    if (count === 0 && person.id !== selected && person.id !== currentPerson?.id) continue;
    const label = person.id === currentPerson?.id
      ? t("sidebar.filter.mine")
      : person.name;
    entries.push([person.id, `${label} (${count})`]);
  }
  const unassignedCount = getSessionCountForPersonFilter(PERSON_FILTER_UNASSIGNED_VALUE);
  if (unassignedCount > 0 || selected === PERSON_FILTER_UNASSIGNED_VALUE) {
    entries.push([
      PERSON_FILTER_UNASSIGNED_VALUE,
      `${t("sidebar.filter.unassigned")} (${unassignedCount})`,
    ]);
  }
  personFilterSelect.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  personFilterSelect.value = selected;
  syncSidebarFiltersVisibility();
}

function renderSourceFilterOptions() {
  if (!sourceFilterSelect) {
    if (sourceFilterSelect) sourceFilterSelect.style.display = "none";
    syncSidebarFiltersVisibility();
    return;
  }

  // A native picker may hold an uncommitted value before input/change arrives.
  // Never mutate its options, value or visibility while the user is interacting.
  if (document.activeElement === sourceFilterSelect) return;

  const selected = getCurrentSourceFilter();
  const options = getVisibleSourceFilterOptions();
  const display = options.length <= 1 && selected === FILTER_ALL_VALUE ? "none" : "";
  if (sourceFilterSelect.style.display !== display) sourceFilterSelect.style.display = display;

  const entries = [
    [FILTER_ALL_VALUE, t("sidebar.filter.allOrigins", {
      count: getSessionCountForSourceFilter(FILTER_ALL_VALUE),
    })],
    ...options.map(([value, name]) => [value, `${name} (${getSessionCountForSourceFilter(value)})`]),
  ];
  const existing = Array.from(sourceFilterSelect.children);
  const sameValues = existing.length === entries.length
    && existing.every((option, index) => option.value === entries[index][0]);
  if (!sameValues) {
    sourceFilterSelect.innerHTML = "";
    for (const [value, label] of entries) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sourceFilterSelect.appendChild(option);
    }
  } else {
    entries.forEach(([, label], index) => {
      if (existing[index].textContent !== label) existing[index].textContent = label;
    });
  }
  if (sourceFilterSelect.value !== selected) sourceFilterSelect.value = selected;
  syncSidebarFiltersVisibility();
}

function commitSourceFilterSelection() {
  const selected = normalizeSourceFilter(sourceFilterSelect.value);
  if (selected === getCurrentSourceFilter()) return;
  setChatActiveSourceFilter(selected, { normalizeSourceFilter });
  persistActiveSourceFilter(selected);
  renderSessionList();
  renderSourceFilterOptions();
}

if (sourceFilterSelect) {
  // input commits promptly; change also covers browsers that only emit change.
  // Both use the same idempotent state transition.
  sourceFilterSelect.addEventListener("input", commitSourceFilterSelection);
  sourceFilterSelect.addEventListener("change", commitSourceFilterSelection);
  sourceFilterSelect.addEventListener("blur", () => {
    // Let native selection events finish before reconciling deferred counts.
    setTimeout(renderSourceFilterOptions, 0);
  });
}

function commitPersonFilterSelection() {
  const selected = personFilterSelect?.value || FILTER_ALL_VALUE;
  if (selected === getCurrentPersonFilter()) return;
  setChatActivePersonFilter(selected);
  localStorage.setItem(ACTIVE_PERSON_FILTER_STORAGE_KEY, selected);
  renderSessionList();
  renderPersonFilterOptions();
  renderSourceFilterOptions();
}

if (personFilterSelect) {
  personFilterSelect.addEventListener("input", commitPersonFilterSelection);
  personFilterSelect.addEventListener("change", commitPersonFilterSelection);
  personFilterSelect.addEventListener("blur", () => setTimeout(renderPersonFilterOptions, 0));
}

refreshSessionCatalog();

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
    .filter((session) => session && !session.archived && !session.internalRole);
}

function getArchivedSessions() {
  return sessions
    .map((session) => (
      typeof getSessionSidebarListSnapshot === "function"
        ? (getSessionSidebarListSnapshot(session) || session)
        : session
    ))
    .filter((session) => session && session.archived && !session.internalRole)
    .slice()
    .sort((a, b) => getArchivedSessionSortTime(b) - getArchivedSessionSortTime(a));
}

function getLatestSession() {
  return sessions[0] || null;
}

function getLatestActiveSession() {
  return getActiveSessions()[0] || null;
}

function getLatestSessionForCurrentFilters() {
  return sessions.find((session) => matchesCurrentFilters(session)) || null;
}

function getLatestActiveSessionForCurrentFilters() {
  return getActiveSessions().find((session) => matchesCurrentFilters(session)) || null;
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
    if (current && !current.archived && matchesCurrentFilters(current)) return current;
  }
  const filteredSession = getLatestActiveSessionForCurrentFilters();
  if (filteredSession) return filteredSession;
  return getLatestActiveSession();
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

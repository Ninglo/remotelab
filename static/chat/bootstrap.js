"use strict";

const buildInfo = window.__REMOTELAB_BUILD__ || {};
const pageBootstrap =
  window.__REMOTELAB_BOOTSTRAP__ && typeof window.__REMOTELAB_BOOTSTRAP__ === "object"
    ? window.__REMOTELAB_BOOTSTRAP__
    : {};
const buildAssetVersion = buildInfo.assetVersion || "dev";
const BUILD_FORCE_RELOAD_HOLD_MS = 700;

function normalizeBootstrapText(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized || "";
}

function normalizeBootstrapAuthInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "visitor" ? "visitor" : "owner";
  if (role === "owner") {
    return { role };
  }

  const sessionId = normalizeBootstrapText(raw.sessionId);
  if (!sessionId) return null;

  const info = {
    role,
    sessionId,
  };
  const appId = normalizeBootstrapText(raw.appId);
  const visitorId = normalizeBootstrapText(raw.visitorId);
  if (appId) info.appId = appId;
  if (visitorId) info.visitorId = visitorId;
  return info;
}

const bootstrapAuthInfo = normalizeBootstrapAuthInfo(pageBootstrap.auth);

function getBootstrapAuthInfo() {
  return bootstrapAuthInfo ? { ...bootstrapAuthInfo } : null;
}

console.info(
  "RemoteLab build",
  buildInfo.title || buildInfo.serviceTitle || buildAssetVersion,
);

let buildRefreshScheduled = false;
let newerBuildInfo = null;
let buildForceReloadHoldTimer = null;

async function clearFrontendCaches() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(
    () => null,
  );
  if (!registration) return;
  const message = { type: "remotelab:clear-caches" };
  registration.installing?.postMessage(message);
  registration.waiting?.postMessage(message);
  registration.active?.postMessage(message);
}

function updateFrontendRefreshUi() {
  if (!refreshFrontendBtn) return;
  const hasUpdate = !!newerBuildInfo?.assetVersion;
  refreshFrontendBtn.hidden = !hasUpdate;
  refreshFrontendBtn.classList.toggle("ready", hasUpdate);
  refreshFrontendBtn.textContent = hasUpdate ? "Update" : "";
}

function hasPendingComposerState() {
  const draft = typeof msgInput?.value === "string" ? msgInput.value.trim() : "";
  return draft.length > 0 || pendingImages.length > 0;
}

function canAutoApplyFreshBuild() {
  if (document.visibilityState !== "visible") return false;
  if (addToolModal && !addToolModal.hidden) return false;
  if (document.activeElement === msgInput) return false;
  if (hasPendingComposerState()) return false;
  if (["running", "queued", "compacting"].includes(sessionStatus)) return false;
  return true;
}

async function reloadForFreshBuild(nextBuildInfo, { force = false } = {}) {
  if (buildRefreshScheduled) return;
  buildRefreshScheduled = true;
  refreshFrontendBtn?.setAttribute("aria-busy", "true");
  console.info(
    "RemoteLab frontend updated; reloading",
    nextBuildInfo?.title ||
      newerBuildInfo?.title ||
      nextBuildInfo?.assetVersion ||
      newerBuildInfo?.assetVersion ||
      "unknown",
  );
  if (!force && !canAutoApplyFreshBuild()) {
    buildRefreshScheduled = false;
    refreshFrontendBtn?.removeAttribute("aria-busy");
    newerBuildInfo = nextBuildInfo || newerBuildInfo;
    updateFrontendRefreshUi();
    return false;
  }
  try {
    await clearFrontendCaches();
  } catch {}
  window.location.reload();
  return true;
}

async function applyBuildInfo(nextBuildInfo) {
  if (buildRefreshScheduled) return false;
  if (!nextBuildInfo?.assetVersion) {
    return false;
  }
  if (nextBuildInfo.assetVersion === buildAssetVersion) {
    if (!buildRefreshScheduled) {
      newerBuildInfo = null;
      updateFrontendRefreshUi();
    }
    return false;
  }
  newerBuildInfo = nextBuildInfo;
  updateFrontendRefreshUi();
  return reloadForFreshBuild(nextBuildInfo);
}

window.RemoteLabBuild = {
  applyBuildInfo,
  reloadForFreshBuild,
};

// ---- Elements ----
const menuBtn = document.getElementById("menuBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const closeSidebar = document.getElementById("closeSidebar");
const forkSessionBtn = document.getElementById("forkSessionBtn");
const shareSnapshotBtn = document.getElementById("shareSnapshotBtn");
const sidebarFilters = document.getElementById("sidebarFilters");
const sessionList = document.getElementById("sessionList");
const sessionListFooter = document.getElementById("sessionListFooter");
const newUserNameInput = document.getElementById("newUserNameInput");
const newUserAppsPicker = document.getElementById("newUserAppsPicker");
const newUserDefaultAppSelect = document.getElementById("newUserDefaultAppSelect");
const createUserBtn = document.getElementById("createUserBtn");
const userFormStatus = document.getElementById("userFormStatus");
const settingsUsersList = document.getElementById("settingsUsersList");
const settingsAppsList = document.getElementById("settingsAppsList");
const newAppNameInput = document.getElementById("newAppNameInput");
const newAppToolSelect = document.getElementById("newAppToolSelect");
const newAppWelcomeInput = document.getElementById("newAppWelcomeInput");
const newAppSystemPromptInput = document.getElementById("newAppSystemPromptInput");
const createAppConfigBtn = document.getElementById("createAppConfigBtn");
const appFormStatus = document.getElementById("appFormStatus");
const newAppBtn = document.getElementById("newAppBtn");
const newSessionBtn = document.getElementById("newSessionBtn");
const messagesEl = document.getElementById("messages");
const messagesInner = document.getElementById("messagesInner");
const emptyState = document.getElementById("emptyState");
const queuedPanel = document.getElementById("queuedPanel");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const headerTitle = document.getElementById("headerTitle");
const refreshFrontendBtn = document.getElementById("refreshFrontendBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const imgBtn = document.getElementById("imgBtn");
const imgFileInput = document.getElementById("imgFileInput");
const imgPreviewStrip = document.getElementById("imgPreviewStrip");
const inlineToolSelect = document.getElementById("inlineToolSelect");
const inlineModelSelect = document.getElementById("inlineModelSelect");
const effortSelect = document.getElementById("effortSelect");
const thinkingToggle = document.getElementById("thinkingToggle");
const cancelBtn = document.getElementById("cancelBtn");
const contextTokens = document.getElementById("contextTokens");
const compactBtn = document.getElementById("compactBtn");
const dropToolsBtn = document.getElementById("dropToolsBtn");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const sessionTemplateRow = document.getElementById("sessionTemplateRow");
const sessionTemplateSelect = document.getElementById("sessionTemplateSelect");
const sessionTemplateStatus = document.getElementById("sessionTemplateStatus");
const tabSessions = document.getElementById("tabSessions");
const tabBoard = document.getElementById("tabBoard");
const tabSettings = document.getElementById("tabSettings");
const sourceFilterSelect = document.getElementById("sourceFilterSelect");
const sessionAppFilterSelect = document.getElementById("sessionAppFilterSelect");
const userFilterSelect = document.getElementById("userFilterSelect");
const boardPanel = document.getElementById("boardPanel");
const settingsPanel = document.getElementById("settingsPanel");
const inputArea = document.getElementById("inputArea");
const inputResizeHandle = document.getElementById("inputResizeHandle");
const addToolModal = document.getElementById("addToolModal");
const closeAddToolModalBtn = document.getElementById("closeAddToolModal");
const closeAddToolModalFooterBtn = document.getElementById(
  "closeAddToolModalFooter",
);
const addToolNameInput = document.getElementById("addToolNameInput");
const addToolCommandInput = document.getElementById("addToolCommandInput");
const addToolRuntimeFamilySelect = document.getElementById(
  "addToolRuntimeFamilySelect",
);
const addToolModelsInput = document.getElementById("addToolModelsInput");
const addToolReasoningKindSelect = document.getElementById(
  "addToolReasoningKindSelect",
);
const addToolReasoningLevelsInput = document.getElementById(
  "addToolReasoningLevelsInput",
);
const addToolStatus = document.getElementById("addToolStatus");
const providerPromptCode = document.getElementById("providerPromptCode");
const saveToolConfigBtn = document.getElementById("saveToolConfigBtn");
const copyProviderPromptBtn = document.getElementById("copyProviderPromptBtn");

function startBuildForceReloadHold() {
  clearTimeout(buildForceReloadHoldTimer);
  buildForceReloadHoldTimer = setTimeout(() => {
    void reloadForFreshBuild(newerBuildInfo, { force: true });
  }, BUILD_FORCE_RELOAD_HOLD_MS);
}

function cancelBuildForceReloadHold() {
  clearTimeout(buildForceReloadHoldTimer);
  buildForceReloadHoldTimer = null;
}

[headerTitle, statusDot, statusText].forEach((element) => {
  element?.addEventListener("pointerdown", startBuildForceReloadHold);
  element?.addEventListener("pointerup", cancelBuildForceReloadHold);
  element?.addEventListener("pointerleave", cancelBuildForceReloadHold);
  element?.addEventListener("pointercancel", cancelBuildForceReloadHold);
});

refreshFrontendBtn?.addEventListener("click", () => {
  void reloadForFreshBuild(newerBuildInfo, { force: true });
});

let ws = null;
let pendingImages = [];
const ACTIVE_SESSION_STORAGE_KEY = "activeSessionId";
const ACTIVE_SIDEBAR_TAB_STORAGE_KEY = "activeSidebarTab";
const LEGACY_ACTIVE_SOURCE_FILTER_STORAGE_KEY = "activeAppFilter";
const ACTIVE_SOURCE_FILTER_STORAGE_KEY = "activeSourceFilter";
const ACTIVE_SESSION_APP_FILTER_STORAGE_KEY = "activeSessionAppFilter";
const ACTIVE_USER_FILTER_STORAGE_KEY = "activeUserFilter";
const LEGACY_SESSION_SEND_FAILURES_STORAGE_KEY = "sessionSendFailures";
const FILTER_ALL_VALUE = "__all__";
const SOURCE_FILTER_CHAT_VALUE = "chat_ui";
const SOURCE_FILTER_BOT_VALUE = "bot";
const SOURCE_FILTER_AUTOMATION_VALUE = "automation";
const ADMIN_USER_FILTER_VALUE = "user_admin";
const USER_FILTER_ALL_VALUE = "__all_users__";
const DEFAULT_APP_ID = "chat";
const BASIC_CHAT_APP_ID = "app_basic_chat";
const DEFAULT_APP_NAME = "Chat";
const sessionStateModel = window.RemoteLabSessionStateModel;
if (!sessionStateModel) {
  throw new Error("RemoteLabSessionStateModel must load before bootstrap.js");
}
let pendingNavigationState = readNavigationStateFromLocation();
let currentSessionId =
  pendingNavigationState.sessionId ||
  localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) ||
  null;
let hasAttachedSession = false;
let sessionStatus = "idle";
let reconnectTimer = null;
let sessions = [];
let sessionAppCatalog = [];
let availableApps = [];
let availableUsers = [];
let hasLoadedSessions = false;
let visitorMode = false;
let visitorSessionId = null;
let currentSessionRefreshPromise = null;
let pendingCurrentSessionRefresh = false;
let hasSeenWsOpen = false;
const sidebarSessionRefreshPromises = new Map();
const pendingSidebarSessionRefreshes = new Set();
const jsonResponseCache = new Map();
const eventBodyCache = new Map();
const eventBodyRequests = new Map();
const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const renderedEventState = {
  sessionId: null,
  latestSeq: 0,
  eventCount: 0,
};

let currentTokens = 0;

let preferredTool =
  localStorage.getItem("preferredTool") ||
  localStorage.getItem("selectedTool") ||
  null;
let selectedTool = preferredTool;
// Default thinking to enabled; only disable if explicitly set to 'false'
let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
// Model/effort are stored per-tool: "selectedModel_claude", "selectedModel_codex"
let selectedModel = null;
let selectedEffort = null;
let currentToolModels = []; // model list for current tool
let currentToolEffortLevels = null; // null = binary toggle, string[] = effort dropdown
let currentToolReasoningKind = "toggle";
let currentToolReasoningLabel = "Thinking";
let currentToolReasoningDefault = null;
let toolsList = [];
let isDesktop = window.matchMedia("(min-width: 768px)").matches;
const ADD_MORE_TOOL_VALUE = "__add_more__";
const COLLAPSED_GROUPS_STORAGE_KEY = "collapsedSessionGroups";
let isSavingToolConfig = false;
let collapsedFolders = JSON.parse(
  localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ||
    localStorage.getItem("collapsedFolders") ||
    "{}",
);

try {
  localStorage.removeItem(LEGACY_SESSION_SEND_FAILURES_STORAGE_KEY);
} catch {}

function readStoredJsonValue(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJsonValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

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

function getSessionBoardColumns() {
  return typeof sessionStateModel.getBoardColumns === "function"
    ? sessionStateModel.getBoardColumns()
    : [];
}

function getSessionBoardColumn(session) {
  return typeof sessionStateModel.getSessionBoardColumn === "function"
    ? sessionStateModel.getSessionBoardColumn(session)
    : {
      key: "parked",
      label: "Parked",
      title: "Paused work",
      emptyText: "No parked sessions",
    };
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
    if (app?.id === "app_video_cut") return 2;
    return 3;
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

function syncSidebarFiltersVisibility(showingSessions = true) {
  if (!sidebarFilters) return;
  const visible = showingSessions && !visitorMode;
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
  const stamp = session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionPinSortRank(session) {
  return session?.pinned === true ? 1 : 0;
}

function sortSessionsInPlace() {
  sessions.sort((a, b) => (
    getSessionPinSortRank(b) - getSessionPinSortRank(a)
    || getSessionSortTime(b) - getSessionSortTime(a)
  ));
}

function getArchivedSessionSortTime(session) {
  const stamp = session?.archivedAt || session?.updatedAt || session?.created || "";
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

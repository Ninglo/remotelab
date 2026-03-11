"use strict";

const buildInfo = window.__REMOTELAB_BUILD__ || {};
const buildAssetVersion = buildInfo.assetVersion || "dev";

console.info("RemoteLab build", buildInfo.title || buildAssetVersion);

// ---- Elements ----
const menuBtn = document.getElementById("menuBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const closeSidebar = document.getElementById("closeSidebar");
const collapseBtn = document.getElementById("collapseBtn");
const forkSessionBtn = document.getElementById("forkSessionBtn");
const shareSnapshotBtn = document.getElementById("shareSnapshotBtn");
const sidebarFilters = document.getElementById("sidebarFilters");
const sessionList = document.getElementById("sessionList");
const sessionListFooter = document.getElementById("sessionListFooter");
const newSessionBtn = document.getElementById("newSessionBtn");
const messagesEl = document.getElementById("messages");
const messagesInner = document.getElementById("messagesInner");
const emptyState = document.getElementById("emptyState");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const headerTitle = document.getElementById("headerTitle");
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
const resumeBtn = document.getElementById("resumeBtn");
const tabSessions = document.getElementById("tabSessions");
const tabProgress = document.getElementById("tabProgress");
const appFilterSelect = document.getElementById("appFilterSelect");
const progressPanel = document.getElementById("progressPanel");
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

let ws = null;
let pendingImages = [];
const ACTIVE_SESSION_STORAGE_KEY = "activeSessionId";
const ACTIVE_SIDEBAR_TAB_STORAGE_KEY = "activeSidebarTab";
const ACTIVE_APP_FILTER_STORAGE_KEY = "activeAppFilter";
const APP_FILTER_ALL_VALUE = "__all__";
const DEFAULT_APP_ID = "chat";
const BUILTIN_APP_LABELS = {
  chat: "Chat",
  feishu: "Lark",
  email: "Email",
  github: "GitHub",
  automation: "Automation",
};
const BUILTIN_APP_ORDER = Object.keys(BUILTIN_APP_LABELS);
let pendingNavigationState = readNavigationStateFromLocation();
let currentSessionId =
  pendingNavigationState.sessionId ||
  localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) ||
  null;
let hasAttachedSession = false;
let sessionStatus = "idle";
let reconnectTimer = null;
let sessions = [];
let appCatalog = [];
let visitorMode = false;
let visitorSessionId = null;
let finishedUnread = new Set(); // sessionIds finished but not yet opened
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
let sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
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

// Thinking block state
let currentThinkingBlock = null; // { el, body, tools: Set }
let inThinkingBlock = false;

let activeAppFilter = normalizeAppFilter(
  localStorage.getItem(ACTIVE_APP_FILTER_STORAGE_KEY) || APP_FILTER_ALL_VALUE,
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
  return tab === "progress" ? "progress" : "sessions";
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
  if (nextTab === "progress") url.searchParams.set("tab", nextTab);
  else url.searchParams.delete("tab");
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
  const builtinId = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUILTIN_APP_LABELS, builtinId)) {
    return builtinId;
  }
  return trimmed;
}

function normalizeAppFilter(appId) {
  const normalized = normalizeAppId(appId);
  return normalized || APP_FILTER_ALL_VALUE;
}

function persistActiveAppFilter(appId) {
  if (visitorMode) return;
  localStorage.setItem(ACTIVE_APP_FILTER_STORAGE_KEY, normalizeAppFilter(appId));
}

function formatAppNameFromId(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return BUILTIN_APP_LABELS[DEFAULT_APP_ID];
  if (BUILTIN_APP_LABELS[normalized]) return BUILTIN_APP_LABELS[normalized];
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createAppCatalogEntry(app) {
  const id = normalizeAppId(app?.id);
  if (!id) return null;
  const name =
    typeof app?.name === "string" && app.name.trim()
      ? app.name.trim()
      : formatAppNameFromId(id);
  return {
    ...app,
    id,
    name,
  };
}

function sortAppCatalogEntries(a, b) {
  const aBuiltinIndex = BUILTIN_APP_ORDER.indexOf(a.id);
  const bBuiltinIndex = BUILTIN_APP_ORDER.indexOf(b.id);
  if (aBuiltinIndex !== -1 || bBuiltinIndex !== -1) {
    if (aBuiltinIndex === -1) return 1;
    if (bBuiltinIndex === -1) return -1;
    return aBuiltinIndex - bBuiltinIndex;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function refreshAppCatalog(apps = []) {
  const next = new Map();

  for (const builtinId of BUILTIN_APP_ORDER) {
    next.set(builtinId, createAppCatalogEntry({ id: builtinId }));
  }

  for (const app of apps) {
    const entry = createAppCatalogEntry(app);
    if (!entry) continue;
    next.set(entry.id, entry);
  }

  for (const session of sessions) {
    const entry = createAppCatalogEntry({ id: session?.appId });
    if (!entry) continue;
    if (!next.has(entry.id)) {
      next.set(entry.id, entry);
    }
  }

  if (activeAppFilter !== APP_FILTER_ALL_VALUE && !next.has(activeAppFilter)) {
    next.set(
      activeAppFilter,
      createAppCatalogEntry({ id: activeAppFilter }),
    );
  }

  appCatalog = [...next.values()].filter(Boolean).sort(sortAppCatalogEntries);
  renderAppFilterOptions();
}

function getAppCatalogEntry(appId) {
  const normalized = normalizeAppId(appId, { fallbackDefault: true });
  return (
    appCatalog.find((entry) => entry.id === normalized)
    || createAppCatalogEntry({ id: normalized })
  );
}

function getEffectiveSessionAppId(session) {
  return normalizeAppId(session?.appId, { fallbackDefault: true });
}

function matchesCurrentAppFilter(session) {
  return (
    activeAppFilter === APP_FILTER_ALL_VALUE
    || getEffectiveSessionAppId(session) === activeAppFilter
  );
}

function getVisibleActiveSessions() {
  return getActiveSessions().filter((session) => matchesCurrentAppFilter(session));
}

function getVisibleArchivedSessions() {
  return getArchivedSessions().filter((session) => matchesCurrentAppFilter(session));
}

function getSessionCountForApp(appId) {
  const activeSessions = getActiveSessions();
  if (appId === APP_FILTER_ALL_VALUE) return activeSessions.length;
  return activeSessions.filter((session) => getEffectiveSessionAppId(session) === appId).length;
}

function renderAppFilterOptions() {
  if (!appFilterSelect || visitorMode) return;

  const previousValue = normalizeAppFilter(appFilterSelect.value || activeAppFilter);
  const selectedValue = appCatalog.some((app) => app.id === previousValue)
    ? previousValue
    : activeAppFilter;

  appFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = APP_FILTER_ALL_VALUE;
  allOption.textContent = `All Apps (${getSessionCountForApp(APP_FILTER_ALL_VALUE)})`;
  appFilterSelect.appendChild(allOption);

  for (const app of appCatalog) {
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = `${app.name} (${getSessionCountForApp(app.id)})`;
    appFilterSelect.appendChild(option);
  }

  appFilterSelect.value = normalizeAppFilter(selectedValue);
}

if (appFilterSelect) {
  appFilterSelect.addEventListener("change", () => {
    activeAppFilter = normalizeAppFilter(appFilterSelect.value);
    persistActiveAppFilter(activeAppFilter);
    renderAppFilterOptions();
    renderSessionList();
  });
}

refreshAppCatalog();

function getSessionSortTime(session) {
  const stamp = session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortSessionsInPlace() {
  sessions.sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a));
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

function resolveRestoreTargetSession() {
  if (pendingNavigationState?.sessionId) {
    const requested = sessions.find(
      (session) => session.id === pendingNavigationState.sessionId,
    );
    if (requested) return requested;
  }
  if (currentSessionId) {
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current) return current;
  }
  return getLatestActiveSession() || getLatestSession();
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

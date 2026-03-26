"use strict";

const buildInfo = window.__REMOTELAB_BUILD__ || {};
const pageBootstrap =
  window.__REMOTELAB_BOOTSTRAP__ && typeof window.__REMOTELAB_BOOTSTRAP__ === "object"
    ? window.__REMOTELAB_BOOTSTRAP__
    : {};
const buildAssetVersion = buildInfo.assetVersion || "dev";
const bootstrapT = window.remotelabT || ((key) => key);

function normalizeBootstrapText(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized || "";
}

function normalizeBootstrapAuthInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "visitor" ? "visitor" : "owner";
  const preferredLanguage = normalizeBootstrapText(raw.preferredLanguage);
  if (role === "owner") {
    return preferredLanguage ? { role, preferredLanguage } : { role };
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
  if (preferredLanguage) info.preferredLanguage = preferredLanguage;
  return info;
}

const bootstrapAuthInfo = normalizeBootstrapAuthInfo(pageBootstrap.auth);

function normalizeBootstrapAssetUploads(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      directUpload: false,
      provider: "",
    };
  }
  return {
    enabled: raw.enabled === true,
    directUpload: raw.directUpload === true,
    provider: normalizeBootstrapText(raw.provider),
  };
}

const bootstrapAssetUploads = normalizeBootstrapAssetUploads(pageBootstrap.assetUploads);

function normalizeBootstrapShareSnapshot(rawPayload, rawMeta = null) {
  const payload = rawPayload && typeof rawPayload === "object"
    ? rawPayload
    : {};
  const meta = rawMeta && typeof rawMeta === "object"
    ? rawMeta
    : {};
  if (Object.keys(payload).length === 0 && Object.keys(meta).length === 0) {
    return null;
  }

  const id = normalizeBootstrapText(payload.id || meta.id || meta.shareId);
  const sessionRaw = payload.session && typeof payload.session === "object"
    ? payload.session
    : (meta.session && typeof meta.session === "object" ? meta.session : {});
  const payloadView = payload.view && typeof payload.view === "object"
    ? payload.view
    : {};
  const metaView = meta.view && typeof meta.view === "object"
    ? meta.view
    : {};
  const view = {
    ...payloadView,
    ...metaView,
  };
  if (meta.badge && !view.badge) view.badge = meta.badge;
  if (meta.note && !view.note) view.note = meta.note;
  if (meta.titleSuffix && !view.titleSuffix) view.titleSuffix = meta.titleSuffix;
  const eventBlocks = payload.eventBlocks && typeof payload.eventBlocks === "object"
    ? Object.fromEntries(
      Object.entries(payload.eventBlocks)
        .filter(([key, events]) => typeof key === "string" && Array.isArray(events)),
    )
    : {};
  const displayEvents = Array.isArray(payload.displayEvents)
    ? payload.displayEvents.filter((event) => event && typeof event === "object")
    : [];

  return {
    id,
    version: payload.version,
    createdAt: normalizeBootstrapText(payload.createdAt || meta.createdAt) || null,
    session: {
      name: normalizeBootstrapText(sessionRaw.name),
      tool: normalizeBootstrapText(sessionRaw.tool),
      created: normalizeBootstrapText(sessionRaw.created) || null,
    },
    view,
    eventCount: Number.isInteger(payload.eventCount)
      ? payload.eventCount
      : displayEvents.length,
    displayEvents,
    eventBlocks,
  };
}

const bootstrapShareSnapshot = normalizeBootstrapShareSnapshot(
  window.__REMOTELAB_SHARE__,
  pageBootstrap.shareSnapshot,
);

function getBootstrapAuthInfo() {
  return bootstrapAuthInfo ? { ...bootstrapAuthInfo } : null;
}

function getBootstrapShareSnapshot() {
  return bootstrapShareSnapshot;
}

function getBootstrapAssetUploads() {
  return { ...bootstrapAssetUploads };
}

console.info(
  "RemoteLab build",
  buildInfo.title || buildInfo.serviceTitle || buildAssetVersion,
);

let buildRefreshScheduled = false;
let newerBuildInfo = null;

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
  const updateTitle = hasUpdate
    ? bootstrapT("status.frontendUpdateReady")
    : bootstrapT("status.frontendReloadLatest");
  refreshFrontendBtn.title = updateTitle;
  refreshFrontendBtn.setAttribute("aria-label", updateTitle);
  if (!hasUpdate) {
    refreshFrontendBtn.removeAttribute("aria-busy");
  }
}

function hasUnsavedComposerState() {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return true;
  }
  const draftText = typeof msgInput?.value === "string" ? msgInput.value.trim() : "";
  if (draftText) {
    return true;
  }
  const pendingAttachmentCount = Number.isInteger(imgPreviewStrip?.childElementCount)
    ? imgPreviewStrip.childElementCount
    : 0;
  return pendingAttachmentCount > 0;
}

async function reloadForFreshBuild(nextBuildInfo) {
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
  if (hasUnsavedComposerState()) {
    return false;
  }
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
const newUserLanguageSelect = document.getElementById("newUserLanguageSelect");
const createUserBtn = document.getElementById("createUserBtn");
const userFormStatus = document.getElementById("userFormStatus");
const settingsUsersList = document.getElementById("settingsUsersList");
const settingsAppsList = document.getElementById("settingsAppsList");
const uiLanguageSelect = document.getElementById("uiLanguageSelect");
const uiLanguageStatus = document.getElementById("uiLanguageStatus");
const newAppNameInput = document.getElementById("newAppNameInput");
const newAppToolSelect = document.getElementById("newAppToolSelect");
const newAppWelcomeInput = document.getElementById("newAppWelcomeInput");
const newAppSystemPromptInput = document.getElementById("newAppSystemPromptInput");
const createAppConfigBtn = document.getElementById("createAppConfigBtn");
const appFormStatus = document.getElementById("appFormStatus");
const sortSessionListBtn = document.getElementById("sortSessionListBtn");
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
const tabSettings = document.getElementById("tabSettings");
const sourceFilterSelect = document.getElementById("sourceFilterSelect");
const sessionAppFilterSelect = document.getElementById("sessionAppFilterSelect");
const userFilterSelect = document.getElementById("userFilterSelect");
const settingsPanel = document.getElementById("settingsPanel");
const inputArea = document.getElementById("inputArea");
const composerPendingState = document.getElementById("composerPendingState");
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

refreshFrontendBtn?.addEventListener("click", () => {
  void reloadForFreshBuild(newerBuildInfo);
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
const SESSION_REVIEW_MARKERS_STORAGE_KEY = "sessionReviewedAtById";
const SESSION_REVIEW_BASELINE_AT_STORAGE_KEY = "sessionReviewBaselineAt";
const FILTER_ALL_VALUE = "__all__";
const SOURCE_FILTER_CHAT_VALUE = "chat_ui";
const SOURCE_FILTER_BOT_VALUE = "bot";
const SOURCE_FILTER_AUTOMATION_VALUE = "automation";
const ADMIN_USER_FILTER_VALUE = "user_admin";
const USER_FILTER_ALL_VALUE = "__all_users__";
const DEFAULT_APP_ID = "chat";
const WELCOME_APP_ID = "app_welcome";
const BASIC_CHAT_APP_ID = "app_basic_chat";
const WELCOME_TEMPLATE_APP_ID = WELCOME_APP_ID;
const BASIC_CHAT_TEMPLATE_APP_ID = BASIC_CHAT_APP_ID;
const CREATE_APP_TEMPLATE_APP_ID = "app_create_app";
const DEFAULT_APP_NAME = "Chat";
const sessionStateModel = window.RemoteLabSessionStateModel;
if (!sessionStateModel) {
  throw new Error("RemoteLabSessionStateModel must load before bootstrap.js");
}

function normalizeSidebarTab(tab) {
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
let archivedSessionCount = 0;
let archivedSessionsLoaded = false;
let archivedSessionsLoading = false;
let archivedSessionsRefreshPromise = null;
let visitorMode = false;
let visitorSessionId = null;
let shareSnapshotMode = false;
let shareSnapshotPayload = bootstrapShareSnapshot;
let currentSessionRefreshPromise = null;
let pendingCurrentSessionRefresh = false;
let hasSeenWsOpen = false;
const sidebarSessionRefreshPromises = new Map();
const pendingSidebarSessionRefreshes = new Set();
const jsonResponseCache = new Map();
const eventBodyCache = new Map();
const eventBodyRequests = new Map();
const eventBlockCache = new Map();
const eventBlockRequests = new Map();
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
  eventBaseKeys: [],
  eventKeys: [],
  runState: "idle",
  runningBlockExpanded: false,
};

function setRunningEventBlockExpanded(sessionId, expanded) {
  if (!sessionId || renderedEventState.sessionId !== sessionId) return;
  renderedEventState.runningBlockExpanded = expanded === true;
}

function shouldUseVisitorRequests() {
  if (visitorMode) return true;
  try {
    return new URL(window.location.href).searchParams.get("visitor") === "1";
  } catch {
    return false;
  }
}

function withVisitorModeUrl(url) {
  const parsed = new URL(String(url || ""), window.location.href);
  if (shouldUseVisitorRequests()) {
    parsed.searchParams.set("visitor", "1");
  }
  if (parsed.origin === window.location.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

let currentTokens = 0;

const DEFAULT_TOOL_ID = "micro-agent";
const LEGACY_AUTO_PREFERRED_TOOL_IDS = new Set(["codex", "micro-agent"]);

function normalizeStoredToolId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function derivePreferredToolId(storedPreferredTool, storedLegacySelectedTool) {
  const preferred = normalizeStoredToolId(storedPreferredTool);
  const legacySelected = normalizeStoredToolId(storedLegacySelectedTool);
  if (preferred && !(LEGACY_AUTO_PREFERRED_TOOL_IDS.has(preferred) && !legacySelected)) {
    return preferred;
  }
  if (legacySelected) {
    return legacySelected;
  }
  return null;
}

const storedPreferredTool = normalizeStoredToolId(localStorage.getItem("preferredTool"));
const storedLegacySelectedTool = normalizeStoredToolId(localStorage.getItem("selectedTool"));

let preferredTool = derivePreferredToolId(storedPreferredTool, storedLegacySelectedTool);
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
let allToolsList = [];
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

let sessionReviewMarkers = readStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, {});
let sessionReviewBaselineAt = readStoredTimestampValue(SESSION_REVIEW_BASELINE_AT_STORAGE_KEY);
if (!sessionReviewBaselineAt) {
  sessionReviewBaselineAt = new Date().toISOString();
  writeStoredTimestampValue(SESSION_REVIEW_BASELINE_AT_STORAGE_KEY, sessionReviewBaselineAt);
}

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

function normalizeStoredTimestamp(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  const time = new Date(trimmed).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function readStoredTimestampValue(key) {
  try {
    return normalizeStoredTimestamp(localStorage.getItem(key));
  } catch {
    return "";
  }
}

function writeStoredTimestampValue(key, value) {
  try {
    const normalized = normalizeStoredTimestamp(value);
    if (normalized) {
      localStorage.setItem(key, normalized);
    } else {
      localStorage.removeItem(key);
    }
  } catch {}
}

function getSessionReviewedAtTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionReviewBaselineAt() {
  return sessionReviewBaselineAt || "";
}

function getLocalSessionReviewedAt(sessionId) {
  if (!sessionId || !sessionReviewMarkers || typeof sessionReviewMarkers !== "object") return "";
  const normalized = normalizeStoredTimestamp(sessionReviewMarkers[sessionId]);
  if (normalized) return normalized;
  if (Object.prototype.hasOwnProperty.call(sessionReviewMarkers, sessionId)) {
    const next = { ...sessionReviewMarkers };
    delete next[sessionId];
    sessionReviewMarkers = next;
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  }
  return "";
}

function setLocalSessionReviewedAt(sessionId, stamp) {
  if (!sessionId) return "";
  const normalized = normalizeStoredTimestamp(stamp);
  const current = getLocalSessionReviewedAt(sessionId);
  if (normalized) {
    if (getSessionReviewedAtTime(normalized) <= getSessionReviewedAtTime(current)) {
      return current;
    }
    sessionReviewMarkers = {
      ...sessionReviewMarkers,
      [sessionId]: normalized,
    };
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  } else if (Object.prototype.hasOwnProperty.call(sessionReviewMarkers, sessionId)) {
    const next = { ...sessionReviewMarkers };
    delete next[sessionId];
    sessionReviewMarkers = next;
    writeStoredJsonValue(SESSION_REVIEW_MARKERS_STORAGE_KEY, sessionReviewMarkers);
  }

  const existing = sessions.find((session) => session.id === sessionId);
  if (existing) {
    if (normalized) {
      existing.localReviewedAt = normalized;
    } else {
      delete existing.localReviewedAt;
    }
  }

  return normalized || "";
}

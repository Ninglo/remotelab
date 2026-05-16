// ---- Sidebar ----
function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

function openSidebar() {
  sidebarOverlay.classList.add("open");
}
function closeSidebarFn() {
  sidebarOverlay.classList.remove("open");
}

function openSessionsSidebar() {
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  openSidebar();
  return true;
}

function createNewSessionShortcut({
  closeSidebar = true,
  forceComposerFocus = false,
  sourceContext = null,
} = {}) {
  if (closeSidebar && !isDesktop) closeSidebarFn();
  const tool = preferredTool || selectedTool || toolsList[0]?.id;
  if (!tool) return false;
  if (
    typeof window.remotelabGetSelectedWorkspaceMode === "function"
    && window.remotelabGetSelectedWorkspaceMode() === WORKSPACE_MODE_CUSTOM
    && !selectedCustomWorkspaceFolder
  ) {
    void openWorkspaceBrowser(getDefaultWorkspaceFolder());
    return false;
  }
  const preferredAgentId = typeof getPreferredAgentTemplateId === "function"
    ? getPreferredAgentTemplateId()
    : "";
  const preferredAgentName = typeof getPreferredAgentTemplateName === "function"
    ? getPreferredAgentTemplateName()
    : "";
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  const createPayload = {
    action: "create",
    folder: typeof window.remotelabGetSelectedSessionFolder === "function"
      ? window.remotelabGetSelectedSessionFolder()
      : (typeof window.remotelabGetDefaultSessionFolder === "function"
        ? window.remotelabGetDefaultSessionFolder()
        : "~"),
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    templateId: preferredAgentId,
    templateName: preferredAgentName,
    ...(forceComposerFocus ? { forceComposerFocus: true } : {}),
    ...(sourceContext && typeof sourceContext === "object" ? { sourceContext } : {}),
  };
  // If the inline agent picker currently indicates Plan, create a Plan-mode session
  try {
    if (typeof inlineAgentSelect !== 'undefined' && inlineAgentSelect && inlineAgentSelect.value === '__plan') {
      createPayload.interactionMode = 'plan';
    }
  } catch (e) {}
  return dispatchAction(createPayload);
}

const WORKSPACE_MODE_STORAGE_KEY = "remotelab.workspaceMode";
const WORKSPACE_CUSTOM_FOLDER_STORAGE_KEY = "remotelab.customWorkspaceFolder";
const WORKSPACE_SELECTION_STORAGE_KEY = "remotelab.selectedWorkspaceFolder";
const WORKSPACE_RECENTS_STORAGE_KEY = "remotelab.recentWorkspaceFolders";
const WORKSPACE_MODE_DEFAULT = "default";
const WORKSPACE_MODE_CUSTOM = "custom";
const WORKSPACE_CUSTOM_BROWSE_SENTINEL = "__remotelab_browse_custom_workspace__";
let currentWorkspaceMode = WORKSPACE_MODE_DEFAULT;
let selectedCustomWorkspaceFolder = "";
let currentBrowsingPath = null;
let pendingWorkspaceBrowserPath = null;

function getDefaultWorkspaceFolder() {
  return typeof window.remotelabGetDefaultSessionFolder === "function"
    ? window.remotelabGetDefaultSessionFolder()
    : "~";
}

async function fetchChildren(path) {
  try {
    const resp = await fetch(`/api/browse?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!resp.ok) return { path: path, parent: null, children: [] };
    const json = await resp.json();
    return json || { path, parent: null, children: [] };
  } catch (e) {
    console.warn('[workspace] fetchChildren error', e && e.message);
    return { path, parent: null, children: [] };
  }
}

function normalizeWorkspaceFolder(folder, fallback = "") {
  const trimmed = typeof folder === "string" ? folder.trim() : "";
  return trimmed || fallback || getDefaultWorkspaceFolder();
}

function normalizeWorkspaceMode(mode) {
  return mode === WORKSPACE_MODE_CUSTOM ? WORKSPACE_MODE_CUSTOM : WORKSPACE_MODE_DEFAULT;
}

function readWorkspaceFolders(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const folders = [];
    for (const entry of parsed) {
      const folder = normalizeWorkspaceFolder(entry, "");
      if (!folder || folders.includes(folder)) continue;
      folders.push(folder);
    }
    return folders.slice(0, 8);
  } catch {
    return [];
  }
}

function saveWorkspaceFolders(key, folders) {
  try {
    localStorage.setItem(key, JSON.stringify(folders));
  } catch {}
}

function getStoredWorkspaceFolder() {
  try {
    return normalizeWorkspaceFolder(localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY), getDefaultWorkspaceFolder());
  } catch {
    return getDefaultWorkspaceFolder();
  }
}

function getStoredWorkspaceMode() {
  try {
    return normalizeWorkspaceMode(localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY));
  } catch {
    return WORKSPACE_MODE_DEFAULT;
  }
}

function getStoredCustomWorkspaceFolder() {
  try {
    const explicit = normalizeWorkspaceFolder(localStorage.getItem(WORKSPACE_CUSTOM_FOLDER_STORAGE_KEY), "");
    if (explicit) return explicit;
    const legacy = getStoredWorkspaceFolder();
    return legacy === getDefaultWorkspaceFolder() ? "" : legacy;
  } catch {
    return "";
  }
}

function persistWorkspaceMode(mode) {
  currentWorkspaceMode = normalizeWorkspaceMode(mode);
  try {
    localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, currentWorkspaceMode);
  } catch {}
}

function rememberWorkspaceFolder(folder) {
  const nextFolder = normalizeWorkspaceFolder(folder, "");
  if (!nextFolder) return;
  const recentFolders = readWorkspaceFolders(WORKSPACE_RECENTS_STORAGE_KEY).filter((entry) => entry !== nextFolder);
  recentFolders.unshift(nextFolder);
  saveWorkspaceFolders(WORKSPACE_RECENTS_STORAGE_KEY, recentFolders.slice(0, 8));
  try {
    localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, nextFolder);
    localStorage.setItem(WORKSPACE_CUSTOM_FOLDER_STORAGE_KEY, nextFolder);
  } catch {}
}

function getSelectedWorkspaceFolder() {
  if (currentWorkspaceMode === WORKSPACE_MODE_CUSTOM) {
    return selectedCustomWorkspaceFolder || getDefaultWorkspaceFolder();
  }
  return getDefaultWorkspaceFolder();
}

function getCustomWorkspaceOptions() {
  const options = [];
  for (const folder of [selectedCustomWorkspaceFolder, ...readWorkspaceFolders(WORKSPACE_RECENTS_STORAGE_KEY)]) {
    const normalized = normalizeWorkspaceFolder(folder, "");
    if (!normalized || options.includes(normalized)) continue;
    options.push(normalized);
  }
  return options;
}

function syncWorkspaceCreateAvailability() {
  if (!newSessionBtn) return;
  const missingCustomFolder = currentWorkspaceMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder;
  newSessionBtn.disabled = missingCustomFolder;
}

function syncWorkspaceModePicker() {
  if (!workspaceSelect) {
    console.warn("[workspace] workspaceSelect element not found");
    return;
  }
  workspaceSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = WORKSPACE_MODE_DEFAULT;
  defaultOption.textContent = t("sidebar.workspace.modeDefault");
  defaultOption.title = getDefaultWorkspaceFolder();
  workspaceSelect.appendChild(defaultOption);

  const customOption = document.createElement("option");
  customOption.value = WORKSPACE_MODE_CUSTOM;
  customOption.textContent = t("sidebar.workspace.modeCustom");
  customOption.title = selectedCustomWorkspaceFolder || t("sidebar.workspace.customOption");
  workspaceSelect.appendChild(customOption);

  workspaceSelect.value = currentWorkspaceMode;
}

function syncCustomWorkspacePicker() {
  if (!workspaceCustomPicker) return;
  const customMode = currentWorkspaceMode === WORKSPACE_MODE_CUSTOM;
  workspaceCustomPicker.hidden = !customMode;
  if (!workspaceCustomFolderSelect) {
    syncWorkspaceCreateAvailability();
    return;
  }
  if (!customMode) {
    workspaceCustomFolderSelect.innerHTML = "";
    closeWorkspaceBrowser();
    syncWorkspaceCreateAvailability();
    return;
  }

  workspaceCustomFolderSelect.innerHTML = "";
  const options = getCustomWorkspaceOptions();
  if (options.length === 0) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("sidebar.workspace.customOption");
    placeholder.disabled = true;
    workspaceCustomFolderSelect.appendChild(placeholder);
  } else {
    for (const optionFolder of options) {
      const option = document.createElement("option");
      option.value = optionFolder;
      option.textContent = optionFolder;
      option.title = optionFolder;
      workspaceCustomFolderSelect.appendChild(option);
    }
  }
  const browseOption = document.createElement("option");
  browseOption.value = WORKSPACE_CUSTOM_BROWSE_SENTINEL;
  browseOption.textContent = t("sidebar.workspace.customOption");
  workspaceCustomFolderSelect.appendChild(browseOption);
  workspaceCustomFolderSelect.value = selectedCustomWorkspaceFolder || "";
  syncWorkspaceCreateAvailability();
}

function syncWorkspaceUi() {
  syncWorkspaceModePicker();
  syncCustomWorkspacePicker();
}

function applyCustomWorkspaceSelection(folder, { persist = true, refresh = true } = {}) {
  const nextFolder = normalizeWorkspaceFolder(folder, getDefaultWorkspaceFolder());
  selectedCustomWorkspaceFolder = nextFolder;
  if (persist) {
    rememberWorkspaceFolder(nextFolder);
  }
  syncWorkspaceUi();
  if (refresh) {
    queueWorkspaceSessionListRefresh({ clearCurrent: true });
  }
  return nextFolder;
}

function applyWorkspaceMode(mode, { persist = true, refresh = true } = {}) {
  const nextMode = normalizeWorkspaceMode(mode);
  if (persist) {
    persistWorkspaceMode(nextMode);
  } else {
    currentWorkspaceMode = nextMode;
  }
  if (nextMode === WORKSPACE_MODE_DEFAULT) {
    closeWorkspaceBrowser();
  }
  syncWorkspaceUi();
  if (refresh && !(nextMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder)) {
    queueWorkspaceSessionListRefresh({ clearCurrent: true });
  } else if (refresh && nextMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder) {
    queueWorkspaceSessionListReset();
  }
  return currentWorkspaceMode;
}

function isSessionInSelectedWorkspace(session) {
  return normalizeWorkspaceFolder(session?.folder, "") === normalizeWorkspaceFolder(getSelectedWorkspaceFolder(), "");
}

function renderWorkspaceSessionList() {
  if (typeof refreshAppCatalog === "function") {
    refreshAppCatalog();
  }
  if (typeof renderSessionList === "function") {
    renderSessionList();
  }
}

function queueWorkspaceSessionListReset({ clearCurrent = true } = {}) {
  if (visitorMode) return Promise.resolve([]);
  const nextState = {
    sessions: [],
    hasLoadedSessions: false,
    archivedSessionCount: 0,
    archivedSessionsLoaded: false,
    archivedSessionsLoading: false,
  };
  if (clearCurrent) {
    nextState.currentSessionId = null;
    nextState.hasAttachedSession = false;
  }
  if (typeof replaceChatState === "function") {
    replaceChatState(nextState, {
      compareSessions: typeof compareClientSessions === "function" ? compareClientSessions : null,
    });
  } else {
    sessions = [];
    if (clearCurrent) {
      currentSessionId = null;
      hasAttachedSession = false;
    }
    hasLoadedSessions = false;
    archivedSessionCount = 0;
    archivedSessionsLoaded = false;
    archivedSessionsLoading = false;
  }
  if (clearCurrent) {
    if (typeof resetAttachedSessionRenderState === "function") {
      resetAttachedSessionRenderState();
    }
    if (typeof persistActiveSessionId === "function") {
      persistActiveSessionId(null);
    }
    if (typeof syncBrowserState === "function") {
      syncBrowserState({
        sessionId: null,
        tab: typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : "sessions",
      });
    }
    if (typeof showEmpty === "function") {
      showEmpty();
    }
    if (typeof updateStatus === "function") {
      updateStatus("connected");
    }
  }
  renderWorkspaceSessionList();
  return Promise.resolve([]);
}

function queueWorkspaceSessionListRefresh({ clearCurrent = false } = {}) {
  if (clearCurrent) {
    queueWorkspaceSessionListReset({ clearCurrent: true });
  }
  if (visitorMode) return Promise.resolve([]);
  if (typeof fetchSessionsList !== "function") return Promise.resolve([]);
  return fetchSessionsList({ forceFresh: true }).then((nextSessions) => {
    if (
      typeof isArchiveSectionExpanded === "function"
      && isArchiveSectionExpanded()
      && typeof fetchArchivedSessions === "function"
      && archivedSessionCount > 0
    ) {
      return fetchArchivedSessions({ forceFresh: true }).then(() => nextSessions);
    }
    return nextSessions;
  }).catch((error) => {
    console.warn("[workspace] Failed to refresh workspace sessions:", error?.message || error);
    renderWorkspaceSessionList();
    return [];
  });
}

// --- Custom workspace browser UI ---
const workspaceCustomPicker = document.getElementById('workspaceCustomPicker');
const workspaceCustomFolderSelect = document.getElementById('workspaceCustomFolderSelect');
const workspaceBrowser = document.getElementById('workspaceBrowser');
const workspaceBrowserSelect = document.getElementById('workspaceBrowserSelect');
const workspaceBrowserPath = document.getElementById('workspaceBrowserPath');
const workspaceBrowserBack = document.getElementById('workspaceBrowserBack');
const workspaceBrowserForth = document.getElementById('workspaceBrowserForth');
const workspaceBrowserConfirm = document.getElementById('workspaceBrowserConfirm');
const emptyOpenSessionBtn = document.getElementById('emptyOpenSessionBtn');
const emptyCreateAgentBtn = document.getElementById('emptyCreateAgentBtn');

async function openWorkspaceBrowser(startPath) {
  if (!workspaceBrowser) return;
  workspaceBrowser.hidden = false;
  currentBrowsingPath = startPath || getDefaultWorkspaceFolder();
  pendingWorkspaceBrowserPath = currentBrowsingPath;
  await populateBrowserFor(currentBrowsingPath);
}

function closeWorkspaceBrowser() {
  if (!workspaceBrowser) return;
  workspaceBrowser.hidden = true;
  currentBrowsingPath = null;
  pendingWorkspaceBrowserPath = null;
}

async function populateBrowserFor(path) {
  if (!workspaceBrowserSelect || !workspaceBrowserPath) return;
  currentBrowsingPath = path || getDefaultWorkspaceFolder();
  pendingWorkspaceBrowserPath = currentBrowsingPath;
  workspaceBrowserPath.textContent = currentBrowsingPath;
  const json = await fetchChildren(currentBrowsingPath);
  workspaceBrowserSelect.innerHTML = '';
  // Add entries
  for (const child of json.children || []) {
    const opt = document.createElement('option');
    opt.value = child.path;
    opt.textContent = child.name || child.path;
    workspaceBrowserSelect.appendChild(opt);
  }
  // If no children, show a disabled placeholder
  if (!json.children || json.children.length === 0) {
    const ph = document.createElement('option');
    ph.textContent = t('sidebar.workspace.noChildren') || 'No subfolders';
    ph.disabled = true;
    workspaceBrowserSelect.appendChild(ph);
  }
}

if (workspaceBrowserSelect) {
  workspaceBrowserSelect.addEventListener('change', () => {
    pendingWorkspaceBrowserPath = workspaceBrowserSelect.value || currentBrowsingPath;
  });
}

if (workspaceBrowserBack) {
  workspaceBrowserBack.addEventListener('click', async () => {
    if (!currentBrowsingPath) return;
    // fetch parent by calling /api/browse on current and reading parent
    try {
      const json = await fetchChildren(currentBrowsingPath);
      const parent = json && json.parent ? json.parent : null;
      if (parent) {
        currentBrowsingPath = parent;
        await populateBrowserFor(currentBrowsingPath);
      } else {
        // already at root
        await populateBrowserFor(currentBrowsingPath);
      }
    } catch {
      // ignore
    }
  });
}

if (workspaceBrowserForth) {
  workspaceBrowserForth.addEventListener('click', async () => {
    const next = workspaceBrowserSelect?.value || pendingWorkspaceBrowserPath;
    if (!next) return;
    await populateBrowserFor(next);
  });
}

if (workspaceBrowserConfirm) {
  workspaceBrowserConfirm.addEventListener('click', () => {
    const confirmedPath = pendingWorkspaceBrowserPath || currentBrowsingPath;
    if (!confirmedPath) return;
    applyCustomWorkspaceSelection(confirmedPath, { persist: true });
    closeWorkspaceBrowser();
  });
}

currentWorkspaceMode = getStoredWorkspaceMode();
selectedCustomWorkspaceFolder = getStoredCustomWorkspaceFolder();
syncWorkspaceUi();

if (workspaceSelect) {
  workspaceSelect.addEventListener("change", async () => {
    applyWorkspaceMode(workspaceSelect.value);
    if (currentWorkspaceMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder) {
      await openWorkspaceBrowser(getDefaultWorkspaceFolder());
    }
  });
}

if (workspaceCustomFolderSelect) {
  workspaceCustomFolderSelect.addEventListener("change", async () => {
    if (!workspaceCustomFolderSelect.value) return;
    if (workspaceCustomFolderSelect.value === WORKSPACE_CUSTOM_BROWSE_SENTINEL) {
      await openWorkspaceBrowser(selectedCustomWorkspaceFolder || getDefaultWorkspaceFolder());
      syncCustomWorkspacePicker();
      return;
    }
    applyCustomWorkspaceSelection(workspaceCustomFolderSelect.value, { persist: true });
    closeWorkspaceBrowser();
  });
  workspaceCustomFolderSelect.addEventListener("focus", async () => {
    if (currentWorkspaceMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder) {
      await openWorkspaceBrowser(getDefaultWorkspaceFolder());
    }
  });
}

if (emptyOpenSessionBtn) {
  emptyOpenSessionBtn.addEventListener("click", () => {
    createNewSessionShortcut({
      closeSidebar: true,
      forceComposerFocus: true,
    });
  });
}

if (emptyCreateAgentBtn) {
  emptyCreateAgentBtn.addEventListener("click", () => {
    if (typeof createAgentBuilderSession === "function") {
      void createAgentBuilderSession().catch((error) => {
        console.warn("[workspace] Failed to create agent builder session:", error?.message || error);
      });
      return;
    }
    if (typeof switchTab === "function") {
      switchTab("agents");
      openSidebar();
    }
  });
}

window.remotelabGetSelectedSessionFolder = function remotelabGetSelectedSessionFolder() {
  return getSelectedWorkspaceFolder();
};
window.remotelabSetSelectedSessionFolder = function remotelabSetSelectedSessionFolder(folder) {
  persistWorkspaceMode(WORKSPACE_MODE_CUSTOM);
  return applyCustomWorkspaceSelection(folder, { persist: true });
};
window.remotelabGetSelectedWorkspaceMode = function remotelabGetSelectedWorkspaceMode() {
  return currentWorkspaceMode;
};
window.remotelabSessionMatchesSelectedWorkspace = function remotelabSessionMatchesSelectedWorkspace(session) {
  return isSessionInSelectedWorkspace(session);
};
window.remotelabRefreshWorkspaceSessions = function remotelabRefreshWorkspaceSessions() {
  return queueWorkspaceSessionListRefresh();
};

if (currentWorkspaceMode === WORKSPACE_MODE_CUSTOM && !selectedCustomWorkspaceFolder) {
  queueWorkspaceSessionListReset();
} else {
  queueWorkspaceSessionListRefresh();
}

function createSortSessionListShortcut() {
  return organizeSessionListWithAgent({ closeSidebar: false });
}

menuBtn.addEventListener("click", openSessionsSidebar);
closeSidebar.addEventListener("click", closeSidebarFn);
sidebarOverlay.addEventListener("click", (e) => {
  if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
});

// ---- Session search ----
if (sessionSearchInput) {
  let searchDebounceTimer = null;
  sessionSearchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      sessionSearchQuery = (sessionSearchInput.value || "").trim();
      renderSessionList();
    }, 120);
  });
  sessionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      sessionSearchInput.value = "";
      sessionSearchQuery = "";
      sessionSearchInput.blur();
      renderSessionList();
    }
  });
}

// ---- View mode switcher ----
function setSessionViewMode(mode) {
  sessionViewMode = mode === "projects" ? "projects" : "inbox";
  localStorage.setItem(SESSION_VIEW_MODE_STORAGE_KEY, sessionViewMode);
  if (viewInboxBtn) viewInboxBtn.classList.toggle("active", sessionViewMode === "inbox");
  if (viewProjectsBtn) viewProjectsBtn.classList.toggle("active", sessionViewMode === "projects");
  renderSessionList();
}

if (viewInboxBtn) {
  viewInboxBtn.classList.toggle("active", sessionViewMode === "inbox");
  viewInboxBtn.addEventListener("click", () => setSessionViewMode("inbox"));
}
if (viewProjectsBtn) {
  viewProjectsBtn.classList.toggle("active", sessionViewMode === "projects");
  viewProjectsBtn.addEventListener("click", () => setSessionViewMode("projects"));
}

// ---- Session list actions ----
sortSessionListBtn.addEventListener("click", () => {
  void createSortSessionListShortcut();
});

newSessionBtn.addEventListener("click", () => {
  createNewSessionShortcut();
});

// ---- Attachment handling ----
function createComposerAttachmentLocalId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cattach_${crypto.randomUUID()}`;
  }
  if (typeof createRequestId === "function") {
    return `cattach_${createRequestId()}`;
  }
  return `cattach_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildPendingAttachment(file) {
  const shouldTrackUpload = typeof shouldUseDirectComposerAssetUploads === "function"
    && shouldUseDirectComposerAssetUploads();
  return {
    localId: createComposerAttachmentLocalId(),
    file,
    originalName: typeof file?.name === "string" ? file.name : "",
    mimeType: file.type || "application/octet-stream",
    ...(Number.isFinite(file?.size) ? { sizeBytes: file.size } : {}),
    objectUrl: URL.createObjectURL(file),
    ...(shouldTrackUpload ? { uploadState: "queued" } : {}),
  };
}

async function addAttachmentFiles(files) {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return;
  }
  if (!currentSessionId) {
    return;
  }
  const pendingAttachments = Array.from(files || [], (file) => buildPendingAttachment(file));
  if (typeof addComposerAttachmentsState === "function") {
    addComposerAttachmentsState(
      pendingAttachments,
      { sessionId: currentSessionId },
    );
  }
  renderImagePreviews();
  const eagerUploadLocalIds = pendingAttachments
    .filter((attachment) => attachment?.uploadState === "queued")
    .map((attachment) => attachment?.localId)
    .filter((localId) => typeof localId === "string" && localId);
  if (typeof ensureComposerAttachmentUploads === "function" && eagerUploadLocalIds.length > 0) {
    void ensureComposerAttachmentUploads(currentSessionId, {
      localIds: eagerUploadLocalIds,
    }).catch(() => {});
  }
}

function getComposerAttachmentUploadMeta(attachment) {
  switch (attachment?.uploadState) {
    case "queued":
      return {
        badgeClassName: "is-queued",
        label: t("compose.attachment.queued"),
      };
    case "uploading":
      return {
        badgeClassName: "is-uploading",
        label: t("compose.attachment.uploading"),
      };
    case "uploaded":
      return {
        badgeClassName: "is-uploaded",
        label: t("compose.attachment.uploaded"),
      };
    case "failed":
      return {
        badgeClassName: "is-failed",
        label: t("compose.attachment.failed"),
        title: attachment?.uploadError || t("compose.attachment.failed"),
      };
    default:
      return null;
  }
}

function renderImagePreviews() {
  const pendingImages = currentSessionId && typeof getComposerAttachmentsState === "function"
    ? getComposerAttachmentsState(currentSessionId)
    : [];
  imgPreviewStrip.innerHTML = "";
  if (pendingImages.length === 0) {
    imgPreviewStrip.classList.remove("has-images");
    if (typeof requestLayoutPass === "function") {
      requestLayoutPass("composer-images");
    } else if (typeof syncInputHeightForLayout === "function") {
      syncInputHeightForLayout();
    }
    return;
  }
  imgPreviewStrip.classList.add("has-images");
  const attachmentsLocked = typeof hasPendingComposerSend === "function" && hasPendingComposerSend();
  pendingImages.forEach((img, i) => {
    const item = document.createElement("div");
    item.className = "img-preview-item";
    const previewNode = createComposerAttachmentPreviewNode(img);
    const uploadMeta = getComposerAttachmentUploadMeta(img);
    if (uploadMeta?.badgeClassName) {
      item.classList.add(uploadMeta.badgeClassName);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img";
    removeBtn.type = "button";
    removeBtn.title = t("action.removeAttachment");
    removeBtn.setAttribute("aria-label", t("action.removeAttachment"));
    removeBtn.innerHTML = renderUiIcon("close");
    removeBtn.disabled = attachmentsLocked;
    removeBtn.onclick = () => {
      if (attachmentsLocked) return;
      if (typeof cancelComposerAttachmentUpload === "function" && img?.localId) {
        cancelComposerAttachmentUpload(currentSessionId, img.localId);
      }
      if (img?.objectUrl) {
        URL.revokeObjectURL(img.objectUrl);
      }
      if (typeof removeComposerAttachmentState === "function") {
        removeComposerAttachmentState(i, { sessionId: currentSessionId });
      }
      renderImagePreviews();
    };
    if (previewNode) {
      item.appendChild(previewNode);
    }
    if (uploadMeta) {
      const statusBadge = document.createElement("div");
      statusBadge.className = `attachment-upload-badge ${uploadMeta.badgeClassName}`;
      statusBadge.textContent = uploadMeta.label;
      if (uploadMeta.title) {
        statusBadge.title = uploadMeta.title;
      }
      item.appendChild(statusBadge);
    }
    if (!attachmentsLocked && img?.uploadState === "failed" && img?.localId && typeof retryComposerAttachmentUpload === "function") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "retry-img-upload";
      retryBtn.type = "button";
      retryBtn.textContent = "↻";
      retryBtn.title = t("action.retryUpload");
      retryBtn.setAttribute("aria-label", t("action.retryUpload"));
      retryBtn.onclick = () => {
        void retryComposerAttachmentUpload(currentSessionId, img.localId).catch(() => {});
      };
      item.appendChild(retryBtn);
    }
    item.appendChild(removeBtn);
    imgPreviewStrip.appendChild(item);
  });
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("composer-images");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
}

imgBtn.addEventListener("click", () => {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return;
  }
  imgFileInput.click();
});
imgFileInput.addEventListener("change", () => {
  if (imgFileInput.files.length > 0) addAttachmentFiles(imgFileInput.files);
  imgFileInput.value = "";
});

msgInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const attachmentFiles = [];
  for (const item of items) {
    const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
    if (file) attachmentFiles.push(file);
  }
  if (attachmentFiles.length > 0) {
    e.preventDefault();
    addAttachmentFiles(attachmentFiles);
  }
});

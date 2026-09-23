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

function openApplicationNavigation() {
  openSidebar();
  return true;
}

function openSessionsSidebar() {
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  openSidebar();
  return true;
}

const DETACHED_COMPOSER_SESSION_ID = "__new_session_draft__";
let pendingNewSessionCreateOptions = null;

function getDraftRuntimeMode() {
  return pendingNewSessionCreateOptions?.runtimeMode === "custom" ? "custom" : "auto";
}

function isQuickSessionUi(session = typeof getCurrentSession === "function" ? getCurrentSession() : null) {
  return session?.executionProfile === "quick";
}

function getActiveRuntimeModeUi(session = typeof getCurrentSession === "function" ? getCurrentSession() : null) {
  if (!currentSessionId) return getDraftRuntimeMode();
  if (!session) return null;
  if (session.lastUserMessageAt || session.autoRouting) return null;
  return session.tool === "codex" && (!session.model || session.model === "auto") ? "auto" : "custom";
}

function syncQuickSessionUi(session = typeof getCurrentSession === "function" ? getCurrentSession() : null) {
  const attached = Boolean(currentSessionId && session);
  const quick = attached && isQuickSessionUi(session);
  const mode = getActiveRuntimeModeUi(session);
  const auto = mode === "auto";
  if (sessionProfileControl) sessionProfileControl.hidden = quick || mode === null;
  if (quickProfileBadge) quickProfileBadge.hidden = !attached || !quick;
  if (runtimeSelectionControls) runtimeSelectionControls.hidden = quick || auto;
  if (autoModeBtn) {
    autoModeBtn.classList.toggle("active", auto);
    autoModeBtn.setAttribute("aria-pressed", auto ? "true" : "false");
  }
  if (customModeBtn) {
    customModeBtn.classList.toggle("active", mode === "custom");
    customModeBtn.setAttribute("aria-pressed", mode === "custom" ? "true" : "false");
  }
}

function setDraftRuntimeMode(mode) {
  if (currentSessionId) return false;
  pendingNewSessionCreateOptions = {
    ...(pendingNewSessionCreateOptions || {}),
    ...(mode === "custom" ? { runtimeMode: "custom" } : {}),
  };
  if (mode !== "custom") delete pendingNewSessionCreateOptions.runtimeMode;
  if (typeof syncQuickSessionUi === "function") syncQuickSessionUi(null);
  if (mode === "custom" && typeof loadModelsForCurrentTool === "function") void loadModelsForCurrentTool();
  return true;
}

async function selectRuntimeMode(mode) {
  if (!currentSessionId) return setDraftRuntimeMode(mode);
  const session = typeof getCurrentSession === "function" ? getCurrentSession() : null;
  const currentMode = getActiveRuntimeModeUi(session);
  if (!session || isQuickSessionUi(session) || currentMode === null || currentMode === mode) return false;
  const auto = mode === "auto";
  const result = await dispatchAction({
    action: "session_preferences",
    sessionId: currentSessionId,
    tool: auto ? "codex" : session.tool || "codex",
    model: auto ? "auto" : session.model && session.model !== "auto" ? session.model : "gpt-6-sol",
    effort: auto ? "" : session.model && session.model !== "auto" ? session.effort || "low" : "low",
    thinking: auto ? false : session.thinking === true,
  });
  if (result !== false && typeof loadModelsForCurrentTool === "function") await loadModelsForCurrentTool();
  syncQuickSessionUi(typeof getCurrentSession === "function" ? getCurrentSession() : null);
  return result !== false;
}

function getActiveComposerSessionId() {
  if (currentSessionId) return currentSessionId;
  return DETACHED_COMPOSER_SESSION_ID;
}

function isNewSessionDraftActive() {
  return !currentSessionId && pendingNewSessionCreateOptions !== null;
}

function buildNewSessionCreateAction(options = pendingNewSessionCreateOptions || {}) {
  const quick = options?.executionProfile === "quick";
  const auto = !quick && options?.runtimeMode !== "custom";
  const tool = selectedTool || preferredTool || toolsList[0]?.id;
  const model = auto ? "auto" : selectedModel === "auto" ? "gpt-6-sol" : typeof selectedModel === "string" ? selectedModel : "";
  const effort = auto ? "" : selectedModel === "auto" ? "low" : typeof selectedEffort === "string" ? selectedEffort : "";
  if (!quick && !auto && !tool) return null;
  return {
    action: "create",
    folder: typeof window.remotelabGetDefaultSessionFolder === "function"
      ? window.remotelabGetDefaultSessionFolder()
      : "~",
    tool: quick || auto ? "codex" : tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    forceComposerFocus: true,
    ...(quick ? { executionProfile: "quick" } : {}),
    ...(!quick && model ? { model } : {}),
    ...(!quick && effort ? { effort } : {}),
    ...(options?.sourceContext && typeof options.sourceContext === "object"
      ? { sourceContext: options.sourceContext }
      : {}),
  };
}

async function materializeNewSessionShortcut() {
  const action = buildNewSessionCreateAction();
  if (!action) return false;
  const created = await dispatchAction(action);
  if (created && currentSessionId) {
    pendingNewSessionCreateOptions = null;
  }
  return created;
}

async function createNewSessionShortcut({
  closeSidebar = true,
  forceComposerFocus = true,
  sourceContext = null,
} = {}) {
  if (closeSidebar && !isDesktop) closeSidebarFn();
  if (!buildNewSessionCreateAction({ sourceContext })) return false;
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }

  const previousSessionId = currentSessionId;
  if (previousSessionId && typeof settleAttachedSessionSidebarState === "function") {
    Promise.resolve(settleAttachedSessionSidebarState({
      sessionId: previousSessionId,
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
  pendingNewSessionCreateOptions = {
    ...(sourceContext && typeof sourceContext === "object" ? { sourceContext } : {}),
  };
  if (typeof syncQuickSessionUi === "function") syncQuickSessionUi(null);
  if (Array.isArray(toolsList) && toolsList.some((tool) => tool.id === "codex")) {
    selectedTool = "codex";
    preferredTool = "codex";
    inlineToolSelect.value = "codex";
    await loadModelsForCurrentTool();
  }

  const detachedAttachments = typeof getComposerAttachmentsState === "function"
    ? getComposerAttachmentsState(DETACHED_COMPOSER_SESSION_ID)
    : [];
  if (typeof releaseImageObjectUrls === "function") {
    releaseImageObjectUrls(detachedAttachments);
  }
  if (typeof clearComposerSessionState === "function") {
    clearComposerSessionState(DETACHED_COMPOSER_SESSION_ID, {
      clearDraft: true,
      clearAttachments: true,
      clearPendingSend: true,
    });
  }
  localStorage.removeItem(`draft_${DETACHED_COMPOSER_SESSION_ID}`);

  if (typeof resetAttachedSessionRenderState === "function") {
    resetAttachedSessionRenderState();
  }
  if (typeof persistActiveSessionId === "function") {
    persistActiveSessionId(null);
  }
  if (typeof syncBrowserState === "function") {
    syncBrowserState({ sessionId: null, tab: "sessions" });
  }
  if (typeof showEmpty === "function") {
    showEmpty();
  }
  window.RemoteLabTranscriptViewport?.resetEntryAnchor?.({
    reason: "new-session-draft",
  });
  if (typeof renderHeaderSessionTitle === "function") {
    renderHeaderSessionTitle(t("session.newDraftName"));
  }
  if (typeof restoreDraft === "function") {
    restoreDraft();
  } else {
    msgInput.value = "";
  }
  if (typeof updateStatus === "function") {
    updateStatus("connected", null);
  }
  renderSessionList();
  if (typeof focusComposer === "function") {
    focusComposer({ force: forceComposerFocus === true, preventScroll: true });
  } else if (forceComposerFocus) {
    msgInput.focus();
  }
  return true;
}

function createSortSessionListShortcut() {
  return organizeSessionList({ closeSidebar: false });
}

menuBtn.addEventListener("click", openApplicationNavigation);
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

// ---- Session list actions ----
if (sortSessionListBtn) {
  sortSessionListBtn.addEventListener("click", () => {
    void createSortSessionListShortcut();
  });
}

async function handleNewSessionShortcutClick() {
  const created = await createNewSessionShortcut();
  if (created && typeof beginQuickEntryFocusRecovery === "function") {
    beginQuickEntryFocusRecovery();
  }
}

newSessionBtn.addEventListener("click", handleNewSessionShortcutClick);
headerNewSessionBtn?.addEventListener("click", handleNewSessionShortcutClick);

const shortcutPlatform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "");
if (newSessionShortcutHint) {
  newSessionShortcutHint.textContent = /Mac|iPhone|iPad/i.test(shortcutPlatform) ? "⌘O" : "Ctrl O";
}

document.addEventListener("keydown", (event) => {
  const modifierPressed = event.metaKey || event.ctrlKey;
  const isNewSessionShortcut = modifierPressed
    && !event.shiftKey
    && !event.altKey
    && String(event.key || "").toLowerCase() === "o";
  if (!isNewSessionShortcut || event.defaultPrevented || event.repeat || event.isComposing) return;
  if (document.body?.classList.contains("share-snapshot-mode") || newSessionBtn?.style.display === "none") return;
  event.preventDefault();
  void handleNewSessionShortcutClick();
});

autoModeBtn?.addEventListener("click", () => { void selectRuntimeMode("auto"); });
customModeBtn?.addEventListener("click", () => { void selectRuntimeMode("custom"); });

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
  const composerSessionId = getActiveComposerSessionId();
  if (!composerSessionId) {
    return;
  }
  const pendingAttachments = Array.from(files || [], (file) => buildPendingAttachment(file));
  if (!currentSessionId) {
    for (const attachment of pendingAttachments) {
      delete attachment.uploadState;
    }
  }
  if (typeof addComposerAttachmentsState === "function") {
    addComposerAttachmentsState(
      pendingAttachments,
      { sessionId: composerSessionId },
    );
  }
  renderImagePreviews();
  const eagerUploadLocalIds = pendingAttachments
    .filter((attachment) => attachment?.uploadState === "queued")
    .map((attachment) => attachment?.localId)
    .filter((localId) => typeof localId === "string" && localId);
  if (currentSessionId && typeof ensureComposerAttachmentUploads === "function" && eagerUploadLocalIds.length > 0) {
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
  const preserveBottomPin = window.RemoteLabLayout?.preserveBottomPinnedMessageViewport;
  const applyPreviewRender = () => {
    const composerSessionId = getActiveComposerSessionId();
    const pendingImages = composerSessionId && typeof getComposerAttachmentsState === "function"
      ? getComposerAttachmentsState(composerSessionId)
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
        if (currentSessionId && typeof cancelComposerAttachmentUpload === "function" && img?.localId) {
          cancelComposerAttachmentUpload(currentSessionId, img.localId);
        }
        if (img?.objectUrl) {
          URL.revokeObjectURL(img.objectUrl);
        }
        if (typeof removeComposerAttachmentState === "function") {
          removeComposerAttachmentState(i, { sessionId: composerSessionId });
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
          if (!currentSessionId) return;
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
  };

  if (typeof preserveBottomPin === "function") {
    preserveBottomPin(applyPreviewRender, { reason: "composer-images" });
    return;
  }
  applyPreviewRender();
}

function isAttachmentPickerBlocked() {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return true;
  }
  return !getActiveComposerSessionId() || imgFileInput?.disabled === true;
}

imgBtn.addEventListener("click", (event) => {
  if (isAttachmentPickerBlocked()) {
    event.preventDefault();
    return;
  }
  imgFileInput.click();
});
imgFileInput.addEventListener("click", (event) => {
  if (isAttachmentPickerBlocked()) {
    event.preventDefault();
  }
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

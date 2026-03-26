// ---- Send message ----
const fallbackStrings = {
  "compose.pending.uploading": "Uploading attachment\u2026",
  "compose.pending.sendingAttachment": "Sending attachment\u2026",
  "compose.pending.sending": "Sending\u2026",
};

function fallbackTranslate(key) {
  return fallbackStrings[key] || key;
}

function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : fallbackTranslate(key);
}

let pendingComposerSend = null;

function getComposerAssetUploadConfig() {
  return typeof getBootstrapAssetUploads === "function"
    ? getBootstrapAssetUploads()
    : { enabled: false, directUpload: false, provider: "" };
}

function shouldUseDirectComposerAssetUploads() {
  const config = getComposerAssetUploadConfig();
  return config.enabled === true
    && config.directUpload === true
    && typeof fetchJsonOrRedirect === "function";
}

async function uploadComposerAttachmentToAsset(sessionId, attachment) {
  const file = attachment?.file;
  if (!file || typeof file.arrayBuffer !== "function") {
    return attachment;
  }

  const intent = await fetchJsonOrRedirect("/api/assets/upload-intents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      originalName: attachment?.originalName || file.name || "attachment",
      mimeType: attachment?.mimeType || file.type || "application/octet-stream",
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
    }),
  });

  const asset = intent?.asset && typeof intent.asset === "object"
    ? intent.asset
    : null;
  const upload = intent?.upload && typeof intent.upload === "object"
    ? intent.upload
    : null;
  if (!asset?.id || !upload?.url) {
    throw new Error("Upload intent is incomplete");
  }

  const uploadResponse = await fetch(upload.url, {
    method: upload.method || "PUT",
    headers: upload.headers || {},
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Attachment upload failed (${uploadResponse.status})`);
  }

  const finalized = await fetchJsonOrRedirect(`/api/assets/${encodeURIComponent(asset.id)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sizeBytes: Number.isFinite(file.size) ? file.size : undefined,
      etag: uploadResponse.headers.get("etag") || "",
    }),
  });

  const finalizedAsset = finalized?.asset && typeof finalized.asset === "object"
    ? finalized.asset
    : asset;
  return {
    assetId: finalizedAsset.id,
    originalName: finalizedAsset.originalName || attachment?.originalName || file.name || "attachment",
    mimeType: finalizedAsset.mimeType || attachment?.mimeType || file.type || "application/octet-stream",
    ...(Number.isFinite(finalizedAsset?.sizeBytes) ? { sizeBytes: finalizedAsset.sizeBytes } : Number.isFinite(file.size) ? { sizeBytes: file.size } : {}),
    ...(attachment?.objectUrl ? { objectUrl: attachment.objectUrl } : {}),
  };
}

async function prepareComposerAttachmentsForSend(sessionId, attachments) {
  if (!shouldUseDirectComposerAssetUploads()) {
    return attachments;
  }

  const prepared = [];
  for (const attachment of attachments || []) {
    if (!(attachment && typeof attachment === "object")) continue;
    if (!attachment.file || typeof attachment.assetId === "string") {
      prepared.push(attachment);
      continue;
    }
    prepared.push(await uploadComposerAttachmentToAsset(sessionId, attachment));
  }
  return prepared;
}

function hasPendingComposerSend() {
  return !!pendingComposerSend;
}

function isComposerPendingForSession(sessionId = currentSessionId) {
  return !!pendingComposerSend && !!sessionId && pendingComposerSend.sessionId === sessionId;
}

function isComposerPendingForCurrentSession() {
  return isComposerPendingForSession(currentSessionId);
}

function syncComposerPendingUi() {
  const pendingForCurrentSession = isComposerPendingForCurrentSession();
  inputArea.classList.toggle("is-pending-send", pendingForCurrentSession);
  msgInput.readOnly = pendingForCurrentSession;

  if (!composerPendingState) {
    return;
  }
  if (!pendingForCurrentSession) {
    composerPendingState.textContent = "";
    composerPendingState.classList.remove("visible");
    return;
  }

  const hasAttachments = Array.isArray(pendingComposerSend?.images) && pendingComposerSend.images.length > 0;
  composerPendingState.textContent = pendingComposerSend?.stage === "uploading"
    ? t("compose.pending.uploading")
    : (hasAttachments && !pendingComposerSend?.text
      ? t("compose.pending.sendingAttachment")
      : t("compose.pending.sending"));
  composerPendingState.classList.add("visible");
}

function finalizeComposerPendingSend(requestId) {
  if (!pendingComposerSend) return false;
  if (requestId && pendingComposerSend.requestId !== requestId) return false;

  const completedSend = pendingComposerSend;
  pendingComposerSend = null;
  clearDraft(completedSend.sessionId);
  if (currentSessionId === completedSend.sessionId) {
    msgInput.value = "";
    autoResizeInput();
  }
  pendingImages = [];
  renderImagePreviews();
  releaseImageObjectUrls(completedSend.images);
  syncComposerPendingUi();
  return true;
}

function createEmptyComposerActivitySnapshot() {
  return {
    run: {
      state: "idle",
      phase: null,
      runId: null,
    },
    queue: {
      state: "idle",
      count: 0,
    },
  };
}

function getComposerSessionActivitySnapshot(session) {
  const raw = session?.activity || {};
  const queueCount = Number.isInteger(raw?.queue?.count) ? raw.queue.count : 0;
  return {
    run: {
      state: raw?.run?.state === "running" ? "running" : "idle",
      phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
      runId: typeof raw?.run?.runId === "string" ? raw.run.runId : null,
    },
    queue: {
      state: raw?.queue?.state === "queued" && queueCount > 0 ? "queued" : "idle",
      count: queueCount,
    },
  };
}

function hasCanonicalComposerSendAcceptance(session) {
  if (!pendingComposerSend) return false;
  if (!session?.id || session.id !== pendingComposerSend.sessionId) return false;

  const queuedMessages = Array.isArray(session.queuedMessages) ? session.queuedMessages : [];
  if (queuedMessages.some((item) => item?.requestId === pendingComposerSend.requestId)) {
    return true;
  }

  const previousActivity = pendingComposerSend.baselineActivity || createEmptyComposerActivitySnapshot();
  const nextActivity = getComposerSessionActivitySnapshot(session);

  if (
    nextActivity.queue.state === "queued"
    && nextActivity.queue.count > (previousActivity.queue?.count || 0)
  ) {
    return true;
  }

  if (previousActivity.run.state !== "running") {
    if (nextActivity.run.state === "running") return true;
    if (nextActivity.run.phase === "accepted" || nextActivity.run.phase === "running") return true;
    if (nextActivity.run.runId && nextActivity.run.runId !== (previousActivity.run?.runId || null)) {
      return true;
    }
  }

  return false;
}

function reconcileComposerPendingSendWithSession(session) {
  if (!pendingComposerSend) return false;
  if (!session?.id || session.id !== pendingComposerSend.sessionId) return false;
  if (!hasCanonicalComposerSendAcceptance(session)) return false;
  return finalizeComposerPendingSend(pendingComposerSend.requestId);
}

function reconcileComposerPendingSendWithEvent(event) {
  if (!pendingComposerSend) return false;
  if (event?.type !== "message" || event.role !== "user") return false;
  if (!event.requestId || event.requestId !== pendingComposerSend.requestId) return false;
  return finalizeComposerPendingSend(event.requestId);
}

function getDraftStorageKey(sessionId = currentSessionId) {
  if (!sessionId) return "";
  return `draft_${sessionId}`;
}

function readStoredDraft(sessionId = currentSessionId) {
  const key = getDraftStorageKey(sessionId);
  if (!key) return "";
  return localStorage.getItem(key) || "";
}

function writeStoredDraft(sessionId = currentSessionId, text = "") {
  const key = getDraftStorageKey(sessionId);
  if (!key) return;
  if (text) {
    localStorage.setItem(key, text);
    return;
  }
  localStorage.removeItem(key);
}

function getComposerDraftText(sessionId = currentSessionId) {
  if (!sessionId) return "";
  if (isComposerPendingForSession(sessionId)) {
    return pendingComposerSend?.text || "";
  }
  return readStoredDraft(sessionId);
}

function sendMessage(existingRequestId) {
  if (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) return;
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  if (hasPendingComposerSend()) return;
  if ((!text && pendingImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  const requestId = existingRequestId || createRequestId();
  const sessionId = currentSessionId;
  const queuedImages = pendingImages.slice();
  const sendTool = selectedTool;
  const sendModel = selectedModel;
  const sendReasoningKind = currentToolReasoningKind;
  const sendEffort = selectedEffort;
  const sendThinking = thinkingEnabled === true;

  pendingComposerSend = {
    sessionId,
    requestId,
    text,
    images: queuedImages,
    baselineActivity: getComposerSessionActivitySnapshot(currentSession),
    stage: "sending",
  };
  clearDraft(sessionId);
  syncComposerPendingUi();
  autoResizeInput();

  void (async () => {
    let outboundText = text;
    let outboundImages = queuedImages;
    try {
      if (queuedImages.length > 0) {
        pendingComposerSend.stage = "uploading";
        syncComposerPendingUi();
        outboundImages = await prepareComposerAttachmentsForSend(sessionId, queuedImages);
        if (!(pendingComposerSend && pendingComposerSend.requestId === requestId)) return;
        pendingComposerSend.images = outboundImages.slice();
        pendingComposerSend.stage = "sending";
        syncComposerPendingUi();
      }

      const msg = {
        action: "send",
        sessionId,
        text: outboundText || "(attachment)",
      };
      msg.requestId = requestId;
      if (!visitorMode) {
        if (sendTool) msg.tool = sendTool;
        if (sendModel) msg.model = sendModel;
        if (sendReasoningKind === "enum") {
          if (sendEffort) msg.effort = sendEffort;
        } else if (sendReasoningKind === "toggle") {
          msg.thinking = sendThinking;
        }
      }
      if (outboundImages.length > 0) {
        msg.images = outboundImages.map((img) => ({
          ...(img.file ? { file: img.file } : {}),
          ...(img.filename ? { filename: img.filename } : {}),
          ...(img.assetId ? { assetId: img.assetId } : {}),
          ...(img.originalName ? { originalName: img.originalName } : {}),
          ...(img.mimeType ? { mimeType: img.mimeType } : {}),
          ...(Number.isFinite(img?.sizeBytes) ? { sizeBytes: img.sizeBytes } : {}),
          ...(img?.renderAs === "file" ? { renderAs: "file" } : {}),
          ...(img.objectUrl ? { objectUrl: img.objectUrl } : {}),
        }));
      }
      const ok = await dispatchAction(msg);
      if (ok) return;
    } catch (error) {
      console.error("Composer send failed:", error?.message || error);
    }

    const failedText = pendingComposerSend?.requestId === requestId
      ? (pendingComposerSend.text || outboundText || text)
      : (outboundText || text);
    restoreFailedSendState(sessionId, failedText, outboundImages, requestId);
  })();
}

cancelBtn.addEventListener("click", () => dispatchAction({ action: "cancel" }));

compactBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "compact" });
});

dropToolsBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "drop_tools" });
});

sendBtn.addEventListener("click", sendMessage);
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// ---- Composer height ----
const INPUT_MIN_LINES = 3;
const INPUT_AUTO_MAX_LINES = 10;
const INPUT_MANUAL_MIN_H = 100;
const INPUT_MAX_VIEWPORT_RATIO = 0.72;
const INPUT_HEIGHT_STORAGE_KEY = "msgInputHeight";
const LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY = "inputAreaHeight";

let isResizingInput = false;
let resizeStartY = 0;
let resizeStartInputH = 0;

function getInputLineHeight() {
  return parseFloat(getComputedStyle(msgInput).lineHeight) || 24;
}

function getAutoInputMinH() {
  return getInputLineHeight() * INPUT_MIN_LINES;
}

function getAutoInputMaxH() {
  return getInputLineHeight() * INPUT_AUTO_MAX_LINES;
}

function getInputChromeH() {
  if (!inputArea?.getBoundingClientRect || !msgInput?.getBoundingClientRect) {
    return 0;
  }
  const areaH = inputArea.getBoundingClientRect().height || 0;
  const inputH = msgInput.getBoundingClientRect().height || 0;
  return Math.max(0, areaH - inputH);
}

function getViewportHeight() {
  const managedViewportHeight = window.RemoteLabLayout?.getViewportHeight?.();
  if (Number.isFinite(managedViewportHeight) && managedViewportHeight > 0) {
    return managedViewportHeight;
  }
  const visualHeight = window.visualViewport?.height;
  if (Number.isFinite(visualHeight) && visualHeight > 0) {
    return visualHeight;
  }
  return window.innerHeight || 0;
}

function getManualInputMaxH() {
  const viewportMax = Math.floor(getViewportHeight() * INPUT_MAX_VIEWPORT_RATIO);
  return Math.max(INPUT_MANUAL_MIN_H, viewportMax - getInputChromeH());
}

function clampInputHeight(height, { manual = false } = {}) {
  const minH = getAutoInputMinH();
  const maxH = manual
    ? Math.max(minH, getManualInputMaxH())
    : Math.max(minH, getAutoInputMaxH());
  return Math.min(Math.max(height, minH), maxH);
}

function isManualInputHeightActive() {
  return inputArea.classList.contains("is-resized");
}

function setManualInputHeight(height, { persist = true } = {}) {
  const newH = clampInputHeight(height, { manual: true });
  msgInput.style.height = newH + "px";
  inputArea.classList.add("is-resized");
  if (persist) {
    localStorage.setItem(INPUT_HEIGHT_STORAGE_KEY, String(newH));
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }
  return newH;
}

function autoResizeInput() {
  if (isManualInputHeightActive()) return;
  msgInput.style.height = "auto";
  const newH = clampInputHeight(msgInput.scrollHeight);
  msgInput.style.height = newH + "px";
}

function restoreSavedInputHeight() {
  const savedInputH = localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY);
  if (savedInputH) {
    const height = parseInt(savedInputH, 10);
    if (Number.isFinite(height) && height > 0) {
      setManualInputHeight(height, { persist: false });
      return;
    }
    localStorage.removeItem(INPUT_HEIGHT_STORAGE_KEY);
  }

  const legacyInputAreaH = localStorage.getItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  if (legacyInputAreaH) {
    const legacyHeight = parseInt(legacyInputAreaH, 10);
    if (Number.isFinite(legacyHeight) && legacyHeight > 0) {
      const migratedHeight = Math.max(
        getAutoInputMinH(),
        legacyHeight - getInputChromeH(),
      );
      setManualInputHeight(migratedHeight);
      return;
    }
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }

  autoResizeInput();
}

function syncInputHeightForLayout() {
  if (!isManualInputHeightActive()) {
    autoResizeInput();
    return;
  }

  const currentHeight = parseFloat(msgInput.style.height);
  if (Number.isFinite(currentHeight) && currentHeight > 0) {
    setManualInputHeight(currentHeight, { persist: false });
    return;
  }

  const savedInputH = parseInt(
    localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY) || "",
    10,
  );
  if (Number.isFinite(savedInputH) && savedInputH > 0) {
    setManualInputHeight(savedInputH, { persist: false });
    return;
  }

  inputArea.classList.remove("is-resized");
  autoResizeInput();
}

function onInputResizeStart(e) {
  isResizingInput = true;
  resizeStartY = e.touches ? e.touches[0].clientY : e.clientY;
  resizeStartInputH = msgInput.getBoundingClientRect().height || getAutoInputMinH();
  document.addEventListener("mousemove", onInputResizeMove);
  document.addEventListener("touchmove", onInputResizeMove, { passive: false });
  document.addEventListener("mouseup", onInputResizeEnd);
  document.addEventListener("touchend", onInputResizeEnd);
  e.preventDefault();
}

function onInputResizeMove(e) {
  if (!isResizingInput) return;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const dy = resizeStartY - clientY;
  setManualInputHeight(resizeStartInputH + dy);
  e.preventDefault();
}

function onInputResizeEnd() {
  isResizingInput = false;
  document.removeEventListener("mousemove", onInputResizeMove);
  document.removeEventListener("touchmove", onInputResizeMove);
  document.removeEventListener("mouseup", onInputResizeEnd);
  document.removeEventListener("touchend", onInputResizeEnd);
}

if (inputResizeHandle) {
  inputResizeHandle.addEventListener("mousedown", onInputResizeStart);
  inputResizeHandle.addEventListener("touchstart", onInputResizeStart, { passive: false });
}

if (window.RemoteLabLayout?.subscribe) {
  window.RemoteLabLayout.subscribe(() => {
    syncInputHeightForLayout();
  });
} else {
  window.addEventListener("resize", syncInputHeightForLayout);
  window.visualViewport?.addEventListener("resize", syncInputHeightForLayout);
}

// ---- Draft persistence ----
function saveDraft() {
  if (!currentSessionId || isComposerPendingForCurrentSession()) return;
  writeStoredDraft(currentSessionId, msgInput.value);
}
function restoreDraft() {
  msgInput.value = getComposerDraftText(currentSessionId);
  autoResizeInput();
  syncComposerPendingUi();
}
function clearDraft(sessionId = currentSessionId) {
  writeStoredDraft(sessionId, "");
}

msgInput.addEventListener("input", () => {
  autoResizeInput();
  saveDraft();
});
// Set initial height
requestAnimationFrame(() => restoreSavedInputHeight());

function releaseImageObjectUrls(images = []) {
  for (const image of images) {
    if (image?.objectUrl) {
      URL.revokeObjectURL(image.objectUrl);
    }
  }
}

function restoreFailedSendState(sessionId, text, images, requestId = "") {
  if (pendingComposerSend && (!requestId || pendingComposerSend.requestId === requestId)) {
    pendingComposerSend = null;
  }
  writeStoredDraft(sessionId, text || "");
  syncComposerPendingUi();
  if (sessionId !== currentSessionId) {
    return;
  }

  if (!msgInput.value.trim() && text) {
    msgInput.value = text;
    autoResizeInput();
    saveDraft();
  }

  if (pendingImages.length === 0 && images.length > 0) {
    pendingImages = images;
    renderImagePreviews();
  }

  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else {
    msgInput.focus();
  }
}

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "settings"

function switchTab(tab, { syncState = true } = {}) {
  activeTab = normalizeSidebarTab(tab);
  const showingSessions = activeTab === "sessions";
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabSettings.classList.toggle("active", activeTab === "settings");
  if (typeof syncSidebarFiltersVisibility === "function") {
    syncSidebarFiltersVisibility(showingSessions);
  } else if (sidebarFilters) {
    sidebarFilters.classList.toggle("hidden", !showingSessions);
  }
  sessionList.style.display = showingSessions ? "" : "none";
  settingsPanel.classList.toggle("visible", activeTab === "settings");
  sessionListFooter.classList.toggle("hidden", activeTab === "settings");
  sortSessionListBtn.classList.toggle("hidden", activeTab === "settings");
  newSessionBtn.classList.toggle("hidden", activeTab === "settings");
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabSettings.addEventListener("click", () => switchTab("settings"));

switchTab(activeTab, { syncState: false });

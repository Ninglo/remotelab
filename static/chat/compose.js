// ---- Send message ----
function sendMessage(existingRequestId) {
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  if ((!text && pendingImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  const requestId = existingRequestId || createRequestId();
  const sessionId = currentSessionId;
  const queuedImages = pendingImages.slice();

  renderOptimisticMessage(text, queuedImages, Date.now());

  const msg = { action: "send", text: text || "(attachment)" };
  msg.requestId = requestId;
  if (!visitorMode) {
    if (selectedTool) msg.tool = selectedTool;
    if (selectedModel) msg.model = selectedModel;
    if (currentToolReasoningKind === "enum") {
      if (selectedEffort) msg.effort = selectedEffort;
    } else if (currentToolReasoningKind === "toggle") {
      msg.thinking = thinkingEnabled;
    }
  }
  if (queuedImages.length > 0) {
    msg.images = queuedImages.map((img) => ({
      file: img.file,
      originalName: img.originalName,
      mimeType: img.mimeType,
      objectUrl: img.objectUrl,
    }));
  }
  msgInput.value = "";
  clearDraft();
  pendingImages = [];
  renderImagePreviews();
  autoResizeInput();
  void dispatchAction(msg).then((ok) => {
    if (ok) {
      clearOptimisticMessage();
      releaseImageObjectUrls(queuedImages);
      return;
    }
    restoreFailedSendState(sessionId, text, queuedImages);
  });
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
  if (!currentSessionId) return;
  if (msgInput.value) {
    localStorage.setItem(`draft_${currentSessionId}`, msgInput.value);
    return;
  }
  localStorage.removeItem(`draft_${currentSessionId}`);
}
function restoreDraft() {
  const draft = currentSessionId
    ? localStorage.getItem(`draft_${currentSessionId}`)
    : "";
  msgInput.value = draft ?? "";
  autoResizeInput();
}
function clearDraft() {
  if (!currentSessionId) return;
  localStorage.removeItem(`draft_${currentSessionId}`);
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

function restoreFailedSendState(sessionId, text, images) {
  clearOptimisticMessage();
  if (sessionId !== currentSessionId) {
    releaseImageObjectUrls(images);
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
  } else {
    releaseImageObjectUrls(images);
  }

  if (typeof focusComposer === "function") {
    focusComposer({ force: true, preventScroll: true });
  } else {
    msgInput.focus();
  }
}

function renderOptimisticMessage(text, images, timestamp = Date.now()) {
  if (emptyState.parentNode === messagesInner) emptyState.remove();
  // Remove any previous optimistic message
  clearOptimisticMessage();

  const wrap = document.createElement("div");
  wrap.className = "msg-user";
  wrap.id = "optimistic-msg";
  const bubble = document.createElement("div");
  bubble.className = "msg-user-bubble msg-pending";

  if (images && images.length > 0) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "msg-images";
    for (const img of images) {
      const attachmentNode = typeof createMessageAttachmentNode === "function"
        ? createMessageAttachmentNode(img)
        : null;
      if (!attachmentNode) continue;
      imgWrap.appendChild(attachmentNode);
    }
    bubble.appendChild(imgWrap);
  }

  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    bubble.appendChild(span);
  }

  appendMessageTimestamp(bubble, timestamp, "msg-user-time");

  wrap.appendChild(bubble);
  messagesInner.appendChild(wrap);
  scrollToBottom();
}

function clearOptimisticMessage() {
  const prev = document.getElementById("optimistic-msg");
  if (prev) prev.remove();
}

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "board" | "settings"

function switchTab(tab, { syncState = true } = {}) {
  activeTab = normalizeSidebarTab(tab);
  const showingSessions = activeTab === "sessions";
  const showingBoard = activeTab === "board";
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabBoard?.classList.toggle("active", activeTab === "board");
  tabSettings.classList.toggle("active", activeTab === "settings");
  if (typeof syncSidebarFiltersVisibility === "function") {
    syncSidebarFiltersVisibility(showingSessions);
  } else if (sidebarFilters) {
    sidebarFilters.classList.toggle("hidden", !showingSessions);
  }
  sessionList.style.display = showingSessions ? "" : "none";
  boardPanel?.classList.toggle("visible", showingBoard);
  settingsPanel.classList.toggle("visible", activeTab === "settings");
  document.body.classList.toggle("board-tab-active", showingBoard);
  sessionListFooter.classList.toggle("hidden", activeTab === "settings");
  newAppBtn.classList.toggle("hidden", activeTab === "settings");
  newSessionBtn.classList.toggle("hidden", activeTab === "settings");
  if (activeTab === "settings" && !visitorMode && typeof fetchAppsList === "function") {
    void fetchAppsList().catch((error) => {
      console.warn("[apps] Failed to refresh apps for settings:", error.message);
    });
    if (typeof fetchVisitorsList === "function") {
      void fetchVisitorsList().catch((error) => {
        console.warn("[visitors] Failed to refresh visitors for settings:", error.message);
      });
    }
  }
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabBoard?.addEventListener("click", () => switchTab("board"));
tabSettings.addEventListener("click", () => switchTab("settings"));
switchTab(activeTab, { syncState: false });

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
  const preferredAgentId = typeof getPreferredAgentTemplateId === "function"
    ? getPreferredAgentTemplateId()
    : "";
  const preferredAgentName = typeof getPreferredAgentTemplateName === "function"
    ? getPreferredAgentTemplateName()
    : "";
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  return dispatchAction({
    action: "create",
    folder: typeof window.remotelabGetDefaultSessionFolder === "function"
      ? window.remotelabGetDefaultSessionFolder()
      : "~",
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    templateId: preferredAgentId,
    templateName: preferredAgentName,
    ...(forceComposerFocus ? { forceComposerFocus: true } : {}),
    ...(sourceContext && typeof sourceContext === "object" ? { sourceContext } : {}),
  });
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

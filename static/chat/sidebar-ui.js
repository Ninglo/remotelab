// ---- Sidebar ----
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

function createNewSessionShortcut({ closeSidebar = true } = {}) {
  const principal = resolveSelectedSessionPrincipal();
  const appId = resolveAppIdForPrincipal(principal, activeSessionAppFilter);
  const app = getAppRecordById(appId);
  if (!app) return false;
  return createSessionForApp(app, { closeSidebar, principal });
}

function createNewAppShortcut({ closeSidebar = true } = {}) {
  return focusNewAppComposer({ closeSidebar });
}

menuBtn.addEventListener("click", openSidebar);
closeSidebar.addEventListener("click", closeSidebarFn);
sidebarOverlay.addEventListener("click", (e) => {
  if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
});

// ---- New Session ----
newAppBtn.addEventListener("click", () => {
  createNewAppShortcut();
});

newSessionBtn.addEventListener("click", () => {
  createNewSessionShortcut();
});

createUserBtn?.addEventListener("click", () => {
  void handleCreateUser();
});

newUserNameInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void handleCreateUser();
});

createAppConfigBtn?.addEventListener("click", () => {
  void handleCreateApp();
});

// ---- Attachment handling ----
function buildPendingAttachment(file) {
  return {
    file,
    originalName: typeof file?.name === "string" ? file.name : "",
    mimeType: file.type || "application/octet-stream",
    objectUrl: URL.createObjectURL(file),
  };
}

async function addAttachmentFiles(files) {
  if (typeof hasPendingComposerSend === "function" && hasPendingComposerSend()) {
    return;
  }
  for (const file of files) {
    if (pendingImages.length >= 4) break;
    pendingImages.push(buildPendingAttachment(file));
  }
  renderImagePreviews();
}

function renderImagePreviews() {
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
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img";
    removeBtn.type = "button";
    removeBtn.title = "Remove attachment";
    removeBtn.setAttribute("aria-label", "Remove attachment");
    removeBtn.innerHTML = renderUiIcon("close");
    removeBtn.disabled = attachmentsLocked;
    removeBtn.onclick = () => {
      if (attachmentsLocked) return;
      URL.revokeObjectURL(img.objectUrl);
      pendingImages.splice(i, 1);
      renderImagePreviews();
    };
    if (previewNode) {
      item.appendChild(previewNode);
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

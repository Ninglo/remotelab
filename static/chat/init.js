// ---- System toast notifications ----
function showSystemToast(message, level = "info") {
  const container = document.getElementById("system-toast-container")
    || (() => {
      const el = document.createElement("div");
      el.id = "system-toast-container";
      el.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:90vw;";
      document.body.appendChild(el);
      return el;
    })();
  const toast = document.createElement("div");
  const bgColor = level === "error" ? "#d32f2f" : level === "warn" ? "#ed6c02" : "#1976d2";
  toast.style.cssText = `background:${bgColor};color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;line-height:1.4;box-shadow:0 2px 12px rgba(0,0,0,.25);pointer-events:auto;cursor:pointer;max-width:100%;word-break:break-word;opacity:0;transition:opacity .2s;`;
  toast.textContent = message;
  toast.onclick = () => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 200); };
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 200); }, level === "error" ? 8000 : 5000);
}

// ---- Visitor mode setup ----
function applyVisitorMode(authInfo = null) {
  visitorMode = true;
  scopedRequestMode = false;
  surfaceMode = "visitor";
  principalKind = "visitor";
  principalId = typeof authInfo?.principalId === "string" && authInfo.principalId.trim()
    ? authInfo.principalId.trim()
    : (typeof authInfo?.visitorId === "string" ? authInfo.visitorId.trim() : "");
  authCapabilities = cloneAuthCapabilityDefaults("visitor");
  scopedAgentContext = null;
  if (typeof authInfo?.sessionId === "string" && authInfo.sessionId.trim()) {
    visitorSessionId = authInfo.sessionId.trim();
  }
  selectedTool = null;
  selectedModel = null;
  selectedEffort = null;
  document.body.classList.add("visitor-mode");
  // Hide sidebar toggle, new session button, and management UI
  if (menuBtn) menuBtn.style.display = "none";
  if (sortSessionListBtn) sortSessionListBtn.style.display = "none";
  if (newSessionBtn) newSessionBtn.style.display = "none";
  // Hide tool/model selectors and context management (visitors use defaults)
  if (inlineAgentSelect) inlineAgentSelect.style.display = "none";
  if (inlineToolSelect) inlineToolSelect.style.display = "none";
  if (inlineModelSelect) inlineModelSelect.style.display = "none";
  if (effortSelect) effortSelect.style.display = "none";
  if (thinkingToggle) thinkingToggle.style.display = "none";
  if (compactBtn) compactBtn.style.display = "none";
  if (dropToolsBtn) dropToolsBtn.style.display = "none";
  if (contextTokens) contextTokens.style.display = "none";
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("visitor-mode");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
  syncForkButton();
  syncShareButton();
}

function applyAgentScopedMode(authInfo = null) {
  visitorMode = false;
  scopedRequestMode = true;
  surfaceMode = "agent_scoped";
  principalKind = typeof authInfo?.principalKind === "string" && authInfo.principalKind.trim()
    ? authInfo.principalKind.trim()
    : "agent_guest";
  principalId = typeof authInfo?.principalId === "string" && authInfo.principalId.trim()
    ? authInfo.principalId.trim()
    : (typeof authInfo?.visitorId === "string" ? authInfo.visitorId.trim() : "");
  authCapabilities = authInfo?.capabilities && typeof authInfo.capabilities === "object"
    ? { ...authInfo.capabilities }
    : cloneAuthCapabilityDefaults("agent_scoped");
  scopedAgentContext = authInfo?.currentAgent && typeof authInfo.currentAgent === "object"
    ? {
      id: typeof authInfo.currentAgent.id === "string" ? authInfo.currentAgent.id.trim() : "",
      name: typeof authInfo.currentAgent.name === "string" ? authInfo.currentAgent.name.trim() : "",
      tool: typeof authInfo.currentAgent.tool === "string" ? authInfo.currentAgent.tool.trim() : "",
    }
    : {
      id: typeof authInfo?.agentId === "string" ? authInfo.agentId.trim() : "",
      name: "",
      tool: "",
    };
  document.body.classList.remove("visitor-mode");
  document.body.classList.add("agent-scoped-mode");

  if (scopedAgentContext?.id && typeof setPreferredAgentTemplate === "function") {
    setPreferredAgentTemplate(scopedAgentContext.id, {
      name: scopedAgentContext.name || "",
      persist: false,
    });
  }

  if (scopedAgentContext?.tool) {
    preferredTool = scopedAgentContext.tool;
    selectedTool = scopedAgentContext.tool;
    selectedModel = "";
    selectedEffort = null;
  }

  if (menuBtn) menuBtn.style.display = "";
  if (newSessionBtn) newSessionBtn.style.display = hasAuthCapability("createSession") ? "" : "none";
  if (sortSessionListBtn) sortSessionListBtn.style.display = canOrganizeSessionList() ? "" : "none";
  if (tabAgents) tabAgents.style.display = "none";
  if (agentsPanel) agentsPanel.style.display = "none";
  if (inlineAgentSelect) inlineAgentSelect.style.display = canSwitchAgents() ? "" : "none";
  if (inlineToolSelect) inlineToolSelect.style.display = canChangeRuntimeSelection() ? "" : "none";
  if (inlineModelSelect) inlineModelSelect.style.display = canChangeRuntimeSelection() ? inlineModelSelect.style.display : "none";
  if (effortSelect) effortSelect.style.display = canChangeRuntimeSelection() ? effortSelect.style.display : "none";
  if (thinkingToggle) thinkingToggle.style.display = canChangeRuntimeSelection() ? thinkingToggle.style.display : "none";
  if (compactBtn) compactBtn.style.display = "none";
  if (dropToolsBtn) dropToolsBtn.style.display = "none";
  if (contextTokens) contextTokens.style.display = "none";
  if (saveTemplateBtn) saveTemplateBtn.style.display = "none";
  if (sessionTemplateRow) sessionTemplateRow.style.display = "none";
  if ((typeof getActiveSidebarTabValue === "function" ? getActiveSidebarTabValue() : null) === "agents" && typeof switchTab === "function") {
    switchTab("sessions");
  }
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("agent-scoped-mode");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
  syncForkButton();
  syncShareButton();
}

function applyShareSnapshotMode(snapshot) {
  shareSnapshotMode = true;
  shareSnapshotPayload = snapshot;
  applyVisitorMode();
  document.body.classList.add("share-snapshot-mode");
  if (statusText) {
    statusText.dataset.i18n = "status.readOnlySnapshot";
    statusText.textContent = t("status.readOnlySnapshot");
  }
  if (msgInput) {
    msgInput.dataset.i18nPlaceholder = "input.placeholder.readOnlySnapshot";
    msgInput.placeholder = t("input.placeholder.readOnlySnapshot");
  }
}

// ---- Init ----
initResponsiveLayout();

const MOBILE_INSTALL_SKIP_STORAGE_KEY = "remotelab.mobileInstall.skipUntil";
const MOBILE_INSTALL_SKIP_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isMobileInstallEligibleDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android/i.test(ua);
}

function isStandaloneDisplayMode() {
  return !!(
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
    || navigator.standalone === true
  );
}

function captureInstallSkipIntent() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("skipInstall") !== "1") return;
  try {
    localStorage.setItem(
      MOBILE_INSTALL_SKIP_STORAGE_KEY,
      String(Date.now() + MOBILE_INSTALL_SKIP_DURATION_MS),
    );
  } catch {}
  url.searchParams.delete("skipInstall");
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function hasRecentInstallSkip() {
  try {
    const until = Number(localStorage.getItem(MOBILE_INSTALL_SKIP_STORAGE_KEY) || 0);
    if (!Number.isFinite(until) || until <= 0) return false;
    if (until <= Date.now()) {
      localStorage.removeItem(MOBILE_INSTALL_SKIP_STORAGE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function shouldOpenMobileInstallFlow(authInfo) {
  const pathname = String(window.location?.pathname || "");
  return !!(
    authInfo
    && authInfo.role === "owner"
    && !visitorMode
    && !shareSnapshotMode
    && isMobileInstallEligibleDevice()
    && !isStandaloneDisplayMode()
    && !pathname.endsWith("/m/install")
    && !hasRecentInstallSkip()
  );
}

async function resolveInitialAuthInfo() {
  const bootstrapAuthInfo =
    typeof getBootstrapAuthInfo === "function"
      ? getBootstrapAuthInfo()
      : null;
  if (bootstrapAuthInfo) {
    return bootstrapAuthInfo;
  }
  try {
    return await fetchJsonOrRedirect("/api/auth/me");
  } catch {
    return null;
  }
}

async function initApp() {
  captureInstallSkipIntent();

  const shareSnapshot =
    typeof getBootstrapShareSnapshot === "function"
      ? getBootstrapShareSnapshot()
      : null;
  if (shareSnapshot) {
    applyShareSnapshotMode(shareSnapshot);
    syncAddToolModal();
    syncForkButton();
    syncShareButton();
    await bootstrapShareSnapshotView();
    return;
  }

  const authInfo = await resolveInitialAuthInfo();

  const url = new URL(window.location.href);
  if (url.searchParams.has("visitor")) {
    url.searchParams.delete("visitor");
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  if (authInfo?.surfaceMode === "agent_scoped") {
    applyAgentScopedMode(authInfo);
  } else if (authInfo?.role === "visitor") {
    applyVisitorMode(authInfo);
  }

  syncAddToolModal();
  syncForkButton();
  syncShareButton();
  if (visitorMode) {
    await bootstrapViaHttp();
    connect();
    setupForegroundRefreshHandlers();
    return;
  }

  if (shouldOpenMobileInstallFlow(authInfo)) {
    const installUrl = typeof window.remotelabResolveProductPath === "function"
      ? window.remotelabResolveProductPath("/m/install?source=auto")
      : "m/install?source=auto";
    window.location.replace(installUrl);
    return;
  }

  if (typeof ensureServiceWorkerRegistration === "function") {
    void ensureServiceWorkerRegistration();
  }

  initializePushNotifications({
    prompt: typeof shouldPromptForInstalledNotifications === "function"
      ? shouldPromptForInstalledNotifications()
      : false,
  });

  if (isAgentScopedMode()) {
    const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
    let toolsPromise = Promise.resolve();
    if (canChangeRuntimeSelection()) {
      toolsPromise = loadInlineTools({ skipModelLoad: true });
    }
    await Promise.all([toolsPromise, sessionsPromise]);
    restoreOwnerSessionSelection();
    connect();
    setupForegroundRefreshHandlers();
    if (canChangeRuntimeSelection()) {
      void loadModelsForCurrentTool();
    }
    void handleShareTargetData();
    return;
  }

  const toolsPromise = loadInlineTools({ skipModelLoad: true });
  const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
  await Promise.all([toolsPromise, sessionsPromise]);
  restoreOwnerSessionSelection();
  connect();
  setupForegroundRefreshHandlers();
  void loadModelsForCurrentTool();

  // Handle incoming share target data (Web Share Target API)
  void handleShareTargetData();
}

async function handleShareTargetData() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("share")) return;
  url.searchParams.delete("share");
  history.replaceState(null, "", `${url.pathname}${url.search}`);

  let cache;
  try {
    cache = await caches.open("remotelab-share-target");
    const response = await cache.match("/share-target-data");
    if (!response) return;
    const shareData = await response.json();
    await cache.delete("/share-target-data");

    // Build text from shared fields
    let text = "";
    if (shareData.title) text += shareData.title + "\n\n";
    if (shareData.text) text += shareData.text;
    if (shareData.url) {
      if (text) text += "\n\n";
      text += shareData.url;
    }
    text = text.trim();

    // Restore shared files from cache
    const sharedFiles = [];
    if (Array.isArray(shareData.files)) {
      for (const fileInfo of shareData.files) {
        try {
          const fileResp = await cache.match(fileInfo.cacheKey);
          if (!fileResp) continue;
          const blob = await fileResp.blob();
          sharedFiles.push(new File([blob], fileInfo.name, { type: fileInfo.type }));
          await cache.delete(fileInfo.cacheKey);
        } catch {}
      }
    }

    if (!text && sharedFiles.length === 0) return;

    // Create a new session for the shared content
    await createNewSessionShortcut({ closeSidebar: true });

    // Persist shared text as a stored draft so restoreDraft() preserves it
    // (attachSession calls restoreDraft asynchronously which would clear direct DOM writes)
    if (text && currentSessionId) {
      if (typeof writeStoredDraft === "function") {
        writeStoredDraft(currentSessionId, text);
      }
      if (typeof msgInput !== "undefined" && msgInput) {
        msgInput.value = text;
        if (typeof autoResizeInput === "function") autoResizeInput();
      }
    }

    // Add shared files as composer attachments
    if (sharedFiles.length > 0 && typeof addAttachmentFiles === "function") {
      await addAttachmentFiles(sharedFiles);
    }

    if (typeof msgInput !== "undefined" && msgInput) {
      msgInput.focus();
    }
  } catch (err) {
    console.warn("[share-target] Failed to process shared data:", err);
  }
}

initApp();

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
const QUICK_ENTRY_FOCUS_PROMPT_DELAY_MS = 420;
const QUICK_ENTRY_FOCUS_RETRY_DELAY_MS = 160;
let pendingInstallPromptEvent = null;
let quickEntryFocusPromptTimer = 0;
let quickEntryFocusRetryTimer = 0;
let quickEntryFocusLayoutUnsubscribe = null;

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

function getInstallFlowState() {
  return {
    promptReady: !!pendingInstallPromptEvent,
    standalone: isStandaloneDisplayMode(),
    mobileEligible: isMobileInstallEligibleDevice(),
    path: String(window.location?.pathname || ""),
  };
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

async function openInstallFlow({ source = "manual", replace = false } = {}) {
  const state = getInstallFlowState();

  if (state.standalone) {
    showSystemToast("RemoteLab is already running as an installed app.");
    return false;
  }

  if (pendingInstallPromptEvent) {
    const promptEvent = pendingInstallPromptEvent;
    pendingInstallPromptEvent = null;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice.catch(() => null);
      return true;
    } catch {}
  }

  if (typeof ensureServiceWorkerRegistration === "function") {
    await ensureServiceWorkerRegistration();
  }

  const installUrl = typeof window.remotelabResolveProductPath === "function"
    ? window.remotelabResolveProductPath(`/m/install?source=${encodeURIComponent(source)}`)
    : `m/install?source=${encodeURIComponent(source)}`;
  if (replace) {
    window.location.replace(installUrl);
  } else {
    window.location.assign(installUrl);
  }
  return true;
}

window.remotelabGetInstallFlowState = getInstallFlowState;
window.remotelabOpenInstallFlow = openInstallFlow;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  pendingInstallPromptEvent = event;
});

function getQuickEntryFocusPromptEls() {
  return {
    prompt: document.getElementById("quickEntryFocusPrompt"),
    button: document.getElementById("quickEntryFocusBtn"),
  };
}

function clearQuickEntryFocusTimers() {
  if (quickEntryFocusPromptTimer) {
    clearTimeout(quickEntryFocusPromptTimer);
    quickEntryFocusPromptTimer = 0;
  }
  if (quickEntryFocusRetryTimer) {
    clearTimeout(quickEntryFocusRetryTimer);
    quickEntryFocusRetryTimer = 0;
  }
}

function clearQuickEntryFocusRecovery() {
  clearQuickEntryFocusTimers();
  if (typeof quickEntryFocusLayoutUnsubscribe === "function") {
    quickEntryFocusLayoutUnsubscribe();
  }
  quickEntryFocusLayoutUnsubscribe = null;
  const { prompt } = getQuickEntryFocusPromptEls();
  if (prompt) {
    prompt.hidden = true;
  }
}

function getQuickEntryLayoutState() {
  if (window.RemoteLabLayout?.syncNow) {
    return window.RemoteLabLayout.syncNow("quick-entry-focus-check");
  }
  if (window.RemoteLabLayout?.getState) {
    return window.RemoteLabLayout.getState();
  }
  return {
    isDesktop: typeof isDesktop === "boolean" ? isDesktop : false,
    keyboardOpen: document.body?.classList?.contains("keyboard-open") === true,
  };
}

function canAttemptQuickEntryComposerFocus() {
  if (visitorMode || shareSnapshotMode || !msgInput || msgInput.disabled) {
    return false;
  }
  const layoutState = getQuickEntryLayoutState();
  return !layoutState?.isDesktop;
}

function shouldShowQuickEntryFocusPrompt() {
  if (!canAttemptQuickEntryComposerFocus()) {
    return false;
  }
  const layoutState = getQuickEntryLayoutState();
  if (layoutState?.keyboardOpen) {
    return false;
  }
  return !(typeof msgInput.value === "string" && msgInput.value.trim());
}

function attemptQuickEntryComposerFocus() {
  if (!msgInput || msgInput.disabled) {
    return false;
  }
  let focused = false;
  if (typeof focusComposer === "function") {
    focused = focusComposer({ force: true, preventScroll: true }) === true;
  } else if (typeof msgInput.focus === "function") {
    try {
      msgInput.focus({ preventScroll: true });
    } catch {
      msgInput.focus();
    }
    focused = true;
  }
  if (focused && typeof msgInput.setSelectionRange === "function") {
    const cursor = typeof msgInput.value === "string" ? msgInput.value.length : 0;
    try {
      msgInput.setSelectionRange(cursor, cursor);
    } catch {}
  }
  if (focused && navigator.virtualKeyboard?.show) {
    try {
      navigator.virtualKeyboard.show();
    } catch {}
  }
  return focused;
}

function syncQuickEntryFocusPromptVisibility() {
  const { prompt } = getQuickEntryFocusPromptEls();
  if (!prompt) {
    return false;
  }
  const shouldShow = shouldShowQuickEntryFocusPrompt();
  prompt.hidden = !shouldShow;
  return shouldShow;
}

function beginQuickEntryFocusRecovery() {
  clearQuickEntryFocusRecovery();
  if (!canAttemptQuickEntryComposerFocus()) {
    return false;
  }
  attemptQuickEntryComposerFocus();
  if (window.RemoteLabLayout?.subscribe) {
    quickEntryFocusLayoutUnsubscribe = window.RemoteLabLayout.subscribe((state) => {
      if (state?.keyboardOpen) {
        clearQuickEntryFocusRecovery();
      }
    });
  }
  const { prompt } = getQuickEntryFocusPromptEls();
  if (!prompt) {
    return true;
  }
  if (!shouldShowQuickEntryFocusPrompt()) {
    return true;
  }
  quickEntryFocusPromptTimer = setTimeout(() => {
    quickEntryFocusPromptTimer = 0;
    if (!syncQuickEntryFocusPromptVisibility()) {
      clearQuickEntryFocusRecovery();
    }
  }, QUICK_ENTRY_FOCUS_PROMPT_DELAY_MS);
  return true;
}

function wireQuickEntryFocusPrompt() {
  const { button } = getQuickEntryFocusPromptEls();
  if (button && !button.dataset.bound) {
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      attemptQuickEntryComposerFocus();
      quickEntryFocusRetryTimer = setTimeout(() => {
        quickEntryFocusRetryTimer = 0;
        if (!syncQuickEntryFocusPromptVisibility()) {
          clearQuickEntryFocusRecovery();
        }
      }, QUICK_ENTRY_FOCUS_RETRY_DELAY_MS);
    });
  }
  if (msgInput && !msgInput.dataset.quickEntryFocusBound) {
    msgInput.dataset.quickEntryFocusBound = "1";
    msgInput.addEventListener("input", () => {
      clearQuickEntryFocusRecovery();
    });
  }
}

function consumeLaunchIntent() {
  const url = new URL(window.location.href);
  const intent = (url.searchParams.get("intent") || "").trim().toLowerCase();
  if (intent !== "new-session") {
    return null;
  }
  url.searchParams.delete("intent");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return {
    type: "new-session",
  };
}

function prepareOwnerLaunchIntentBootstrap(launchIntent) {
  if (!launchIntent || launchIntent.type !== "new-session" || visitorMode) {
    return;
  }
  pendingNavigationState = null;
  if (typeof setChatCurrentSession === "function") {
    setChatCurrentSession(null, { hasAttachedSession: false });
  } else {
    currentSessionId = null;
    hasAttachedSession = false;
  }
}

async function handleOwnerLaunchIntent(launchIntent) {
  if (!launchIntent || launchIntent.type !== "new-session") {
    return false;
  }
  const created = await createNewSessionShortcut({
    closeSidebar: true,
    forceComposerFocus: true,
    sourceContext: {
      channel: "pwa_shortcut",
      entrypoint: "manifest_shortcut",
      shortcutId: "new_session",
      launchIntent: "new_session",
    },
  });
  if (created) {
    beginQuickEntryFocusRecovery();
  }
  return created;
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
  wireQuickEntryFocusPrompt();

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
    await openInstallFlow({ source: "auto", replace: true });
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

  const launchIntent = authInfo?.role === "owner" && !isAgentScopedMode()
    ? consumeLaunchIntent()
    : null;
  if (launchIntent) {
    prepareOwnerLaunchIntentBootstrap(launchIntent);
  }

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
  const launchHandled = launchIntent
    ? await handleOwnerLaunchIntent(launchIntent)
    : false;
  if (!launchHandled) {
    restoreOwnerSessionSelection();
  }
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

    beginQuickEntryFocusRecovery();
  } catch (err) {
    console.warn("[share-target] Failed to process shared data:", err);
  }
}

initApp();

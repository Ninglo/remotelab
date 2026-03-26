// ---- Visitor mode setup ----
function applyVisitorMode() {
  visitorMode = true;
  selectedTool = null;
  selectedModel = null;
  selectedEffort = null;
  document.body.classList.add("visitor-mode");
  // Hide sidebar toggle, new session button, and management UI
  if (menuBtn) menuBtn.style.display = "none";
  if (sortSessionListBtn) sortSessionListBtn.style.display = "none";
  if (newSessionBtn) newSessionBtn.style.display = "none";
  // Hide tool/model selectors and context management (visitors use defaults)
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

function applyShareSnapshotMode(snapshot) {
  shareSnapshotMode = true;
  shareSnapshotPayload = snapshot;
  applyVisitorMode();
  document.body.classList.add("share-snapshot-mode");
  if (statusText) statusText.textContent = "read-only snapshot";
}

// ---- Init ----
initResponsiveLayout();

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
  if (authInfo?.role === "visitor" && authInfo.sessionId) {
    visitorSessionId = authInfo.sessionId;
    applyVisitorMode();
  }

  const url = new URL(window.location.href);
  if (url.searchParams.has("visitor")) {
    url.searchParams.delete("visitor");
    history.replaceState(null, "", `${url.pathname}${url.search}`);
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

  initializePushNotifications();

  const toolsPromise = loadInlineTools({ skipModelLoad: true });
  const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
  await Promise.all([toolsPromise, sessionsPromise]);
  restoreOwnerSessionSelection();
  connect();
  setupForegroundRefreshHandlers();
  void loadModelsForCurrentTool();
}

initApp();

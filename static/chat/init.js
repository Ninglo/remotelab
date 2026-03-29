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
  const opsPanelBtn = document.getElementById("opsPanelBtn");
  if (opsPanelBtn) opsPanelBtn.style.display = "none";
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
  if (window.RemoteLabOpsPanel && typeof window.RemoteLabOpsPanel.syncVisibilityForMode === "function") {
    window.RemoteLabOpsPanel.syncVisibilityForMode();
  }
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

  const toolsPromise = loadInlineTools({ skipModelLoad: true });
  const sessionsPromise = bootstrapViaHttp({ deferOwnerRestore: true });
  await Promise.all([toolsPromise, sessionsPromise]);
  restoreOwnerSessionSelection();
  connect();
  setupForegroundRefreshHandlers();
  void loadModelsForCurrentTool();
}

initApp();

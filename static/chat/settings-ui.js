function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

const CREATE_AGENT_TEMPLATE_ID = "app_create_app";
const HIDDEN_MANAGED_AGENT_IDS = new Set([
  "email",
  "app_welcome",
  "app_basic_chat",
  CREATE_AGENT_TEMPLATE_ID,
]);
let managedAppsCache = [];
let managedAppsLoaded = false;

function canManageAgentsFromUi() {
  return typeof canManageAgents === "function"
    ? canManageAgents()
    : !visitorMode;
}

function isAgentScopedModeFromUi() {
  return typeof isAgentScopedMode === "function"
    ? isAgentScopedMode()
    : false;
}

function showSettingsAgentsMessage(message) {
  if (!settingsAgentsList) return;
  settingsAgentsList.innerHTML = `<div class="settings-app-empty">${message}</div>`;
}

function resolveSettingsAppKind(app) {
  return app?.builtin
    ? t("settings.apps.kind.builtin")
    : t("settings.apps.kind.custom");
}

function describeSettingsApp(app) {
  if (!app?.id) return "";
  if (app.id === "chat") {
    return t("settings.apps.label.defaultConversation");
  }
  if (app.builtin) {
    return t("settings.apps.label.builtinAgent");
  }
  return t("settings.apps.label.customAgent");
}

function shouldShowManagedApp(app) {
  if (!app?.id) return false;
  return !HIDDEN_MANAGED_AGENT_IDS.has(app.id);
}

function sortManagedApps(apps = []) {
  return [...apps].sort((left, right) => {
    if (left?.id === "chat") return -1;
    if (right?.id === "chat") return 1;
    if (left?.builtin && !right?.builtin) return -1;
    if (!left?.builtin && right?.builtin) return 1;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
}

async function fetchManagedApps() {
  if (visitorMode || !canManageAgentsFromUi()) return [];
  const data = typeof fetchJsonOrRedirect === "function"
    ? await fetchJsonOrRedirect("/api/agents")
    : await fetch("/api/agents").then((response) => response.json());
  const apps = Array.isArray(data?.agents) ? data.agents : [];
  managedAppsCache = apps;
  managedAppsLoaded = true;
  return apps;
}

function buildManagedAgentShareUrl(app) {
  const shareToken = typeof app?.shareToken === "string" ? app.shareToken.trim() : "";
  if (!shareToken) return "";
  if (typeof window.remotelabResolveProductUrl === "function") {
    return window.remotelabResolveProductUrl(`/agent/${encodeURIComponent(shareToken)}`);
  }
  return new URL(`/agent/${encodeURIComponent(shareToken)}`, window.location.origin).toString();
}

async function copyManagedAgentShareLink(app) {
  const shareUrl = buildManagedAgentShareUrl(app);
  if (!shareUrl) {
    throw new Error(t("settings.apps.shareUnavailable"));
  }
  if (typeof copyText === "function") {
    await copyText(shareUrl);
    return shareUrl;
  }
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(shareUrl);
    return shareUrl;
  }
  throw new Error(t("settings.apps.shareFailed"));
}

function temporarilyUpdateButtonLabel(button, label, {
  resetLabel = "",
  durationMs = 1600,
  keepDisabled = false,
} = {}) {
  if (!button) return;
  const previousLabel = resetLabel || button.textContent || "";
  button.textContent = label;
  button.disabled = keepDisabled;
  window.setTimeout(() => {
    button.textContent = previousLabel;
    button.disabled = false;
  }, durationMs);
}

function findManagedAppById(appId) {
  return Array.isArray(managedAppsCache)
    ? managedAppsCache.find((app) => app?.id === appId) || null
    : null;
}

async function openManagedAppSession(app, { rememberPreference = true } = {}) {
  const tool = typeof app?.tool === "string" && app.tool.trim()
    ? app.tool.trim()
    : (preferredTool || selectedTool || toolsList[0]?.id || "");
  if (!tool || typeof dispatchAction !== "function") {
    throw new Error(t("settings.apps.openFailed"));
  }
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  if (typeof closeSidebarFn === "function" && !isDesktop) {
    closeSidebarFn();
  }
  if (rememberPreference && typeof setPreferredAgentTemplate === "function") {
    setPreferredAgentTemplate(app.id || "", { name: app.name || "" });
  }
  await dispatchAction({
    action: "create",
    folder: "~",
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_WEB_SOURCE_NAME,
    templateId: app.id || "",
    templateName: app.name || "",
  });
}

async function deleteManagedApp(app) {
  if (!app?.id || app.builtin) return;
  const confirmed = typeof window.confirm !== "function"
    ? true
    : window.confirm(t("settings.apps.deleteConfirm", {
      name: app.name || t("settings.apps.untitled"),
    }));
  if (!confirmed) return;
  if (typeof fetchJsonOrRedirect === "function") {
    await fetchJsonOrRedirect(`/api/agents/${encodeURIComponent(app.id)}`, {
      method: "DELETE",
    });
  } else {
    const response = await fetch(`/api/agents/${encodeURIComponent(app.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(t("settings.apps.deleteFailed"));
    }
  }
  await renderSettingsAgentsPanel({ force: true });
}

function buildManagedAppCard(app) {
  const card = document.createElement("div");
  card.className = "settings-app-card";

  const header = document.createElement("div");
  header.className = "settings-app-card-header";

  const name = document.createElement("div");
  name.className = "settings-app-name";
  name.textContent = app?.name || t("settings.apps.untitled");
  header.appendChild(name);

  const kind = document.createElement("div");
  kind.className = "settings-app-kind";
  kind.textContent = resolveSettingsAppKind(app);
  header.appendChild(kind);
  card.appendChild(header);

  const description = document.createElement("div");
  description.className = "settings-app-description";
  description.textContent = describeSettingsApp(app);
  card.appendChild(description);

  const meta = document.createElement("div");
  meta.className = "settings-app-meta";
  meta.textContent = t("settings.apps.meta.defaultTool", {
    tool: app?.tool || t("settings.apps.toolNotSet"),
  });
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "settings-app-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "settings-app-btn";
  openBtn.textContent = t("settings.apps.openSession");
  openBtn.addEventListener("click", async () => {
    openBtn.disabled = true;
    try {
      await openManagedAppSession(app);
    } catch (error) {
      openBtn.disabled = false;
      showSettingsAgentsMessage(error?.message || t("settings.apps.openFailed"));
    }
  });
  actions.appendChild(openBtn);

  if (!app?.builtin) {
    if (typeof app?.shareToken === "string" && app.shareToken.trim()) {
      const shareBtn = document.createElement("button");
      shareBtn.type = "button";
      shareBtn.className = "settings-app-btn";
      shareBtn.textContent = t("settings.apps.copyLink");
      shareBtn.addEventListener("click", async () => {
        const defaultLabel = t("settings.apps.copyLink");
        shareBtn.disabled = true;
        try {
          await copyManagedAgentShareLink(app);
          temporarilyUpdateButtonLabel(shareBtn, t("action.copied"), {
            resetLabel: defaultLabel,
            keepDisabled: true,
          });
        } catch (error) {
          console.warn("[agents] Failed to copy share link:", error?.message || error);
          temporarilyUpdateButtonLabel(shareBtn, t("settings.apps.shareFailed"), {
            resetLabel: defaultLabel,
            keepDisabled: true,
          });
        }
      });
      actions.appendChild(shareBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-app-btn";
    deleteBtn.textContent = t("settings.apps.delete");
    deleteBtn.addEventListener("click", async () => {
      deleteBtn.disabled = true;
      try {
        await deleteManagedApp(app);
      } catch (error) {
        deleteBtn.disabled = false;
        showSettingsAgentsMessage(error?.message || t("settings.apps.deleteFailed"));
      }
    });
    actions.appendChild(deleteBtn);
  }

  card.appendChild(actions);
  return card;
}

async function renderSettingsAgentsPanel({ force = false } = {}) {
  if (!settingsAgentsList) return;
  if (visitorMode || !canManageAgentsFromUi()) {
    settingsAgentsList.innerHTML = `<div class="settings-app-empty">${t("settings.apps.ownerOnly")}</div>`;
    if (createAgentBtn) createAgentBtn.disabled = true;
    return;
  }

  if (createAgentBtn) {
    createAgentBtn.disabled = false;
  }

  if (force || !managedAppsLoaded) {
    settingsAgentsList.innerHTML = `<div class="settings-app-empty">${t("settings.apps.loading")}</div>`;
    try {
      await fetchManagedApps();
      if (typeof refreshInlineAgentPicker === "function") {
        void refreshInlineAgentPicker({ force: true });
      }
    } catch (error) {
      settingsAgentsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.apps.loadingFailed")}</div>`;
      return;
    }
  }

  const visibleApps = sortManagedApps(managedAppsCache.filter((app) => shouldShowManagedApp(app)));
  settingsAgentsList.innerHTML = "";
  if (visibleApps.length === 0) {
    settingsAgentsList.innerHTML = `<div class="settings-app-empty">${t("settings.apps.none")}</div>`;
    return;
  }
  for (const app of visibleApps) {
    settingsAgentsList.appendChild(buildManagedAppCard(app));
  }
}

async function createAgentBuilderSession() {
  if (createAgentBtn) {
    createAgentBtn.disabled = true;
  }
  try {
    if (!managedAppsLoaded) {
      await fetchManagedApps();
    }
    const builderApp = findManagedAppById(CREATE_AGENT_TEMPLATE_ID);
    if (!builderApp) {
      throw new Error(t("settings.apps.builderMissing"));
    }
    await openManagedAppSession(builderApp, { rememberPreference: false });
  } finally {
    if (createAgentBtn) {
      createAgentBtn.disabled = false;
    }
  }
}

function renderUiLanguageOptions(selectEl, selectedValue = "auto") {
  if (!selectEl) return;
  const options = typeof window.remotelabGetUiLanguageOptions === "function"
    ? window.remotelabGetUiLanguageOptions()
    : [
      { value: "auto", label: t("settings.language.optionAuto") },
      { value: "zh-CN", label: t("settings.language.optionZhCN") },
      { value: "en", label: t("settings.language.optionEn") },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "auto";
}

function syncUiLanguageSelect() {
  renderUiLanguageOptions(
    uiLanguageSelect,
    typeof window.remotelabGetUiLanguagePreference === "function"
      ? window.remotelabGetUiLanguagePreference()
      : "auto",
  );
}

function initUiLanguageSettings() {
  if (!uiLanguageSelect) {
    return;
  }
  syncUiLanguageSelect();
  if (uiLanguageSelect.dataset.bound === "true") {
    return;
  }
  uiLanguageSelect.addEventListener("change", () => {
    const value = uiLanguageSelect.value || "auto";
    if (typeof window.remotelabSetUiLanguagePreference === "function") {
      window.remotelabSetUiLanguagePreference(value, { reload: true });
    }
  });
  uiLanguageSelect.dataset.bound = "true";
}

function renderThemeOptions(selectEl, selectedValue = "system") {
  if (!selectEl) return;
  const options = typeof window.remotelabGetThemeOptions === "function"
    ? window.remotelabGetThemeOptions()
    : [
      { value: "system", label: t("settings.theme.optionSystem") },
      { value: "amber", label: t("settings.theme.optionAmber") },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "system";
}

function syncThemeSelect() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  if (!uiThemeSelect) return;
  const currentPreference = typeof window.remotelabGetThemePreference === "function"
    ? window.remotelabGetThemePreference()
    : "system";
  renderThemeOptions(uiThemeSelect, currentPreference);
}

function initThemeSettings() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  if (!uiThemeSelect) {
    return;
  }
  syncThemeSelect();
  if (uiThemeSelect.dataset.bound === "true") {
    return;
  }
  uiThemeSelect.addEventListener("change", () => {
    const value = uiThemeSelect.value || "system";
    if (typeof window.remotelabSetThemePreference === "function") {
      window.remotelabSetThemePreference(value);
    }
    syncThemeSelect();
  });
  uiThemeSelect.dataset.bound = "true";
}

function renderThinkingBlockDisplayOptions(selectEl, selectedValue = "collapsed") {
  if (!selectEl) return;
  const options = typeof window.remotelabGetThinkingBlockDisplayOptions === "function"
    ? window.remotelabGetThinkingBlockDisplayOptions()
    : [
      { value: "expanded", label: t("settings.thinkingBlocks.optionExpanded") },
      { value: "collapsed", label: t("settings.thinkingBlocks.optionCollapsed") },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "collapsed";
}

function syncThinkingBlockDisplaySelect() {
  if (!thinkingBlockDisplaySelect) return;
  const currentMode = typeof window.remotelabGetThinkingBlockDisplayMode === "function"
    ? window.remotelabGetThinkingBlockDisplayMode()
    : "collapsed";
  renderThinkingBlockDisplayOptions(thinkingBlockDisplaySelect, currentMode);
}

function initThinkingBlockDisplaySettings() {
  if (!thinkingBlockDisplaySelect) {
    return;
  }
  syncThinkingBlockDisplaySelect();
  if (thinkingBlockDisplaySelect.dataset.bound === "true") {
    return;
  }
  thinkingBlockDisplaySelect.addEventListener("change", () => {
    const value = thinkingBlockDisplaySelect.value || "collapsed";
    if (typeof window.remotelabSetThinkingBlockDisplayMode === "function") {
      window.remotelabSetThinkingBlockDisplayMode(value);
    }
    syncThinkingBlockDisplaySelect();
  });
  thinkingBlockDisplaySelect.dataset.bound = "true";
}

function formatInstallDiagnosticEntry(entry) {
  const timestamp = typeof entry?.ts === "string" ? entry.ts : "";
  const eventName = typeof entry?.event === "string" ? entry.event : "unknown";
  const details = entry?.details && typeof entry.details === "object"
    ? Object.entries(entry.details)
      .filter(([, value]) => value !== "" && value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" · ")
    : "";
  return {
    timestamp,
    text: details ? `${eventName} · ${details}` : eventName,
  };
}

function renderInstallSettingsPanel() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  const clearBtn = document.getElementById("settingsInstallLogClearBtn");
  const statusEl = document.getElementById("settingsInstallStatus");
  const logEl = document.getElementById("settingsInstallLog");
  if (!installBtn || !clearBtn || !statusEl || !logEl) return;

  const state = typeof window.remotelabGetInstallFlowState === "function"
    ? window.remotelabGetInstallFlowState()
    : { promptReady: false, standalone: false, mobileEligible: false };
  const entries = typeof window.remotelabGetInstallDiagnostics === "function"
    ? window.remotelabGetInstallDiagnostics()
    : [];

  installBtn.disabled = visitorMode;
  installBtn.textContent = state.promptReady
    ? t("settings.install.promptReady")
    : t("settings.install.open");

  if (state.standalone) {
    statusEl.textContent = t("settings.install.statusStandalone");
  } else if (state.promptReady) {
    statusEl.textContent = t("settings.install.statusPromptReady");
  } else if (state.mobileEligible) {
    statusEl.textContent = t("settings.install.statusFallback");
  } else {
    statusEl.textContent = t("settings.install.statusDesktop");
  }
  statusEl.hidden = false;

  logEl.innerHTML = "";
  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-install-log-empty";
    empty.textContent = t("settings.install.logEmpty");
    logEl.appendChild(empty);
    return;
  }

  for (const entry of [...entries].reverse()) {
    const row = document.createElement("div");
    row.className = "settings-install-log-entry";
    const time = document.createElement("time");
    const formatted = formatInstallDiagnosticEntry(entry);
    time.textContent = formatted.timestamp ? formatted.timestamp.slice(11, 19) : "--:--:--";
    row.appendChild(time);
    row.appendChild(document.createTextNode(formatted.text));
    logEl.appendChild(row);
  }
}

function initInstallSettings() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  const clearBtn = document.getElementById("settingsInstallLogClearBtn");
  if (!installBtn || !clearBtn) return;

  renderInstallSettingsPanel();

  if (installBtn.dataset.bound !== "true") {
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      try {
        if (typeof window.remotelabOpenInstallFlow === "function") {
          await window.remotelabOpenInstallFlow({ source: "settings_button" });
        }
      } finally {
        installBtn.disabled = false;
        renderInstallSettingsPanel();
      }
    });
    installBtn.dataset.bound = "true";
  }

  if (clearBtn.dataset.bound !== "true") {
    clearBtn.addEventListener("click", () => {
      if (typeof window.remotelabClearInstallDiagnostics === "function") {
        window.remotelabClearInstallDiagnostics();
      }
      renderInstallSettingsPanel();
    });
    clearBtn.dataset.bound = "true";
  }
}

function resolveManagedSessionEntryMode(session) {
  return session?.entryMode === "read" ? "read" : "resume";
}

function renderManagedSessionEntryModeOptions(selectEl, selectedValue = "resume") {
  if (!selectEl) return;
  const options = [
    { value: "resume", label: t("settings.sessionPresentation.entryMode.resume") },
    { value: "read", label: t("settings.sessionPresentation.entryMode.read") },
  ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "resume";
}

function getManagedSettingsSession() {
  if (visitorMode || isAgentScopedModeFromUi()) return null;
  if (typeof getCurrentSession === "function") {
    return getCurrentSession();
  }
  return Array.isArray(sessions)
    ? sessions.find((session) => session?.id === currentSessionId) || null
    : null;
}

function renderSettingsSessionPresentationPanel() {
  if (!settingsSessionPresentationList) return;
  if (visitorMode || isAgentScopedModeFromUi()) {
    settingsSessionPresentationList.innerHTML = `<div class="settings-app-empty">${t("settings.sessionPresentation.ownerOnly")}</div>`;
    return;
  }
  const session = getManagedSettingsSession();
  settingsSessionPresentationList.innerHTML = "";
  if (!session?.id) {
    settingsSessionPresentationList.innerHTML = `<div class="settings-app-empty">${t("settings.sessionPresentation.noSession")}</div>`;
    return;
  }

  const card = document.createElement("div");
  card.className = "settings-app-card";

  const header = document.createElement("div");
  header.className = "settings-app-card-header";

  const name = document.createElement("div");
  name.className = "settings-app-name";
  name.textContent = typeof getSessionDisplayName === "function"
    ? getSessionDisplayName(session)
    : (session.name || t("session.defaultName"));
  header.appendChild(name);

  const kind = document.createElement("div");
  kind.className = "settings-app-kind";
  kind.textContent = t("settings.sessionPresentation.currentSession");
  header.appendChild(kind);
  card.appendChild(header);

  const modeSelect = document.createElement("select");
  modeSelect.className = "settings-inline-select";
  modeSelect.setAttribute("aria-label", t("settings.sessionPresentation.entryModeAriaLabel"));

  let currentEntryMode = resolveManagedSessionEntryMode(session);
  renderManagedSessionEntryModeOptions(modeSelect, currentEntryMode);

  const editor = document.createElement("div");
  editor.className = "settings-app-editor";
  editor.appendChild(modeSelect);

  const inlineStatus = document.createElement("div");
  inlineStatus.className = "settings-app-empty inline-status";
  inlineStatus.hidden = true;
  editor.appendChild(inlineStatus);

  modeSelect.addEventListener("change", async () => {
    const nextEntryMode = modeSelect.value === "read" ? "read" : "resume";
    if (nextEntryMode === currentEntryMode) {
      inlineStatus.hidden = true;
      inlineStatus.textContent = "";
      return;
    }
    modeSelect.disabled = true;
    inlineStatus.hidden = false;
    inlineStatus.textContent = t("settings.sessionPresentation.saving");
    try {
      const updated = typeof updateSessionRecord === "function"
        ? await updateSessionRecord(session.id, { entryMode: nextEntryMode })
        : null;
      currentEntryMode = resolveManagedSessionEntryMode(updated || session);
      modeSelect.value = currentEntryMode;
      inlineStatus.hidden = true;
      inlineStatus.textContent = "";
    } catch (error) {
      modeSelect.value = currentEntryMode;
      inlineStatus.hidden = false;
      inlineStatus.textContent = error?.message || t("settings.sessionPresentation.saveFailed");
    } finally {
      modeSelect.disabled = false;
    }
  });

  card.appendChild(editor);
  settingsSessionPresentationList.appendChild(card);
}

initUiLanguageSettings();
initThemeSettings();
initThinkingBlockDisplaySettings();
initInstallSettings();
renderSettingsSessionPresentationPanel();
void renderSettingsAgentsPanel();

if (createAgentBtn && createAgentBtn.dataset.bound !== "true") {
  createAgentBtn.addEventListener("click", () => {
    void createAgentBuilderSession().catch((error) => {
      if (settingsAgentsList) {
        settingsAgentsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.apps.openFailed")}</div>`;
      }
    });
  });
  createAgentBtn.dataset.bound = "true";
}

if (tabAgents && tabAgents.dataset.appsBound !== "true") {
  tabAgents.addEventListener("click", () => {
    void renderSettingsAgentsPanel({ force: true });
  });
  tabAgents.dataset.appsBound = "true";
}

window.addEventListener("remotelab:localechange", () => {
  if (uiLanguageSelect) {
    syncUiLanguageSelect();
  }
  syncThemeSelect();
  syncThinkingBlockDisplaySelect();
  renderInstallSettingsPanel();
  renderSettingsSessionPresentationPanel();
  void renderSettingsAgentsPanel();
});

window.addEventListener("remotelab:themechange", () => {
  syncThemeSelect();
});

window.addEventListener("remotelab:thinkingblockdisplaychange", () => {
  syncThinkingBlockDisplaySelect();
});

window.addEventListener("remotelab:installlogchange", () => {
  renderInstallSettingsPanel();
});

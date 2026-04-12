function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

const voiceInputProviderSelect = document.getElementById("voiceInputProviderSelect");
const voiceInputAppId = document.getElementById("voiceInputAppId");
const voiceInputAccessToken = document.getElementById("voiceInputAccessToken");
const voiceInputClusterPresetSelect = document.getElementById("voiceInputClusterPresetSelect");
const voiceInputCluster = document.getElementById("voiceInputCluster");
const voiceInputGatewayApiKey = document.getElementById("voiceInputGatewayApiKey");
const voiceInputGatewayUrl = document.getElementById("voiceInputGatewayUrl");
const voiceInputGatewayModel = document.getElementById("voiceInputGatewayModel");
const voiceInputLanguageSelect = document.getElementById("voiceInputLanguageSelect");
const voiceInputStatus = document.getElementById("voiceInputStatus");
let voiceInputSettingsLoaded = false;

const HIDDEN_MANAGED_AGENT_IDS = new Set([
  "email",
]);
const CREATE_AGENT_STARTER_PRESET = "create_agent";
let managedAppsCache = [];
let managedAppsLoaded = false;
const settingsConnectorsList = document.getElementById("settingsConnectorsList");
let connectorSurfacesCache = [];
let connectorSurfacesLoaded = false;
let expandedConnectorSurfaceId = "";

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
    folder: typeof window.remotelabGetDefaultSessionFolder === "function"
      ? window.remotelabGetDefaultSessionFolder()
      : "~",
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
    const tool = preferredTool || selectedTool || toolsList[0]?.id || "";
    if (!tool || typeof dispatchAction !== "function") {
      throw new Error(t("settings.apps.openFailed"));
    }
    if (typeof switchTab === "function") {
      switchTab("sessions");
    }
    if (typeof closeSidebarFn === "function" && !isDesktop) {
      closeSidebarFn();
    }
    await dispatchAction({
      action: "create",
      folder: typeof window.remotelabGetDefaultSessionFolder === "function"
        ? window.remotelabGetDefaultSessionFolder()
        : "~",
      tool,
      name: t("settings.apps.create"),
      sourceId: DEFAULT_APP_ID,
      sourceName: DEFAULT_WEB_SOURCE_NAME,
      starterPreset: CREATE_AGENT_STARTER_PRESET,
      forceComposerFocus: true,
    });
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

function renderVoiceInputLanguageOptions(selectEl, selectedValue = "zh-CN") {
  if (!selectEl) return;
  const options = typeof window.remotelabGetVoiceInputLanguageOptions === "function"
    ? window.remotelabGetVoiceInputLanguageOptions()
    : [
      { value: "zh-CN", label: "zh-CN" },
      { value: "en-US", label: "en-US" },
    ];
  selectEl.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectEl.appendChild(option);
  }
  selectEl.value = options.some((option) => option.value === selectedValue) ? selectedValue : "zh-CN";
}

function getVoiceInputClusterOptions() {
  return typeof window.remotelabGetVoiceInputClusterOptions === "function"
    ? window.remotelabGetVoiceInputClusterOptions()
    : [
      { value: "volc.seedasr.sauc.duration", label: "volc.seedasr.sauc.duration" },
      { value: "volc.seedasr.sauc.concurrent", label: "volc.seedasr.sauc.concurrent" },
      { value: "volc.bigasr.sauc.duration", label: "volc.bigasr.sauc.duration" },
      { value: "volc.bigasr.sauc.concurrent", label: "volc.bigasr.sauc.concurrent" },
      { value: "__custom__", label: "Custom", isCustom: true },
    ];
}

function getVoiceInputCustomClusterOptionValue() {
  const customOption = getVoiceInputClusterOptions().find((option) => option?.isCustom);
  return customOption?.value || "__custom__";
}

function isGatewayDirectVoiceProvider(provider = "") {
  return String(provider || "").trim() === "doubao_gateway_direct";
}

function getVoiceInputProviderOptions() {
  return [
    {
      value: "doubao",
      label: t("settings.voice.provider.optionRelay"),
    },
    {
      value: "doubao_gateway_direct",
      label: t("settings.voice.provider.optionDirect"),
    },
  ];
}

function renderVoiceInputProviderOptions(selectedProvider = "doubao") {
  if (!voiceInputProviderSelect) return;
  const options = getVoiceInputProviderOptions();
  const normalizedProvider = isGatewayDirectVoiceProvider(selectedProvider)
    ? "doubao_gateway_direct"
    : "doubao";
  voiceInputProviderSelect.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    voiceInputProviderSelect.appendChild(option);
  }
  voiceInputProviderSelect.value = options.some((option) => option.value === normalizedProvider)
    ? normalizedProvider
    : "doubao";
}

function renderVoiceInputClusterOptions(selectedCluster = "") {
  if (!voiceInputClusterPresetSelect || !voiceInputCluster) return;
  const options = getVoiceInputClusterOptions();
  const customValue = getVoiceInputCustomClusterOptionValue();
  const recommendedOption = options.find((option) => option && !option.isCustom);
  const normalizedCluster = typeof selectedCluster === "string" ? selectedCluster.trim() : "";
  const matchesPreset = options.some((option) => !option?.isCustom && option?.value === normalizedCluster);
  const nextPresetValue = matchesPreset
    ? normalizedCluster
    : normalizedCluster
      ? customValue
      : (recommendedOption?.value || customValue);

  voiceInputClusterPresetSelect.innerHTML = "";
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    voiceInputClusterPresetSelect.appendChild(option);
  }
  voiceInputClusterPresetSelect.value = options.some((option) => option.value === nextPresetValue)
    ? nextPresetValue
    : (recommendedOption?.value || customValue);

  if (nextPresetValue === customValue) {
    voiceInputCluster.hidden = false;
    voiceInputCluster.disabled = false;
    voiceInputCluster.value = normalizedCluster;
    voiceInputCluster.dataset.lastCustomValue = normalizedCluster;
    return;
  }

  if (voiceInputCluster.value.trim()) {
    voiceInputCluster.dataset.lastCustomValue = voiceInputCluster.value.trim();
  }
  voiceInputCluster.hidden = true;
  voiceInputCluster.disabled = true;
  voiceInputCluster.value = "";
}

function getSelectedVoiceInputClusterValue() {
  if (!voiceInputClusterPresetSelect) {
    return voiceInputCluster?.value?.trim?.() || "";
  }
  const selectedValue = voiceInputClusterPresetSelect.value || "";
  if (selectedValue === getVoiceInputCustomClusterOptionValue()) {
    return voiceInputCluster?.value?.trim?.() || "";
  }
  return selectedValue.trim();
}

function syncVoiceInputClusterPresetVisibility() {
  if (!voiceInputClusterPresetSelect || !voiceInputCluster) return;
  if (isGatewayDirectVoiceProvider(voiceInputProviderSelect?.value)) {
    voiceInputCluster.hidden = true;
    voiceInputCluster.disabled = true;
    return;
  }
  const customValue = getVoiceInputCustomClusterOptionValue();
  if (voiceInputClusterPresetSelect.value === customValue) {
    voiceInputCluster.hidden = false;
    voiceInputCluster.disabled = false;
    voiceInputCluster.value = voiceInputCluster.dataset.lastCustomValue || voiceInputCluster.value || "";
    return;
  }
  if (voiceInputCluster.value.trim()) {
    voiceInputCluster.dataset.lastCustomValue = voiceInputCluster.value.trim();
  }
  voiceInputCluster.hidden = true;
  voiceInputCluster.disabled = true;
}

function syncVoiceInputProviderVisibility() {
  const gatewayDirect = isGatewayDirectVoiceProvider(voiceInputProviderSelect?.value);
  if (voiceInputAppId) voiceInputAppId.hidden = gatewayDirect;
  if (voiceInputAccessToken) voiceInputAccessToken.hidden = gatewayDirect;
  if (voiceInputClusterPresetSelect) voiceInputClusterPresetSelect.hidden = gatewayDirect;
  if (voiceInputCluster) {
    voiceInputCluster.hidden = gatewayDirect || voiceInputClusterPresetSelect?.value !== getVoiceInputCustomClusterOptionValue();
    voiceInputCluster.disabled = gatewayDirect || voiceInputCluster.hidden;
  }
  if (voiceInputGatewayApiKey) {
    voiceInputGatewayApiKey.hidden = !gatewayDirect;
    voiceInputGatewayApiKey.disabled = !gatewayDirect;
  }
  if (voiceInputGatewayUrl) {
    voiceInputGatewayUrl.hidden = !gatewayDirect;
    voiceInputGatewayUrl.disabled = !gatewayDirect;
  }
  if (voiceInputGatewayModel) {
    voiceInputGatewayModel.hidden = !gatewayDirect;
    voiceInputGatewayModel.disabled = !gatewayDirect;
  }
}

function setVoiceInputStatus(message, { hidden = false } = {}) {
  if (!voiceInputStatus) return;
  voiceInputStatus.hidden = hidden;
  voiceInputStatus.textContent = hidden ? "" : message;
}

function canManageInstanceSettingsFromUi() {
  return typeof window.remotelabCanManageInstanceSettings === "function"
    ? window.remotelabCanManageInstanceSettings()
    : !visitorMode;
}

function getCurrentVoiceInputSettings() {
  if (typeof window.remotelabGetVoiceInputInstanceSettings === "function") {
    return window.remotelabGetVoiceInputInstanceSettings();
  }
  if (typeof window.remotelabGetVoiceInputConfig === "function") {
    return window.remotelabGetVoiceInputConfig();
  }
  return {
    provider: "doubao",
    appId: "",
    accessToken: "",
    resourceId: "",
    cluster: "",
    gatewayApiKey: "",
    gatewayUrl: "wss://ai-gateway.vei.volces.com/v1/realtime",
    gatewayModel: "bigmodel",
    gatewayAuthMode: "subprotocol",
    language: "zh-CN",
    configured: false,
    clientReady: false,
  };
}

function setVoiceInputControlsDisabled(disabled) {
  for (const control of [
    voiceInputProviderSelect,
    voiceInputAppId,
    voiceInputAccessToken,
    voiceInputClusterPresetSelect,
    voiceInputCluster,
    voiceInputGatewayApiKey,
    voiceInputGatewayUrl,
    voiceInputGatewayModel,
    voiceInputLanguageSelect,
  ]) {
    if (!control) continue;
    control.disabled = disabled || control.hidden === true;
  }
}

function getVoiceInputStatusMessage(config, {
  loading = false,
  saving = false,
  loadFailed = false,
  saveFailed = false,
} = {}) {
  if (loading) return t("settings.voice.statusLoading");
  if (saving) return t("settings.voice.statusSaving");
  if (loadFailed) return t("settings.voice.statusLoadFailed");
  if (saveFailed) return t("settings.voice.statusSaveFailed");
  if (canManageInstanceSettingsFromUi()) {
    return config?.configured === true
      ? t("settings.voice.statusStored")
      : t("settings.voice.statusIncomplete");
  }
  return config?.configured === true
    ? t("settings.voice.statusOwnerOnlyConfigured")
    : t("settings.voice.statusOwnerOnlyIncomplete");
}

function syncVoiceInputSettings() {
  if (
    !voiceInputProviderSelect
    || !voiceInputAppId
    || !voiceInputAccessToken
    || !voiceInputClusterPresetSelect
    || !voiceInputCluster
    || !voiceInputGatewayApiKey
    || !voiceInputGatewayUrl
    || !voiceInputGatewayModel
    || !voiceInputLanguageSelect
  ) {
    return;
  }
  const config = getCurrentVoiceInputSettings();
  renderVoiceInputProviderOptions(config.provider || "doubao");
  voiceInputAppId.value = config.appId || "";
  voiceInputAccessToken.value = config.accessToken || "";
  renderVoiceInputClusterOptions(config.cluster || "");
  voiceInputGatewayApiKey.value = config.gatewayApiKey || "";
  voiceInputGatewayUrl.value = config.gatewayUrl || "";
  voiceInputGatewayModel.value = config.gatewayModel || "";
  renderVoiceInputLanguageOptions(voiceInputLanguageSelect, config.language || "zh-CN");
  syncVoiceInputProviderVisibility();
  setVoiceInputControlsDisabled(!canManageInstanceSettingsFromUi());
  setVoiceInputStatus(getVoiceInputStatusMessage(config));
}

async function refreshVoiceInputSettings({ force = false } = {}) {
  syncVoiceInputSettings();
  if (typeof window.remotelabFetchInstanceSettings !== "function") {
    voiceInputSettingsLoaded = true;
    return;
  }
  setVoiceInputStatus(getVoiceInputStatusMessage(getCurrentVoiceInputSettings(), { loading: true }));
  try {
    await window.remotelabFetchInstanceSettings({ force });
    voiceInputSettingsLoaded = true;
    syncVoiceInputSettings();
  } catch (error) {
    voiceInputSettingsLoaded = true;
    syncVoiceInputSettings();
    setVoiceInputStatus(error?.message || getVoiceInputStatusMessage(getCurrentVoiceInputSettings(), { loadFailed: true }));
  }
}

async function persistVoiceInputSettings() {
  if (!canManageInstanceSettingsFromUi()) {
    syncVoiceInputSettings();
    return;
  }
  if (typeof window.remotelabUpdateInstanceSettings !== "function") {
    return;
  }
  const patch = {
    voiceInput: {
      provider: voiceInputProviderSelect.value || "doubao",
      appId: voiceInputAppId.value,
      accessToken: voiceInputAccessToken.value,
      resourceId: getSelectedVoiceInputClusterValue(),
      cluster: getSelectedVoiceInputClusterValue(),
      gatewayApiKey: voiceInputGatewayApiKey.value,
      gatewayUrl: voiceInputGatewayUrl.value,
      gatewayModel: voiceInputGatewayModel.value,
      gatewayAuthMode: "subprotocol",
      language: voiceInputLanguageSelect.value || "zh-CN",
    },
  };
  setVoiceInputStatus(getVoiceInputStatusMessage(getCurrentVoiceInputSettings(), { saving: true }));
  try {
    await window.remotelabUpdateInstanceSettings(patch);
    syncVoiceInputSettings();
  } catch (error) {
    syncVoiceInputSettings();
    setVoiceInputStatus(error?.message || getVoiceInputStatusMessage(getCurrentVoiceInputSettings(), { saveFailed: true }));
  }
}

async function initVoiceInputSettings() {
  if (
    !voiceInputProviderSelect
    || !voiceInputAppId
    || !voiceInputAccessToken
    || !voiceInputClusterPresetSelect
    || !voiceInputCluster
    || !voiceInputGatewayApiKey
    || !voiceInputGatewayUrl
    || !voiceInputGatewayModel
    || !voiceInputLanguageSelect
  ) {
    return;
  }
  await refreshVoiceInputSettings();
  if (voiceInputAppId.dataset.bound === "true") {
    return;
  }

  for (const input of [
    voiceInputAppId,
    voiceInputAccessToken,
    voiceInputCluster,
    voiceInputGatewayApiKey,
    voiceInputGatewayUrl,
    voiceInputGatewayModel,
  ]) {
    input.addEventListener("input", () => {
      void persistVoiceInputSettings();
    });
  }
  voiceInputProviderSelect.addEventListener("change", () => {
    syncVoiceInputProviderVisibility();
    setVoiceInputControlsDisabled(!canManageInstanceSettingsFromUi());
    void persistVoiceInputSettings();
  });
  voiceInputClusterPresetSelect.addEventListener("change", () => {
    syncVoiceInputClusterPresetVisibility();
    void persistVoiceInputSettings();
  });
  voiceInputLanguageSelect.addEventListener("change", () => {
    void persistVoiceInputSettings();
  });
  const currentConfig = getCurrentVoiceInputSettings();
  if (
    canManageInstanceSettingsFromUi()
    && currentConfig
    && !isGatewayDirectVoiceProvider(currentConfig.provider)
    && !currentConfig.resourceId
    && !currentConfig.cluster
    && typeof window.remotelabUpdateInstanceSettings === "function"
  ) {
    await window.remotelabUpdateInstanceSettings({
      voiceInput: {
        ...currentConfig,
        provider: currentConfig.provider || "doubao",
        resourceId: getSelectedVoiceInputClusterValue(),
        cluster: getSelectedVoiceInputClusterValue(),
        language: voiceInputLanguageSelect.value || currentConfig.language || "zh-CN",
      },
    });
  }
  voiceInputAppId.dataset.bound = "true";
}

function renderInstallSettingsPanel() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  const statusEl = document.getElementById("settingsInstallStatus");
  if (!installBtn || !statusEl) return;

  const state = typeof window.remotelabGetInstallFlowState === "function"
    ? window.remotelabGetInstallFlowState()
    : { promptReady: false, standalone: false, mobileEligible: false };

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
}

function initInstallSettings() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  if (!installBtn) return;

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
}

function canManageConnectorSurfacesFromUi() {
  return !visitorMode && !isAgentScopedModeFromUi();
}

function resolveConnectorSurfaceUrl(entryUrl) {
  const normalized = typeof entryUrl === "string" ? entryUrl.trim() : "";
  if (!normalized) return "";
  if (typeof window.remotelabResolveProductUrl === "function") {
    return window.remotelabResolveProductUrl(normalized);
  }
  return new URL(normalized, window.location.origin).toString();
}

function getConnectorSurfaceCapabilityTone(surface) {
  return surface?.surface?.capabilityState === "ready" ? "ready" : "pending";
}

function getConnectorSurfaceCapabilityLabel(surface) {
  return surface?.surface?.capabilityState === "ready"
    ? t("settings.connectors.connected")
    : t("settings.connectors.needsAction");
}

function describeConnectorSurface(surface) {
  const statusMessage = typeof surface?.surface?.message === "string"
    ? surface.surface.message.trim()
    : "";
  if (statusMessage) return statusMessage;
  const fallbackDescription = typeof surface?.description === "string"
    ? surface.description.trim()
    : "";
  return fallbackDescription || t("settings.connectors.defaultDescription");
}

async function fetchConnectorSurfaces() {
  if (!canManageConnectorSurfacesFromUi()) return [];
  const data = typeof fetchJsonOrRedirect === "function"
    ? await fetchJsonOrRedirect("/api/connectors/surfaces")
    : await fetch("/api/connectors/surfaces").then((response) => response.json());
  const surfaces = Array.isArray(data?.surfaces)
    ? data.surfaces.filter((surface) => surface && typeof surface === "object")
    : [];
  connectorSurfacesCache = surfaces;
  connectorSurfacesLoaded = true;
  return surfaces;
}

function buildConnectorSurfaceCard(surface) {
  const card = document.createElement("div");
  card.className = "settings-app-card";

  const header = document.createElement("div");
  header.className = "settings-app-card-header";

  const name = document.createElement("div");
  name.className = "settings-app-name";
  name.textContent = surface?.title || surface?.connectorId || t("settings.connectors.untitled");
  header.appendChild(name);

  const kind = document.createElement("div");
  kind.className = "settings-app-kind";
  kind.textContent = surface?.surfaceType || surface?.connectorId || "";
  header.appendChild(kind);
  card.appendChild(header);

  const description = document.createElement("div");
  description.className = "settings-app-description";
  description.textContent = describeConnectorSurface(surface);
  card.appendChild(description);

  const status = document.createElement("div");
  status.className = "settings-connector-status";

  const pill = document.createElement("span");
  pill.className = `settings-connector-pill ${getConnectorSurfaceCapabilityTone(surface)}`;
  pill.textContent = getConnectorSurfaceCapabilityLabel(surface);
  status.appendChild(pill);

  const detail = document.createElement("span");
  detail.className = "settings-app-meta";
  detail.textContent = t("settings.connectors.status", {
    status: surface?.surface?.status || surface?.surface?.capabilityState || surface?.surfaceType || t("settings.connectors.unknownStatus"),
  });
  status.appendChild(detail);
  card.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "settings-app-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "settings-app-btn";
  openBtn.textContent = t("settings.connectors.open");
  openBtn.addEventListener("click", () => {
    const targetUrl = resolveConnectorSurfaceUrl(surface?.entryUrl);
    if (!targetUrl) return;
    const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = targetUrl;
    }
  });
  actions.appendChild(openBtn);

  const canEmbed = surface?.allowEmbed === true && !!resolveConnectorSurfaceUrl(surface?.entryUrl);
  if (canEmbed) {
    const embedBtn = document.createElement("button");
    embedBtn.type = "button";
    embedBtn.className = "settings-app-btn";
    embedBtn.textContent = expandedConnectorSurfaceId === surface.connectorId
      ? t("settings.connectors.hideHere")
      : t("settings.connectors.showHere");
    embedBtn.addEventListener("click", () => {
      expandedConnectorSurfaceId = expandedConnectorSurfaceId === surface.connectorId
        ? ""
        : surface.connectorId;
      renderSettingsConnectorsPanel();
    });
    actions.appendChild(embedBtn);
  }

  card.appendChild(actions);

  if (canEmbed && expandedConnectorSurfaceId === surface.connectorId) {
    const frameWrap = document.createElement("div");
    frameWrap.className = "settings-connector-frame-wrap";

    const iframe = document.createElement("iframe");
    iframe.className = "settings-connector-frame";
    iframe.loading = "lazy";
    iframe.src = resolveConnectorSurfaceUrl(surface.entryUrl);
    iframe.title = surface?.title || surface?.connectorId || t("settings.connectors.untitled");
    frameWrap.appendChild(iframe);
    card.appendChild(frameWrap);
  }

  return card;
}

async function renderSettingsConnectorsPanel({ force = false } = {}) {
  if (!settingsConnectorsList) return;
  if (!canManageConnectorSurfacesFromUi()) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.ownerOnly")}</div>`;
    return;
  }

  if (force || !connectorSurfacesLoaded) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.loading")}</div>`;
    try {
      await fetchConnectorSurfaces();
    } catch (error) {
      settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${error?.message || t("settings.connectors.loadingFailed")}</div>`;
      return;
    }
  }

  const visibleSurfaces = [...connectorSurfacesCache].sort((left, right) => {
    const leftTitle = String(left?.title || left?.connectorId || "");
    const rightTitle = String(right?.title || right?.connectorId || "");
    return leftTitle.localeCompare(rightTitle);
  });

  if (!expandedConnectorSurfaceId) {
    const recommendedSurface = visibleSurfaces.find((surface) => surface?.allowEmbed === true && surface?.surface?.capabilityState !== "ready");
    if (recommendedSurface) {
      expandedConnectorSurfaceId = recommendedSurface.connectorId || "";
    }
  } else if (!visibleSurfaces.some((surface) => surface?.connectorId === expandedConnectorSurfaceId)) {
    expandedConnectorSurfaceId = "";
  }

  settingsConnectorsList.innerHTML = "";
  if (visibleSurfaces.length === 0) {
    settingsConnectorsList.innerHTML = `<div class="settings-app-empty">${t("settings.connectors.none")}</div>`;
    return;
  }
  for (const surface of visibleSurfaces) {
    settingsConnectorsList.appendChild(buildConnectorSurfaceCard(surface));
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
void initVoiceInputSettings();
initInstallSettings();
void renderSettingsConnectorsPanel();
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

if (tabSettings && tabSettings.dataset.connectorsBound !== "true") {
  tabSettings.addEventListener("click", () => {
    void renderSettingsConnectorsPanel({ force: true });
  });
  tabSettings.dataset.connectorsBound = "true";
}

window.addEventListener("remotelab:localechange", () => {
  if (uiLanguageSelect) {
    syncUiLanguageSelect();
  }
  syncThemeSelect();
  syncThinkingBlockDisplaySelect();
  if (voiceInputSettingsLoaded) {
    syncVoiceInputSettings();
  }
  renderInstallSettingsPanel();
  void renderSettingsConnectorsPanel();
  renderSettingsSessionPresentationPanel();
  void renderSettingsAgentsPanel();
});

window.addEventListener("remotelab:themechange", () => {
  syncThemeSelect();
});

window.addEventListener("remotelab:thinkingblockdisplaychange", () => {
  syncThinkingBlockDisplaySelect();
});

window.addEventListener("remotelab:instancesettingschange", () => {
  syncVoiceInputSettings();
});

window.remotelabSetVoiceInputRuntimeStatus = function remotelabSetVoiceInputRuntimeStatus(message, { hidden = false } = {}) {
  setVoiceInputStatus(message, { hidden });
};

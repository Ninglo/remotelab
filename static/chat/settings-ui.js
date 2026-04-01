function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
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

function syncUiLanguageStatus() {
  if (!uiLanguageStatus) return;
  const currentPreference = typeof window.remotelabGetUiLanguagePreference === "function"
    ? window.remotelabGetUiLanguagePreference()
    : "auto";
  uiLanguageStatus.textContent = currentPreference === "auto"
    ? t("settings.language.ownerStatusAuto")
    : t("settings.language.ownerStatusOverride");
}

function initUiLanguageSettings() {
  if (!uiLanguageSelect || uiLanguageSelect.dataset.bound === "true") {
    syncUiLanguageStatus();
    return;
  }
  renderUiLanguageOptions(
    uiLanguageSelect,
    typeof window.remotelabGetUiLanguagePreference === "function"
      ? window.remotelabGetUiLanguagePreference()
      : "auto",
  );
  syncUiLanguageStatus();
  uiLanguageSelect.addEventListener("change", () => {
    const value = uiLanguageSelect.value || "auto";
    if (typeof window.remotelabSetUiLanguagePreference === "function") {
      window.remotelabSetUiLanguagePreference(value, { reload: true });
      return;
    }
    syncUiLanguageStatus();
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

function syncThemeStatus() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  const uiThemeStatus = document.getElementById("uiThemeStatus");
  if (!uiThemeSelect || !uiThemeStatus) return;
  const currentPreference = typeof window.remotelabGetThemePreference === "function"
    ? window.remotelabGetThemePreference()
    : "system";
  renderThemeOptions(uiThemeSelect, currentPreference);
  uiThemeStatus.textContent = currentPreference === "amber"
    ? t("settings.theme.statusAmber")
    : t("settings.theme.statusSystem");
}

function initThemeSettings() {
  const uiThemeSelect = document.getElementById("uiThemeSelect");
  if (!uiThemeSelect || uiThemeSelect.dataset.bound === "true") {
    syncThemeStatus();
    return;
  }
  syncThemeStatus();
  uiThemeSelect.addEventListener("change", () => {
    const value = uiThemeSelect.value || "system";
    if (typeof window.remotelabSetThemePreference === "function") {
      window.remotelabSetThemePreference(value);
    }
    syncThemeStatus();
  });
  uiThemeSelect.dataset.bound = "true";
}

function resolveManagedSessionEntryMode(session) {
  return session?.entryMode === "read" ? "read" : "resume";
}

function describeManagedSessionEntryMode(entryMode) {
  return entryMode === "read"
    ? t("settings.sessionPresentation.entryMode.readHelp")
    : t("settings.sessionPresentation.entryMode.resumeHelp");
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
  if (visitorMode) return null;
  if (typeof getCurrentSession === "function") {
    return getCurrentSession();
  }
  return Array.isArray(sessions)
    ? sessions.find((session) => session?.id === currentSessionId) || null
    : null;
}

function renderSettingsSessionPresentationPanel() {
  if (!settingsSessionPresentationList) return;
  if (visitorMode) {
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

  const description = document.createElement("div");
  description.className = "settings-app-description";
  description.textContent = t("settings.sessionPresentation.note");
  card.appendChild(description);

  const editor = document.createElement("div");
  editor.className = "settings-app-editor";

  const modeSelect = document.createElement("select");
  modeSelect.className = "settings-inline-select";
  modeSelect.setAttribute("aria-label", t("settings.sessionPresentation.entryModeAriaLabel"));

  let currentEntryMode = resolveManagedSessionEntryMode(session);
  renderManagedSessionEntryModeOptions(modeSelect, currentEntryMode);
  editor.appendChild(modeSelect);

  const inlineStatus = document.createElement("div");
  inlineStatus.className = "settings-app-empty inline-status";
  inlineStatus.textContent = describeManagedSessionEntryMode(currentEntryMode);
  editor.appendChild(inlineStatus);

  modeSelect.addEventListener("change", async () => {
    const nextEntryMode = modeSelect.value === "read" ? "read" : "resume";
    if (nextEntryMode === currentEntryMode) {
      inlineStatus.textContent = describeManagedSessionEntryMode(currentEntryMode);
      return;
    }
    modeSelect.disabled = true;
    inlineStatus.textContent = t("settings.sessionPresentation.saving");
    try {
      const updated = typeof updateSessionRecord === "function"
        ? await updateSessionRecord(session.id, { entryMode: nextEntryMode })
        : null;
      currentEntryMode = resolveManagedSessionEntryMode(updated || session);
      modeSelect.value = currentEntryMode;
      inlineStatus.textContent = describeManagedSessionEntryMode(currentEntryMode);
    } catch (error) {
      modeSelect.value = currentEntryMode;
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
renderSettingsSessionPresentationPanel();

window.addEventListener("remotelab:localechange", () => {
  if (!uiLanguageSelect?.dataset.bound) return;
  renderUiLanguageOptions(
    uiLanguageSelect,
    typeof window.remotelabGetUiLanguagePreference === "function"
      ? window.remotelabGetUiLanguagePreference()
      : "auto",
  );
  syncUiLanguageStatus();
  syncThemeStatus();
});

window.addEventListener("remotelab:themechange", () => {
  syncThemeStatus();
});

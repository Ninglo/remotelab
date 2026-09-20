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
const sessionAutoArchiveSelect = document.getElementById("sessionAutoArchiveSelect");
let voiceInputSettingsLoaded = false;

function getSessionAutoArchiveOptions() {
  return [
    { value: "0", label: t("settings.autoArchive.optionOff") },
    { value: "12", label: t("settings.autoArchive.option12h") },
    { value: "24", label: t("settings.autoArchive.option24h") },
    { value: "72", label: t("settings.autoArchive.option3d") },
    { value: "168", label: t("settings.autoArchive.option7d") },
  ];
}

function syncSessionAutoArchiveSettings() {
  if (!sessionAutoArchiveSelect) return;
  const settings = typeof window.remotelabGetInstanceSettings === "function"
    ? window.remotelabGetInstanceSettings().sessionAutoArchive
    : { enabled: false, inactiveAfterHours: 24 };
  const value = settings?.enabled === true ? String(settings.inactiveAfterHours || 24) : "0";
  sessionAutoArchiveSelect.innerHTML = "";
  for (const optionData of getSessionAutoArchiveOptions()) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    sessionAutoArchiveSelect.appendChild(option);
  }
  sessionAutoArchiveSelect.value = value;
  sessionAutoArchiveSelect.disabled = !canManageInstanceSettingsFromUi();
}

async function persistSessionAutoArchiveSettings() {
  if (!sessionAutoArchiveSelect || !canManageInstanceSettingsFromUi()) return;
  const hours = Number.parseInt(sessionAutoArchiveSelect.value, 10);
  await window.remotelabUpdateInstanceSettings({
    sessionAutoArchive: {
      enabled: hours > 0,
      inactiveAfterHours: hours > 0 ? hours : 24,
    },
  });
  syncSessionAutoArchiveSettings();
}

function initSessionAutoArchiveSettings() {
  if (!sessionAutoArchiveSelect) return;
  syncSessionAutoArchiveSettings();
  if (sessionAutoArchiveSelect.dataset.bound === "true") return;
  sessionAutoArchiveSelect.addEventListener("change", () => {
    void persistSessionAutoArchiveSettings().catch((error) => {
      syncSessionAutoArchiveSettings();
      console.warn("[settings] Failed to save session auto-archive settings:", error?.message || error);
    });
  });
  sessionAutoArchiveSelect.dataset.bound = "true";
}

const settingsConnectorsList = document.getElementById("settingsConnectorsList");
const settingsPeopleList = document.getElementById("settingsPeopleList");
const settingsCurrentPersonSummary = document.getElementById("settingsCurrentPersonSummary");
const settingsDefaultPersonFilter = document.getElementById("settingsDefaultPersonFilter");
const settingsPersonCreateToggle = document.getElementById("settingsPersonCreateToggle");
const settingsPersonCreatePanel = document.getElementById("settingsPersonCreatePanel");
const settingsPersonName = document.getElementById("settingsPersonName");
const settingsPersonUsername = document.getElementById("settingsPersonUsername");
const settingsPersonCreate = document.getElementById("settingsPersonCreate");
const settingsPersonCreateCancel = document.getElementById("settingsPersonCreateCancel");
const settingsPeopleStatus = document.getElementById("settingsPeopleStatus");
let connectorSurfacesCache = [];
let connectorSurfacesLoaded = false;
let expandedConnectorSurfaceId = "";
let codexAuthState = null;
let codexAuthPollTimer = null;
let codexAuthRequestId = 0;
const CODEX_AUTH_MUTATION_TIMEOUT_MS = 20_000;
let piAuthState = null;

function setPeopleStatus(message = "", { error = false } = {}) {
  if (!settingsPeopleStatus) return;
  settingsPeopleStatus.hidden = !message;
  settingsPeopleStatus.textContent = message;
  settingsPeopleStatus.classList.toggle("error", error);
}

async function requestPeople(path = "/api/people", options = {}) {
  const payload = await fetchJsonOrRedirect(path, {
    revalidate: false,
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  if (Array.isArray(payload?.people)) {
    replacePeopleDirectory(payload.people);
    if (typeof refreshSessionCatalog === "function") refreshSessionCatalog();
  }
  return payload;
}

function getPersonInitials(person) {
  const name = String(person?.name || person?.handle || "?").trim();
  if (!name) return "?";
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  const characters = Array.from(name);
  return characters.length > 0 ? characters[0].toUpperCase() : "?";
}

function getPersonTone(person) {
  let hash = 0;
  for (const character of String(person?.handle || person?.id || "")) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return String(Math.abs(hash) % 5);
}

function buildPersonAvatar(person, className = "") {
  const avatar = document.createElement("div");
  avatar.className = `settings-person-avatar${className ? ` ${className}` : ""}`;
  avatar.dataset.tone = getPersonTone(person);
  avatar.textContent = getPersonInitials(person);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function buildPersonBadge(text, variant = "") {
  const badge = document.createElement("span");
  badge.className = `settings-person-badge${variant ? ` ${variant}` : ""}`;
  badge.textContent = text;
  return badge;
}

function getConnectedIdentities(person) {
  return (person.identities || []).filter((identity) => identity.kind !== "web" && identity.kind !== "system");
}

function buildPersonSummaryMeta(person) {
  const meta = document.createElement("div");
  meta.className = "settings-person-summary-meta";
  const identities = getConnectedIdentities(person);
  const identityCounts = new Map();
  for (const identity of identities) {
    const kind = identity.kind === "feishu" ? "Feishu" : identity.kind;
    identityCounts.set(kind, (identityCounts.get(kind) || 0) + 1);
  }
  for (const [kind, count] of identityCounts) meta.appendChild(buildPersonBadge(count > 1 ? `${kind} ×${count}` : kind, "connected"));
  const passwords = (person.credentials || []).filter((credential) => credential.type === "password");
  const tokens = (person.credentials || []).filter((credential) => credential.type === "token");
  if (passwords.length > 0) meta.appendChild(buildPersonBadge(t("settings.people.passwordAccess")));
  if (tokens.length > 0) meta.appendChild(buildPersonBadge(tokens.length > 1 ? `${t("settings.people.token")} ×${tokens.length}` : t("settings.people.token")));
  if (passwords.length === 0 && tokens.length === 0) meta.appendChild(buildPersonBadge(t("settings.people.noWebSignIn"), "muted"));
  return meta;
}

function buildPersonSection(title, note = "") {
  const section = document.createElement("section");
  section.className = "settings-person-detail-section";
  const heading = document.createElement("div");
  heading.className = "settings-person-detail-heading";
  const label = document.createElement("h4");
  label.textContent = title;
  heading.appendChild(label);
  if (note) {
    const description = document.createElement("p");
    description.textContent = note;
    heading.appendChild(description);
  }
  section.appendChild(heading);
  return section;
}

function buildCredentialRow(person, credential) {
  const row = document.createElement("div");
  row.className = "settings-person-data-row";
  const icon = document.createElement("div");
  icon.className = "settings-person-data-icon";
  icon.textContent = credential.type === "password" ? "P" : "T";
  icon.setAttribute("aria-hidden", "true");
  row.appendChild(icon);
  const copy = document.createElement("div");
  copy.className = "settings-person-data-copy";
  const title = document.createElement("strong");
  title.textContent = credential.type === "password"
    ? t("settings.people.passwordAccess")
    : (credential.label || t("settings.people.token"));
  const detail = document.createElement("span");
  detail.textContent = credential.type === "password"
    ? `@${credential.username || person.handle}`
    : `•••• ${credential.tokenSuffix || ""}`;
  copy.append(title, detail);
  row.appendChild(copy);
  const remove = document.createElement("button");
  remove.className = "settings-person-text-btn danger";
  remove.type = "button";
  remove.textContent = t("action.remove");
  remove.addEventListener("click", async () => {
    if (!window.confirm(t("settings.people.removeCredentialConfirm"))) return;
    remove.disabled = true;
    try {
      await requestPeople(`/api/people/${encodeURIComponent(person.id)}/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
      await renderPeopleSettings();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
      remove.disabled = false;
    }
  });
  row.appendChild(remove);
  return row;
}

function buildIdentityRow(identity) {
  const row = document.createElement("div");
  row.className = "settings-person-data-row";
  const icon = document.createElement("div");
  icon.className = "settings-person-data-icon connected";
  icon.textContent = identity.kind === "feishu" ? "飞" : String(identity.kind || "?").slice(0, 1).toUpperCase();
  icon.setAttribute("aria-hidden", "true");
  row.appendChild(icon);
  const copy = document.createElement("div");
  copy.className = "settings-person-data-copy";
  const title = document.createElement("strong");
  title.textContent = identity.kind === "feishu" ? "Feishu" : identity.kind;
  const detail = document.createElement("span");
  detail.textContent = [identity.displayName, identity.realm].filter(Boolean).join(" · ");
  copy.append(title, detail);
  row.appendChild(copy);
  const status = document.createElement("span");
  status.className = "settings-person-connected-status";
  status.textContent = t("settings.people.connected");
  row.appendChild(status);
  return row;
}

function buildPersonCard(person) {
  const card = document.createElement("details");
  card.className = "settings-person-card";
  const summary = document.createElement("summary");
  summary.className = "settings-person-summary";
  summary.appendChild(buildPersonAvatar(person));
  const summaryCopy = document.createElement("div");
  summaryCopy.className = "settings-person-summary-copy";
  const titleRow = document.createElement("div");
  titleRow.className = "settings-person-title-row";
  const title = document.createElement("strong");
  title.textContent = person.name;
  titleRow.appendChild(title);
  if (person.id === currentPerson?.id) titleRow.appendChild(buildPersonBadge(t("settings.people.you"), "current"));
  const handle = document.createElement("span");
  handle.className = "settings-person-handle";
  handle.textContent = `@${person.handle}`;
  summaryCopy.append(titleRow, handle, buildPersonSummaryMeta(person));
  summary.appendChild(summaryCopy);
  const manage = document.createElement("span");
  manage.className = "settings-person-manage";
  manage.textContent = t("settings.people.manage");
  summary.appendChild(manage);
  card.appendChild(summary);

  const body = document.createElement("div");
  body.className = "settings-person-body";
  const profile = buildPersonSection(t("settings.people.profile"), t("settings.people.profileNote"));
  const profileGrid = document.createElement("div");
  profileGrid.className = "settings-person-profile-grid";
  const nameField = document.createElement("label");
  nameField.className = "settings-person-field";
  const nameLabel = document.createElement("span");
  nameLabel.textContent = t("settings.people.nameLabel");
  const name = document.createElement("input");
  name.className = "settings-inline-input";
  name.value = person.name;
  name.maxLength = 120;
  nameField.append(nameLabel, name);
  const handleField = document.createElement("label");
  handleField.className = "settings-person-field";
  const handleLabel = document.createElement("span");
  handleLabel.textContent = t("settings.people.handleLabel");
  const handleInput = document.createElement("input");
  handleInput.className = "settings-inline-input";
  handleInput.value = person.handle || "";
  handleInput.autocomplete = "username";
  handleField.append(handleLabel, handleInput);
  profileGrid.append(nameField, handleField);
  profile.appendChild(profileGrid);
  const profileActions = document.createElement("div");
  profileActions.className = "settings-person-form-actions";
  const save = document.createElement("button");
  save.className = "settings-app-btn settings-person-primary";
  save.type = "button";
  save.textContent = t("action.save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await requestPeople(`/api/people/${encodeURIComponent(person.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.value, handle: handleInput.value }),
      });
      setPeopleStatus(t("settings.people.saved"));
      await renderPeopleSettings();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
      save.disabled = false;
    }
  });
  profileActions.appendChild(save);
  profile.appendChild(profileActions);
  body.appendChild(profile);

  const credentials = person.credentials || [];
  const signIn = buildPersonSection(t("settings.people.signIn"), t("settings.people.signInNote"));
  const credentialList = document.createElement("div");
  credentialList.className = "settings-person-data-list";
  for (const credential of credentials) credentialList.appendChild(buildCredentialRow(person, credential));
  if (credentials.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-person-empty-state";
    empty.textContent = t("settings.people.noSignInMethods");
    credentialList.appendChild(empty);
  }
  signIn.appendChild(credentialList);
  const credentialActions = document.createElement("div");
  credentialActions.className = "settings-person-form-actions left";
  if (!credentials.some((credential) => credential.type === "password")) {
    const addPassword = document.createElement("button");
    addPassword.className = "settings-app-btn";
    addPassword.type = "button";
    addPassword.textContent = t("settings.people.addPassword");
    addPassword.addEventListener("click", async () => {
      const password = window.prompt(t("settings.people.passwordPrompt"), "") || "";
      if (!password) return;
      addPassword.disabled = true;
      try {
        await requestPeople(`/api/people/${encodeURIComponent(person.id)}/credentials`, {
          method: "POST",
          body: JSON.stringify({ type: "password", password }),
        });
        setPeopleStatus(t("settings.people.passwordAdded"));
        await renderPeopleSettings();
      } catch (error) {
        setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
        addPassword.disabled = false;
      }
    });
    credentialActions.appendChild(addPassword);
  }
  const addToken = document.createElement("button");
  addToken.className = "settings-app-btn";
  addToken.type = "button";
  addToken.textContent = t("settings.people.addToken");
  addToken.addEventListener("click", async () => {
    addToken.disabled = true;
    try {
      const result = await requestPeople(`/api/people/${encodeURIComponent(person.id)}/credentials`, {
        method: "POST",
        body: JSON.stringify({ type: "token" }),
      });
      setPeopleStatus(`${t("settings.people.copyToken")}: ${result.issuedToken || ""}`);
      await renderPeopleSettings();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
      addToken.disabled = false;
    }
  });
  credentialActions.appendChild(addToken);
  signIn.appendChild(credentialActions);
  body.appendChild(signIn);

  const identities = getConnectedIdentities(person);
  const connections = buildPersonSection(t("settings.people.connectedApps"), t("settings.people.connectedAppsNote"));
  const identityList = document.createElement("div");
  identityList.className = "settings-person-data-list";
  for (const identity of identities) identityList.appendChild(buildIdentityRow(identity));
  if (identities.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-person-empty-state";
    empty.textContent = t("settings.people.noConnectedApps");
    identityList.appendChild(empty);
  }
  connections.appendChild(identityList);
  body.appendChild(connections);
  card.appendChild(body);
  return card;
}

function renderCurrentPersonSettings(people = getPeopleDirectory()) {
  if (!settingsCurrentPersonSummary || !settingsDefaultPersonFilter) return;
  const person = people.find((entry) => entry.id === currentPerson?.id && entry.system !== true);
  settingsCurrentPersonSummary.replaceChildren();
  if (!person) {
    settingsDefaultPersonFilter.disabled = true;
    return;
  }
  settingsCurrentPersonSummary.appendChild(buildPersonAvatar(person, "small"));
  const copy = document.createElement("div");
  copy.className = "settings-current-person-copy";
  const name = document.createElement("strong");
  name.textContent = person.name;
  const handle = document.createElement("span");
  handle.textContent = `@${person.handle}`;
  copy.append(name, handle);
  settingsCurrentPersonSummary.appendChild(copy);
  settingsDefaultPersonFilter.disabled = false;
  settingsDefaultPersonFilter.value = person.preferences?.defaultSessionPersonFilter === "mine" ? "mine" : "all";
}

async function renderPeopleSettings({ refresh = false } = {}) {
  if (!settingsPeopleList) return;
  if (refresh) {
    try {
      await requestPeople();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.loadFailed"), { error: true });
    }
  }
  const people = getPeopleDirectory();
  renderCurrentPersonSettings(people);
  const visiblePeople = people
    .filter((person) => person.system !== true)
    .sort((left, right) => {
      if (left.id === currentPerson?.id) return -1;
      if (right.id === currentPerson?.id) return 1;
      return String(left.name || "").localeCompare(String(right.name || ""));
    });
  settingsPeopleList.replaceChildren(...visiblePeople.map((person) => buildPersonCard(person)));
}

function setPersonCreateExpanded(expanded) {
  if (!settingsPersonCreatePanel || !settingsPersonCreateToggle) return;
  settingsPersonCreatePanel.hidden = !expanded;
  settingsPersonCreateToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) settingsPersonName?.focus();
}

function resetPersonCreateForm() {
  if (settingsPersonName) settingsPersonName.value = "";
  if (settingsPersonUsername) settingsPersonUsername.value = "";
}

function initPeopleSettings() {
  if (!settingsPeopleList) return;
  settingsPersonCreateToggle?.addEventListener("click", () => {
    setPersonCreateExpanded(settingsPersonCreatePanel?.hidden !== false);
  });
  settingsPersonCreateCancel?.addEventListener("click", () => {
    resetPersonCreateForm();
    setPersonCreateExpanded(false);
  });
  settingsDefaultPersonFilter?.addEventListener("change", async () => {
    const person = getPeopleDirectory().find((entry) => entry.id === currentPerson?.id);
    if (!person) return;
    settingsDefaultPersonFilter.disabled = true;
    try {
      await requestPeople(`/api/people/${encodeURIComponent(person.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ defaultSessionPersonFilter: settingsDefaultPersonFilter.value }),
      });
      renderCurrentPersonSettings();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
      renderCurrentPersonSettings();
    }
  });
  settingsPersonCreate?.addEventListener("click", async () => {
    const name = settingsPersonName?.value.trim() || "";
    if (!name) return setPeopleStatus(t("settings.people.nameRequired"), { error: true });
    settingsPersonCreate.disabled = true;
    setPeopleStatus("");
    try {
      await requestPeople("/api/people", {
        method: "POST",
        body: JSON.stringify({
          name,
          handle: settingsPersonUsername?.value || "",
          credentialType: "none",
        }),
      });
      resetPersonCreateForm();
      setPersonCreateExpanded(false);
      setPeopleStatus(t("settings.people.added"));
      await renderPeopleSettings();
    } catch (error) {
      setPeopleStatus(error?.message || t("settings.people.saveFailed"), { error: true });
    } finally {
      settingsPersonCreate.disabled = false;
    }
  });
  void renderPeopleSettings();
}
function getCodexAuthCopy() {
  const isChinese = String(document.documentElement.lang || "").toLowerCase().startsWith("zh");
  return isChinese ? {
    title: "Codex 登录",
    checking: "检测中…",
    authenticated: "已登录",
    awaiting: "等待登录",
    loggedOut: "未登录",
    unavailable: "未安装 Codex",
    failed: "登录异常",
    check: "检查状态",
    start: "获取登录码",
    retry: "重新获取",
    open: "打开登录页",
    copy: "复制验证码",
    copied: "已复制",
    switchAccount: "更换账号",
    switching: "正在退出…",
    switchConfirm: "将清除当前实例的 Codex 登录，并立即生成新的登录码。确定继续吗？",
    logoutFailed: "Codex 退出失败",
    switchTimedOut: "切换请求超时，正在重新读取登录状态…",
    account: "当前账号",
    accountUnknown: "账号信息未提供",
    apiKey: "API Key 登录",
    usageChecking: "额度检测中…",
    usageIdle: "点击“检查状态”获取额度",
    usageUnavailable: "额度暂时无法获取，点击“检查状态”重试",
    usageUnsupported: "此登录方式未提供 Codex 订阅额度",
    updated: "额度更新于",
    reset: "重置",
    refreshDue: "已到重置时间，请检查状态",
    quota: "额度",
    remaining: "剩余",
    day: "天", hour: "小时", minute: "分钟",
  } : {
    title: "Codex login",
    checking: "Checking…",
    authenticated: "Signed in",
    awaiting: "Waiting for sign-in",
    loggedOut: "Signed out",
    unavailable: "Codex is not installed",
    failed: "Login issue",
    check: "Check status",
    start: "Get login code",
    retry: "Get a new code",
    open: "Open login page",
    copy: "Copy code",
    copied: "Copied",
    switchAccount: "Switch account",
    switching: "Signing out…",
    switchConfirm: "This clears the Codex login for this instance and immediately generates a new login code. Continue?",
    logoutFailed: "Codex logout failed",
    switchTimedOut: "Account switch timed out. Reloading login status…",
    account: "Current account",
    accountUnknown: "Account details not provided",
    apiKey: "API key sign-in",
    usageChecking: "Checking usage…",
    usageIdle: "Check status to load usage.",
    usageUnavailable: "Usage temporarily unavailable. Check status to retry.",
    usageUnsupported: "Codex subscription limits are not provided for this sign-in method.",
    updated: "Usage updated",
    reset: "Resets",
    refreshDue: "Reset time reached. Check status to refresh.",
    quota: "limit",
    remaining: "Remaining",
    day: "d", hour: "h", minute: "min",
  };
}

function ensureCodexAuthSection() {
  if (!settingsPanel || !canManageInstanceSettingsFromUi()) return null;
  let section = document.getElementById("settingsCodexAuthSection");
  if (section) return section;
  section = document.createElement("div");
  section.className = "settings-section";
  section.id = "settingsCodexAuthSection";
  section.innerHTML = `
    <div class="settings-section-title" id="settingsCodexAuthTitle"></div>
    <div class="settings-connector-status">
      <span class="settings-connector-pill pending" id="settingsCodexAuthPill"></span>
    </div>
    <div class="settings-codex-account" id="settingsCodexAuthAccount" hidden></div>
    <div class="settings-app-empty settings-codex-usage" id="settingsCodexAuthUsage" aria-live="polite" hidden></div>
    <div class="settings-app-actions">
      <button class="settings-app-btn" id="settingsCodexAuthCheckBtn" type="button"></button>
      <button class="settings-app-btn" id="settingsCodexAuthLoginBtn" type="button"></button>
      <button class="settings-app-btn" id="settingsCodexAuthSwitchBtn" type="button" hidden></button>
    </div>
    <div class="settings-app-card" id="settingsCodexAuthDevice" hidden>
      <div class="settings-app-name" id="settingsCodexAuthCode"></div>
      <div class="settings-app-actions">
        <a class="settings-app-btn" id="settingsCodexAuthLink" target="_blank" rel="noopener noreferrer"></a>
        <button class="settings-app-btn" id="settingsCodexAuthCopyBtn" type="button"></button>
      </div>
    </div>
    <div class="settings-app-empty inline-status" id="settingsCodexAuthError" hidden></div>
  `;
  settingsPanel.prepend(section);
  document.getElementById("settingsCodexAuthCheckBtn")?.addEventListener("click", () => {
    void refreshCodexAuthStatus({ force: true });
  });
  document.getElementById("settingsCodexAuthLoginBtn")?.addEventListener("click", () => {
    void startCodexDeviceLogin();
  });
  document.getElementById("settingsCodexAuthSwitchBtn")?.addEventListener("click", () => {
    void switchCodexAccount();
  });
  document.getElementById("settingsCodexAuthCopyBtn")?.addEventListener("click", async (event) => {
    const code = String(codexAuthState?.userCode || "");
    if (!code) return;
    if (typeof copyText === "function") await copyText(code);
    else await navigator.clipboard.writeText(code);
    const copy = getCodexAuthCopy();
    temporarilyUpdateButtonLabel(event.currentTarget, copy.copied, { resetLabel: copy.copy });
  });
  return section;
}

function stopCodexAuthPolling() {
  if (codexAuthPollTimer) window.clearInterval(codexAuthPollTimer);
  codexAuthPollTimer = null;
}

function startCodexAuthPolling() {
  if (codexAuthPollTimer) return;
  codexAuthPollTimer = window.setInterval(() => {
    void refreshCodexAuthStatus({ silent: true });
  }, 2500);
}

function renderCodexAuthPanel({ checking = false } = {}) {
  if (!ensureCodexAuthSection()) return;
  const copy = getCodexAuthCopy();
  const state = codexAuthState || {};
  const title = document.getElementById("settingsCodexAuthTitle");
  const pill = document.getElementById("settingsCodexAuthPill");
  const checkBtn = document.getElementById("settingsCodexAuthCheckBtn");
  const loginBtn = document.getElementById("settingsCodexAuthLoginBtn");
  const switchBtn = document.getElementById("settingsCodexAuthSwitchBtn");
  const device = document.getElementById("settingsCodexAuthDevice");
  const code = document.getElementById("settingsCodexAuthCode");
  const link = document.getElementById("settingsCodexAuthLink");
  const copyBtn = document.getElementById("settingsCodexAuthCopyBtn");
  const error = document.getElementById("settingsCodexAuthError");
  const accountInfo = document.getElementById("settingsCodexAuthAccount");
  const usageInfo = document.getElementById("settingsCodexAuthUsage");
  const awaiting = !state.loggedIn && state.deviceLoginActive && state.userCode;

  title.textContent = copy.title;
  checkBtn.textContent = copy.check;
  loginBtn.textContent = awaiting ? copy.retry : copy.start;
  loginBtn.hidden = state.loggedIn === true;
  loginBtn.disabled = checking || state.available === false;
  switchBtn.textContent = copy.switchAccount;
  switchBtn.hidden = state.loggedIn !== true;
  switchBtn.disabled = checking || state.available === false;
  checkBtn.disabled = checking;

  let statusLabel = copy.loggedOut;
  let tone = "pending";
  if (checking) statusLabel = copy.checking;
  else if (state.loggedIn) {
    statusLabel = copy.authenticated;
    tone = "ready";
  } else if (awaiting) statusLabel = copy.awaiting;
  else if (state.available === false) statusLabel = copy.unavailable;
  else if (state.phase === "failed") statusLabel = copy.failed;
  pill.className = `settings-connector-pill ${tone}`;
  pill.textContent = statusLabel;

  device.hidden = !awaiting;
  code.textContent = awaiting ? state.userCode : "";
  link.textContent = copy.open;
  link.href = awaiting ? state.verificationUri : "";
  copyBtn.textContent = copy.copy;
  error.hidden = !state.error;
  error.textContent = state.error || "";
  accountInfo.hidden = !state.loggedIn;
  usageInfo.hidden = !state.loggedIn;
  const account = state.account || {};
  const identity = [account.name, account.email].filter(Boolean).join(" · ");
  accountInfo.textContent = state.loggedIn
    ? `${copy.account}：${identity || (account.type === "apiKey" ? copy.apiKey : copy.accountUnknown)}${account.planType ? ` · ${account.planType}` : ""}` : "";
  usageInfo.textContent = state.loggedIn ? formatCodexUsage(state.usage, copy) : "";

  if (awaiting) startCodexAuthPolling();
  else stopCodexAuthPolling();
}

function formatCodexUsage(usage, copy) {
  if (usage?.status === "idle") return copy.usageIdle;
  if (!usage || usage.status === "checking") return copy.usageChecking;
  if (usage.status === "unsupported") return copy.usageUnsupported;
  if (usage.status !== "ready" || !usage.buckets?.length) return copy.usageUnavailable;
  const locale = document.documentElement.lang || undefined;
  const date = value => new Date(value).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const lines = [];
  for (const bucket of usage.buckets) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      const mins = window.windowDurationMins;
      const duration = !mins ? "" : mins % 1440 === 0 ? `${mins / 1440}${copy.day}`
        : mins % 60 === 0 ? `${mins / 60}${copy.hour}` : `${mins}${copy.minute}`;
      const prefix = usage.buckets.length > 1 || bucket.id !== "codex" ? `${bucket.name || bucket.id} · ` : "";
      const resetAt = Date.parse(window.resetsAt || "");
      const quota = Number.isFinite(resetAt) && resetAt <= Date.now() ? copy.refreshDue
        : `${copy.remaining} ${Number(window.remainingPercent.toFixed(1))}%${Number.isFinite(resetAt) ? ` · ${copy.reset} ${date(resetAt)}` : ""}`;
      lines.push(`${prefix}${duration} ${copy.quota}：${quota}`);
    }
  }
  if (usage.checkedAt) lines.push(`${copy.updated} ${date(usage.checkedAt)}`);
  return lines.join("\n");
}

async function refreshCodexUsage(requestId, { force = false } = {}) {
  if (!codexAuthState?.loggedIn || requestId !== codexAuthRequestId) return;
  try {
    const data = await fetchJsonOrRedirect(`/api/codex-auth/rate-limits${force ? "?refresh=1" : ""}`, { cache: "no-store", revalidate: false });
    if (requestId !== codexAuthRequestId) return;
    const usage = data?.codexUsage;
    codexAuthState.usage = usage?.accountRevision === codexAuthState.accountRevision ? usage : { status: "unavailable" };
  } catch {
    if (requestId !== codexAuthRequestId) return;
    codexAuthState.usage = { status: "unavailable" };
  }
  renderCodexAuthPanel();
}

async function refreshCodexAuthStatus({ silent = false, force = false, includeUsage = true } = {}) {
  if (!canManageInstanceSettingsFromUi()) return;
  const requestId = ++codexAuthRequestId;
  renderCodexAuthPanel({ checking: !silent });
  try {
    const data = await fetchJsonOrRedirect("/api/codex-auth/status", {
      cache: "no-store",
      revalidate: false,
    });
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = data?.codexAuth || {};
    if (!includeUsage) codexAuthState.usage = { status: "idle" };
  } catch (error) {
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = { phase: "failed", error: error?.message || "Codex status check failed" };
  }
  renderCodexAuthPanel();
  if (includeUsage) await refreshCodexUsage(requestId, { force });
}

async function startCodexDeviceLogin() {
  const requestId = ++codexAuthRequestId;
  const loginBtn = document.getElementById("settingsCodexAuthLoginBtn");
  if (loginBtn) loginBtn.disabled = true;
  try {
    const data = await fetchJsonOrRedirect("/api/codex-auth/device-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restart: true }),
      revalidate: false,
    });
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = data?.codexAuth || {};
  } catch (error) {
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = { phase: "failed", error: error?.message || "Codex login failed" };
  }
  renderCodexAuthPanel();
  await refreshCodexUsage(requestId);
}

async function switchCodexAccount() {
  const copy = getCodexAuthCopy();
  if (!window.confirm(copy.switchConfirm)) return;
  const requestId = ++codexAuthRequestId;
  stopCodexAuthPolling();
  codexAuthState = null;
  renderCodexAuthPanel({ checking: true });
  const switchBtn = document.getElementById("settingsCodexAuthSwitchBtn");
  if (switchBtn) {
    switchBtn.disabled = true;
    switchBtn.textContent = copy.switching;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CODEX_AUTH_MUTATION_TIMEOUT_MS);
  try {
    const data = await fetchJsonOrRedirect("/api/codex-auth/switch-account", {
      method: "POST",
      signal: controller.signal,
      revalidate: false,
    });
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = data?.codexAuth || {};
    renderCodexAuthPanel();
  } catch (error) {
    if (requestId !== codexAuthRequestId) return;
    codexAuthState = {
      phase: "failed",
      error: controller.signal.aborted ? copy.switchTimedOut : (error?.message || copy.logoutFailed),
    };
    renderCodexAuthPanel();
    await refreshCodexAuthStatus({ force: true, includeUsage: false });
  } finally {
    window.clearTimeout(timeout);
  }
}

function getPiAuthCopy() {
  const isChinese = String(document.documentElement.lang || "").toLowerCase().startsWith("zh");
  return isChinese ? {
    title: "Pi · OpenAI 登录",
    note: "Pi 复用本机 Codex 登录，不再维护第二套 OpenAI 账号。",
    checking: "检测中…",
    authenticated: "已同步",
    loggedOut: "未同步",
    unavailable: "未安装 Pi",
    failed: "同步异常",
    check: "检查状态",
    start: "同步 Codex 登录",
  } : {
    title: "Pi · OpenAI login",
    note: "Pi reuses this machine's Codex login instead of maintaining a second OpenAI account.",
    checking: "Checking…",
    authenticated: "Synced",
    loggedOut: "Not synced",
    unavailable: "Pi is not installed",
    failed: "Sync issue",
    check: "Check status",
    start: "Sync Codex login",
  };
}

function ensurePiAuthSection() {
  if (!settingsPanel || !canManageInstanceSettingsFromUi()) return null;
  let section = document.getElementById("settingsPiAuthSection");
  if (section) return section;
  section = document.createElement("div");
  section.className = "settings-section";
  section.id = "settingsPiAuthSection";
  section.innerHTML = `
    <div class="settings-section-title" id="settingsPiAuthTitle"></div>
    <div class="settings-section-note" id="settingsPiAuthNote"></div>
    <div class="settings-connector-status">
      <span class="settings-connector-pill pending" id="settingsPiAuthPill"></span>
    </div>
    <div class="settings-app-actions">
      <button class="settings-app-btn" id="settingsPiAuthCheckBtn" type="button"></button>
      <button class="settings-app-btn" id="settingsPiAuthLoginBtn" type="button"></button>
    </div>
    <div class="settings-app-empty inline-status" id="settingsPiAuthError" hidden></div>
  `;
  settingsPanel.prepend(section);
  document.getElementById("settingsPiAuthCheckBtn")?.addEventListener("click", () => {
    void refreshPiAuthStatus({ force: true });
  });
  document.getElementById("settingsPiAuthLoginBtn")?.addEventListener("click", () => {
    void syncPiCodexLogin();
  });
  return section;
}

function renderPiAuthPanel({ checking = false } = {}) {
  if (!ensurePiAuthSection()) return;
  const copy = getPiAuthCopy();
  const state = piAuthState || {};
  const title = document.getElementById("settingsPiAuthTitle");
  const note = document.getElementById("settingsPiAuthNote");
  const pill = document.getElementById("settingsPiAuthPill");
  const checkBtn = document.getElementById("settingsPiAuthCheckBtn");
  const loginBtn = document.getElementById("settingsPiAuthLoginBtn");
  const error = document.getElementById("settingsPiAuthError");

  title.textContent = copy.title;
  note.textContent = copy.note;
  checkBtn.textContent = copy.check;
  loginBtn.textContent = copy.start;
  loginBtn.hidden = state.loggedIn === true;
  loginBtn.disabled = checking || state.available === false;
  checkBtn.disabled = checking;

  let statusLabel = copy.loggedOut;
  let tone = "pending";
  if (checking) statusLabel = copy.checking;
  else if (state.loggedIn) {
    statusLabel = copy.authenticated;
    tone = "ready";
  } else if (state.available === false) statusLabel = copy.unavailable;
  else if (state.phase === "failed") statusLabel = copy.failed;
  pill.className = `settings-connector-pill ${tone}`;
  pill.textContent = statusLabel;

  error.hidden = !state.error;
  error.textContent = state.error || "";
}

async function refreshPiAuthStatus({ silent = false } = {}) {
  renderPiAuthPanel({ checking: !silent });
  try {
    const data = await fetchJsonOrRedirect("/api/pi-auth/status", {
      cache: "no-store",
      revalidate: false,
    });
    piAuthState = data?.piAuth || {};
  } catch (error) {
    piAuthState = { phase: "failed", error: error?.message || "Pi status check failed" };
  }
  renderPiAuthPanel();
}

async function syncPiCodexLogin() {
  const loginBtn = document.getElementById("settingsPiAuthLoginBtn");
  if (loginBtn) loginBtn.disabled = true;
  try {
    const data = await fetchJsonOrRedirect("/api/pi-auth/sync-codex", {
      method: "POST",
      revalidate: false,
    });
    piAuthState = data?.piAuth || {};
    if (
      piAuthState.loggedIn === true
      && selectedTool === "pi"
      && typeof loadModelsForCurrentTool === "function"
    ) {
      await loadModelsForCurrentTool({ refresh: true });
    }
  } catch (error) {
    piAuthState = { phase: "failed", error: error?.message || "Pi login sync failed" };
  }
  renderPiAuthPanel();
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
    : true;
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
  return config?.configured === true
    ? t("settings.voice.statusStored")
    : t("settings.voice.statusIncomplete");
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

let pushNotificationPermissionPending = false;
let pushNotificationPermissionError = "";

function supportsBrowserPushSettings() {
  return "Notification" in window && "PushManager" in window
    && Boolean(navigator.serviceWorker) && window.isSecureContext !== false;
}

function renderPushNotificationSettings() {
  const section = document.getElementById("settingsPushSection");
  const button = document.getElementById("settingsPushEnableBtn");
  const statusEl = document.getElementById("settingsPushStatus");
  if (!section || !button || !statusEl) return;
  section.hidden = !isPushFeatureEnabled();
  if (section.hidden) return;

  const supported = supportsBrowserPushSettings();
  const permission = supported ? Notification.permission : "default";
  const state = typeof getPushNotificationSetupState === "function"
    ? getPushNotificationSetupState()
    : { status: "idle", error: "" };
  const busy = pushNotificationPermissionPending || state.status === "registering";
  button.disabled = !supported || permission === "denied" || busy;
  button.textContent = t(busy ? "settings.push.enabling"
    : permission === "granted" ? "settings.push.reconnect" : "settings.push.enable");

  let statusKey = "settings.push.statusDefault";
  if (!supported) statusKey = "settings.push.statusUnsupported";
  else if (permission === "denied") statusKey = "settings.push.statusDenied";
  else if (pushNotificationPermissionPending && permission !== "granted") statusKey = "settings.push.statusRequesting";
  else if (pushNotificationPermissionError) statusKey = "settings.push.statusFailed";
  else if (permission === "granted") {
    statusKey = state.status === "subscribed" ? "settings.push.statusSubscribed"
      : state.status === "registering" ? "settings.push.statusRegistering"
      : state.status === "failed" ? "settings.push.statusFailed"
      : "settings.push.statusGranted";
  }
  statusEl.textContent = t(statusKey, { error: pushNotificationPermissionError || state.error });
}

async function enablePushNotificationsFromSettings() {
  if (!isPushFeatureEnabled() || !supportsBrowserPushSettings() || pushNotificationPermissionPending) return;
  pushNotificationPermissionPending = true;
  pushNotificationPermissionError = "";
  renderPushNotificationSettings();
  try {
    // Keep requestPermission in the click's activation stack, before any network/SW await.
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission === "granted") await setupPushNotifications();
  } catch (error) {
    pushNotificationPermissionError = error?.message || String(error);
  } finally {
    pushNotificationPermissionPending = false;
    renderPushNotificationSettings();
  }
}

function initPushNotificationSettings() {
  const button = document.getElementById("settingsPushEnableBtn");
  if (!button) return;
  renderPushNotificationSettings();
  if (button.dataset.bound !== "true") {
    button.addEventListener("click", enablePushNotificationsFromSettings);
    button.dataset.bound = "true";
  }
}

function renderInstallSettingsPanel() {
  const installBtn = document.getElementById("settingsInstallAppBtn");
  const statusEl = document.getElementById("settingsInstallStatus");
  if (!installBtn || !statusEl) return;

  const state = typeof window.remotelabGetInstallFlowState === "function"
    ? window.remotelabGetInstallFlowState()
    : { promptReady: false, standalone: false, mobileEligible: false };

  installBtn.disabled = false;
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
  return true;
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
  if (typeof getCurrentSession === "function") {
    return getCurrentSession();
  }
  return Array.isArray(sessions)
    ? sessions.find((session) => session?.id === currentSessionId) || null
    : null;
}

function renderSettingsSessionPresentationPanel() {
  if (!settingsSessionPresentationList) return;
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
ensureCodexAuthSection();
void refreshCodexAuthStatus({ includeUsage: false });
ensurePiAuthSection();
void refreshPiAuthStatus();
initThemeSettings();
initThinkingBlockDisplaySettings();
initSessionAutoArchiveSettings();
initPeopleSettings();
void initVoiceInputSettings();
initInstallSettings();
initPushNotificationSettings();
void renderSettingsConnectorsPanel();
renderSettingsSessionPresentationPanel();

if (tabSettings && tabSettings.dataset.connectorsBound !== "true") {
  tabSettings.addEventListener("click", () => {
    renderPushNotificationSettings();
    void refreshCodexAuthStatus({ force: true });
    void refreshPiAuthStatus({ force: true });
    void renderPeopleSettings({ refresh: true });
    void renderSettingsConnectorsPanel({ force: true });
  });
  tabSettings.dataset.connectorsBound = "true";
}

window.addEventListener("remotelab:localechange", () => {
  renderCodexAuthPanel();
  renderPiAuthPanel();
  if (uiLanguageSelect) {
    syncUiLanguageSelect();
  }
  syncThemeSelect();
  syncThinkingBlockDisplaySelect();
  syncSessionAutoArchiveSettings();
  void renderPeopleSettings();
  if (voiceInputSettingsLoaded) {
    syncVoiceInputSettings();
  }
  renderInstallSettingsPanel();
  renderPushNotificationSettings();
  void renderSettingsConnectorsPanel();
  renderSettingsSessionPresentationPanel();
});

window.addEventListener("remotelab:pushstatechange", renderPushNotificationSettings);
window.addEventListener("focus", renderPushNotificationSettings);

window.addEventListener("remotelab:themechange", () => {
  syncThemeSelect();
});

window.addEventListener("remotelab:thinkingblockdisplaychange", () => {
  syncThinkingBlockDisplaySelect();
});

window.addEventListener("remotelab:instancesettingschange", () => {
  syncSessionAutoArchiveSettings();
  syncVoiceInputSettings();
});

window.remotelabSetVoiceInputRuntimeStatus = function remotelabSetVoiceInputRuntimeStatus(message, { hidden = false } = {}) {
  setVoiceInputStatus(message, { hidden });
};

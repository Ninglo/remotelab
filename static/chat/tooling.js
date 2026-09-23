// ---- Thinking effort select ----
function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

let runtimePresetCatalog = [];

function canChangeRuntimeSelectionFromUi() {
  return typeof canChangeRuntimeSelection === "function"
    ? canChangeRuntimeSelection()
    : true;
}

function canPublishShareSnapshotsFromUi() {
  return typeof canPublishShareSnapshots === "function"
    ? canPublishShareSnapshots()
    : true;
}

function canForkSessionsFromUi() {
  return typeof canForkSessions === "function"
    ? canForkSessions()
    : true;
}

async function loadRuntimePresetCatalog() {
  try {
    const data = await fetchJsonOrRedirect('/api/runtime-presets', { revalidate: true });
    runtimePresetCatalog = Array.isArray(data?.presets) ? data.presets : [];
  } catch (error) {
    runtimePresetCatalog = [];
    console.warn('[runtime-presets] Failed to load presets:', error?.message || error);
  }
  syncRuntimePresetUi();
}

function inferCurrentRuntimePreset(session) {
  const storedTier = typeof session?.runtimeTier === 'string' ? session.runtimeTier : '';
  if (runtimePresetCatalog.some((preset) => preset.id === storedTier)) return storedTier;
  const exact = runtimePresetCatalog.find((preset) => (
    preset.model === session?.model
    && (preset.effort || '') === (session?.effort || '')
  ));
  return exact?.id || 'custom';
}

function syncRuntimePresetUi() {
  if (!runtimePresetSelect) return;
  const session = typeof getCurrentSession === 'function' ? getCurrentSession() : null;
  const visible = Boolean(
    currentSessionId
    && session
    && !isQuickSessionUi(session)
    && session.tool === 'codex'
    && session.model !== 'auto'
    && runtimePresetCatalog.length > 0
  );
  runtimePresetSelect.hidden = !visible;
  if (!visible) return;
  runtimePresetSelect.innerHTML = '';
  for (const preset of runtimePresetCatalog) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = t(`tooling.preset.${preset.id}`);
    option.title = `${preset.model} / ${preset.effort}`;
    runtimePresetSelect.appendChild(option);
  }
  const inferred = inferCurrentRuntimePreset(session);
  if (inferred === 'custom') {
    const option = document.createElement('option');
    option.value = 'custom';
    option.textContent = t('tooling.preset.custom');
    option.disabled = true;
    runtimePresetSelect.appendChild(option);
  }
  runtimePresetSelect.value = inferred;
}

runtimePresetSelect?.addEventListener('change', () => {
  if (!currentSessionId || runtimePresetSelect.value === 'custom') return;
  dispatchAction({
    action: 'session_preferences',
    sessionId: currentSessionId,
    runtimeTier: runtimePresetSelect.value,
  });
});

function cloneReasoningState(reasoning, fallbackLabel = t("tooling.thinking")) {
  if (!reasoning || typeof reasoning !== "object") return null;
  const kind = String(reasoning.kind || "").trim().toLowerCase();
  const label = String(reasoning.label || fallbackLabel).trim() || fallbackLabel;
  if (kind === "enum") {
    const levels = [...new Set(
      (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((level) => String(level || "").trim())
        .filter(Boolean),
    )];
    if (levels.length === 0) return null;
    const defaultValue = String(
      reasoning.default || reasoning.defaultReasoning || reasoning.defaultEffort || levels[0],
    ).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === "none") {
    return { kind, label };
  }
  return null;
}

function findCurrentToolModelRecord(modelId = selectedModel) {
  if (!Array.isArray(currentToolModels) || currentToolModels.length === 0) return null;
  if (modelId) {
    const matched = currentToolModels.find((model) => model.id === modelId);
    if (matched) return matched;
  }
  return currentToolModels[0] || null;
}

function resolveActiveReasoningState(modelId = selectedModel) {
  const fallbackReasoning =
    cloneReasoningState(currentToolBaseReasoning)
    || { kind: "none", label: t("tooling.thinking") };
  const modelData = findCurrentToolModelRecord(modelId);
  const modelReasoning = cloneReasoningState(modelData?.reasoning, fallbackReasoning.label);
  return {
    modelData,
    reasoning: modelReasoning || fallbackReasoning,
  };
}

function applyCurrentModelReasoningUi({ sessionPreferences = null, preserveCurrentSelection = false } = {}) {
  const { modelData, reasoning } = resolveActiveReasoningState();
  currentToolReasoningKind = reasoning.kind || "none";
  currentToolReasoningLabel = reasoning.label || t("tooling.thinking");
  currentToolReasoningDefault =
    currentToolReasoningKind === "enum"
      ? (reasoning.default || null)
      : null;
  currentToolEffortLevels =
    currentToolReasoningKind === "enum"
      ? reasoning.levels || []
      : null;
  if (currentToolReasoningKind === "enum") {
    effortSelect.style.display = "";
    effortSelect.innerHTML = "";
    for (const level of currentToolEffortLevels) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = level;
      effortSelect.appendChild(opt);
    }

    const storedModelEffort = selectedTool && modelData?.id
      ? (localStorage.getItem(`selectedEffort_${selectedTool}_${modelData.id}`) || "")
      : "";
    const storedEffort = storedModelEffort || (selectedTool
      ? (localStorage.getItem(`selectedEffort_${selectedTool}`) || "")
      : "");
    const preferredEffort = sessionPreferences?.hasEffort
      ? sessionPreferences.effort
      : preserveCurrentSelection
        ? (selectedEffort || storedEffort)
        : storedEffort;
    const modelDefaultEffort = modelData?.defaultEffort || modelData?.defaultReasoning || "";

    if (preferredEffort && currentToolEffortLevels.includes(preferredEffort)) {
      effortSelect.value = preferredEffort;
      selectedEffort = preferredEffort;
    } else if (modelDefaultEffort && currentToolEffortLevels.includes(modelDefaultEffort)) {
      effortSelect.value = modelDefaultEffort;
      selectedEffort = modelDefaultEffort;
    } else if (
      currentToolReasoningDefault
      && currentToolEffortLevels.includes(currentToolReasoningDefault)
    ) {
      effortSelect.value = currentToolReasoningDefault;
      selectedEffort = currentToolReasoningDefault;
    } else if (currentToolEffortLevels[0]) {
      effortSelect.value = currentToolEffortLevels[0];
      selectedEffort = currentToolEffortLevels[0];
    } else {
      selectedEffort = "";
    }
    return;
  }

  selectedEffort = null;
  effortSelect.style.display = "none";
}

function getAttachedSessionToolPreferences(toolId = selectedTool) {
  const session = getCurrentSession();
  if (!session || !toolId || session.tool !== toolId) return null;
  return {
    hasModel: Object.prototype.hasOwnProperty.call(session, "model"),
    model: typeof session.model === "string" ? session.model : "",
    hasEffort: Object.prototype.hasOwnProperty.call(session, "effort"),
    effort: typeof session.effort === "string" ? session.effort : "",
  };
}

function persistCurrentSessionToolPreferences() {
  if (!canChangeRuntimeSelectionFromUi() || !currentSessionId || !selectedTool) return;
  const payload = {
    action: "session_preferences",
    sessionId: currentSessionId,
    tool: selectedTool,
    model: selectedModel || "",
    effort: selectedEffort || "",
  };
  dispatchAction(payload);
}

effortSelect.addEventListener("change", () => {
  selectedEffort = effortSelect.value;
  if (selectedTool) localStorage.setItem(`selectedEffort_${selectedTool}`, selectedEffort);
  if (selectedTool && selectedModel) {
    localStorage.setItem(`selectedEffort_${selectedTool}_${selectedModel}`, selectedEffort);
  }
  persistCurrentSessionToolPreferences();
});
// ---- Inline tool select ----
function slugifyToolValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "my-tool";
}

function getSelectedToolDefinition(toolId = selectedTool) {
  return toolsList.find((tool) => tool.id === toolId) || null;
}

function parseModelLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const id = String(parts.shift() || "").trim();
      const label = String(parts.join("|") || id).trim() || id;
      return id ? { id, label } : null;
    })
    .filter(Boolean);
}

function parseReasoningLevels(raw) {
  return [...new Set(
    String(raw || "")
      .split(",")
      .map((level) => level.trim())
      .filter(Boolean),
  )];
}

function setAddToolStatus(message = "", tone = "") {
  if (!addToolStatus) return;
  addToolStatus.textContent = message;
  addToolStatus.className = `provider-helper-status${tone ? ` ${tone}` : ""}`;
}

function syncQuickAddControls() {
  const family = addToolRuntimeFamilySelect?.value || "claude-stream-json";
  const allowedKinds = ["enum", "none"];

  for (const opt of addToolReasoningKindSelect.options) {
    const allowed = allowedKinds.includes(opt.value);
    opt.disabled = !allowed;
    opt.hidden = !allowed;
  }
  if (!allowedKinds.includes(addToolReasoningKindSelect.value)) {
    addToolReasoningKindSelect.value = allowedKinds[0];
  }

  const showLevels = addToolReasoningKindSelect.value === "enum";
  const levelsField = addToolReasoningLevelsInput.closest(".provider-helper-field");
  addToolReasoningLevelsInput.disabled = !showLevels;
  if (levelsField) levelsField.style.opacity = showLevels ? "1" : "0.55";
  if (family === "codex-json" && !addToolReasoningLevelsInput.value.trim()) {
    addToolReasoningLevelsInput.value = "low, medium, high, xhigh";
  }
}

function getAddToolDraft() {
  const name = (addToolNameInput?.value || "").trim() || "My Tool";
  const command = (addToolCommandInput?.value || "").trim() || "my-tool";
  const runtimeFamily =
    addToolRuntimeFamilySelect?.value || "claude-stream-json";
  const models = parseModelLines(addToolModelsInput?.value || "");
  const reasoningKind = addToolReasoningKindSelect?.value || "enum";
  const reasoning = { kind: reasoningKind, label: t("tooling.thinking") };
  if (reasoningKind === "enum") {
    reasoning.levels = parseReasoningLevels(addToolReasoningLevelsInput?.value || "")
      .length > 0
      ? parseReasoningLevels(addToolReasoningLevelsInput?.value || "")
      : ["low", "medium", "high", "xhigh"];
    reasoning.default = reasoning.levels[0];
  }

  return {
    name,
    command,
    runtimeFamily,
    commandSlug: slugifyToolValue(command),
    models,
    reasoning,
  };
}

function buildProviderBasePrompt() {
  const draft = getAddToolDraft();
  const modelLines = draft.models.length > 0
    ? draft.models.map((model) => `- ${model.id}${model.label !== model.id ? ` | ${model.label}` : ""}`).join("\n")
    : "- none configured yet";
  const reasoningLine = draft.reasoning.kind === "enum"
    ? `${draft.reasoning.kind} (${draft.reasoning.levels.join(", ")})`
    : draft.reasoning.kind;
  return [
    `I want to add a new tool/provider to RemoteLab.`,
    ``,
    `Target tool`,
    `- Name: ${draft.name}`,
    `- Command: ${draft.command}`,
    `- Derived ID / slug: ${draft.commandSlug}`,
    `- Runtime family: ${draft.runtimeFamily}`,
    `- Reasoning mode: ${reasoningLine}`,
    `- Models:`,
    modelLines,
    ``,
    `Work in the RemoteLab repo root (usually \`~/code/remotelab\`; adjust if your checkout lives elsewhere).`,
    `Read \`AGENTS.md\` (legacy \`CLAUDE.md\` is only a compatibility shim) and \`notes/directional/provider-architecture.md\` first.`,
    ``,
    `Please:`,
    `1. Decide whether this can stay a simple provider bound to an existing runtime family or needs full provider code.`,
    `2. If simple config is enough, explain the minimal runtimeFamily/models/reasoning config that should be saved.`,
    `3. If the command is not compatible with the runtime family's normal CLI flags, implement the minimal arg-mapping/provider code needed to make it work.`,
    `4. If full provider support is needed (models, thinking, runtime, parser, resume handling), implement the minimal code changes in the repo.`,
    `5. Keep changes surgical, update docs if needed, and validate the flow end-to-end.`,
    ``,
    `Do not stop at planning — apply the changes if they are clear.`,
  ].join("\n");
}

function updateCopyButtonLabel(button, label) {
  if (!button) return;
  const original = button.dataset.originalLabel || getHeaderActionButtonLabel(button);
  button.dataset.originalLabel = original;
  if (button.dataset.originalTitle === undefined) {
    button.dataset.originalTitle = getHeaderActionButtonAttribute(button, "title");
  }
  if (button.dataset.originalAriaLabel === undefined) {
    button.dataset.originalAriaLabel = getHeaderActionButtonAttribute(button, "aria-label");
  }
  setHeaderActionButtonLabel(button, label);
  window.clearTimeout(button._copyResetTimer);
  button._copyResetTimer = window.setTimeout(() => {
    setHeaderActionButtonLabel(button, button.dataset.originalLabel || original);
    restoreHeaderActionButtonAccessibility(button);
  }, 1400);
}

function getHeaderActionButtonLabelNode(button) {
  if (!button || typeof button.querySelector !== "function") return null;
  const labelNode = button.querySelector(".header-action-label");
  if (!labelNode) return null;
  if (labelNode.classList && typeof labelNode.classList.contains === "function") {
    return labelNode.classList.contains("header-action-label") ? labelNode : null;
  }
  if (typeof labelNode.matches === "function") {
    return labelNode.matches(".header-action-label") ? labelNode : null;
  }
  return labelNode;
}

function getHeaderActionButtonLabel(button) {
  const labelNode = getHeaderActionButtonLabelNode(button);
  return labelNode ? labelNode.textContent : button?.textContent || "";
}

function getHeaderActionButtonAttribute(button, name) {
  if (!button) return "";
  if (typeof button.getAttribute === "function") {
    return button.getAttribute(name) || "";
  }
  return typeof button[name] === "string" ? button[name] : "";
}

function setHeaderActionButtonAttribute(button, name, value) {
  if (!button) return;
  if (typeof button.setAttribute === "function") {
    button.setAttribute(name, value);
    return;
  }
  button[name] = value;
}

function removeHeaderActionButtonAttribute(button, name) {
  if (!button) return;
  if (typeof button.removeAttribute === "function") {
    button.removeAttribute(name);
    return;
  }
  delete button[name];
}

function setHeaderActionButtonLabel(button, label) {
  if (!button) return;
  const labelNode = getHeaderActionButtonLabelNode(button);
  if (labelNode) {
    labelNode.textContent = label;
  } else {
    button.textContent = label;
  }
  setHeaderActionButtonAttribute(button, "title", label);
  setHeaderActionButtonAttribute(button, "aria-label", label);
}

function restoreHeaderActionButtonAccessibility(button) {
  if (!button) return;
  if (button.dataset.originalTitle !== undefined) {
    if (button.dataset.originalTitle) {
      setHeaderActionButtonAttribute(button, "title", button.dataset.originalTitle);
    } else {
      removeHeaderActionButtonAttribute(button, "title");
    }
  }
  if (button.dataset.originalAriaLabel !== undefined) {
    if (button.dataset.originalAriaLabel) {
      setHeaderActionButtonAttribute(button, "aria-label", button.dataset.originalAriaLabel);
    } else {
      removeHeaderActionButtonAttribute(button, "aria-label");
    }
  }
}

function getToolingLabel(key, vars) {
  if (typeof t === "function") return t(key, vars);
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

function resetHeaderActionButton(button) {
  if (!button) return;
  button.disabled = false;
  window.clearTimeout(button._copyResetTimer);
  if (button.dataset.originalLabel) {
    setHeaderActionButtonLabel(button, button.dataset.originalLabel);
  }
  restoreHeaderActionButtonAccessibility(button);
}

function syncShareButton() {
  if (!shareSnapshotBtn) return;
  const publishShareSnapshotsEnabled = typeof canPublishShareSnapshots === "function"
    ? canPublishShareSnapshots()
    : true;
  const visible = publishShareSnapshotsEnabled && !!currentSessionId;
  shareSnapshotBtn.style.display = visible ? "" : "none";
  if (!visible) {
    resetHeaderActionButton(shareSnapshotBtn);
  }
}

function syncForkButton() {
  if (!forkSessionBtn) return;
  const forkSessionsEnabled = typeof canForkSessions === "function"
    ? canForkSessions()
    : true;
  const visible = forkSessionsEnabled && !!currentSessionId;
  forkSessionBtn.style.display = visible ? "" : "none";
  if (!visible) {
    resetHeaderActionButton(forkSessionBtn);
    return;
  }
  const session = getCurrentSession();
  const activity = getSessionActivity(session);
  forkSessionBtn.disabled = !session || activity.run.state === "running" || activity.compact.state === "pending";
}

function getShareSnapshotTitle(session) {
  const name = typeof session?.name === "string" ? session.name.trim() : "";
  if (name) return name;
  const tool = typeof session?.tool === "string" ? session.tool.trim() : "";
  if (tool) return tool;
  return `RemoteLab ${getToolingLabel("status.readOnlySnapshot")}`;
}

function buildShareSnapshotShareText(session, shareUrl) {
  const title = getShareSnapshotTitle(session);
  const link = typeof shareUrl === "string" ? shareUrl.trim() : "";
  return link ? `${title}\n${link}` : title;
}

function getShareSnapshotBaseUrl() {
  if (typeof window.remotelabGetProductBaseUrl === "function") {
    return window.remotelabGetProductBaseUrl();
  }
  if (typeof document === "object" && typeof document.baseURI === "string" && document.baseURI) {
    return document.baseURI;
  }
  if (typeof location === "object" && typeof location.href === "string" && location.href) {
    return location.href;
  }
  return location.origin;
}

async function shareCurrentSessionSnapshot() {
  const publishShareSnapshotsEnabled = typeof canPublishShareSnapshots === "function"
    ? canPublishShareSnapshots()
    : true;
  if (!currentSessionId || !publishShareSnapshotsEnabled || !shareSnapshotBtn) return;

  const currentSession = getCurrentSession();
  shareSnapshotBtn.disabled = true;

  try {
    const shareEndpoint = typeof window.remotelabResolveProductPath === "function"
      ? window.remotelabResolveProductPath(`/api/sessions/${encodeURIComponent(currentSessionId)}/share`)
      : `/api/sessions/${encodeURIComponent(currentSessionId)}/share`;
    const res = await fetch(shareEndpoint, {
      method: "POST",
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {}

    const shareUrl = payload?.share?.url
      ? new URL(payload.share.url, getShareSnapshotBaseUrl()).toString()
      : null;
    const shareText = buildShareSnapshotShareText(currentSession, shareUrl);

    if (!res.ok || !shareUrl) {
      throw new Error(payload?.error || "Failed to create share link");
    }

    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
        updateCopyButtonLabel(shareSnapshotBtn, getToolingLabel("action.share"));
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }

    try {
      await copyText(shareText);
      updateCopyButtonLabel(shareSnapshotBtn, getToolingLabel("action.copied"));
    } catch {
      window.prompt("Copy share text", shareText);
      updateCopyButtonLabel(shareSnapshotBtn, getToolingLabel("action.copy"));
    }
  } catch (err) {
    console.warn("[share] Failed to create snapshot:", err.message);
    updateCopyButtonLabel(shareSnapshotBtn, getToolingLabel("action.copyFailed"));
  } finally {
    shareSnapshotBtn.disabled = false;
    syncShareButton();
  }
}

async function forkCurrentSession() {
  const forkSessionsEnabled = typeof canForkSessions === "function"
    ? canForkSessions()
    : true;
  if (!currentSessionId || !forkSessionsEnabled || !forkSessionBtn) return;

  const original = forkSessionBtn.dataset.originalLabel || forkSessionBtn.textContent;
  forkSessionBtn.dataset.originalLabel = original;
  forkSessionBtn.disabled = true;
  forkSessionBtn.textContent = `${getToolingLabel("action.fork")}…`;

  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/fork`, {
      method: "POST",
    });
    if (data.session) {
      upsertSession(data.session);
      renderSessionList();
      updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.fork"));
    } else {
      updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.copyFailed"));
    }
  } catch (err) {
    console.warn("[fork] Failed to fork session:", err.message);
    updateCopyButtonLabel(forkSessionBtn, getToolingLabel("action.copyFailed"));
  } finally {
    syncForkButton();
  }
}

function syncAddToolModal() {
  if (!providerPromptCode) return;
  syncQuickAddControls();
  providerPromptCode.textContent = buildProviderBasePrompt();
}

function openAddToolModal() {
  if (!canChangeRuntimeSelectionFromUi()) return;
  if (!addToolModal) return;
  if (!addToolNameInput.value.trim()) addToolNameInput.value = "My Tool";
  if (!addToolCommandInput.value.trim()) {
    addToolCommandInput.value = "my-tool";
  }
  const selectedToolDef = getSelectedToolDefinition();
  if (selectedToolDef?.runtimeFamily) {
    addToolRuntimeFamilySelect.value = selectedToolDef.runtimeFamily;
  }
  setAddToolStatus("");
  syncAddToolModal();
  addToolModal.hidden = false;
  addToolNameInput.focus();
  addToolNameInput.select();
}

function closeAddToolModal() {
  if (!addToolModal) return;
  addToolModal.hidden = true;
}

async function saveSimpleToolConfig() {
  if (isSavingToolConfig) return;
  const draft = getAddToolDraft();

  if (!draft.command) {
    setAddToolStatus("Command is required.", "error");
    addToolCommandInput.focus();
    return;
  }

  isSavingToolConfig = true;
  saveToolConfigBtn.disabled = true;
  setAddToolStatus("Saving and refreshing picker...");

  try {
    const data = await fetchJsonOrRedirect("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });

    const savedTool = data.tool;
    if (savedTool?.id) {
      selectedTool = savedTool.id;
      preferredTool = savedTool.id;
      localStorage.setItem("preferredTool", preferredTool);
      localStorage.setItem("selectedTool", selectedTool);
    }

    await loadInlineTools({ skipModelLoad: true });
    if (selectedTool) {
      await loadModelsForCurrentTool({ refresh: true });
    }

    if (savedTool?.available) {
      setAddToolStatus("Saved. The new tool is ready in the picker.", "success");
      closeAddToolModal();
    } else {
      setAddToolStatus(
        "Saved, but the command is not currently available on PATH, so it will stay hidden until the binary is available.",
        "error",
      );
    }
  } catch (err) {
    setAddToolStatus(err.message || "Failed to save tool config", "error");
  } finally {
    isSavingToolConfig = false;
    saveToolConfigBtn.disabled = false;
    syncAddToolModal();
  }
}

function renderInlineToolOptions(selectedValue, emptyMessage = "No tools found") {
  inlineToolSelect.disabled = !canChangeRuntimeSelectionFromUi();
  inlineToolSelect.innerHTML = "";

  if (toolsList.length === 0) {
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = emptyMessage;
    emptyOpt.disabled = true;
    emptyOpt.selected = true;
    inlineToolSelect.appendChild(emptyOpt);
  } else {
    for (const tool of toolsList) {
      const opt = document.createElement("option");
      opt.value = tool.id;
      opt.textContent = tool.name;
      inlineToolSelect.appendChild(opt);
    }
  }

  const addMoreOpt = document.createElement("option");
  addMoreOpt.value = ADD_MORE_TOOL_VALUE;
  addMoreOpt.textContent = t("tooling.addMore");
  inlineToolSelect.appendChild(addMoreOpt);

  if (selectedValue && toolsList.some((tool) => tool.id === selectedValue)) {
    inlineToolSelect.value = selectedValue;
  } else if (toolsList[0]) {
    inlineToolSelect.value = toolsList[0].id;
  }
}

function getVisiblePrimaryToolOptions() {
  return prioritizeToolOptions(
    filterPrimaryToolOptions(
      (Array.isArray(allToolsList) ? allToolsList : []).filter((tool) => tool?.available),
    ),
  );
}

function refreshPrimaryToolPicker({ keepToolIds = [], selectedValue = "" } = {}) {
  toolsList = getVisiblePrimaryToolOptions();
  const resolvedTool = resolvePreferredToolId(toolsList, [
    selectedValue,
    ...(Array.isArray(keepToolIds) ? keepToolIds : [keepToolIds]),
    selectedTool,
    preferredTool,
  ]);
  renderInlineToolOptions(resolvedTool);
  return resolvedTool;
}

const modelResponseCache = new Map();
const pendingModelResponseRequests = new Map();

async function fetchModelResponse(toolId, { refresh = false } = {}) {
  if (!toolId) {
    return {
      models: [],
      effortLevels: null,
      defaultModel: null,
      reasoning: { kind: "none", label: t("tooling.thinking") },
    };
  }

  if (!refresh && modelResponseCache.has(toolId)) {
    return modelResponseCache.get(toolId);
  }

  if (!refresh && pendingModelResponseRequests.has(toolId)) {
    return pendingModelResponseRequests.get(toolId);
  }

  const refreshQuery = refresh ? "&refresh=1" : "";
  const request = fetchJsonOrRedirect(`/api/models?tool=${encodeURIComponent(toolId)}${refreshQuery}`, {
    revalidate: !refresh,
  })
    .then((data) => {
      modelResponseCache.set(toolId, data);
      return data;
    })
    .finally(() => {
      pendingModelResponseRequests.delete(toolId);
    });

  pendingModelResponseRequests.set(toolId, request);
  return request;
}

async function loadInlineTools({ skipModelLoad = false } = {}) {
  if (!canChangeRuntimeSelectionFromUi()) {
    allToolsList = [];
    toolsList = [];
    selectedModel = null;
    selectedEffort = null;
    inlineToolSelect.disabled = true;
    inlineToolSelect.innerHTML = "";
    return;
  }
  try {
    await loadRuntimePresetCatalog();
    const data = await fetchJsonOrRedirect("/api/tools");
    allToolsList = Array.isArray(data.tools) ? data.tools : [];
    const initialTool = refreshPrimaryToolPicker();
    if (initialTool) {
      selectedTool = initialTool;
      if (!preferredTool) {
        preferredTool = initialTool;
        localStorage.setItem("preferredTool", preferredTool);
      }
    }
    if (!skipModelLoad) {
      await loadModelsForCurrentTool();
    }
  } catch (err) {
    allToolsList = [];
    toolsList = [];
    console.warn("[tools] Failed to load tools:", err.message);
    renderInlineToolOptions("", "Failed to load tools");
  }
}

inlineToolSelect.addEventListener("change", async () => {
  const nextTool = inlineToolSelect.value;
  if (nextTool === ADD_MORE_TOOL_VALUE) {
    renderInlineToolOptions(resolvePreferredToolId(toolsList, [selectedTool, preferredTool]));
    openAddToolModal();
    return;
  }

  selectedTool = nextTool;
  preferredTool = selectedTool;
  localStorage.setItem("preferredTool", preferredTool);
  localStorage.setItem("selectedTool", selectedTool);
  await loadModelsForCurrentTool();
  persistCurrentSessionToolPreferences();
});

// ---- Provider / model select ----
function getModelProviderId(model) {
  const explicitProvider = String(model?.provider || "").trim();
  if (explicitProvider) return explicitProvider;
  const id = String(model?.id || "").trim();
  const separator = id.indexOf("/");
  return separator > 0 ? id.slice(0, separator) : "";
}

function getModelProviderLabel(model, providerId) {
  const explicitLabel = String(model?.providerLabel || "").trim();
  if (explicitLabel) return explicitLabel;
  return String(providerId || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPiProviderCatalog() {
  const providers = [];
  const seen = new Set();
  for (const model of currentToolModels) {
    const id = getModelProviderId(model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    providers.push({ id, label: getModelProviderLabel(model, id) || id });
  }
  return providers;
}

function getPiModelsForProvider(providerId) {
  return currentToolModels.filter((model) => getModelProviderId(model) === providerId);
}

function renderInlineProviderOptions(providers, selectedValue) {
  inlineProviderSelect.innerHTML = "";
  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    inlineProviderSelect.appendChild(option);
  }
  inlineProviderSelect.value = providers.some((provider) => provider.id === selectedValue)
    ? selectedValue
    : providers[0]?.id || "";
  inlineProviderSelect.style.display = providers.length > 1 ? "" : "none";
}

function renderInlineModelOptions(models, { includeDefault = true, selectedValue = "" } = {}) {
  inlineModelSelect.innerHTML = "";
  if (includeDefault) {
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = t("tooling.defaultModel");
    inlineModelSelect.appendChild(defaultOption);
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    inlineModelSelect.appendChild(option);
  }
  inlineModelSelect.value = models.some((model) => model.id === selectedValue)
    ? selectedValue
    : (includeDefault ? "" : models[0]?.id || "");
}

function resetCurrentModelPickerUi() {
  currentToolModels = [];
  currentToolBaseReasoning = { kind: "none", label: t("tooling.thinking") };
  currentToolEffortLevels = null;
  currentToolReasoningKind = "none";
  currentToolReasoningLabel = t("tooling.thinking");
  currentToolReasoningDefault = null;
  selectedModelProvider = "";
  selectedEffort = null;
  inlineProviderSelect.innerHTML = "";
  inlineProviderSelect.style.display = "none";
  inlineModelSelect.innerHTML = "";
  inlineModelSelect.style.display = "none";
  effortSelect.style.display = "none";
  if (runtimePresetSelect) runtimePresetSelect.hidden = true;
}

async function loadModelsForCurrentTool({ refresh = false } = {}) {
  if (!canChangeRuntimeSelectionFromUi()) {
    resetCurrentModelPickerUi();
    return;
  }
  const toolId = selectedTool;
  if (!toolId) {
    selectedModel = null;
    resetCurrentModelPickerUi();
    return;
  }
  try {
    const sessionPreferences = getAttachedSessionToolPreferences(toolId);
    const data = await fetchModelResponse(toolId, { refresh });
    if (selectedTool !== toolId) return;
    currentToolModels = data.models || [];
    currentToolBaseReasoning =
      cloneReasoningState(data.reasoning)
      || (data.effortLevels
        ? {
          kind: "enum",
          label: t("tooling.thinking"),
          levels: data.effortLevels || [],
          default: data.effortLevels?.[0] || null,
        }
        : { kind: "none", label: t("tooling.thinking") });

    const rawSavedModel = localStorage.getItem(`selectedModel_${toolId}`) || "";
    const savedModel = toolId === "codex" && typeof normalizeStoredCodexModelId === "function"
      ? normalizeStoredCodexModelId(rawSavedModel)
      : rawSavedModel;
    if (savedModel !== rawSavedModel) {
      localStorage.setItem(`selectedModel_${toolId}`, savedModel);
    }
    const concreteCodex = toolId === "codex"
      && typeof getActiveRuntimeModeUi === "function"
      && getActiveRuntimeModeUi() !== "auto";
    const visibleModels = concreteCodex ? currentToolModels.filter((model) => model.id !== "auto") : currentToolModels;
    const defaultModel = concreteCodex ? "gpt-6-sol" : data.defaultModel || "";
    const attachedModel = sessionPreferences?.hasModel ? sessionPreferences.model : "";
    const requestedModel = concreteCodex && attachedModel === "auto"
      ? defaultModel
      : attachedModel || (!currentSessionId ? defaultModel : savedModel);

    if (toolId === "pi") {
      const providers = getPiProviderCatalog();
      const requestedRecord = currentToolModels.find((model) => model.id === requestedModel);
      const defaultRecord = currentToolModels.find((model) => model.id === defaultModel);
      const storedProvider = localStorage.getItem(`selectedProvider_${toolId}`) || "";
      selectedModelProvider = getModelProviderId(requestedRecord)
        || (providers.some((provider) => provider.id === storedProvider) ? storedProvider : "")
        || getModelProviderId(defaultRecord)
        || providers[0]?.id
        || "";
      renderInlineProviderOptions(providers, selectedModelProvider);

      const providerModels = getPiModelsForProvider(selectedModelProvider);
      const providerSavedModel = localStorage.getItem(
        `selectedModel_${toolId}_${selectedModelProvider}`,
      ) || "";
      const providerDefaultModel = providerModels.find((model) => model.providerDefault)?.id || "";
      selectedModel = [attachedModel, providerDefaultModel, providerSavedModel, defaultModel, savedModel]
        .find((candidate) => providerModels.some((model) => model.id === candidate))
        || providerModels[0]?.id
        || "";
      renderInlineModelOptions(providerModels, {
        includeDefault: false,
        selectedValue: selectedModel,
      });
    } else {
      selectedModelProvider = "";
      inlineProviderSelect.innerHTML = "";
      inlineProviderSelect.style.display = "none";
      selectedModel = requestedModel;
      if (!selectedModel || !visibleModels.some((model) => model.id === selectedModel)) {
        selectedModel = visibleModels.some((model) => model.id === defaultModel)
          ? defaultModel
          : visibleModels[0]?.id || "";
      }
      renderInlineModelOptions(visibleModels, {
        includeDefault: !concreteCodex,
        selectedValue: selectedModel,
      });
    }

    inlineModelSelect.style.display = (currentToolModels.length > 0 || toolId === "codex") ? "" : "none";
    applyCurrentModelReasoningUi({ sessionPreferences });
    syncRuntimePresetUi();
    // Runtime controls belong to the attached Session or pending draft. The
    // next draft always starts again from the immutable Auto default.
  } catch (error) {
    console.warn("[models] Failed to load model picker:", error?.message || error);
    resetCurrentModelPickerUi();
  }
}

inlineProviderSelect.addEventListener("change", () => {
  if (selectedTool !== "pi") return;
  selectedModelProvider = inlineProviderSelect.value || "";
  localStorage.setItem(`selectedProvider_${selectedTool}`, selectedModelProvider);
  const providerModels = getPiModelsForProvider(selectedModelProvider);
  const providerDefaultModel = providerModels.find((model) => model.providerDefault)?.id || "";
  selectedModel = providerDefaultModel || providerModels[0]?.id || "";
  renderInlineModelOptions(providerModels, {
    includeDefault: false,
    selectedValue: selectedModel,
  });
  localStorage.setItem(`selectedModel_${selectedTool}`, selectedModel);
  if (selectedModel) {
    localStorage.setItem(`selectedModel_${selectedTool}_${selectedModelProvider}`, selectedModel);
  }
  applyCurrentModelReasoningUi({ preserveCurrentSelection: false });
  persistCurrentSessionToolPreferences();
});

inlineModelSelect.addEventListener("change", () => {
  selectedModel = inlineModelSelect.value;
  if (selectedTool) localStorage.setItem(`selectedModel_${selectedTool}`, selectedModel);
  if (selectedTool === "pi" && selectedModelProvider && selectedModel) {
    localStorage.setItem(`selectedProvider_${selectedTool}`, selectedModelProvider);
    localStorage.setItem(`selectedModel_${selectedTool}_${selectedModelProvider}`, selectedModel);
  }
  applyCurrentModelReasoningUi({ preserveCurrentSelection: false });
  persistCurrentSessionToolPreferences();
});

window.addEventListener("remotelab:localechange", () => {
  applyCurrentModelReasoningUi({ preserveCurrentSelection: true });
  syncRuntimePresetUi();
});

addToolNameInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolCommandInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolRuntimeFamilySelect.addEventListener("change", () => {
  syncAddToolModal();
});

addToolModelsInput.addEventListener("input", () => {
  syncAddToolModal();
});

addToolReasoningKindSelect.addEventListener("change", () => {
  syncAddToolModal();
});

addToolReasoningLevelsInput.addEventListener("input", () => {
  syncAddToolModal();
});

closeAddToolModalBtn.addEventListener("click", closeAddToolModal);
closeAddToolModalFooterBtn.addEventListener("click", closeAddToolModal);
addToolModal.addEventListener("click", (e) => {
  if (e.target === addToolModal) closeAddToolModal();
});

saveToolConfigBtn.addEventListener("click", saveSimpleToolConfig);

copyProviderPromptBtn.addEventListener("click", async () => {
  try {
    await copyText(buildProviderBasePrompt());
    updateCopyButtonLabel(copyProviderPromptBtn, t("action.copied"));
  } catch (err) {
    console.warn("[copy] Failed to copy provider prompt:", err.message);
  }
});

if (shareSnapshotBtn) {
  shareSnapshotBtn.addEventListener("click", shareCurrentSessionSnapshot);
}

if (forkSessionBtn) {
  forkSessionBtn.addEventListener("click", forkCurrentSession);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && addToolModal && !addToolModal.hidden) {
    closeAddToolModal();
  }
});

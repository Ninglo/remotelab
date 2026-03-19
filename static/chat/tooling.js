// ---- Thinking toggle / effort select ----
let runtimeSelectionSyncPromise = Promise.resolve();
let lastSyncedRuntimeSelectionPayload = '';

function buildRuntimeSelectionPayload() {
  if (visitorMode || !selectedTool) return null;
  return {
    selectedTool,
    selectedModel: selectedModel || '',
    selectedEffort: currentToolReasoningKind === 'enum' ? (selectedEffort || '') : '',
    thinkingEnabled: currentToolReasoningKind === 'toggle' ? thinkingEnabled === true : false,
    reasoningKind: currentToolReasoningKind || 'none',
  };
}

function queueRuntimeSelectionSync() {
  const payload = buildRuntimeSelectionPayload();
  if (!payload) return;
  const serialized = JSON.stringify(payload);
  if (serialized === lastSyncedRuntimeSelectionPayload) {
    return;
  }
  lastSyncedRuntimeSelectionPayload = serialized;
  runtimeSelectionSyncPromise = runtimeSelectionSyncPromise
    .catch(() => {})
    .then(async () => {
      try {
        await fetchJsonOrRedirect('/api/runtime-selection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serialized,
        });
      } catch (error) {
        lastSyncedRuntimeSelectionPayload = '';
        console.warn('[runtime-selection] Failed to sync current selection:', error.message);
      }
    });
}

function updateThinkingUI() {
  thinkingToggle.classList.toggle("active", thinkingEnabled);
}
updateThinkingUI();

function getAttachedSessionToolPreferences(toolId = selectedTool) {
  const session = getCurrentSession();
  if (!session || !toolId || session.tool !== toolId) return null;
  return {
    hasModel: Object.prototype.hasOwnProperty.call(session, "model"),
    model: typeof session.model === "string" ? session.model : "",
    hasEffort: Object.prototype.hasOwnProperty.call(session, "effort"),
    effort: typeof session.effort === "string" ? session.effort : "",
    hasThinking: Object.prototype.hasOwnProperty.call(session, "thinking"),
    thinking: session.thinking === true,
  };
}

function persistCurrentSessionToolPreferences() {
  if (visitorMode || !currentSessionId || !selectedTool) return;
  const payload = {
    action: "session_preferences",
    sessionId: currentSessionId,
    tool: selectedTool,
    model: selectedModel || "",
    effort: selectedEffort || "",
    thinking: currentToolReasoningKind === "toggle" ? thinkingEnabled : false,
  };
  dispatchAction(payload);
}

thinkingToggle.addEventListener("click", () => {
  thinkingEnabled = !thinkingEnabled;
  localStorage.setItem("thinkingEnabled", thinkingEnabled);
  updateThinkingUI();
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
});

effortSelect.addEventListener("change", () => {
  selectedEffort = effortSelect.value;
  if (selectedTool) localStorage.setItem(`selectedEffort_${selectedTool}`, selectedEffort);
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
});
// ---- Inline tool select ----
function slugifyToolValue(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "my-agent";
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
  const allowedKinds = family === "codex-json" ? ["enum", "none"] : ["toggle", "none"];

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
  const name = (addToolNameInput?.value || "").trim() || "My Agent";
  const command = (addToolCommandInput?.value || "").trim() || "my-agent";
  const runtimeFamily =
    addToolRuntimeFamilySelect?.value || "claude-stream-json";
  const models = parseModelLines(addToolModelsInput?.value || "");
  const reasoningKind = addToolReasoningKindSelect?.value || "toggle";
  const reasoning = { kind: reasoningKind, label: "Thinking" };
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
    `I want to add a new agent/provider to RemoteLab.`,
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
  const original = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = original;
  button.textContent = label;
  window.clearTimeout(button._copyResetTimer);
  button._copyResetTimer = window.setTimeout(() => {
    button.textContent = button.dataset.originalLabel || original;
  }, 1400);
}

function resetHeaderActionButton(button) {
  if (!button) return;
  button.disabled = false;
  window.clearTimeout(button._copyResetTimer);
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

function syncShareButton() {
  if (!shareSnapshotBtn) return;
  const visible = !visitorMode && !!currentSessionId;
  shareSnapshotBtn.style.display = visible ? "" : "none";
  if (!visible) {
    resetHeaderActionButton(shareSnapshotBtn);
  }
}

function syncForkButton() {
  if (!forkSessionBtn) return;
  const visible = !visitorMode && !!currentSessionId;
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
  return "RemoteLab snapshot";
}

function buildShareSnapshotShareText(session, shareUrl) {
  const title = getShareSnapshotTitle(session);
  const link = typeof shareUrl === "string" ? shareUrl.trim() : "";
  return link ? `${title}\n${link}` : title;
}

async function shareCurrentSessionSnapshot() {
  if (!currentSessionId || visitorMode || !shareSnapshotBtn) return;

  const currentSession = getCurrentSession();
  shareSnapshotBtn.disabled = true;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/share`, {
      method: "POST",
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {}

    const shareUrl = payload?.share?.url
      ? new URL(payload.share.url, location.origin).toString()
      : null;
    const shareText = buildShareSnapshotShareText(currentSession, shareUrl);

    if (!res.ok || !shareUrl) {
      throw new Error(payload?.error || "Failed to create share link");
    }

    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
        updateCopyButtonLabel(shareSnapshotBtn, "Shared");
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }

    try {
      await copyText(shareText);
      updateCopyButtonLabel(shareSnapshotBtn, "Copied");
    } catch {
      window.prompt("Copy share text", shareText);
      updateCopyButtonLabel(shareSnapshotBtn, "Ready");
    }
  } catch (err) {
    console.warn("[share] Failed to create snapshot:", err.message);
    updateCopyButtonLabel(shareSnapshotBtn, "Failed");
  } finally {
    shareSnapshotBtn.disabled = false;
    syncShareButton();
  }
}

async function forkCurrentSession() {
  if (!currentSessionId || visitorMode || !forkSessionBtn) return;

  const original = forkSessionBtn.dataset.originalLabel || forkSessionBtn.textContent;
  forkSessionBtn.dataset.originalLabel = original;
  forkSessionBtn.disabled = true;
  forkSessionBtn.textContent = "Forking…";

  try {
    const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/fork`, {
      method: "POST",
    });
    if (data.session) {
      upsertSession(data.session);
      renderSessionList();
      updateCopyButtonLabel(forkSessionBtn, "Forked");
    } else {
      updateCopyButtonLabel(forkSessionBtn, "Failed");
    }
  } catch (err) {
    console.warn("[fork] Failed to fork session:", err.message);
    updateCopyButtonLabel(forkSessionBtn, "Failed");
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
  if (!addToolModal) return;
  if (!addToolNameInput.value.trim()) addToolNameInput.value = "My Agent";
  if (!addToolCommandInput.value.trim()) {
    addToolCommandInput.value = "my-agent";
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
      setAddToolStatus("Saved. The new agent is ready in the picker.", "success");
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

function renderInlineToolOptions(selectedValue, emptyMessage = "No agents found") {
  inlineToolSelect.disabled = visitorMode;
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
  addMoreOpt.textContent = "+ Add more...";
  inlineToolSelect.appendChild(addMoreOpt);

  if (selectedValue && toolsList.some((tool) => tool.id === selectedValue)) {
    inlineToolSelect.value = selectedValue;
  } else if (toolsList[0]) {
    inlineToolSelect.value = toolsList[0].id;
  }
}

const modelResponseCache = new Map();
const pendingModelResponseRequests = new Map();

async function fetchModelResponse(toolId, { refresh = false } = {}) {
  if (!toolId) {
    return {
      models: [],
      effortLevels: null,
      defaultModel: null,
      reasoning: { kind: "none", label: "Thinking" },
    };
  }

  if (!refresh && modelResponseCache.has(toolId)) {
    return modelResponseCache.get(toolId);
  }

  if (!refresh && pendingModelResponseRequests.has(toolId)) {
    return pendingModelResponseRequests.get(toolId);
  }

  const request = fetchJsonOrRedirect(`/api/models?tool=${encodeURIComponent(toolId)}`, {
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
  if (visitorMode) {
    toolsList = [];
    selectedTool = null;
    selectedModel = null;
    selectedEffort = null;
    return;
  }
  try {
    const data = await fetchJsonOrRedirect("/api/tools");
    toolsList = prioritizeToolOptions((data.tools || []).filter((t) => t.available));
    const initialTool = resolvePreferredToolId(toolsList, [selectedTool, preferredTool]);
    renderInlineToolOptions(initialTool);
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
    if (typeof renderAppToolSelectOptions === "function") {
      renderAppToolSelectOptions(newAppToolSelect, newAppToolSelect?.value || selectedTool || initialTool || "");
    }
    if (typeof renderSettingsAppsPanel === "function") {
      renderSettingsAppsPanel();
    }
  } catch (err) {
    toolsList = [];
    console.warn("[tools] Failed to load tools:", err.message);
    renderInlineToolOptions("", "Failed to load agents");
    if (typeof renderAppToolSelectOptions === "function") {
      renderAppToolSelectOptions(newAppToolSelect, newAppToolSelect?.value || "");
    }
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
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
});

// ---- Model select ----
async function loadModelsForCurrentTool({ refresh = false } = {}) {
  if (visitorMode) {
    currentToolModels = [];
    currentToolEffortLevels = null;
    currentToolReasoningKind = "none";
    currentToolReasoningLabel = "Thinking";
    currentToolReasoningDefault = null;
    selectedModel = null;
    selectedEffort = null;
    inlineModelSelect.innerHTML = "";
    inlineModelSelect.style.display = "none";
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
    return;
  }
  const toolId = selectedTool;
  if (!selectedTool) {
    currentToolModels = [];
    currentToolEffortLevels = null;
    currentToolReasoningKind = "none";
    currentToolReasoningLabel = "Thinking";
    currentToolReasoningDefault = null;
    selectedModel = null;
    selectedEffort = null;
    inlineModelSelect.innerHTML = "";
    inlineModelSelect.style.display = "none";
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
    return;
  }
  try {
    const sessionPreferences = getAttachedSessionToolPreferences(toolId);
    const data = await fetchModelResponse(toolId, { refresh });
    if (selectedTool !== toolId) return;
    currentToolModels = data.models || [];
    currentToolReasoningKind =
      data.reasoning?.kind || (data.effortLevels ? "enum" : "toggle");
    currentToolReasoningLabel = data.reasoning?.label || "Thinking";
    currentToolReasoningDefault = data.reasoning?.default || null;
    currentToolEffortLevels =
      currentToolReasoningKind === "enum"
        ? data.reasoning?.levels || data.effortLevels || []
        : null;
    thinkingToggle.textContent = currentToolReasoningLabel;

    // Populate model dropdown
    inlineModelSelect.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "default";
    inlineModelSelect.appendChild(defaultOpt);
    for (const m of currentToolModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      inlineModelSelect.appendChild(opt);
    }
    // Restore saved model for this tool
    const savedModel = localStorage.getItem(`selectedModel_${toolId}`) || "";
    const defaultModel = data.defaultModel || "";
    selectedModel = sessionPreferences?.hasModel ? sessionPreferences.model : savedModel;
    if (selectedModel && currentToolModels.some((m) => m.id === selectedModel)) {
      inlineModelSelect.value = selectedModel;
    } else if (defaultModel && currentToolModels.some((m) => m.id === defaultModel)) {
      inlineModelSelect.value = defaultModel;
      selectedModel = defaultModel;
    } else {
      inlineModelSelect.value = "";
      selectedModel = "";
    }
    inlineModelSelect.style.display = currentToolModels.length > 0 ? "" : "none";

    if (currentToolReasoningKind === "enum") {
      thinkingToggle.style.display = "none";
      effortSelect.style.display = "";
      effortSelect.innerHTML = "";
      for (const level of currentToolEffortLevels) {
        const opt = document.createElement("option");
        opt.value = level;
        opt.textContent = level;
        effortSelect.appendChild(opt);
      }

      selectedEffort = sessionPreferences?.hasEffort
        ? sessionPreferences.effort
        : (localStorage.getItem(`selectedEffort_${toolId}`) || "");
      const currentModelData = currentToolModels.find((m) => m.id === selectedModel);
      if (selectedEffort && currentToolEffortLevels.includes(selectedEffort)) {
        effortSelect.value = selectedEffort;
      } else if (currentModelData?.defaultEffort) {
        effortSelect.value = currentModelData.defaultEffort;
        selectedEffort = currentModelData.defaultEffort;
      } else if (
        currentToolReasoningDefault
        && currentToolEffortLevels.includes(currentToolReasoningDefault)
      ) {
        effortSelect.value = currentToolReasoningDefault;
        selectedEffort = currentToolReasoningDefault;
      } else if (currentToolModels[0]?.defaultEffort) {
        effortSelect.value = currentToolModels[0].defaultEffort;
        selectedEffort = currentToolModels[0].defaultEffort;
      } else if (currentToolEffortLevels[0]) {
        effortSelect.value = currentToolEffortLevels[0];
        selectedEffort = currentToolEffortLevels[0];
      }
    } else if (currentToolReasoningKind === "toggle") {
      thinkingToggle.style.display = "";
      effortSelect.style.display = "none";
      selectedEffort = null;
      if (sessionPreferences?.hasThinking) {
        thinkingEnabled = sessionPreferences.thinking;
      }
      updateThinkingUI();
    } else {
      thinkingToggle.style.display = "none";
      effortSelect.style.display = "none";
      selectedEffort = null;
    }
    queueRuntimeSelectionSync();
  } catch {
    currentToolModels = [];
    currentToolEffortLevels = null;
    currentToolReasoningKind = "none";
    inlineModelSelect.style.display = "none";
    thinkingToggle.style.display = "none";
    effortSelect.style.display = "none";
  }
}

inlineModelSelect.addEventListener("change", () => {
  selectedModel = inlineModelSelect.value;
  if (selectedTool) localStorage.setItem(`selectedModel_${selectedTool}`, selectedModel);
  // Update default effort when model changes (enum reasoning tools)
  if (currentToolReasoningKind === "enum" && selectedModel) {
    const modelData = currentToolModels.find((m) => m.id === selectedModel);
    if (modelData?.defaultEffort && !localStorage.getItem(`selectedEffort_${selectedTool}`)) {
      effortSelect.value = modelData.defaultEffort;
      selectedEffort = modelData.defaultEffort;
    }
  }
  queueRuntimeSelectionSync();
  persistCurrentSessionToolPreferences();
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
    updateCopyButtonLabel(copyProviderPromptBtn, "Copied");
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

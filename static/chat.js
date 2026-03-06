(function () {
  "use strict";

  console.log("hello!");

  // ---- Elements ----
  const menuBtn = document.getElementById("menuBtn");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const closeSidebar = document.getElementById("closeSidebar");
  const collapseBtn = document.getElementById("collapseBtn");
  const sessionList = document.getElementById("sessionList");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const messagesEl = document.getElementById("messages");
  const messagesInner = document.getElementById("messagesInner");
  const emptyState = document.getElementById("emptyState");
  const msgInput = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");
  const headerTitle = document.getElementById("headerTitle");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const imgBtn = document.getElementById("imgBtn");
  const imgFileInput = document.getElementById("imgFileInput");
  const imgPreviewStrip = document.getElementById("imgPreviewStrip");
  const inlineToolSelect = document.getElementById("inlineToolSelect");
  const inlineModelSelect = document.getElementById("inlineModelSelect");
  const effortSelect = document.getElementById("effortSelect");
  const thinkingToggle = document.getElementById("thinkingToggle");
  const cancelBtn = document.getElementById("cancelBtn");
  const contextTokens = document.getElementById("contextTokens");
  const compactBtn = document.getElementById("compactBtn");
  const dropToolsBtn = document.getElementById("dropToolsBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  const tabSessions = document.getElementById("tabSessions");
  const tabProgress = document.getElementById("tabProgress");
  const progressPanel = document.getElementById("progressPanel");
  const inputArea = document.getElementById("inputArea");
  const inputResizeHandle = document.getElementById("inputResizeHandle");
  const addToolModal = document.getElementById("addToolModal");
  const closeAddToolModalBtn = document.getElementById("closeAddToolModal");
  const closeAddToolModalFooterBtn = document.getElementById(
    "closeAddToolModalFooter",
  );
  const addToolNameInput = document.getElementById("addToolNameInput");
  const addToolCommandInput = document.getElementById("addToolCommandInput");
  const addToolRuntimeFamilySelect = document.getElementById(
    "addToolRuntimeFamilySelect",
  );
  const addToolModelsInput = document.getElementById("addToolModelsInput");
  const addToolReasoningKindSelect = document.getElementById(
    "addToolReasoningKindSelect",
  );
  const addToolReasoningLevelsInput = document.getElementById(
    "addToolReasoningLevelsInput",
  );
  const addToolStatus = document.getElementById("addToolStatus");
  const providerPromptCode = document.getElementById("providerPromptCode");
  const saveToolConfigBtn = document.getElementById("saveToolConfigBtn");
  const copyProviderPromptBtn = document.getElementById("copyProviderPromptBtn");

  let ws = null;
  let pendingImages = [];
  let currentSessionId = null;
  let sessionStatus = "idle";
  let reconnectTimer = null;
  let sessions = [];
  let archivedSessions = []; // sessions sorted by archivedAt desc
  let visitorMode = false;
  let visitorSessionId = null;
  let pendingSummary = new Set(); // sessionIds awaiting summary generation
  let finishedUnread = new Set(); // sessionIds finished but not yet opened
  let lastSidebarUpdatedAt = {}; // sessionId -> last known updatedAt
  let messageQueue = []; // messages queued while disconnected

  let currentTokens = 0;

  let preferredTool =
    localStorage.getItem("preferredTool") ||
    localStorage.getItem("selectedTool") ||
    null;
  let selectedTool = preferredTool;
  // Default thinking to enabled; only disable if explicitly set to 'false'
  let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
  // Model/effort are stored per-tool: "selectedModel_claude", "selectedModel_codex"
  let selectedModel = null;
  let selectedEffort = null;
  let currentToolModels = []; // model list for current tool
  let currentToolEffortLevels = null; // null = binary toggle, string[] = effort dropdown
  let currentToolReasoningKind = "toggle";
  let currentToolReasoningLabel = "Thinking";
  let currentToolReasoningDefault = null;
  let sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
  let toolsList = [];
  let isDesktop = window.matchMedia("(min-width: 768px)").matches;
  const ADD_MORE_TOOL_VALUE = "__add_more__";
  let isSavingToolConfig = false;
  let collapsedFolders = JSON.parse(
    localStorage.getItem("collapsedFolders") || "{}",
  );

  // Thinking block state
  let currentThinkingBlock = null; // { el, body, tools: Set }
  let inThinkingBlock = false;

  function registerHiddenMarkdownExtensions() {
    const hiddenTagStart = /<(private|hide)\b/i;
    const hiddenBlockPattern = /^(?: {0,3})<(private|hide)\b[^>]*>[\s\S]*?<\/\1>(?:\n+|$)/i;
    const hiddenInlinePattern = /^<(private|hide)\b[^>]*>[\s\S]*?<\/\1>/i;
    marked.use({
      extensions: [
        {
          name: "hiddenUiBlock",
          level: "block",
          start(src) {
            const match = src.match(hiddenTagStart);
            return match ? match.index : undefined;
          },
          tokenizer(src) {
            const match = src.match(hiddenBlockPattern);
            if (!match) return undefined;
            return { type: "hiddenUiBlock", raw: match[0] };
          },
          renderer() {
            return "";
          },
        },
        {
          name: "hiddenUiInline",
          level: "inline",
          start(src) {
            const match = src.match(hiddenTagStart);
            return match ? match.index : undefined;
          },
          tokenizer(src) {
            const match = src.match(hiddenInlinePattern);
            if (!match) return undefined;
            return { type: "hiddenUiInline", raw: match[0] };
          },
          renderer() {
            return "";
          },
        },
      ],
    });
  }

  function initializePushNotifications() {
    if (visitorMode || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted" && !visitorMode) setupPushNotifications();
      });
    } else if (Notification.permission === "granted") {
      setupPushNotifications();
    }
  }

  registerHiddenMarkdownExtensions();

  function notifyCompletion(session) {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    if (document.visibilityState === "visible") return;
    const folder = (session?.folder || "").split("/").pop() || "Session";
    const name = session?.name || folder;
    const n = new Notification("RemoteLab", {
      body: `${name} — task completed`,
      tag: "remotelab-done",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++)
      outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function setupPushNotifications() {
    if (visitorMode) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return; // already subscribed
      const res = await fetch("/api/push/vapid-public-key");
      if (!res.ok) return;
      const { publicKey } = await res.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      console.log("[push] Subscribed to web push");
    } catch (err) {
      console.warn("[push] Setup failed:", err.message);
    }
  }

  // ---- Responsive layout ----
  function initResponsiveLayout() {
    const mq = window.matchMedia("(min-width: 768px)");
    function onBreakpointChange(e) {
      isDesktop = e.matches;
      if (isDesktop) {
        sidebarOverlay.classList.remove("open");
        if (sidebarCollapsed) sidebarOverlay.classList.add("collapsed");
      } else {
        sidebarOverlay.classList.remove("collapsed");
      }
    }
    mq.addEventListener("change", onBreakpointChange);
    onBreakpointChange(mq);
  }

  // ---- Thinking toggle / effort select ----
  function updateThinkingUI() {
    thinkingToggle.classList.toggle("active", thinkingEnabled);
  }
  updateThinkingUI();

  thinkingToggle.addEventListener("click", () => {
    thinkingEnabled = !thinkingEnabled;
    localStorage.setItem("thinkingEnabled", thinkingEnabled);
    updateThinkingUI();
  });

  effortSelect.addEventListener("change", () => {
    selectedEffort = effortSelect.value;
    if (selectedTool) localStorage.setItem(`selectedEffort_${selectedTool}`, selectedEffort);
  });

  // ---- Sidebar collapse (desktop) ----
  collapseBtn.addEventListener("click", () => {
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem("sidebarCollapsed", sidebarCollapsed);
    sidebarOverlay.classList.toggle("collapsed", sidebarCollapsed);
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
      `Read \`CLAUDE.md\` and \`notes/provider-architecture.md\` first.`,
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
      const res = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save tool config");
      }

      const savedTool = data.tool;
      if (savedTool?.id) {
        selectedTool = savedTool.id;
        preferredTool = savedTool.id;
        localStorage.setItem("preferredTool", preferredTool);
        localStorage.setItem("selectedTool", selectedTool);
      }

      await loadInlineTools();
      if (selectedTool) {
        await loadModelsForCurrentTool();
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

  function renderInlineToolOptions(selectedValue) {
    inlineToolSelect.disabled = visitorMode;
    inlineToolSelect.innerHTML = "";

    if (toolsList.length === 0) {
      const emptyOpt = document.createElement("option");
      emptyOpt.value = "";
      emptyOpt.textContent = "No agents found";
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

  async function loadInlineTools() {
    if (visitorMode) {
      toolsList = [];
      selectedTool = null;
      selectedModel = null;
      selectedEffort = null;
      return;
    }
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      toolsList = (data.tools || []).filter((t) => t.available);
      const initialTool = [selectedTool, preferredTool, toolsList[0]?.id].find(
        (toolId) => toolId && toolsList.some((t) => t.id === toolId),
      );
      renderInlineToolOptions(initialTool);
      if (initialTool) {
        selectedTool = initialTool;
        if (!preferredTool) {
          preferredTool = initialTool;
          localStorage.setItem("preferredTool", preferredTool);
        }
      }
      await loadModelsForCurrentTool();
    } catch {
      toolsList = [];
      renderInlineToolOptions("");
    }
  }

  inlineToolSelect.addEventListener("change", async () => {
    const nextTool = inlineToolSelect.value;
    if (nextTool === ADD_MORE_TOOL_VALUE) {
      renderInlineToolOptions(selectedTool || preferredTool || toolsList[0]?.id || "");
      openAddToolModal();
      return;
    }

    selectedTool = nextTool;
    preferredTool = selectedTool;
    localStorage.setItem("preferredTool", preferredTool);
    localStorage.setItem("selectedTool", selectedTool);
    await loadModelsForCurrentTool();
  });

  // ---- Model select ----
  async function loadModelsForCurrentTool() {
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
      const res = await fetch(`/api/models?tool=${encodeURIComponent(selectedTool)}`);
      const data = await res.json();
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
      const savedModel = localStorage.getItem(`selectedModel_${selectedTool}`) || "";
      const defaultModel = data.defaultModel || "";
      selectedModel = savedModel;
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

        selectedEffort = localStorage.getItem(`selectedEffort_${selectedTool}`) || "";
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
      } else {
        thinkingToggle.style.display = "none";
        effortSelect.style.display = "none";
        selectedEffort = null;
      }
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && addToolModal && !addToolModal.hidden) {
      closeAddToolModal();
    }
  });

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      updateStatus("connected", "idle");
      if (visitorMode && visitorSessionId) {
        // Visitor: skip session list, directly attach to assigned session
        currentSessionId = visitorSessionId;
        ws.send(JSON.stringify({ action: "attach", sessionId: visitorSessionId }));
      } else {
        ws.send(JSON.stringify({ action: "list" }));
        ws.send(JSON.stringify({ action: "list_archived" }));
        if (currentSessionId) {
          ws.send(
            JSON.stringify({ action: "attach", sessionId: currentSessionId }),
          );
        }
      }
      // Flush messages queued while disconnected
      for (const m of messageQueue) {
        ws.send(JSON.stringify(m));
      }
      messageQueue = [];
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleWsMessage(msg);
    };

    ws.onclose = () => {
      updateStatus("disconnected", "idle");
      scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function getCurrentSession() {
    return sessions.find((s) => s.id === currentSessionId) || null;
  }

  function updateResumeButton() {
    const session = getCurrentSession();
    const canResume = !!session && session.status === "interrupted" && session.recoverable;
    resumeBtn.style.display = canResume ? "" : "none";
    resumeBtn.disabled = !canResume;
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "sessions":
        sessions = msg.sessions || [];
        renderSessionList();
        break;

      case "session":
        if (msg.session) {
          const prevEntry = sessions.find((s) => s.id === msg.session.id);
          const wasRunning = prevEntry?.status === "running";
          const isCurrentSession = msg.session.id === currentSessionId;
          const prevStatus = isCurrentSession ? sessionStatus : prevEntry?.status || "idle";
          const idx = sessions.findIndex((s) => s.id === msg.session.id);
          if (idx >= 0) sessions[idx] = msg.session;
          else sessions.push(msg.session);
          if (isCurrentSession) {
            const displayName =
              msg.session.name || msg.session.folder?.split("/").pop() || "Session";
            headerTitle.textContent = displayName;
            sessionStatus = msg.session.status || "idle";
            updateStatus("connected", sessionStatus, msg.session.renameState);
          }
          if (
            isCurrentSession &&
            prevStatus === "running" &&
            sessionStatus === "idle"
          ) {
            notifyCompletion(msg.session);
          }
          // Mark finished-unread for sessions that completed without being viewed
          if (wasRunning && msg.session.status === "idle") {
            const isActiveAndVisible =
              msg.session.id === currentSessionId &&
              document.visibilityState === "visible";
            if (!isActiveAndVisible) {
              finishedUnread.add(msg.session.id);
            }
          }
          // Mark as pending summary when any session goes running → idle (only if progress enabled)
          if (wasRunning && msg.session.status === "idle" && progressEnabled) {
            pendingSummary.add(msg.session.id);
            if (activeTab === "progress") renderProgressPanel(lastProgressState);
          }
          renderSessionList();
          updateResumeButton();
        }
        break;

      case "history":
        clearMessages();
        if (msg.events && msg.events.length > 0) {
          for (const evt of msg.events) renderEvent(evt, false);
          scrollToBottom();
        }
        // Check for unconfirmed messages from a previous page load
        checkPendingMessage(msg.events || []);
        updateResumeButton();
        break;

      case "event":
        if (msg.event) {
          // Server confirmed our user message — remove optimistic bubble & clear pending
          if (msg.event.type === "message" && msg.event.role === "user") {
            const optimistic = document.getElementById("optimistic-msg");
            if (optimistic) optimistic.remove();
            clearPendingMessage();
          }
          renderEvent(msg.event, true);
        }
        break;

      case "deleted":
      case "archived":
        sessions = sessions.filter((s) => s.id !== msg.sessionId);
        localStorage.removeItem(`draft_${msg.sessionId}`);
        clearPendingMessage(msg.sessionId);
        if (currentSessionId === msg.sessionId) {
          messageQueue = [];
          currentSessionId = null;
          clearMessages();
          showEmpty();
        }
        renderSessionList();
        wsSend({ action: "list_archived" });
        break;

      case "archived_list":
        archivedSessions = msg.sessions || [];
        renderArchivedSection();
        break;

      case "unarchived":
        if (msg.session) {
          archivedSessions = archivedSessions.filter((s) => s.id !== msg.session.id);
          const exists = sessions.find((s) => s.id === msg.session.id);
          if (!exists) sessions.push(msg.session);
          renderSessionList();
          renderArchivedSection();
        }
        break;

      case "sidebar_update":
        if (msg.state) {
          // Clear pending flags for sessions with new data
          for (const [sessionId, entry] of Object.entries(msg.state.sessions || {})) {
            if (pendingSummary.has(sessionId)) {
              const prev = lastSidebarUpdatedAt[sessionId] || 0;
              if ((entry.updatedAt || 0) > prev) {
                pendingSummary.delete(sessionId);
              }
            }
            lastSidebarUpdatedAt[sessionId] = entry.updatedAt || 0;
          }
          lastProgressState = msg.state;
          if (activeTab === "progress") renderProgressPanel(msg.state);
        }
        break;

      case "error":
        console.error("WS error:", msg.message);
        break;
    }
  }

  // ---- Status ----
  function updateStatus(connState, sessState, renameState) {
    if (connState === "disconnected") {
      statusDot.className = "status-dot";
      statusText.textContent = "reconnecting…";
      // Keep input usable if we have a session — messages will be queued
      if (!currentSessionId) {
        msgInput.disabled = true;
        sendBtn.style.display = "";
        sendBtn.disabled = true;
      }
      cancelBtn.style.display = "none";
      resumeBtn.style.display = "none";
      return;
    }
    sessionStatus = sessState;
    const isRunning = sessState === "running";
    const isInterrupted = sessState === "interrupted";
    const isRenaming = renameState === "pending";
    const renameFailed = renameState === "failed";
    if (isRunning) {
      statusDot.className = "status-dot running";
      statusText.textContent = "running";
    } else if (isInterrupted) {
      statusDot.className = "status-dot interrupted";
      statusText.textContent = "interrupted";
    } else if (isRenaming) {
      statusDot.className = "status-dot renaming";
      statusText.textContent = "renaming…";
    } else if (renameFailed) {
      statusDot.className = "status-dot rename-failed";
      statusText.textContent = "rename failed";
    } else {
      statusDot.className = "status-dot";
      statusText.textContent = currentSessionId ? "idle" : "connected";
    }
    const hasSession = !!currentSessionId;
    msgInput.disabled = !hasSession;
    sendBtn.style.display = isRunning ? "none" : "";
    sendBtn.disabled = !hasSession;
    cancelBtn.style.display = isRunning && hasSession ? "flex" : "none";
    imgBtn.disabled = !hasSession;
    inlineToolSelect.disabled = visitorMode;
    inlineModelSelect.disabled = !hasSession;
    thinkingToggle.disabled = !hasSession;
    effortSelect.disabled = !hasSession;
    updateResumeButton();
  }

  // ---- Message rendering ----
  function clearMessages() {
    messagesInner.innerHTML = "";
    // Reset thinking block state
    inThinkingBlock = false;
    currentThinkingBlock = null;
  }

  function showEmpty() {
    messagesInner.innerHTML = "";
    messagesInner.appendChild(emptyState);
    inThinkingBlock = false;
    currentThinkingBlock = null;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function renderEvent(evt, autoScroll) {
    if (emptyState.parentNode === messagesInner) emptyState.remove();

    const shouldScroll =
      autoScroll &&
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
        120;

    switch (evt.type) {
      case "message":
        renderMessage(evt);
        break;
      case "tool_use":
        renderToolUse(evt);
        break;
      case "tool_result":
        renderToolResult(evt);
        break;
      case "file_change":
        renderFileChange(evt);
        break;
      case "reasoning":
        renderReasoning(evt);
        break;
      case "status":
        renderStatusMsg(evt);
        break;
      case "usage":
        renderUsage(evt);
        break;
    }

    if (shouldScroll) scrollToBottom();
  }

  // ---- Thinking block helpers ----
  function openThinkingBlock() {
    const block = document.createElement("div");
    block.className = "thinking-block collapsed"; // collapsed by default

    const header = document.createElement("div");
    header.className = "thinking-header";
    header.innerHTML = `<span class="thinking-icon">&#9881;</span>
      <span class="thinking-label">Thinking…</span>
      <span class="thinking-chevron">&#9660;</span>`;

    const body = document.createElement("div");
    body.className = "thinking-body";

    header.addEventListener("click", () => {
      block.classList.toggle("collapsed");
    });

    block.appendChild(header);
    block.appendChild(body);
    messagesInner.appendChild(block);

    currentThinkingBlock = {
      el: block,
      header,
      body,
      label: header.querySelector(".thinking-label"),
      tools: new Set(),
    };
    inThinkingBlock = true;
  }

  function finalizeThinkingBlock() {
    if (!currentThinkingBlock) return;
    const { label, tools } = currentThinkingBlock;
    const toolList = [...tools];
    if (toolList.length > 0) {
      label.textContent = `Thought · used ${toolList.join(", ")}`;
    } else {
      label.textContent = "Thought";
    }
    inThinkingBlock = false;
    currentThinkingBlock = null;
  }

  async function copyText(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("copy failed");
  }

  function setCopyButtonState(button, copied) {
    const icon = copied
      ? `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.5 4.5 6.5 11.5 3 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`
      : `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="3" width="8" height="10" rx="1.5" ry="1.5" fill="none" stroke="currentColor" stroke-width="1.4"></rect><path d="M3 10.5V4.5C3 3.67 3.67 3 4.5 3H10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
    button.innerHTML = icon;
    button.classList.toggle("copied", copied);
    button.title = copied ? "Copied" : "Copy code";
    button.setAttribute("aria-label", copied ? "Copied" : "Copy code");
  }

  function enhanceCodeBlocks(root) {
    const blocks = root.querySelectorAll("pre > code");
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre || pre.parentElement?.classList.contains("code-block-wrap")) continue;

      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrap";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-btn";
      setCopyButtonState(button, false);

      let resetTimer = null;
      button.addEventListener("click", async () => {
        try {
          await copyText(code.textContent || "");
          setCopyButtonState(button, true);
          window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(() => {
            setCopyButtonState(button, false);
          }, 1600);
        } catch (err) {
          console.warn("[copy] Failed to copy code block:", err.message);
        }
      });

      wrapper.appendChild(button);
    }
  }

  function getThinkingBody() {
    if (!inThinkingBlock) openThinkingBlock();
    return currentThinkingBlock.body;
  }

  // ---- Render functions ----
  function renderMessage(evt) {
    const role = evt.role || "assistant";

    if (inThinkingBlock) {
      finalizeThinkingBlock();
    }

    if (role === "user") {
      const wrap = document.createElement("div");
      wrap.className = "msg-user";
      const bubble = document.createElement("div");
      bubble.className = "msg-user-bubble";
      if (evt.images && evt.images.length > 0) {
        const imgWrap = document.createElement("div");
        imgWrap.className = "msg-images";
        for (const img of evt.images) {
          const imgEl = document.createElement("img");
          imgEl.src = `/api/images/${img.filename}`;
          imgEl.alt = "attached image";
          imgEl.loading = "lazy";
          imgEl.onclick = () => window.open(imgEl.src, "_blank");
          imgWrap.appendChild(imgEl);
        }
        bubble.appendChild(imgWrap);
      }
      if (evt.content) {
        const span = document.createElement("span");
        span.textContent = evt.content;
        bubble.appendChild(span);
      }
      wrap.appendChild(bubble);
      messagesInner.appendChild(wrap);
    } else {
      const div = document.createElement("div");
      div.className = "msg-assistant md-content";
      if (evt.content) {
        const rendered = marked.parse(evt.content);
        if (!rendered.trim()) return;
        div.innerHTML = rendered;
        enhanceCodeBlocks(div);
      }
      messagesInner.appendChild(div);
    }
  }

  function renderToolUse(evt) {
    const container = getThinkingBody();
    if (currentThinkingBlock && evt.toolName) {
      currentThinkingBlock.tools.add(evt.toolName);
    }

    const card = document.createElement("div");
    card.className = "tool-card";

    const header = document.createElement("div");
    header.className = "tool-header";
    header.innerHTML = `<span class="tool-name">${esc(evt.toolName || "tool")}</span>
      <span class="tool-toggle">&#9654;</span>`;

    const body = document.createElement("div");
    body.className = "tool-body";
    body.id = "tool_" + evt.id;
    const pre = document.createElement("pre");
    pre.textContent = evt.toolInput || "";
    body.appendChild(pre);

    header.addEventListener("click", () => {
      header.classList.toggle("expanded");
      body.classList.toggle("expanded");
    });

    card.appendChild(header);
    card.appendChild(body);
    card.dataset.toolId = evt.id;
    container.appendChild(card);
  }

  function renderToolResult(evt) {
    // Search in current thinking block body, or fall back to messagesInner
    const searchRoot =
      inThinkingBlock && currentThinkingBlock
        ? currentThinkingBlock.body
        : messagesInner;

    const cards = searchRoot.querySelectorAll(".tool-card");
    let targetCard = null;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (!cards[i].querySelector(".tool-result")) {
        targetCard = cards[i];
        break;
      }
    }

    if (targetCard) {
      const body = targetCard.querySelector(".tool-body");
      const label = document.createElement("div");
      label.className = "tool-result-label";
      label.innerHTML =
        "Result" +
        (evt.exitCode !== undefined
          ? `<span class="exit-code ${evt.exitCode === 0 ? "ok" : "fail"}">${evt.exitCode === 0 ? "exit 0" : "exit " + evt.exitCode}</span>`
          : "");
      const pre = document.createElement("pre");
      pre.className = "tool-result";
      pre.textContent = evt.output || "";
      body.appendChild(label);
      body.appendChild(pre);
      if (evt.exitCode && evt.exitCode !== 0) {
        targetCard.querySelector(".tool-header").classList.add("expanded");
        body.classList.add("expanded");
      }
    }
  }

  function renderFileChange(evt) {
    const container = getThinkingBody();
    const div = document.createElement("div");
    div.className = "file-card";
    const kind = evt.changeType || "edit";
    div.innerHTML = `<span class="file-path">${esc(evt.filePath || "")}</span>
      <span class="change-type ${kind}">${kind}</span>`;
    container.appendChild(div);
  }

  function renderReasoning(evt) {
    const container = getThinkingBody();
    const div = document.createElement("div");
    div.className = "reasoning";
    div.textContent = evt.content || "";
    container.appendChild(div);
  }

  function renderStatusMsg(evt) {
    // Finalize thinking block when the AI turn ends (completed/error)
    if (inThinkingBlock && evt.content !== "thinking") {
      finalizeThinkingBlock();
    }
    if (
      !evt.content ||
      evt.content === "completed" ||
      evt.content === "thinking"
    )
      return;
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = evt.content;
    messagesInner.appendChild(div);
  }

  function formatTokens(n) {
    if (n < 500) return "< 1K";
    return "~" + Math.round(n / 1000) + "K";
  }

  function updateContextDisplay(inputTokens) {
    currentTokens = inputTokens;
    if (inputTokens > 0 && currentSessionId) {
      contextTokens.textContent = formatTokens(inputTokens);
      contextTokens.style.display = "";
      compactBtn.style.display = "";
      dropToolsBtn.style.display = "";
    }
  }

  function renderUsage(evt) {
    const div = document.createElement("div");
    div.className = "usage-info";
    const input = evt.inputTokens || 0;
    const output = evt.outputTokens || 0;
    div.textContent = `${input.toLocaleString()} in · ${output.toLocaleString()} out`;
    messagesInner.appendChild(div);
    updateContextDisplay(input);
  }

  function esc(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  // ---- Session list ----
  function renderSessionList() {
    sessionList.innerHTML = "";

    const groups = new Map();
    for (const s of sessions) {
      const folder = s.folder || "?";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(s);
    }

    for (const [folder, folderSessions] of groups) {
      const group = document.createElement("div");
      group.className = "folder-group";

      const shortFolder = folder.replace(/^\/Users\/[^/]+/, "~");
      const folderName = shortFolder.split("/").pop() || shortFolder;

      const header = document.createElement("div");
      header.className =
        "folder-group-header" + (collapsedFolders[folder] ? " collapsed" : "");
      header.innerHTML = `<span class="folder-chevron">&#9660;</span>
        <span class="folder-name" title="${esc(shortFolder)}">${esc(folderName)}</span>
        <span class="folder-count">${folderSessions.length}</span>
        <button class="folder-add-btn" title="New session">+</button>`;
      header.addEventListener("click", (e) => {
        if (e.target.classList.contains("folder-add-btn")) return;
        header.classList.toggle("collapsed");
        collapsedFolders[folder] = header.classList.contains("collapsed");
        localStorage.setItem(
          "collapsedFolders",
          JSON.stringify(collapsedFolders),
        );
      });
      header.querySelector(".folder-add-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        const tool = preferredTool || selectedTool || toolsList[0]?.id;
        if (!tool) return;
        if (!isDesktop) closeSidebarFn();
        wsSend({ action: "create", folder, tool });
        const handler = (evt) => {
          let msg;
          try { msg = JSON.parse(evt.data); } catch { return; }
          if (msg.type === "session" && msg.session) {
            ws.removeEventListener("message", handler);
            attachSession(msg.session.id, msg.session);
            wsSend({ action: "list" });
          }
        };
        ws.addEventListener("message", handler);
      });

      const items = document.createElement("div");
      items.className = "folder-group-items";

      for (const s of folderSessions) {
        const div = document.createElement("div");
        div.className =
          "session-item" + (s.id === currentSessionId ? " active" : "");

        const displayName = s.name || s.tool || "session";
        const metaParts = [];
        if (s.name && s.tool) metaParts.push(s.tool);
        if (s.status === "running") metaParts.push("●&nbsp;running");
        const renameReason = s.renameError ? ` title="${esc(s.renameError)}"` : "";
        const metaHtml = s.renameState === "pending"
          ? `<span class="status-renaming">● renaming</span>`
          : s.renameState === "failed"
            ? `<span class="status-rename-failed"${renameReason}>● rename failed</span>`
          : finishedUnread.has(s.id)
          ? `<span class="status-done">● done</span>`
          : s.status === "running"
            ? `<span class="status-running">● running</span>`
            : s.status === "interrupted"
              ? `<span class="status-interrupted">● interrupted</span>`
            : s.tool && s.name
              ? `<span>${esc(s.tool)}</span>`
              : "";

        div.innerHTML = `
          <div class="session-item-info">
            <div class="session-item-name">${esc(displayName)}</div>
            <div class="session-item-meta">${metaHtml}</div>
          </div>
          <div class="session-item-actions">
            <button class="session-action-btn rename" title="Rename" data-id="${s.id}">&#9998;</button>
            <button class="session-action-btn archive" title="Archive" data-id="${s.id}">&#8615;</button>
          </div>`;

        div.addEventListener("click", (e) => {
          if (
            e.target.classList.contains("rename") ||
            e.target.classList.contains("archive")
          )
            return;
          attachSession(s.id, s);
          if (!isDesktop) closeSidebarFn();
        });

        div.querySelector(".rename").addEventListener("click", (e) => {
          e.stopPropagation();
          startRename(div, s);
        });

        div.querySelector(".archive").addEventListener("click", (e) => {
          e.stopPropagation();
          wsSend({ action: "archive", sessionId: s.id });
        });

        items.appendChild(div);
      }

      group.appendChild(header);
      group.appendChild(items);
      sessionList.appendChild(group);
    }
  }

  function renderArchivedSection() {
    const existing = document.getElementById("archivedSection");
    if (existing) existing.remove();
    if (archivedSessions.length === 0) return;

    const section = document.createElement("div");
    section.id = "archivedSection";
    section.className = "archived-section";

    const header = document.createElement("div");
    header.className = "archived-section-header";
    const isCollapsed = localStorage.getItem("archivedCollapsed") !== "false";
    if (isCollapsed) header.classList.add("collapsed");
    header.innerHTML = `<span class="folder-chevron">&#9660;</span><span class="archived-label">Archive</span><span class="folder-count">${archivedSessions.length}</span>`;
    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      localStorage.setItem("archivedCollapsed", header.classList.contains("collapsed") ? "true" : "false");
    });

    const items = document.createElement("div");
    items.className = "archived-items";

    for (const s of archivedSessions) {
      const div = document.createElement("div");
      div.className = "session-item archived-item";
      const displayName = s.name || s.tool || "session";
      const shortFolder = (s.folder || "").replace(/^\/Users\/[^/]+/, "~");
      const folderName = shortFolder.split("/").pop() || shortFolder;
      const date = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : "";
      div.innerHTML = `
        <div class="session-item-info">
          <div class="session-item-name">${esc(displayName)}</div>
          <div class="session-item-meta"><span title="${esc(shortFolder)}">${esc(folderName)}</span>${date ? ` · ${date}` : ""}</div>
        </div>
        <div class="session-item-actions">
          <button class="session-action-btn restore" title="Restore" data-id="${s.id}">&#8617;</button>
        </div>`;
      div.querySelector(".restore").addEventListener("click", (e) => {
        e.stopPropagation();
        wsSend({ action: "unarchive", sessionId: s.id });
      });
      items.appendChild(div);
    }

    section.appendChild(header);
    section.appendChild(items);
    sessionList.appendChild(section);
  }

  function startRename(itemEl, session) {
    const nameEl = itemEl.querySelector(".session-item-name");
    const current = session.name || session.tool || "";
    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.value = current;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== current) {
        wsSend({ action: "rename", sessionId: session.id, name: newName });
      } else {
        renderSessionList(); // revert
      }
    }

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.removeEventListener("blur", commit);
        renderSessionList();
      }
    });
  }

  function attachSession(id, session) {
    currentSessionId = id;
    currentTokens = 0;
    contextTokens.style.display = "none";
    compactBtn.style.display = "none";
    dropToolsBtn.style.display = "none";
    finishedUnread.delete(id);
    clearMessages();
    wsSend({ action: "attach", sessionId: id });

    const displayName =
      session?.name || session?.folder?.split("/").pop() || "Session";
    headerTitle.textContent = displayName;
    updateStatus("connected", session?.status || "idle", session?.renameState);
    msgInput.disabled = false;
    sendBtn.disabled = false;
    imgBtn.disabled = false;
    inlineToolSelect.disabled = false;
    inlineModelSelect.disabled = false;
    thinkingToggle.disabled = false;
    effortSelect.disabled = false;

    if (session?.tool && toolsList.some((t) => t.id === session.tool)) {
      inlineToolSelect.value = session.tool;
      const prevTool = selectedTool;
      selectedTool = session.tool;
      if (prevTool !== selectedTool) {
        loadModelsForCurrentTool();
      }
    }

    restoreDraft();
    msgInput.focus();
    renderSessionList();
    updateResumeButton();
  }

  // ---- Sidebar ----
  function openSidebar() {
    sidebarOverlay.classList.add("open");
  }
  function closeSidebarFn() {
    sidebarOverlay.classList.remove("open");
  }

  menuBtn.addEventListener("click", openSidebar);
  closeSidebar.addEventListener("click", closeSidebarFn);
  sidebarOverlay.addEventListener("click", (e) => {
    if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
  });

  // Clear "done" badge when user returns to tab (read-receipt semantics)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentSessionId && finishedUnread.delete(currentSessionId)) {
      renderSessionList();
    }
  });

  // ---- New Session ----
  newSessionBtn.addEventListener("click", () => {
    if (!isDesktop) closeSidebarFn();
    const tool = preferredTool || selectedTool || toolsList[0]?.id;
    if (!tool) return;
    wsSend({ action: "create", folder: "~", tool });
    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "session" && msg.session) {
        ws.removeEventListener("message", handler);
        attachSession(msg.session.id, msg.session);
        wsSend({ action: "list" });
      }
    };
    ws.addEventListener("message", handler);
  });

  // ---- Image handling ----
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(",")[1];
        resolve({
          data: base64,
          mimeType: file.type || "image/png",
          objectUrl: URL.createObjectURL(file),
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (pendingImages.length >= 4) break;
      pendingImages.push(await fileToBase64(file));
    }
    renderImagePreviews();
  }

  function renderImagePreviews() {
    imgPreviewStrip.innerHTML = "";
    if (pendingImages.length === 0) {
      imgPreviewStrip.classList.remove("has-images");
      return;
    }
    imgPreviewStrip.classList.add("has-images");
    pendingImages.forEach((img, i) => {
      const item = document.createElement("div");
      item.className = "img-preview-item";
      const imgEl = document.createElement("img");
      imgEl.src = img.objectUrl;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-img";
      removeBtn.innerHTML = "&times;";
      removeBtn.onclick = () => {
        URL.revokeObjectURL(img.objectUrl);
        pendingImages.splice(i, 1);
        renderImagePreviews();
      };
      item.appendChild(imgEl);
      item.appendChild(removeBtn);
      imgPreviewStrip.appendChild(item);
    });
  }

  imgBtn.addEventListener("click", () => imgFileInput.click());
  imgFileInput.addEventListener("change", () => {
    if (imgFileInput.files.length > 0) addImageFiles(imgFileInput.files);
    imgFileInput.value = "";
  });

  msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
    }
  });

  // ---- Send message ----
  function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingImages.length === 0) || !currentSessionId) return;

    // Protect the message: save to localStorage before anything else
    savePendingMessage(text);

    // Render optimistic bubble BEFORE revoking image URLs
    renderOptimisticMessage(text, pendingImages);

    const msg = { action: "send", text: text || "(image)" };
    if (!visitorMode) {
      if (selectedTool) msg.tool = selectedTool;
      if (selectedModel) msg.model = selectedModel;
      if (currentToolReasoningKind === "enum") {
        if (selectedEffort) msg.effort = selectedEffort;
      } else if (currentToolReasoningKind === "toggle") {
        msg.thinking = thinkingEnabled;
      }
    }
    if (pendingImages.length > 0) {
      msg.images = pendingImages.map((img) => ({
        data: img.data,
        mimeType: img.mimeType,
      }));
      pendingImages.forEach((img) => URL.revokeObjectURL(img.objectUrl));
      pendingImages = [];
      renderImagePreviews();
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      messageQueue.push(msg);
    }
    msgInput.value = "";
    clearDraft();
    autoResizeInput();
  }

  cancelBtn.addEventListener("click", () => wsSend({ action: "cancel" }));
  resumeBtn.addEventListener("click", () => wsSend({ action: "resume_interrupted" }));

  compactBtn.addEventListener("click", () => {
    if (!currentSessionId) return;
    wsSend({ action: "compact" });
  });

  dropToolsBtn.addEventListener("click", () => {
    if (!currentSessionId) return;
    wsSend({ action: "drop_tools" });
  });

  sendBtn.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea: 3 lines default, 10 lines max
  function autoResizeInput() {
    if (inputArea.classList.contains("is-resized")) return;
    msgInput.style.height = "auto";
    const lineH = parseFloat(getComputedStyle(msgInput).lineHeight) || 24;
    const minH = lineH * 3;
    const maxH = lineH * 10;
    const newH = Math.min(Math.max(msgInput.scrollHeight, minH), maxH);
    msgInput.style.height = newH + "px";
  }
  // ---- Draft persistence ----
  function saveDraft() {
    if (!currentSessionId) return;
    localStorage.setItem(`draft_${currentSessionId}`, msgInput.value);
  }
  function restoreDraft() {
    if (!currentSessionId) return;
    const draft = localStorage.getItem(`draft_${currentSessionId}`);
    if (draft) {
      msgInput.value = draft;
      autoResizeInput();
    }
  }
  function clearDraft() {
    if (!currentSessionId) return;
    localStorage.removeItem(`draft_${currentSessionId}`);
  }

  msgInput.addEventListener("input", () => {
    autoResizeInput();
    saveDraft();
  });
  // Set initial height
  requestAnimationFrame(() => autoResizeInput());

  // ---- Pending message protection ----
  // Saves sent message to localStorage until server confirms receipt.
  // Prevents message loss on refresh, network failure, or server crash.
  function savePendingMessage(text) {
    if (!currentSessionId) return;
    localStorage.setItem(
      `pending_msg_${currentSessionId}`,
      JSON.stringify({ text, timestamp: Date.now() }),
    );
  }
  function clearPendingMessage(sessionId) {
    localStorage.removeItem(`pending_msg_${sessionId || currentSessionId}`);
  }
  function getPendingMessage(sessionId) {
    const raw = localStorage.getItem(
      `pending_msg_${sessionId || currentSessionId}`,
    );
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function renderOptimisticMessage(text, images) {
    if (emptyState.parentNode === messagesInner) emptyState.remove();
    // Remove any previous optimistic message
    const prev = document.getElementById("optimistic-msg");
    if (prev) prev.remove();

    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    wrap.id = "optimistic-msg";
    const bubble = document.createElement("div");
    bubble.className = "msg-user-bubble msg-pending";

    if (images && images.length > 0) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of images) {
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.mimeType};base64,${img.data}`;
        imgEl.alt = "attached image";
        imgWrap.appendChild(imgEl);
      }
      bubble.appendChild(imgWrap);
    }

    if (text) {
      const span = document.createElement("span");
      span.textContent = text;
      bubble.appendChild(span);
    }

    wrap.appendChild(bubble);
    messagesInner.appendChild(wrap);
    scrollToBottom();
  }

  function renderPendingRecovery(pending) {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    wrap.id = "pending-msg-recovery";
    const bubble = document.createElement("div");
    bubble.className = "msg-user-bubble msg-failed";

    if (pending.text) {
      const span = document.createElement("span");
      span.textContent = pending.text;
      bubble.appendChild(span);
    }

    const actions = document.createElement("div");
    actions.className = "msg-failed-actions";

    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Resend";
    retryBtn.className = "msg-retry-btn";
    retryBtn.onclick = () => {
      wrap.remove();
      clearPendingMessage();
      msgInput.value = pending.text;
      sendMessage();
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "msg-edit-btn";
    editBtn.onclick = () => {
      msgInput.value = pending.text;
      autoResizeInput();
      wrap.remove();
      clearPendingMessage();
      msgInput.focus();
    };

    const discardBtn = document.createElement("button");
    discardBtn.textContent = "Discard";
    discardBtn.className = "msg-discard-btn";
    discardBtn.onclick = () => {
      wrap.remove();
      clearPendingMessage();
    };

    actions.appendChild(retryBtn);
    actions.appendChild(editBtn);
    actions.appendChild(discardBtn);
    bubble.appendChild(actions);

    wrap.appendChild(bubble);
    messagesInner.appendChild(wrap);
    scrollToBottom();
  }

  function checkPendingMessage(historyEvents) {
    const pending = getPendingMessage();
    if (!pending) return;

    // Check if the pending message already exists in history
    // (server received it but client didn't get confirmation before refresh)
    const lastUserMsg = [...historyEvents]
      .reverse()
      .find((e) => e.type === "message" && e.role === "user");
    if (
      lastUserMsg &&
      lastUserMsg.content === pending.text &&
      lastUserMsg.timestamp >= pending.timestamp - 5000
    ) {
      clearPendingMessage();
      return;
    }

    // Show the pending message with recovery actions
    renderPendingRecovery(pending);
  }

  // ---- Progress sidebar ----
  let activeTab = "sessions"; // "sessions" | "progress"
  let progressPollTimer = null;
  let lastProgressState = { sessions: {} };
  let progressEnabled = false; // loaded from backend, default off

  async function fetchSettings() {
    if (visitorMode) return;
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const s = await res.json();
      progressEnabled = s.progressEnabled === true;
    } catch {}
  }

  function switchTab(tab) {
    activeTab = tab;
    tabSessions.classList.toggle("active", tab === "sessions");
    tabProgress.classList.toggle("active", tab === "progress");
    sessionList.style.display = tab === "sessions" ? "" : "none";
    progressPanel.classList.toggle("visible", tab === "progress");
    newSessionBtn.classList.toggle("hidden", tab === "progress");
    if (tab === "progress") {
      fetchSidebarState();
      if (progressEnabled && !progressPollTimer) {
        progressPollTimer = setInterval(fetchSidebarState, 30_000);
      }
    } else {
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }
  }

  tabSessions.addEventListener("click", () => switchTab("sessions"));
  tabProgress.addEventListener("click", () => switchTab("progress"));

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function appendProgressToggle() {
    const toggleRow = document.createElement("div");
    toggleRow.className = "progress-toggle-row";
    const label = document.createElement("span");
    label.className = "progress-toggle-label";
    label.textContent = "Auto-summarize";
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "progress-toggle-btn" + (progressEnabled ? " active" : "");
    toggleBtn.textContent = progressEnabled ? "On" : "Off";
    toggleRow.appendChild(label);
    toggleRow.appendChild(toggleBtn);
    toggleBtn.addEventListener("click", async () => {
      progressEnabled = !progressEnabled;
      try {
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ progressEnabled }),
        });
      } catch {}
      if (progressEnabled && !progressPollTimer) {
        progressPollTimer = setInterval(fetchSidebarState, 30_000);
      } else if (!progressEnabled) {
        clearInterval(progressPollTimer);
        progressPollTimer = null;
      }
      renderProgressPanel(lastProgressState);
    });
    progressPanel.appendChild(toggleRow);
  }

  function renderProgressPanel(state) {
    progressPanel.innerHTML = "";
    const stateEntries = Object.entries(state.sessions || {});

    // Collect all session IDs to render: those with data + those pending without data yet
    const pendingOnly = [...pendingSummary].filter(id => !state.sessions[id]);
    const allEntries = [
      ...stateEntries,
      ...pendingOnly.map(id => {
        const s = sessions.find(sess => sess.id === id);
        return [id, { folder: s?.folder || "", name: s?.name || "", _pendingOnly: true }];
      }),
    ];

    if (allEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "progress-empty";
      empty.textContent = progressEnabled
        ? "No summaries yet. Send a message in any session to generate one."
        : "Auto-summarize is off. Enable it below to track AI progress.";
      progressPanel.appendChild(empty);
      appendProgressToggle();
      return;
    }

    // Sort by most recently updated; pending-only entries sort to top
    allEntries.sort((a, b) => {
      const aPending = pendingSummary.has(a[0]);
      const bPending = pendingSummary.has(b[0]);
      if (aPending !== bPending) return aPending ? -1 : 1;
      return (b[1].updatedAt || 0) - (a[1].updatedAt || 0);
    });

    for (const [sessionId, entry] of allEntries) {
      const isRunning = sessions.some(s => s.id === sessionId && s.status === "running");
      const isSummarizing = pendingSummary.has(sessionId);
      const card = document.createElement("div");
      card.className = "progress-card";

      const folderName = (entry.folder || "").split("/").pop() || entry.folder || "unknown";
      const displayName = entry.name || folderName;

      const summaryIndicator = isSummarizing
        ? '<div class="progress-summarizing">Summarizing...</div>'
        : "";

      if (entry._pendingOnly) {
        card.innerHTML = `
          <div class="progress-card-header">
            <div class="progress-card-name">${escapeHtml(displayName)}</div>
          </div>
          <div class="progress-card-folder">${escapeHtml(entry.folder || "")}</div>
          <div class="progress-summarizing">Summarizing...</div>
        `;
      } else {
        card.innerHTML = `
          <div class="progress-card-header">
            ${isRunning ? '<div class="progress-running-dot"></div>' : ''}
            <div class="progress-card-name">${escapeHtml(displayName)}</div>
          </div>
          <div class="progress-card-folder">${escapeHtml(entry.folder || "")}</div>
          <div class="progress-card-bg">${escapeHtml(entry.background || "")}</div>
          <div class="progress-card-action">↳ ${escapeHtml(entry.lastAction || "")}</div>
          <div class="progress-card-footer">
            ${entry.updatedAt ? `<span class="progress-card-time">${relativeTime(entry.updatedAt)}</span>` : ""}
            ${summaryIndicator}
          </div>
        `;
      }

      // Click card to switch to that session
      card.addEventListener("click", () => {
        const session = sessions.find(s => s.id === sessionId);
        if (session) {
          switchTab("sessions");
          attachSession(session.id, session);
          if (!isDesktop) closeSidebarFn();
        }
      });
      card.style.cursor = "pointer";

      progressPanel.appendChild(card);
    }

    appendProgressToggle();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function fetchSidebarState() {
    if (visitorMode) return;
    try {
      const res = await fetch("/api/sidebar");
      if (!res.ok) return;
      const state = await res.json();
      // Clear pending flag for sessions whose summary just arrived or updated
      for (const [sessionId, entry] of Object.entries(state.sessions || {})) {
        if (pendingSummary.has(sessionId)) {
          const prev = lastSidebarUpdatedAt[sessionId] || 0;
          if ((entry.updatedAt || 0) > prev) {
            pendingSummary.delete(sessionId);
          }
        }
        lastSidebarUpdatedAt[sessionId] = entry.updatedAt || 0;
      }
      lastProgressState = state;
      renderProgressPanel(state);
    } catch {}
  }

  // ---- Input area resize ----
  const INPUT_MIN_H = 100;
  let isResizingInput = false;
  let resizeStartY = 0;
  let resizeStartH = 0;

  function getInputMaxH() {
    return Math.floor(window.innerHeight * 0.72);
  }

  function onInputResizeStart(e) {
    isResizingInput = true;
    resizeStartY = e.touches ? e.touches[0].clientY : e.clientY;
    resizeStartH = inputArea.getBoundingClientRect().height;
    document.addEventListener("mousemove", onInputResizeMove);
    document.addEventListener("touchmove", onInputResizeMove, { passive: false });
    document.addEventListener("mouseup", onInputResizeEnd);
    document.addEventListener("touchend", onInputResizeEnd);
    e.preventDefault();
  }

  function onInputResizeMove(e) {
    if (!isResizingInput) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = resizeStartY - clientY; // drag up = positive dy = bigger height
    const newH = Math.max(INPUT_MIN_H, Math.min(getInputMaxH(), resizeStartH + dy));
    inputArea.style.height = newH + "px";
    inputArea.classList.add("is-resized");
    localStorage.setItem("inputAreaHeight", newH);
    e.preventDefault();
  }

  function onInputResizeEnd() {
    isResizingInput = false;
    document.removeEventListener("mousemove", onInputResizeMove);
    document.removeEventListener("touchmove", onInputResizeMove);
    document.removeEventListener("mouseup", onInputResizeEnd);
    document.removeEventListener("touchend", onInputResizeEnd);
  }

  inputResizeHandle.addEventListener("mousedown", onInputResizeStart);
  inputResizeHandle.addEventListener("touchstart", onInputResizeStart, { passive: false });

  // Restore saved height
  const savedInputH = localStorage.getItem("inputAreaHeight");
  if (savedInputH) {
    const h = parseInt(savedInputH, 10);
    if (h >= INPUT_MIN_H && h <= getInputMaxH()) {
      inputArea.style.height = h + "px";
      inputArea.classList.add("is-resized");
    }
  }

  // ---- Visitor mode setup ----
  function applyVisitorMode() {
    visitorMode = true;
    selectedTool = null;
    selectedModel = null;
    selectedEffort = null;
    document.body.classList.add("visitor-mode");
    // Hide sidebar toggle, new session button, and management UI
    if (menuBtn) menuBtn.style.display = "none";
    if (newSessionBtn) newSessionBtn.style.display = "none";
    if (collapseBtn) collapseBtn.style.display = "none";
    // Hide tool/model selectors and context management (visitors use defaults)
    if (inlineToolSelect) inlineToolSelect.style.display = "none";
    if (inlineModelSelect) inlineModelSelect.style.display = "none";
    if (effortSelect) effortSelect.style.display = "none";
    if (thinkingToggle) thinkingToggle.style.display = "none";
    if (compactBtn) compactBtn.style.display = "none";
    if (dropToolsBtn) dropToolsBtn.style.display = "none";
    if (contextTokens) contextTokens.style.display = "none";
  }

  // ---- Init ----
  initResponsiveLayout();

  async function initApp() {
    const urlParams = new URLSearchParams(location.search);
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const info = await res.json();
        if (info.role === "visitor" && info.sessionId) {
          visitorSessionId = info.sessionId;
          applyVisitorMode();
        }
      }
    } catch {}

    if (urlParams.has("visitor")) {
      history.replaceState(null, "", "/");
    }

    syncAddToolModal();
    if (!visitorMode) {
      await fetchSettings();
      await loadInlineTools();
      initializePushNotifications();
    }
    connect();
  }

  initApp();
})();

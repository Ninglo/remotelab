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
  const newSessionModal = document.getElementById("newSessionModal");
  const folderInput = document.getElementById("folderInput");
  const folderSuggestions = document.getElementById("folderSuggestions");
  const toolSelect = document.getElementById("toolSelect");
  const cancelModal = document.getElementById("cancelModal");
  const createSessionBtn = document.getElementById("createSession");
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
  const tabSessions = document.getElementById("tabSessions");
  const tabProgress = document.getElementById("tabProgress");
  const progressPanel = document.getElementById("progressPanel");
  const inputArea = document.getElementById("inputArea");
  const inputResizeHandle = document.getElementById("inputResizeHandle");

  let ws = null;
  let pendingImages = [];
  let currentSessionId = null;
  let sessionStatus = "idle";
  let reconnectTimer = null;
  let sessions = [];
  let archivedSessions = []; // sessions sorted by archivedAt desc
  let pendingSummary = new Set(); // sessionIds awaiting summary generation
  let finishedUnread = new Set(); // sessionIds finished but not yet opened
  let lastSidebarUpdatedAt = {}; // sessionId -> last known updatedAt
  let messageQueue = []; // messages queued while disconnected

  let currentTokens = 0;

  let selectedTool = localStorage.getItem("selectedTool") || null;
  // Default thinking to enabled; only disable if explicitly set to 'false'
  let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
  // Model/effort are stored per-tool: "selectedModel_claude", "selectedModel_codex"
  let selectedModel = null;
  let selectedEffort = null;
  let currentToolModels = []; // model list for current tool
  let currentToolEffortLevels = null; // null = binary toggle, string[] = effort dropdown
  let sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
  let toolsList = [];
  let isDesktop = window.matchMedia("(min-width: 768px)").matches;
  let collapsedFolders = JSON.parse(
    localStorage.getItem("collapsedFolders") || "{}",
  );

  // Thinking block state
  let currentThinkingBlock = null; // { el, body, tools: Set }
  let inThinkingBlock = false;

  // ---- Browser Notifications + Web Push ----
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") setupPushNotifications();
    });
  } else if ("Notification" in window && Notification.permission === "granted") {
    setupPushNotifications();
  }

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
  async function loadInlineTools() {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      toolsList = (data.tools || []).filter((t) => t.available);
      inlineToolSelect.innerHTML = "";
      for (const t of toolsList) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        inlineToolSelect.appendChild(opt);
      }
      if (selectedTool && toolsList.some((t) => t.id === selectedTool)) {
        inlineToolSelect.value = selectedTool;
      } else if (toolsList.length > 0) {
        selectedTool = toolsList[0].id;
      }
      await loadModelsForCurrentTool();
    } catch {}
  }

  inlineToolSelect.addEventListener("change", async () => {
    selectedTool = inlineToolSelect.value;
    localStorage.setItem("selectedTool", selectedTool);
    await loadModelsForCurrentTool();
  });

  // ---- Model select ----
  async function loadModelsForCurrentTool() {
    if (!selectedTool) {
      inlineModelSelect.innerHTML = "";
      inlineModelSelect.style.display = "none";
      return;
    }
    try {
      const res = await fetch(`/api/models?tool=${encodeURIComponent(selectedTool)}`);
      const data = await res.json();
      currentToolModels = data.models || [];
      currentToolEffortLevels = data.effortLevels || null;

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
      selectedModel = localStorage.getItem(`selectedModel_${selectedTool}`) || "";
      if (selectedModel && currentToolModels.some((m) => m.id === selectedModel)) {
        inlineModelSelect.value = selectedModel;
      } else {
        inlineModelSelect.value = "";
        selectedModel = "";
      }
      inlineModelSelect.style.display = currentToolModels.length > 0 ? "" : "none";

      // Show thinking toggle (Claude) or effort dropdown (Codex)
      if (currentToolEffortLevels) {
        // Effort-based tool (Codex)
        thinkingToggle.style.display = "none";
        effortSelect.style.display = "";
        effortSelect.innerHTML = "";
        for (const level of currentToolEffortLevels) {
          const opt = document.createElement("option");
          opt.value = level;
          opt.textContent = level;
          effortSelect.appendChild(opt);
        }
        // Restore saved effort or use model's default
        selectedEffort = localStorage.getItem(`selectedEffort_${selectedTool}`) || "";
        const currentModelData = currentToolModels.find((m) => m.id === selectedModel);
        if (selectedEffort && currentToolEffortLevels.includes(selectedEffort)) {
          effortSelect.value = selectedEffort;
        } else if (currentModelData?.defaultEffort) {
          effortSelect.value = currentModelData.defaultEffort;
          selectedEffort = currentModelData.defaultEffort;
        } else if (currentToolModels[0]?.defaultEffort) {
          effortSelect.value = currentToolModels[0].defaultEffort;
          selectedEffort = currentToolModels[0].defaultEffort;
        }
      } else {
        // Toggle-based tool (Claude)
        thinkingToggle.style.display = "";
        effortSelect.style.display = "none";
        selectedEffort = null;
      }
    } catch {
      inlineModelSelect.style.display = "none";
    }
  }

  inlineModelSelect.addEventListener("change", () => {
    selectedModel = inlineModelSelect.value;
    if (selectedTool) localStorage.setItem(`selectedModel_${selectedTool}`, selectedModel);
    // Update default effort when model changes (Codex)
    if (currentToolEffortLevels && selectedModel) {
      const modelData = currentToolModels.find((m) => m.id === selectedModel);
      if (modelData?.defaultEffort && !localStorage.getItem(`selectedEffort_${selectedTool}`)) {
        effortSelect.value = modelData.defaultEffort;
        selectedEffort = modelData.defaultEffort;
      }
    }
  });

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      updateStatus("connected", "idle");
      ws.send(JSON.stringify({ action: "list" }));
      ws.send(JSON.stringify({ action: "list_archived" }));
      if (currentSessionId) {
        ws.send(
          JSON.stringify({ action: "attach", sessionId: currentSessionId }),
        );
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

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "sessions":
        sessions = msg.sessions || [];
        renderSessionList();
        break;

      case "session":
        if (msg.session) {
          const prevStatus = sessionStatus;
          sessionStatus = msg.session.status || "idle";
          updateStatus("connected", sessionStatus);
          const prevEntry = sessions.find((s) => s.id === msg.session.id);
          const wasRunning = prevEntry?.status === "running";
          if (
            msg.session.id === currentSessionId &&
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
          const idx = sessions.findIndex((s) => s.id === msg.session.id);
          if (idx >= 0) sessions[idx] = msg.session;
          else sessions.push(msg.session);
          renderSessionList();
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

      case "error":
        console.error("WS error:", msg.message);
        break;
    }
  }

  // ---- Status ----
  function updateStatus(connState, sessState) {
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
      return;
    }
    sessionStatus = sessState;
    const isRunning = sessState === "running";
    if (isRunning) {
      statusDot.className = "status-dot running";
      statusText.textContent = "running";
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
    inlineToolSelect.disabled = !hasSession;
    inlineModelSelect.disabled = !hasSession;
    thinkingToggle.disabled = !hasSession;
    effortSelect.disabled = !hasSession;
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

  function getThinkingBody() {
    if (!inThinkingBlock) openThinkingBlock();
    return currentThinkingBlock.body;
  }

  // ---- Render functions ----
  function renderMessage(evt) {
    const role = evt.role || "assistant";

    if (role === "assistant" && inThinkingBlock) {
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
      if (evt.content) div.innerHTML = marked.parse(evt.content);
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
        const tool = selectedTool || toolsList[0]?.id;
        if (!tool) {
          // No tool loaded yet — fallback to modal
          if (!isDesktop) closeSidebarFn();
          newSessionModal.classList.add("open");
          loadTools();
          folderInput.value = folder;
          folderSuggestions.innerHTML = "";
          return;
        }
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
        const metaHtml = finishedUnread.has(s.id)
          ? `<span class="status-done">● done</span>`
          : s.status === "running"
            ? `<span class="status-running">● running</span>`
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
      localStorage.setItem("selectedTool", selectedTool);
      if (prevTool !== selectedTool) {
        loadModelsForCurrentTool();
      }
    }

    restoreDraft();
    msgInput.focus();
    renderSessionList();
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

  // ---- New Session Modal ----
  newSessionBtn.addEventListener("click", () => {
    if (!isDesktop) closeSidebarFn();
    newSessionModal.classList.add("open");
    loadTools();
    folderInput.value = "";
    folderSuggestions.innerHTML = "";
    folderInput.focus();
  });

  cancelModal.addEventListener("click", () =>
    newSessionModal.classList.remove("open"),
  );
  newSessionModal.addEventListener("click", (e) => {
    if (e.target === newSessionModal) newSessionModal.classList.remove("open");
  });

  createSessionBtn.addEventListener("click", () => {
    const folder = folderInput.value.trim();
    const tool = toolSelect.value;
    if (!folder) {
      folderInput.focus();
      return;
    }
    wsSend({ action: "create", folder, tool });
    newSessionModal.classList.remove("open");

    const handler = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "session" && msg.session) {
        ws.removeEventListener("message", handler);
        attachSession(msg.session.id, msg.session);
        wsSend({ action: "list" });
      }
    };
    ws.addEventListener("message", handler);
  });

  async function loadTools() {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      toolSelect.innerHTML = "";
      for (const t of data.tools || []) {
        if (!t.available) continue;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        toolSelect.appendChild(opt);
      }
    } catch {}
  }

  // Folder autocomplete
  let acTimer = null;
  folderInput.addEventListener("input", () => {
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      const q = folderInput.value.trim();
      if (q.length < 2) {
        folderSuggestions.innerHTML = "";
        return;
      }
      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        folderSuggestions.innerHTML = "";
        for (const s of (data.suggestions || []).slice(0, 5)) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = s.replace(/^\/Users\/[^/]+/, "~");
          btn.onclick = () => {
            folderInput.value = s;
            folderSuggestions.innerHTML = "";
          };
          folderSuggestions.appendChild(btn);
        }
      } catch {}
    }, 200);
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
    if (selectedTool) msg.tool = selectedTool;
    if (selectedModel) msg.model = selectedModel;
    if (currentToolEffortLevels) {
      // Codex: send effort level (always), skip thinking flag
      if (selectedEffort) msg.effort = selectedEffort;
    } else {
      // Claude: send thinking toggle
      msg.thinking = thinkingEnabled;
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
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const s = await res.json();
      progressEnabled = s.progressEnabled === true;
    } catch {}
  }
  fetchSettings();

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

  // ---- Init ----
  initResponsiveLayout();
  loadInlineTools();
  connect();
})();

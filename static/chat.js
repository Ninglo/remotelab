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
  let pendingSummary = new Set(); // sessionIds awaiting summary generation
  let finishedUnread = new Set(); // sessionIds finished but not yet opened
  let lastSidebarUpdatedAt = {}; // sessionId -> last known updatedAt
  let messageQueue = []; // messages queued while disconnected

  let currentTokens = 0;

  let selectedTool = localStorage.getItem("selectedTool") || null;
  // Default thinking to enabled; only disable if explicitly set to 'false'
  let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
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

  // ---- Thinking toggle ----
  function updateThinkingUI() {
    thinkingToggle.classList.toggle("active", thinkingEnabled);
  }
  updateThinkingUI();

  thinkingToggle.addEventListener("click", () => {
    thinkingEnabled = !thinkingEnabled;
    localStorage.setItem("thinkingEnabled", thinkingEnabled);
    updateThinkingUI();
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
    } catch {}
  }

  inlineToolSelect.addEventListener("change", () => {
    selectedTool = inlineToolSelect.value;
    localStorage.setItem("selectedTool", selectedTool);
  });

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      updateStatus("connected", "idle");
      ws.send(JSON.stringify({ action: "list" }));
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
          // Mark as pending summary when any session goes running → idle
          if (wasRunning && msg.session.status === "idle") {
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
        break;

      case "event":
        if (msg.event) renderEvent(msg.event, true);
        break;

      case "deleted":
        sessions = sessions.filter((s) => s.id !== msg.sessionId);
        localStorage.removeItem(`draft_${msg.sessionId}`);
        if (currentSessionId === msg.sessionId) {
          messageQueue = [];
          currentSessionId = null;
          clearMessages();
          showEmpty();
        }
        renderSessionList();
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
    thinkingToggle.disabled = !hasSession;
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
            <button class="session-action-btn del" title="Delete" data-id="${s.id}">&times;</button>
          </div>`;

        div.addEventListener("click", (e) => {
          if (
            e.target.classList.contains("rename") ||
            e.target.classList.contains("del")
          )
            return;
          attachSession(s.id, s);
          if (!isDesktop) closeSidebarFn();
        });

        div.querySelector(".rename").addEventListener("click", (e) => {
          e.stopPropagation();
          startRename(div, s);
        });

        div.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm("Delete this session?")) {
            wsSend({ action: "delete", sessionId: s.id });
          }
        });

        items.appendChild(div);
      }

      group.appendChild(header);
      group.appendChild(items);
      sessionList.appendChild(group);
    }
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
    thinkingToggle.disabled = false;

    if (session?.tool && toolsList.some((t) => t.id === session.tool)) {
      inlineToolSelect.value = session.tool;
      selectedTool = session.tool;
      localStorage.setItem("selectedTool", selectedTool);
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
    const msg = { action: "send", text: text || "(image)" };
    if (selectedTool) msg.tool = selectedTool;
    msg.thinking = thinkingEnabled;
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

  // ---- Progress sidebar ----
  let activeTab = "sessions"; // "sessions" | "progress"
  let progressPollTimer = null;
  let lastProgressState = { sessions: {} };

  function switchTab(tab) {
    activeTab = tab;
    tabSessions.classList.toggle("active", tab === "sessions");
    tabProgress.classList.toggle("active", tab === "progress");
    sessionList.style.display = tab === "sessions" ? "" : "none";
    progressPanel.classList.toggle("visible", tab === "progress");
    newSessionBtn.classList.toggle("hidden", tab === "progress");
    if (tab === "progress") {
      fetchSidebarState();
      if (!progressPollTimer) {
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
      empty.textContent = "No summaries yet. Send a message in any session to generate one.";
      progressPanel.appendChild(empty);
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

// ---- Send message ----
function sendMessage(existingRequestId) {
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  if ((!text && pendingImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  const requestId = existingRequestId || createRequestId();

  // Protect the message: save to localStorage before anything else
  const pendingTimestamp = savePendingMessage(text, requestId);

  // Render optimistic bubble BEFORE revoking image URLs
  renderOptimisticMessage(text, pendingImages, pendingTimestamp);

  const msg = { action: "send", text: text || "(image)" };
  msg.requestId = requestId;
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
  dispatchAction(msg);
  msgInput.value = "";
  clearDraft();
  autoResizeInput();
}

cancelBtn.addEventListener("click", () => dispatchAction({ action: "cancel" }));
resumeBtn.addEventListener("click", () => dispatchAction({ action: "resume_interrupted" }));

compactBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "compact" });
});

dropToolsBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "drop_tools" });
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
function savePendingMessage(text, requestId) {
  if (!currentSessionId) return;
  const timestamp = Date.now();
  localStorage.setItem(
    `pending_msg_${currentSessionId}`,
    JSON.stringify({ text, requestId, timestamp }),
  );
  return timestamp;
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

function renderOptimisticMessage(text, images, timestamp = Date.now()) {
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

  appendMessageTimestamp(bubble, timestamp, "msg-user-time");

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

  appendMessageTimestamp(bubble, pending.timestamp, "msg-user-time");

  const actions = document.createElement("div");
  actions.className = "msg-failed-actions";

  const retryBtn = document.createElement("button");
  retryBtn.textContent = "Resend";
  retryBtn.className = "msg-retry-btn";
  retryBtn.onclick = () => {
    wrap.remove();
    clearPendingMessage();
    msgInput.value = pending.text;
    sendMessage(pending.requestId);
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
    ((pending.requestId && lastUserMsg.requestId === pending.requestId) ||
      (lastUserMsg.content === pending.text &&
        lastUserMsg.timestamp >= pending.timestamp - 5000))
  ) {
    clearPendingMessage();
    return;
  }

  // Show the pending message with recovery actions
  renderPendingRecovery(pending);
}

// ---- Progress sidebar ----
let activeTab = normalizeSidebarTab(
  pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "progress"
let lastProgressState = { sessions: {} };
let progressEnabled = false; // loaded from backend, default off

async function fetchSettings() {
  if (visitorMode) return;
  try {
    const s = await fetchJsonOrRedirect("/api/settings");
    progressEnabled = s.progressEnabled === true;
  } catch {}
}

function switchTab(tab, { syncState = true } = {}) {
  activeTab = normalizeSidebarTab(tab);
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabProgress.classList.toggle("active", activeTab === "progress");
  sessionList.style.display = activeTab === "sessions" ? "" : "none";
  progressPanel.classList.toggle("visible", activeTab === "progress");
  sessionListFooter.classList.toggle("hidden", activeTab !== "sessions");
  newSessionBtn.classList.toggle("hidden", activeTab === "progress");
  if (activeTab === "progress") {
    fetchSidebarState();
  }
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabProgress.addEventListener("click", () => switchTab("progress"));
switchTab(activeTab, { syncState: false });

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
      await fetchJsonOrRedirect("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progressEnabled }),
      });
    } catch {}
    if (progressEnabled && activeTab === "progress") {
      fetchSidebarState().catch(() => {});
    }
    renderProgressPanel(lastProgressState);
  });
  progressPanel.appendChild(toggleRow);
}

function renderProgressPanel(state) {
  progressPanel.innerHTML = "";
  const stateEntries = Object.entries(state.sessions || {}).filter(([sessionId]) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    return !session?.archived;
  });

  // Collect all session IDs to render: those with data + those pending without data yet
  const pendingOnly = [...pendingSummary].filter((id) => {
    if (state.sessions[id]) return false;
    const session = sessions.find((entry) => entry.id === id);
    return !session?.archived;
  });
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

    const groupInfo = getSessionGroupInfo(entry);
    const displayName = entry.name || getFolderLabel(entry.folder) || "Session";
    const groupingTitle = entry.group
      ? entry.description || entry.folder || groupInfo.title
      : groupInfo.title;

    const summaryIndicator = isSummarizing
      ? '<div class="progress-summarizing">Summarizing...</div>'
      : "";

    if (entry._pendingOnly) {
      card.innerHTML = `
        <div class="progress-card-header">
          <div class="progress-card-name">${escapeHtml(displayName)}</div>
        </div>
        <div class="progress-card-folder" title="${escapeHtml(groupingTitle || "")}">${escapeHtml(groupInfo.label)}</div>
        <div class="progress-summarizing">Summarizing...</div>
      `;
    } else {
      card.innerHTML = `
        <div class="progress-card-header">
          ${isRunning ? '<div class="progress-running-dot"></div>' : ''}
          <div class="progress-card-name">${escapeHtml(displayName)}</div>
        </div>
        <div class="progress-card-folder" title="${escapeHtml(groupingTitle || "")}">${escapeHtml(groupInfo.label)}</div>
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
    const state = await fetchJsonOrRedirect("/api/sidebar");
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


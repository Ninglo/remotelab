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
  if (msgInput.value) {
    localStorage.setItem(`draft_${currentSessionId}`, msgInput.value);
    return;
  }
  localStorage.removeItem(`draft_${currentSessionId}`);
}
function restoreDraft() {
  const draft = currentSessionId
    ? localStorage.getItem(`draft_${currentSessionId}`)
    : "";
  msgInput.value = draft ?? "";
  autoResizeInput();
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
  clearOptimisticMessage();

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

function clearOptimisticMessage() {
  const prev = document.getElementById("optimistic-msg");
  if (prev) prev.remove();
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

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "progress"

function switchTab(tab, { syncState = true } = {}) {
  activeTab = normalizeSidebarTab(tab);
  const showingSessions = activeTab === "sessions";
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabProgress.classList.toggle("active", activeTab === "progress");
  if (typeof syncSidebarFiltersVisibility === "function") {
    syncSidebarFiltersVisibility(showingSessions);
  } else if (sidebarFilters) {
    sidebarFilters.classList.toggle("hidden", !showingSessions);
  }
  sessionList.style.display = showingSessions ? "" : "none";
  progressPanel.classList.toggle("visible", activeTab === "progress");
  progressPanel.textContent = "";
  sessionListFooter.classList.toggle("hidden", !showingSessions);
  newSessionBtn.classList.toggle("hidden", !showingSessions);
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabProgress.addEventListener("click", () => switchTab("progress"));
switchTab(activeTab, { syncState: false });

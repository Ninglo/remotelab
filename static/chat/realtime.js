// ---- WebSocket ----
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    updateStatus(
      "connected",
      getCurrentSession()?.status || "idle",
      getCurrentSession()?.renameState,
      getCurrentSession()?.archived === true,
    );
    if (hasSeenWsOpen) {
      refreshRealtimeViews().catch(() => {});
    } else {
      hasSeenWsOpen = true;
    }
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
    updateStatus(
      "disconnected",
      getCurrentSession()?.status || "idle",
      getCurrentSession()?.renameState,
      getCurrentSession()?.archived === true,
    );
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

async function dispatchAction(msg) {
  try {
    switch (msg.action) {
      case "list":
        await fetchSessionsList();
        return;
      case "attach":
        currentSessionId = msg.sessionId;
        hasAttachedSession = true;
        await refreshCurrentSession();
        return;
      case "create": {
        const data = await fetchJsonOrRedirect("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder: msg.folder || "~",
            tool: msg.tool,
            name: msg.name || "",
            appId: msg.appId || "",
          }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          attachSession(session.id, session);
        } else {
          await fetchSessionsList();
        }
        return;
      }
      case "rename": {
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: msg.name }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === msg.sessionId) {
            applyAttachedSessionState(msg.sessionId, session);
          }
        } else if (currentSessionId === msg.sessionId) {
          await refreshCurrentSession();
        } else {
          await refreshSidebarSession(msg.sessionId);
        }
        return;
      }
      case "archive":
      case "unarchive": {
        const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(msg.sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: msg.action === "archive" }),
        });
        if (data.session) {
          const session = upsertSession(data.session) || data.session;
          renderSessionList();
          if (currentSessionId === msg.sessionId) {
            applyAttachedSessionState(msg.sessionId, session);
          }
        } else if (currentSessionId === msg.sessionId) {
          await refreshCurrentSession();
        } else {
          await fetchSessionsList();
        }
        return;
      }
      case "send": {
        const pending = getPendingMessage();
        const requestId = msg.requestId || pending?.requestId || createRequestId();
        savePendingMessage(msg.text, requestId);
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId,
            text: msg.text,
            ...(msg.images ? { images: msg.images } : {}),
            ...(msg.tool ? { tool: msg.tool } : {}),
            ...(msg.model ? { model: msg.model } : {}),
            ...(msg.effort ? { effort: msg.effort } : {}),
            ...(msg.thinking ? { thinking: true } : {}),
          }),
        });
        await refreshCurrentSession();
        return;
      }
      case "cancel":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/cancel`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return;
      case "resume_interrupted":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/resume`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return;
      case "compact":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/compact`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return;
      case "drop_tools":
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(currentSessionId)}/drop-tools`, {
          method: "POST",
        });
        await refreshCurrentSession();
        return;
      default:
        return;
    }
  } catch (error) {
    console.error("HTTP action failed:", error.message);
  }
}

function getCurrentSession() {
  return sessions.find((s) => s.id === currentSessionId) || null;
}

function normalizeSessionStatus(incomingStatus, previousStatus) {
  if (incomingStatus !== "idle") return incomingStatus;
  if (previousStatus === "running" || previousStatus === "done") {
    return "done";
  }
  return "idle";
}

function updateResumeButton() {
  const session = getCurrentSession();
  const canResume = !!session && !session.archived && session.status === "interrupted" && session.recoverable;
  resumeBtn.style.display = canResume ? "" : "none";
  resumeBtn.disabled = !canResume;
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "sessions_invalidated":
      fetchSessionsList().catch(() => {});
      break;

    case "session_invalidated":
      if (!msg.sessionId) {
        refreshRealtimeViews().catch(() => {});
        break;
      }
      if (msg.sessionId === currentSessionId) {
        refreshCurrentSession().catch(() => {});
      } else if (!visitorMode) {
        refreshSidebarSession(msg.sessionId).catch(() => {});
      }
      break;

    case "error":
      console.error("WS error:", msg.message);
      break;
  }
}

// ---- Status ----
function updateStatus(connState, sessState, renameState, archived = false) {
  if (connState === "disconnected") {
    statusDot.className = "status-dot";
    statusText.textContent = "Reconnecting…";
    msgInput.disabled = !currentSessionId || archived;
    msgInput.placeholder = archived ? "Archived session — restore to continue" : "Message...";
    sendBtn.style.display = "";
    sendBtn.disabled = !currentSessionId || archived;
    return;
  }
  sessionStatus = sessState;
  const isRunning = sessState === "running";
  const isDone = sessState === "done";
  const isInterrupted = sessState === "interrupted";
  const isRenaming = renameState === "pending";
  const renameFailed = renameState === "failed";
  if (isRunning) {
    statusDot.className = "status-dot running";
    statusText.textContent = archived ? "running · archived" : "running";
  } else if (isDone) {
    statusDot.className = archived ? "status-dot" : "status-dot done";
    statusText.textContent = archived ? "archived" : "done";
  } else if (isInterrupted) {
    statusDot.className = archived ? "status-dot" : "status-dot interrupted";
    statusText.textContent = archived ? "archived" : "interrupted";
  } else if (isRenaming) {
    statusDot.className = "status-dot renaming";
    statusText.textContent = "renaming…";
  } else if (renameFailed) {
    statusDot.className = "status-dot rename-failed";
    statusText.textContent = "rename failed";
  } else if (archived) {
    statusDot.className = "status-dot";
    statusText.textContent = "archived";
  } else {
    statusDot.className = "status-dot";
    statusText.textContent = currentSessionId ? "idle" : "connected";
  }
  const hasSession = !!currentSessionId;
  msgInput.disabled = !hasSession || archived;
  msgInput.placeholder = archived ? "Archived session — restore to continue" : "Message...";
  sendBtn.style.display = isRunning ? "none" : "";
  sendBtn.disabled = !hasSession || archived;
  cancelBtn.style.display = isRunning && hasSession ? "flex" : "none";
  imgBtn.disabled = !hasSession || archived;
  inlineToolSelect.disabled = visitorMode || archived;
  inlineModelSelect.disabled = !hasSession || archived;
  thinkingToggle.disabled = !hasSession || archived;
  effortSelect.disabled = !hasSession || archived;
  updateResumeButton();
  syncForkButton();
  syncShareButton();
}

// ---- Message rendering ----
function clearMessages() {
  messagesInner.innerHTML = "";
  resetRenderedEventState();
  // Reset thinking block state
  inThinkingBlock = false;
  currentThinkingBlock = null;
}

function showEmpty() {
  messagesInner.innerHTML = "";
  messagesInner.appendChild(emptyState);
  inThinkingBlock = false;
  currentThinkingBlock = null;
  syncForkButton();
  syncShareButton();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function scrollNodeToTop(node, { margin = 10 } = {}) {
  if (!node) return;
  requestAnimationFrame(() => {
    const containerRect = messagesEl.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextTop =
      messagesEl.scrollTop + (nodeRect.top - containerRect.top) - margin;
    messagesEl.scrollTop = Math.max(0, nextTop);
  });
}

function parseMessageTimestamp(stamp) {
  if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
  if (typeof stamp === "string" && stamp.trim()) {
    const parsed = new Date(stamp).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function appendMessageTimestamp(container, stamp, extraClass = "") {
  const parsed = parseMessageTimestamp(stamp);
  if (!parsed) return;
  const time = document.createElement("div");
  time.className = `msg-timestamp${extraClass ? ` ${extraClass}` : ""}`;
  time.textContent = messageTimeFormatter.format(parsed);
  time.title = new Date(parsed).toLocaleString();
  container.appendChild(time);
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

function unwrapTurnCollapseDrawers() {
  const drawers = messagesInner.querySelectorAll(".turn-collapse-drawer");
  for (const drawer of drawers) {
    const body = drawer.querySelector(".turn-collapse-body");
    if (!body) {
      drawer.remove();
      continue;
    }
    const fragment = document.createDocumentFragment();
    while (body.firstChild) {
      fragment.appendChild(body.firstChild);
    }
    drawer.replaceWith(fragment);
  }
}

function collectRenderedTurns() {
  const turns = [];
  let currentTurn = null;
  for (const node of messagesInner.children) {
    if (node === emptyState || node.classList.contains("turn-collapse-drawer")) {
      continue;
    }
    if (node.classList.contains("msg-user")) {
      currentTurn = { userNode: node, bodyNodes: [] };
      turns.push(currentTurn);
      continue;
    }
    if (currentTurn) {
      currentTurn.bodyNodes.push(node);
    }
  }
  return turns;
}

function getLastThinkingNodeIndex(nodes) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]?.classList?.contains("thinking-block")) {
      return index;
    }
  }
  return -1;
}

function buildTurnCollapseLabel(hiddenNodes) {
  const thoughtCount = hiddenNodes.filter((node) =>
    node.classList?.contains("thinking-block"),
  ).length;
  if (thoughtCount > 1) {
    return `Earlier reasoning & tool steps · ${thoughtCount} thoughts`;
  }
  return "Earlier reasoning & tool steps";
}

function applyFinishedTurnCollapseState() {
  unwrapTurnCollapseDrawers();
  const turns = collectRenderedTurns();
  let latestTurnStart = null;

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn?.userNode || turn.bodyNodes.length === 0) continue;
    latestTurnStart = turn.userNode;

    const isLastTurn = index === turns.length - 1;
    if (isLastTurn && (sessionStatus === "running" || inThinkingBlock)) {
      continue;
    }

    const lastThinkingIndex = getLastThinkingNodeIndex(turn.bodyNodes);
    if (lastThinkingIndex < 0) continue;

    const hiddenNodes = turn.bodyNodes.slice(0, lastThinkingIndex + 1);
    const visibleNodes = turn.bodyNodes.slice(lastThinkingIndex + 1);
    if (hiddenNodes.length === 0 || visibleNodes.length === 0) continue;

    const hasVisibleTail = visibleNodes.some(
      (node) =>
        node.classList?.contains("msg-assistant")
        || node.classList?.contains("msg-system")
        || node.classList?.contains("usage-info"),
    );
    if (!hasVisibleTail) continue;

    const drawer = document.createElement("details");
    drawer.className = "turn-collapse-drawer";

    const summary = document.createElement("summary");
    summary.className = "turn-collapse-summary";
    summary.textContent = buildTurnCollapseLabel(hiddenNodes);

    const body = document.createElement("div");
    body.className = "turn-collapse-body";
    for (const node of hiddenNodes) {
      body.appendChild(node);
    }

    drawer.appendChild(summary);
    drawer.appendChild(body);
    turn.userNode.insertAdjacentElement("afterend", drawer);
  }

  return latestTurnStart;
}

function shouldFocusLatestTurnStart(node) {
  return !!node && sessionStatus !== "running" && !inThinkingBlock;
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

  header.addEventListener("click", async () => {
    block.classList.toggle("collapsed");
    if (!block.classList.contains("collapsed")) {
      await hydrateLazyNodes(block);
    }
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

function eventBodyCacheKey(sessionId, seq) {
  return `${sessionId}:${seq}`;
}

async function fetchEventBody(sessionId, seq) {
  const key = eventBodyCacheKey(sessionId, seq);
  if (eventBodyCache.has(key)) return eventBodyCache.get(key);
  if (eventBodyRequests.has(key)) return eventBodyRequests.get(key);
  const request = fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/${seq}/body`,
  )
    .then((data) => {
      const body = data.body || null;
      eventBodyCache.set(key, body);
      eventBodyRequests.delete(key);
      return body;
    })
    .catch((error) => {
      eventBodyRequests.delete(key);
      throw error;
    });
  eventBodyRequests.set(key, request);
  return request;
}

function cleanBase64TextForDisplay(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function looksLikeReadableDisplayText(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return false;
  if (value.includes("\uFFFD")) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function tryDecodeUtf8Base64Text(text) {
  const normalized = cleanBase64TextForDisplay(text);
  if (
    normalized.length < 16 ||
    normalized.length % 4 !== 0 ||
    !/[+/=]/.test(normalized) ||
    /[^A-Za-z0-9+/=]/.test(normalized)
  ) {
    return "";
  }

  try {
    const binary = window.atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    return looksLikeReadableDisplayText(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function formatDecodedDisplayText(text) {
  const source = typeof text === "string" ? text : "";
  const marker = "Original email:";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return source;

  const prefix = source.slice(0, markerIndex + marker.length);
  const encodedTail = source.slice(markerIndex + marker.length).replace(/^\s+/, "");
  const decodedTail = tryDecodeUtf8Base64Text(encodedTail);
  if (!decodedTail) return source;
  return `${prefix}\n${decodedTail}`;
}

async function hydrateLazyNode(node) {
  const sessionId = currentSessionId;
  const seq = parseInt(node?.dataset?.eventSeq || "", 10);
  if (!sessionId || !seq || node.dataset.bodyPending !== "true") return;
  node.dataset.bodyPending = "loading";
  try {
    const body = await fetchEventBody(sessionId, seq);
    node.textContent = formatDecodedDisplayText(body?.value || node.dataset.preview || "");
    node.dataset.bodyPending = "false";
  } catch (error) {
    console.warn("[event-body] Failed to load body:", error.message);
    node.dataset.bodyPending = "true";
  }
}

async function hydrateLazyNodes(root) {
  const nodes = root?.querySelectorAll?.('[data-body-pending="true"]') || [];
  await Promise.all([...nodes].map((node) => hydrateLazyNode(node)));
}

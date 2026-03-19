// ---- Message rendering ----
function clearMessages({ preserveRunningBlockExpanded = false } = {}) {
  const shouldPreserveRunningBlockExpanded =
    preserveRunningBlockExpanded === true && renderedEventState.runningBlockExpanded === true;
  messagesInner.innerHTML = "";
  resetRenderedEventState();
  if (shouldPreserveRunningBlockExpanded) {
    renderedEventState.runningBlockExpanded = true;
  }
  // Reset thinking block state
  inThinkingBlock = false;
  currentThinkingBlock = null;
}

function showEmpty() {
  messagesInner.innerHTML = "";
  messagesInner.appendChild(emptyState);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(null);
  }
  inThinkingBlock = false;
  currentThinkingBlock = null;
  if (typeof syncSessionTemplateControls === "function") {
    syncSessionTemplateControls();
  }
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

function queueHydrateLazyNodes(root) {
  if (!root) return;
  setTimeout(() => {
    hydrateLazyNodes(root).catch(() => {});
  }, 0);
}

function renderEvent(evt, autoScroll) {
  let rendered = false;

  switch (evt.type) {
    case "message":
      rendered = true;
      renderMessage(evt);
      break;
    case "collapsed_block":
      rendered = true;
      renderCollapsedBlock(evt);
      break;
    case "thinking_block":
      rendered = true;
      renderThinkingBlockEvent(evt);
      break;
    case "tool_use":
      rendered = true;
      renderToolUse(evt);
      break;
    case "tool_result":
      rendered = true;
      renderToolResult(evt);
      break;
    case "file_change":
      rendered = true;
      renderFileChange(evt);
      break;
    case "reasoning":
      rendered = true;
      renderReasoning(evt);
      break;
    case "status":
      rendered = true;
      renderStatusMsg(evt);
      break;
    case "context_barrier":
      rendered = true;
      renderContextBarrier(evt);
      break;
    case "usage":
      rendered = true;
      renderUsage(evt);
      break;
  }

  if (!rendered) return;

  if (emptyState.parentNode === messagesInner) emptyState.remove();

  const shouldScroll =
    autoScroll &&
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      120;

  if (shouldScroll) scrollToBottom();
}

function applyFinishedTurnCollapseState() {
  let latestTurnStart = null;
  for (const node of messagesInner.children) {
    if (node === emptyState) continue;
    if (node.classList?.contains("msg-user")) {
      latestTurnStart = node;
    }
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
  header.innerHTML = `${renderRealtimeIcon("gear", "thinking-icon")}
    <span class="thinking-label">Thinking…</span>
    <span class="thinking-chevron">${renderRealtimeIcon("chevron-down")}</span>`;

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

function eventBlockCacheKey(sessionId, startSeq, endSeq) {
  return `${sessionId}:${startSeq}-${endSeq}`;
}

async function fetchEventBlock(sessionId, startSeq, endSeq) {
  const key = eventBlockCacheKey(sessionId, startSeq, endSeq);
  if (eventBlockCache.has(key)) return eventBlockCache.get(key);
  if (eventBlockRequests.has(key)) return eventBlockRequests.get(key);
  if ((typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) && typeof getShareSnapshotEventBlock === "function") {
    const localBlock = getShareSnapshotEventBlock(startSeq, endSeq);
    if (localBlock) {
      eventBlockCache.set(key, localBlock);
      return localBlock;
    }
  }
  const request = fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/blocks/${startSeq}-${endSeq}`,
    { revalidate: false },
  )
    .then((data) => {
      eventBlockCache.set(key, data);
      eventBlockRequests.delete(key);
      return data;
    })
    .catch((error) => {
      eventBlockRequests.delete(key);
      throw error;
    });
  eventBlockRequests.set(key, request);
  return request;
}

function eventBodyCacheKey(sessionId, seq) {
  return `${sessionId}:${seq}`;
}

const EVENT_BODY_FETCH_CONCURRENCY = 6;
const eventBodyQueue = [];
let activeEventBodyFetches = 0;

function pumpEventBodyQueue() {
  while (activeEventBodyFetches < EVENT_BODY_FETCH_CONCURRENCY && eventBodyQueue.length > 0) {
    const next = eventBodyQueue.shift();
    if (!next) break;
    activeEventBodyFetches += 1;
    Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeEventBodyFetches = Math.max(0, activeEventBodyFetches - 1);
        pumpEventBodyQueue();
      });
  }
}

function scheduleEventBodyFetch(run) {
  return new Promise((resolve, reject) => {
    eventBodyQueue.push({ run, resolve, reject });
    pumpEventBodyQueue();
  });
}

async function fetchEventBody(sessionId, seq) {
  const key = eventBodyCacheKey(sessionId, seq);
  if (eventBodyCache.has(key)) return eventBodyCache.get(key);
  if (eventBodyRequests.has(key)) return eventBodyRequests.get(key);
  const request = scheduleEventBodyFetch(() => fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/${seq}/body`,
    { revalidate: false },
  ))
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

function applyLazyBodyToNode(node, body) {
  if (!node) return;
  const renderMode = node.dataset.bodyRender || "text";
  const value = formatDecodedDisplayText(body?.value || node.dataset.preview || "");
  if (renderMode === "markdown" && typeof renderMarkdownIntoNode === "function") {
    renderMarkdownIntoNode(node, value);
    return;
  }
  node.textContent = value;
}

function cleanBase64TextForDisplay(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function stripHiddenDisplayBlocks(text) {
  return String(text || "")
    .replace(/<private>[\s\S]*?<\/private>/gi, "")
    .replace(/<hide>[\s\S]*?<\/hide>/gi, "")
    .trim();
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
  const source = stripHiddenDisplayBlocks(typeof text === "string" ? text : "");
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
  try {
    const body = await fetchEventBody(sessionId, seq);
    applyLazyBodyToNode(node, body);
    node.dataset.bodyPending = "false";
  } catch (error) {
    console.warn("[event-body] Failed to load body:", error.message);
  }
}

async function hydrateLazyNodes(root) {
  const nodes = root?.querySelectorAll?.('[data-body-pending="true"]') || [];
  await Promise.all([...nodes].map((node) => hydrateLazyNode(node)));
}

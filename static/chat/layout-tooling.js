// ---- Responsive layout ----
const MOBILE_KEYBOARD_OPEN_THRESHOLD = 120;
const MESSAGE_VIEWPORT_STICKY_THRESHOLD = 120;
const MESSAGE_VIEWPORT_TRACE_LIMIT = 80;
const layoutSubscribers = new Set();
let layoutPassHandle = 0;
let pendingLayoutReason = null;
let currentLayoutState = null;
let messageViewportFollowBottom = true;
let messageViewportRestoreGeneration = 0;
let messageViewportControllerInitialized = false;
let messageViewportResizeObserver = null;
let messageViewportMutationObserver = null;
const messageViewportTrace = [];

function scheduleAnimationFrame(callback) {
  if (typeof window?.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  callback();
  return 0;
}

function getLayoutViewportHeightPx() {
  const innerHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return Math.round(innerHeight);
}

function getVisualViewportHeightPx() {
  const visualHeight = window.visualViewport?.height;
  if (Number.isFinite(visualHeight) && visualHeight > 0) {
    return Math.round(visualHeight);
  }
  return 0;
}

function buildLayoutState() {
  const layoutViewportHeight = getLayoutViewportHeightPx();
  const visualViewportHeight = getVisualViewportHeightPx();
  const viewportHeight = visualViewportHeight > 0
    ? Math.min(layoutViewportHeight || visualViewportHeight, visualViewportHeight)
    : layoutViewportHeight;
  const keyboardInsetHeight = !isDesktop && layoutViewportHeight > 0
    ? Math.max(0, layoutViewportHeight - viewportHeight)
    : 0;
  const viewportOffsetTop = window.visualViewport?.offsetTop || 0;
  return {
    isDesktop,
    layoutViewportHeight,
    viewportHeight,
    viewportOffsetTop,
    keyboardInsetHeight,
    keyboardOpen: !isDesktop && keyboardInsetHeight >= MOBILE_KEYBOARD_OPEN_THRESHOLD,
  };
}

function isMessageViewportNearBottom(threshold = MESSAGE_VIEWPORT_STICKY_THRESHOLD) {
  if (!messagesEl) return false;
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function recordMessageViewportTrace(reason, details = {}) {
  if (!messagesEl) return;
  messageViewportTrace.push({
    at: Date.now(),
    reason,
    scrollTop: Math.round(messagesEl.scrollTop || 0),
    scrollHeight: Math.round(messagesEl.scrollHeight || 0),
    clientHeight: Math.round(messagesEl.clientHeight || 0),
    followBottom: messageViewportFollowBottom,
    ...details,
  });
  if (messageViewportTrace.length > MESSAGE_VIEWPORT_TRACE_LIMIT) {
    messageViewportTrace.splice(0, messageViewportTrace.length - MESSAGE_VIEWPORT_TRACE_LIMIT);
  }
}

function setMessageViewportScrollTop(nextScrollTop, reason) {
  if (!messagesEl) return;
  messagesEl.scrollTop = Math.max(0, Number(nextScrollTop) || 0);
  recordMessageViewportTrace(reason, { action: "write" });
}

function getMessageViewportChildren() {
  if (typeof messagesInner === "undefined" || !messagesInner?.children) return [];
  return Array.from(messagesInner.children);
}

function captureMessageViewportAnchor() {
  if (!messagesEl?.getBoundingClientRect) return null;
  const containerRect = messagesEl.getBoundingClientRect();
  const children = getMessageViewportChildren();
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    if (!node?.getBoundingClientRect) continue;
    const nodeRect = node.getBoundingClientRect();
    if (nodeRect.bottom <= containerRect.top) continue;
    return {
      key: typeof node.dataset?.transcriptKey === "string"
        ? node.dataset.transcriptKey
        : "",
      index,
      offsetTop: nodeRect.top - containerRect.top,
    };
  }
  return null;
}

function captureMessageViewport({
  threshold = MESSAGE_VIEWPORT_STICKY_THRESHOLD,
  reason = "capture",
} = {}) {
  if (!messagesEl) return null;
  const nearBottom = isMessageViewportNearBottom(threshold);
  const followBottom = messageViewportControllerInitialized
    ? (messageViewportFollowBottom || nearBottom)
    : nearBottom;
  const snapshot = {
    followBottom,
    scrollTop: messagesEl.scrollTop || 0,
    distanceFromBottom: Math.max(
      0,
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight,
    ),
    anchor: followBottom ? null : captureMessageViewportAnchor(),
  };
  recordMessageViewportTrace(reason, {
    action: "capture",
    capturedFollowBottom: followBottom,
    anchorKey: snapshot.anchor?.key || "",
    anchorIndex: Number.isInteger(snapshot.anchor?.index) ? snapshot.anchor.index : null,
  });
  return snapshot;
}

function findMessageViewportAnchorNode(anchor) {
  if (!anchor) return null;
  const children = getMessageViewportChildren();
  if (anchor.key) {
    const keyedNode = children.find((node) => node?.dataset?.transcriptKey === anchor.key);
    if (keyedNode) return keyedNode;
  }
  return Number.isInteger(anchor.index) ? (children[anchor.index] || null) : null;
}

function applyMessageViewportSnapshot(snapshot, reason) {
  if (!messagesEl || !snapshot) return;
  if (snapshot.followBottom) {
    messageViewportFollowBottom = true;
    setMessageViewportScrollTop(messagesEl.scrollHeight, `${reason}:bottom`);
    return;
  }

  messageViewportFollowBottom = false;
  const anchorNode = findMessageViewportAnchorNode(snapshot.anchor);
  if (anchorNode?.getBoundingClientRect && messagesEl.getBoundingClientRect) {
    const containerRect = messagesEl.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    const anchorDelta = anchorRect.top - containerRect.top - snapshot.anchor.offsetTop;
    setMessageViewportScrollTop(
      messagesEl.scrollTop + anchorDelta,
      `${reason}:anchor`,
    );
    return;
  }
  setMessageViewportScrollTop(snapshot.scrollTop, `${reason}:position`);
}

function restoreMessageViewport(snapshot, { reason = "restore" } = {}) {
  if (!snapshot) return;
  const restoreGeneration = ++messageViewportRestoreGeneration;
  const applyIfCurrent = (phase) => {
    if (restoreGeneration !== messageViewportRestoreGeneration) return;
    applyMessageViewportSnapshot(snapshot, `${reason}:${phase}`);
  };
  applyIfCurrent("now");
  scheduleAnimationFrame(() => {
    applyIfCurrent("frame-1");
    scheduleAnimationFrame(() => applyIfCurrent("frame-2"));
  });
}

function scrollMessageViewportToBottom({ reason = "bottom" } = {}) {
  if (!messagesEl) return;
  messageViewportFollowBottom = true;
  restoreMessageViewport({
    followBottom: true,
    scrollTop: messagesEl.scrollTop || 0,
    distanceFromBottom: 0,
    anchor: null,
  }, { reason });
}

function scrollMessageViewportToTop({ reason = "top" } = {}) {
  if (!messagesEl) return;
  messageViewportRestoreGeneration += 1;
  messageViewportFollowBottom = false;
  setMessageViewportScrollTop(0, reason);
}

function scrollMessageNodeToTop(node, { margin = 10, reason = "node-top" } = {}) {
  if (!messagesEl || !node) return;
  messageViewportRestoreGeneration += 1;
  messageViewportFollowBottom = false;
  scheduleAnimationFrame(() => {
    if (!messagesEl?.getBoundingClientRect || !node?.getBoundingClientRect) return;
    const containerRect = messagesEl.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextTop = messagesEl.scrollTop + (nodeRect.top - containerRect.top) - margin;
    setMessageViewportScrollTop(nextTop, reason);
  });
}

function preserveBottomPinnedMessageViewport(mutator, {
  threshold = MESSAGE_VIEWPORT_STICKY_THRESHOLD,
  reason = "mutation",
} = {}) {
  if (typeof mutator !== "function") {
    return undefined;
  }
  const shouldPin = messageViewportControllerInitialized
    ? (messageViewportFollowBottom || isMessageViewportNearBottom(threshold))
    : isMessageViewportNearBottom(threshold);
  if (!shouldPin) {
    messageViewportRestoreGeneration += 1;
  }
  const result = mutator();
  if (shouldPin) {
    scrollMessageViewportToBottom({ reason });
  }
  return result;
}

function handleMessageViewportScroll() {
  messageViewportFollowBottom = isMessageViewportNearBottom();
  recordMessageViewportTrace("scroll", { action: "observe" });
}

function handleMessageViewportUserIntent() {
  messageViewportRestoreGeneration += 1;
  recordMessageViewportTrace("user-scroll-intent", { action: "observe" });
}

function handleMessageViewportResize() {
  recordMessageViewportTrace("resize", { action: "observe" });
  if (messageViewportFollowBottom) {
    scrollMessageViewportToBottom({ reason: "resize-follow" });
  }
}

function handleMessageViewportMutation() {
  recordMessageViewportTrace("mutation", { action: "observe" });
  if (messageViewportFollowBottom) {
    scrollMessageViewportToBottom({ reason: "mutation-follow" });
  }
}

function initMessageViewportController() {
  if (messageViewportControllerInitialized || !messagesEl) return;
  messageViewportControllerInitialized = true;
  messageViewportFollowBottom = isMessageViewportNearBottom();
  messagesEl.addEventListener?.("scroll", handleMessageViewportScroll, { passive: true });
  messagesEl.addEventListener?.("pointerdown", handleMessageViewportUserIntent, { passive: true });
  messagesEl.addEventListener?.("touchstart", handleMessageViewportUserIntent, { passive: true });
  messagesEl.addEventListener?.("wheel", handleMessageViewportUserIntent, { passive: true });
  messagesEl.addEventListener?.("keydown", handleMessageViewportUserIntent);
  if (typeof ResizeObserver === "function") {
    messageViewportResizeObserver = new ResizeObserver(handleMessageViewportResize);
    messageViewportResizeObserver.observe(messagesEl);
    if (typeof messagesInner !== "undefined" && messagesInner) {
      messageViewportResizeObserver.observe(messagesInner);
    }
  }
  if (
    typeof MutationObserver === "function"
    && typeof messagesInner !== "undefined"
    && messagesInner
  ) {
    messageViewportMutationObserver = new MutationObserver(handleMessageViewportMutation);
    messageViewportMutationObserver.observe(messagesInner, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  recordMessageViewportTrace("init", { action: "observe" });
}

function applyLayoutState(state) {
  if (state.viewportHeight > 0) {
    document.documentElement.style.setProperty("--app-height", `${state.viewportHeight}px`);
  }
  document.documentElement.style.setProperty("--keyboard-inset-height", `${state.keyboardInsetHeight}px`);
  document.documentElement.classList.toggle("keyboard-open", state.keyboardOpen);
  document.body?.classList.toggle("keyboard-open", state.keyboardOpen);
}

function didLayoutAffectMessageViewport(previousState, nextState) {
  if (!previousState || !nextState) return true;
  return previousState.isDesktop !== nextState.isDesktop
    || previousState.viewportHeight !== nextState.viewportHeight
    || previousState.keyboardInsetHeight !== nextState.keyboardInsetHeight
    || previousState.keyboardOpen !== nextState.keyboardOpen;
}

function getLayoutState() {
  if (!currentLayoutState) {
    currentLayoutState = buildLayoutState();
    applyLayoutState(currentLayoutState);
  }
  return currentLayoutState;
}

function runLayoutPass(reason = "layout") {
  layoutPassHandle = 0;
  pendingLayoutReason = null;
  const previousState = currentLayoutState;
  const nextState = buildLayoutState();
  const shouldRestoreMessageViewport = didLayoutAffectMessageViewport(previousState, nextState);
  const viewportSnapshot = shouldRestoreMessageViewport
    ? captureMessageViewport({ reason: `layout:${reason}` })
    : null;
  currentLayoutState = nextState;
  applyLayoutState(currentLayoutState);
  for (const subscriber of layoutSubscribers) {
    try {
      subscriber(currentLayoutState, reason);
    } catch (error) {
      console.warn("[layout] Subscriber failed:", error.message);
    }
  }
  if (viewportSnapshot) {
    restoreMessageViewport(viewportSnapshot, { reason: `layout:${reason}` });
  }
  return currentLayoutState;
}

function requestLayoutPass(reason = "layout") {
  pendingLayoutReason = reason;
  if (layoutPassHandle) {
    return layoutPassHandle;
  }
  layoutPassHandle = scheduleAnimationFrame(() => {
    runLayoutPass(pendingLayoutReason || reason);
  });
  return layoutPassHandle;
}

function normalizeToolId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function filterPrimaryToolOptions(toolOptions = []) {
  return (Array.isArray(toolOptions) ? toolOptions : []).filter((tool) => {
    const toolId = normalizeToolId(tool?.id);
    return tool && typeof tool === "object" && toolId && toolId !== "micro-agent";
  });
}

function prioritizeToolOptions(toolOptions = []) {
  const tools = Array.isArray(toolOptions) ? [...toolOptions] : [];
  const defaultIndex = tools.findIndex((tool) => tool?.id === DEFAULT_TOOL_ID);
  if (defaultIndex > 0) {
    const [defaultTool] = tools.splice(defaultIndex, 1);
    tools.unshift(defaultTool);
  }
  return tools;
}

function resolvePreferredToolId(toolOptions = [], candidates = []) {
  const tools = prioritizeToolOptions(toolOptions).filter((tool) => tool?.id);
  const availableIds = new Set(tools.map((tool) => tool.id));
  for (const candidate of candidates) {
    const toolId = typeof candidate === "string" ? candidate.trim() : "";
    if (toolId && availableIds.has(toolId)) {
      return toolId;
    }
  }
  return tools[0]?.id || "";
}

function subscribeLayoutPass(subscriber, { immediate = false } = {}) {
  if (typeof subscriber !== "function") {
    return () => {};
  }
  layoutSubscribers.add(subscriber);
  if (immediate) {
    subscriber(getLayoutState(), "subscribe");
  }
  return () => {
    layoutSubscribers.delete(subscriber);
  };
}

function getViewportHeightPx() {
  return getLayoutState().viewportHeight;
}

function syncViewportHeight() {
  return runLayoutPass("viewport");
}

function focusComposer({ force = false, preventScroll = false } = {}) {
  if (!msgInput?.focus) return false;
  if ((typeof shareSnapshotMode !== "undefined" && shareSnapshotMode) || msgInput.disabled) return false;
  if (!force && !getLayoutState().isDesktop) return false;
  try {
    if (preventScroll) {
      msgInput.focus({ preventScroll: true });
    } else {
      msgInput.focus();
    }
  } catch {
    msgInput.focus();
  }
  return true;
}

window.RemoteLabLayout = {
  getState: getLayoutState,
  getViewportHeight: getViewportHeightPx,
  requestPass: requestLayoutPass,
  subscribe: subscribeLayoutPass,
  syncNow: runLayoutPass,
  focusComposer,
  preserveBottomPinnedMessageViewport,
};

window.RemoteLabTranscriptViewport = {
  capture: captureMessageViewport,
  restore: restoreMessageViewport,
  preserveBottom: preserveBottomPinnedMessageViewport,
  scrollToBottom: scrollMessageViewportToBottom,
  scrollToTop: scrollMessageViewportToTop,
  scrollNodeToTop: scrollMessageNodeToTop,
  isFollowingBottom: () => messageViewportFollowBottom,
  getDebugState: () => ({
    followBottom: messageViewportFollowBottom,
    trace: messageViewportTrace.map((entry) => ({ ...entry })),
  }),
};

function initResponsiveLayout() {
  initMessageViewportController();
  const mq = window.matchMedia("(min-width: 768px)");
  function onBreakpointChange(e) {
    isDesktop = e.matches;
    sidebarOverlay.classList.remove("collapsed");
    if (isDesktop) {
      document.documentElement.classList.remove("keyboard-open");
      document.body?.classList.remove("keyboard-open");
      sidebarOverlay.classList.remove("open");
    }
    runLayoutPass("breakpoint");
  }
  window.addEventListener("resize", () => requestLayoutPass("window-resize"));
  window.visualViewport?.addEventListener("resize", () => requestLayoutPass("visual-viewport-resize"));
  window.visualViewport?.addEventListener("scroll", () => requestLayoutPass("visual-viewport-scroll"));
  mq.addEventListener("change", onBreakpointChange);
  onBreakpointChange(mq);
}

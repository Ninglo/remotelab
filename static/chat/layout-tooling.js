// ---- Responsive layout ----
const MOBILE_KEYBOARD_OPEN_THRESHOLD = 120;
const layoutSubscribers = new Set();
let layoutPassHandle = 0;
let pendingLayoutReason = null;
let currentLayoutState = null;

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
  return {
    isDesktop,
    layoutViewportHeight,
    viewportHeight,
    keyboardInsetHeight,
    keyboardOpen: !isDesktop && keyboardInsetHeight >= MOBILE_KEYBOARD_OPEN_THRESHOLD,
  };
}

function applyLayoutState(state) {
  if (state.viewportHeight > 0) {
    document.documentElement.style.setProperty("--app-height", `${state.viewportHeight}px`);
  }
  document.documentElement.style.setProperty("--keyboard-inset-height", `${state.keyboardInsetHeight}px`);
  document.documentElement.classList.toggle("keyboard-open", state.keyboardOpen);
  document.body?.classList.toggle("keyboard-open", state.keyboardOpen);
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
  currentLayoutState = buildLayoutState();
  applyLayoutState(currentLayoutState);
  for (const subscriber of layoutSubscribers) {
    try {
      subscriber(currentLayoutState, reason);
    } catch (error) {
      console.warn("[layout] Subscriber failed:", error.message);
    }
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

function normalizeToolVisibility(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "private" ? "private" : "public";
}

function filterPrimaryToolOptions(toolOptions = [], { keepIds = [] } = {}) {
  const explicitIds = new Set(
    [
      ...(Array.isArray(keepIds) ? keepIds : [keepIds]),
      DEFAULT_TOOL_ID,
    ]
      .map((toolId) => normalizeToolId(toolId))
      .filter(Boolean),
  );
  return (Array.isArray(toolOptions) ? toolOptions : []).filter((tool) => {
    const toolId = normalizeToolId(tool?.id);
    if (toolId && explicitIds.has(toolId)) {
      return true;
    }
    return normalizeToolVisibility(tool?.visibility) !== "private";
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
};

function initResponsiveLayout() {
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
  mq.addEventListener("change", onBreakpointChange);
  onBreakpointChange(mq);
}

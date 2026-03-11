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
  syncForkButton();
  syncShareButton();
}

// ---- Init ----
initResponsiveLayout();

async function initApp() {
  try {
    const info = await fetchJsonOrRedirect("/api/auth/me");
    if (info.role === "visitor" && info.sessionId) {
      visitorSessionId = info.sessionId;
      applyVisitorMode();
    }
  } catch {}

  const url = new URL(window.location.href);
  if (url.searchParams.has("visitor")) {
    url.searchParams.delete("visitor");
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  syncAddToolModal();
  syncForkButton();
  syncShareButton();
  if (!visitorMode) {
    await loadInlineTools();
    await fetchAppsList();
    initializePushNotifications();
  }
  await bootstrapViaHttp();
  connect();
}

initApp();

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

function redirectToLogin() {
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

const LOCAL_EDITOR_ROOT_PATTERN = /^\/(Users|home|opt|private|var|tmp|etc|Volumes|mnt)\//;

function safeDecodeHref(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizeLocalEditorHrefCandidate(href) {
  const decoded = safeDecodeHref(href);
  if (!decoded) return "";
  let candidate = decoded;
  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    candidate = candidate.slice(0, hashIndex);
  }
  const colonMatch = candidate.match(/^(.*):\d+(?::\d+)?$/);
  if (colonMatch && LOCAL_EDITOR_ROOT_PATTERN.test(colonMatch[1])) {
    return colonMatch[1];
  }
  return candidate;
}

function isLikelyLocalEditorHref(href) {
  const candidate = normalizeLocalEditorHrefCandidate(href);
  return LOCAL_EDITOR_ROOT_PATTERN.test(candidate);
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLocalEditorTarget(href) {
  const decoded = safeDecodeHref(href);
  if (!decoded) return null;

  const hashMatch = decoded.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch && LOCAL_EDITOR_ROOT_PATTERN.test(hashMatch[1])) {
    return {
      path: hashMatch[1],
      line: parsePositiveInt(hashMatch[2]),
      column: parsePositiveInt(hashMatch[3]),
    };
  }

  const colonMatch = decoded.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (colonMatch && LOCAL_EDITOR_ROOT_PATTERN.test(colonMatch[1])) {
    return {
      path: colonMatch[1],
      line: parsePositiveInt(colonMatch[2]),
      column: parsePositiveInt(colonMatch[3]),
    };
  }

  if (!LOCAL_EDITOR_ROOT_PATTERN.test(decoded)) return null;
  return { path: decoded, line: null, column: null };
}

function supportsDesktopEditorLinks() {
  if (typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(pointer: fine)").matches &&
    window.matchMedia("(hover: hover)").matches
  );
}

function buildVscodeEditorHref(href) {
  const target = parseLocalEditorTarget(href);
  if (!target) return "";
  const lineSuffix = target.line
    ? `:${target.line}${target.column ? `:${target.column}` : ""}`
    : "";
  return `vscode://file${encodeURI(target.path)}${lineSuffix}`;
}

function enhanceRenderedContentLinks(root) {
  if (!root) return;

  root.querySelectorAll("a[href]").forEach((link) => {
    const href = (
      link.dataset.localEditorSource ||
      link.getAttribute("href") ||
      ""
    ).trim();
    if (!href) return;

    if (isLikelyLocalEditorHref(href)) {
      link.dataset.localEditorSource = href;
      link.removeAttribute("target");
      link.removeAttribute("rel");

      if (visitorMode) {
        link.removeAttribute("href");
        link.title = "Local file links are unavailable in visitor mode";
        return;
      }

      if (!supportsDesktopEditorLinks()) {
        link.removeAttribute("href");
        link.title = "Open this link from a desktop browser";
        return;
      }

      const editorHref = buildVscodeEditorHref(href);
      if (!editorHref) {
        link.removeAttribute("href");
        link.title = "Unsupported local file link";
        return;
      }

      link.href = editorHref;
      link.title = "Open in VS Code";
      return;
    }

    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

function buildJsonCacheKey(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return String(url);
  }
}

const SESSION_LIST_URL = "/api/sessions?includeVisitor=1";
const ARCHIVED_SESSION_LIST_URL = "/api/sessions/archived?includeVisitor=1";

function getSessionSidebarUrl(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}?view=sidebar`;
}

function resolveRequestUrl(url) {
  if (typeof withVisitorModeUrl === "function") {
    return withVisitorModeUrl(url);
  }
  return typeof url === "string" ? url : String(url || "");
}

function getActiveShareSnapshotPayload() {
  return typeof shareSnapshotPayload !== "undefined"
    ? shareSnapshotPayload
    : null;
}

function isShareSnapshotReadOnlyMode() {
  return typeof shareSnapshotMode !== "undefined" && shareSnapshotMode === true;
}

function shouldOpenCurrentSessionFromTop() {
  return isShareSnapshotReadOnlyMode();
}

function scrollCurrentSessionViewportToTop() {
  if (!messagesEl) return;
  messagesEl.scrollTop = 0;
}

function getSessionEntryViewportState() {
  if (!(globalThis.__sessionEntryViewportState && typeof globalThis.__sessionEntryViewportState === "object")) {
    globalThis.__sessionEntryViewportState = {
      latestTurnFocusSessionId: null,
      latestTurnFocusConsumed: false,
    };
  }
  return globalThis.__sessionEntryViewportState;
}

function shouldFocusLatestTurnStartOnSessionEntry(sessionId, node) {
  if (!shouldFocusLatestTurnStart(node)) return false;
  const state = getSessionEntryViewportState();
  if (state.latestTurnFocusSessionId !== sessionId) {
    state.latestTurnFocusSessionId = sessionId;
    state.latestTurnFocusConsumed = false;
  }
  if (state.latestTurnFocusConsumed) return false;
  state.latestTurnFocusConsumed = true;
  return true;
}

function normalizeSessionViewportIntent(value) {
  return value === "session_entry" ? "session_entry" : "preserve";
}

function hasShareSnapshotPayload() {
  const payload = getActiveShareSnapshotPayload();
  return !!(payload && typeof payload === "object");
}

function buildShareSnapshotSessionId(snapshot = getActiveShareSnapshotPayload()) {
  const rawId = typeof snapshot?.id === "string" ? snapshot.id.trim() : "";
  return rawId ? `share_snapshot:${rawId}` : "share_snapshot";
}

function getShareSnapshotDisplayEvents(snapshot = getActiveShareSnapshotPayload()) {
  return Array.isArray(snapshot?.displayEvents) ? snapshot.displayEvents : [];
}

function getShareSnapshotEventBlock(startSeq, endSeq, snapshot = getActiveShareSnapshotPayload()) {
  const key = `${startSeq}-${endSeq}`;
  const events = Array.isArray(snapshot?.eventBlocks?.[key])
    ? snapshot.eventBlocks[key]
    : null;
  if (!events) return null;
  return {
    sessionId: buildShareSnapshotSessionId(snapshot),
    startSeq,
    endSeq,
    events,
  };
}

function getShareSnapshotLastEventAt(snapshot = getActiveShareSnapshotPayload()) {
  const displayEvents = getShareSnapshotDisplayEvents(snapshot);
  for (let index = displayEvents.length - 1; index >= 0; index -= 1) {
    const stamp = typeof displayEvents[index]?.timestamp === "string"
      ? displayEvents[index].timestamp.trim()
      : "";
    if (stamp) return stamp;
  }
  return typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
    ? snapshot.createdAt.trim()
    : null;
}

function getShareSnapshotViewValue(key, fallback = "") {
  const value = getActiveShareSnapshotPayload()?.view?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function buildShareSnapshotSessionRecord(snapshot = getActiveShareSnapshotPayload()) {
  if (!(snapshot && typeof snapshot === "object")) return null;
  const displayEvents = getShareSnapshotDisplayEvents(snapshot);
  const name = typeof snapshot?.session?.name === "string" && snapshot.session.name.trim()
    ? snapshot.session.name.trim()
    : (typeof snapshot?.session?.tool === "string" && snapshot.session.tool.trim()
      ? snapshot.session.tool.trim()
      : "Shared session snapshot");
  const lastEventAt = getShareSnapshotLastEventAt(snapshot);
  return {
    id: buildShareSnapshotSessionId(snapshot),
    name,
    tool: typeof snapshot?.session?.tool === "string" ? snapshot.session.tool.trim() : "",
    created: typeof snapshot?.session?.created === "string" && snapshot.session.created.trim()
      ? snapshot.session.created.trim()
      : (typeof snapshot?.createdAt === "string" && snapshot.createdAt.trim()
        ? snapshot.createdAt.trim()
        : null),
    updatedAt: lastEventAt,
    lastEventAt,
    sourceId: "share_snapshot",
    sourceName: getShareSnapshotViewValue("badge", "Shared Snapshot"),
    messageCount: displayEvents.filter((event) => event?.type === "message").length,
    activity: {
      run: { state: "idle" },
      queue: { state: "idle", count: 0 },
      compact: { state: "idle" },
    },
  };
}

async function fetchJsonOrRedirect(url, options = {}) {
  const requestOptions = { ...options };
  const revalidate = requestOptions.revalidate !== false;
  delete requestOptions.revalidate;
  const requestUrl = resolveRequestUrl(url);

  const method = String(requestOptions.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const cacheKey = isGet && revalidate ? buildJsonCacheKey(requestUrl) : null;
  const cached = cacheKey ? jsonResponseCache.get(cacheKey) : null;
  const headers = new Headers(requestOptions.headers || {});
  if (cached?.etag) {
    headers.set("If-None-Match", cached.etag);
  }

  const res = await fetch(requestUrl, {
    ...requestOptions,
    method,
    headers,
  });
  const redirectedToLogin =
    res.redirected && new URL(res.url, window.location.href).pathname === "/login";

  if (res.status === 401 || redirectedToLogin) {
    redirectToLogin();
    throw new Error("Authentication required");
  }

  if (res.status === 304) {
    if (!cached) {
      throw new Error("Cache revalidation failed");
    }
    return cached.data;
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json().catch(() => ({}))
    : null;

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }

  if (!data) {
    throw new Error("Expected JSON response");
  }

  if (cacheKey) {
    const etag = res.headers.get("etag");
    if (etag) {
      jsonResponseCache.set(cacheKey, { etag, data });
    } else {
      jsonResponseCache.delete(cacheKey);
    }
  }

  return data;
}

function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resetRenderedEventState(sessionId = null) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.latestSeq = 0;
  renderedEventState.eventCount = 0;
  renderedEventState.eventBaseKeys = [];
  renderedEventState.eventKeys = [];
  renderedEventState.runState = "idle";
  renderedEventState.runningBlockExpanded = false;
}

function getEventBoundarySeq(event) {
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) {
    return event.blockEndSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function getNormalizedEventRenderType(event) {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  return type === "collapsed_block" ? "thinking_block" : type;
}

function isRunningThinkingBlockEvent(event) {
  return getNormalizedEventRenderType(event) === "thinking_block"
    && event?.state === "running";
}

function getEventRenderBaseKey(event) {
  const seq = Number.isInteger(event?.seq) ? event.seq : 0;
  const type = getNormalizedEventRenderType(event);
  if (type === "thinking_block") {
    const state = typeof event?.state === "string" ? event.state : "";
    return `${seq}:${type}:${state}`;
  }
  return `${seq}:${type}`;
}

function getEventRenderKey(event) {
  const baseKey = getEventRenderBaseKey(event);
  const dynamicBoundary = isRunningThinkingBlockEvent(event) && renderedEventState.runningBlockExpanded === true
    ? `:${Number.isInteger(event?.blockEndSeq) ? event.blockEndSeq : 0}`
    : "";
  return `${baseKey}${dynamicBoundary}`;
}

function eventKeyArraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function eventKeyPrefixMatches(prefix, full) {
  if (prefix.length > full.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) return false;
  }
  return true;
}

function getLatestEventSeq(events) {
  let latestSeq = 0;
  for (const event of events || []) {
    const boundarySeq = getEventBoundarySeq(event);
    if (boundarySeq > latestSeq) {
      latestSeq = boundarySeq;
    }
  }
  return latestSeq;
}

function updateRenderedEventState(sessionId, events, { runState = "idle" } = {}) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.latestSeq = getLatestEventSeq(events);
  renderedEventState.eventCount = Array.isArray(events) ? events.length : 0;
  renderedEventState.eventBaseKeys = Array.isArray(events)
    ? events.map((event) => getEventRenderBaseKey(event))
    : [];
  renderedEventState.eventKeys = Array.isArray(events)
    ? events.map((event) => getEventRenderKey(event))
    : [];
  renderedEventState.runState = runState === "running" ? "running" : "idle";
  if (renderedEventState.runState !== "running") {
    renderedEventState.runningBlockExpanded = false;
  }

}

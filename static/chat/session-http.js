function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const requestedTab = pendingNavigationState?.tab || activeTab;
  if (requestedTab !== activeTab) {
    switchTab(requestedTab, { syncState: false });
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    currentSessionId = null;
    hasAttachedSession = false;
    persistActiveSessionId(null);
    syncBrowserState({ sessionId: null, tab: activeTab });
    showEmpty();
    restoreDraft();
    updateStatus("connected", "idle");
    pendingNavigationState = null;
    return;
  }

  if (!hasAttachedSession || currentSessionId !== targetSession.id) {
    attachSession(targetSession.id, targetSession);
  } else {
    syncBrowserState();
  }
  pendingNavigationState = null;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "remotelab:open-session") return;
    applyNavigationState(event.data);
    window.focus();
  });
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
    applyNavigationState({ sessionId: session?.id, tab: "sessions" });
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

function redirectToLogin() {
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

function buildJsonCacheKey(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return String(url);
  }
}

async function fetchJsonOrRedirect(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const cacheKey = isGet ? buildJsonCacheKey(url) : null;
  const cached = cacheKey ? jsonResponseCache.get(cacheKey) : null;
  const headers = new Headers(options.headers || {});
  if (cached?.etag) {
    headers.set("If-None-Match", cached.etag);
  }

  const res = await fetch(url, {
    ...options,
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
}

function getLatestEventSeq(events) {
  let latestSeq = 0;
  for (const event of events || []) {
    if (Number.isInteger(event?.seq) && event.seq > latestSeq) {
      latestSeq = event.seq;
    }
  }
  return latestSeq;
}

function updateRenderedEventState(sessionId, events) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.latestSeq = getLatestEventSeq(events);
  renderedEventState.eventCount = Array.isArray(events) ? events.length : 0;
}

function getEventRenderPlan(sessionId, events) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const latestSeq = getLatestEventSeq(normalizedEvents);
  const sameSession = renderedEventState.sessionId === sessionId;
  const hasRenderedSnapshot = sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );

  if (!sameSession || !hasRenderedSnapshot) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (
    latestSeq < renderedEventState.latestSeq ||
    normalizedEvents.length < renderedEventState.eventCount
  ) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (
    latestSeq === renderedEventState.latestSeq &&
    normalizedEvents.length === renderedEventState.eventCount
  ) {
    return { mode: "noop", events: [] };
  }

  const appendedEvents = normalizedEvents.filter(
    (event) => Number.isInteger(event?.seq) && event.seq > renderedEventState.latestSeq,
  );

  if (appendedEvents.length === 0) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (appendedEvents[0].seq !== renderedEventState.latestSeq + 1) {
    return { mode: "reset", events: normalizedEvents };
  }

  return { mode: "append", events: appendedEvents };
}

function reconcilePendingMessageState(event) {
  if (event?.type !== "message" || event.role !== "user") return;
  const optimistic = document.getElementById("optimistic-msg");
  if (optimistic) optimistic.remove();
  const pending = getPendingMessage();
  if (pending && (!pending.requestId || pending.requestId === event.requestId)) {
    clearPendingMessage();
  }
}

function normalizeSessionRecord(session, previous = null) {
  const normalized = {
    ...(previous || {}),
    ...session,
    appId: getEffectiveSessionAppId(session),
    status: normalizeSessionStatus(session.status, previous?.status),
  };
  if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
    if ((session?.queuedMessageCount || 0) > 0 && Array.isArray(previous?.queuedMessages)) {
      normalized.queuedMessages = previous.queuedMessages;
    } else {
      delete normalized.queuedMessages;
    }
  }
  return normalized;
}

function upsertSession(session) {
  if (!session?.id) return null;
  const previous = sessions.find((entry) => entry.id === session.id);
  const normalized = normalizeSessionRecord(session, previous);
  const index = sessions.findIndex((entry) => entry.id === session.id);
  if (index === -1) {
    sessions.push(normalized);
  } else {
    sessions[index] = normalized;
  }
  sortSessionsInPlace();
  refreshAppCatalog();
  return normalized;
}

async function fetchAppsList() {
  if (visitorMode) return [];
  refreshAppCatalog();
  return appCatalog;
}

async function fetchSessionsList() {
  if (visitorMode) return [];
  const data = await fetchJsonOrRedirect("/api/sessions");
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  sessions = (data.sessions || []).map((session) => normalizeSessionRecord(session, previousMap.get(session.id) || null));
  sortSessionsInPlace();
  refreshAppCatalog();
  renderSessionList();
  if (currentSessionId && !sessions.some((session) => session.id === currentSessionId)) {
    currentSessionId = null;
    hasAttachedSession = false;
    clearMessages();
    showEmpty();
    restoreDraft();
  }
  return sessions;
}

function applyAttachedSessionState(id, session) {
  currentSessionId = id;
  hasAttachedSession = true;
  currentTokens = 0;
  contextTokens.style.display = "none";
  compactBtn.style.display = "none";
  dropToolsBtn.style.display = "none";
  finishedUnread.delete(id);

  const displayName = getSessionDisplayName(session);
  headerTitle.textContent = displayName;
  updateStatus("connected", session?.status || "idle", session?.renameState, session?.archived === true);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(session);
  }

  if (session?.tool && toolsList.some((tool) => tool.id === session.tool)) {
    inlineToolSelect.value = session.tool;
    const previousTool = selectedTool;
    selectedTool = session.tool;
    if (previousTool !== selectedTool) {
      loadModelsForCurrentTool();
    }
  }

  restoreDraft();
  renderSessionList();
  updateResumeButton();
  syncBrowserState();
  syncForkButton();
  syncShareButton();
}

async function fetchSessionState(sessionId) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const normalized = upsertSession(data.session);
  if (normalized && currentSessionId === sessionId) {
    applyAttachedSessionState(sessionId, normalized);
  }
  return normalized;
}

async function fetchSessionEvents(sessionId) {
  const hadRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  const shouldStickToBottom =
    !hadRenderedMessages ||
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
  );
  const events = data.events || [];
  if (currentSessionId !== sessionId) return events;
  const renderPlan = getEventRenderPlan(sessionId, events);

  if (renderPlan.mode === "reset") {
    clearMessages();
    if (events.length === 0) {
      showEmpty();
    }
    for (const event of events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events);
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldFocusLatestTurnStart(latestTurnStart)) {
      scrollNodeToTop(latestTurnStart);
    } else if (events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    checkPendingMessage(events);
    return events;
  }

  if (renderPlan.mode === "append") {
    for (const event of renderPlan.events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events);
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldFocusLatestTurnStart(latestTurnStart)) {
      scrollNodeToTop(latestTurnStart);
    } else if (renderPlan.events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    return renderPlan.events;
  }

  updateRenderedEventState(sessionId, events);
  const latestTurnStart = applyFinishedTurnCollapseState();
  if (shouldFocusLatestTurnStart(latestTurnStart)) {
    scrollNodeToTop(latestTurnStart);
  }
  return events;
}

async function runCurrentSessionRefresh(sessionId) {
  const session = await fetchSessionState(sessionId);
  if (currentSessionId !== sessionId) return session;
  await fetchSessionEvents(sessionId);
  return session;
}

async function refreshCurrentSession() {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  if (currentSessionRefreshPromise) {
    pendingCurrentSessionRefresh = true;
    return currentSessionRefreshPromise;
  }
  currentSessionRefreshPromise = (async () => {
    try {
      return await runCurrentSessionRefresh(sessionId);
    } finally {
      currentSessionRefreshPromise = null;
      if (pendingCurrentSessionRefresh) {
        pendingCurrentSessionRefresh = false;
        refreshCurrentSession().catch(() => {});
      }
    }
  })();
  return currentSessionRefreshPromise;
}

async function refreshSidebarSession(sessionId) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession();
  }
  if (sidebarSessionRefreshPromises.has(sessionId)) {
    pendingSidebarSessionRefreshes.add(sessionId);
    return sidebarSessionRefreshPromises.get(sessionId);
  }
  const request = (async () => {
    try {
      return await fetchSessionState(sessionId);
    } catch (error) {
      if (error?.message === "Session not found") {
        const nextSessions = sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length !== sessions.length) {
          sessions = nextSessions;
          refreshAppCatalog();
          renderSessionList();
        }
        return null;
      }
      throw error;
    } finally {
      sidebarSessionRefreshPromises.delete(sessionId);
      if (pendingSidebarSessionRefreshes.delete(sessionId)) {
        refreshSidebarSession(sessionId).catch(() => {});
      }
    }
  })();
  sidebarSessionRefreshPromises.set(sessionId, request);
  return request;
}

async function refreshRealtimeViews() {
  if (visitorMode) {
    if (currentSessionId) {
      await refreshCurrentSession().catch(() => {});
    }
    return;
  }

  await fetchSessionsList().catch(() => {});
  if (currentSessionId) {
    await refreshCurrentSession().catch(() => {});
  }
}

async function bootstrapViaHttp() {
  if (visitorMode && visitorSessionId) {
    currentSessionId = visitorSessionId;
    attachSession(visitorSessionId, { id: visitorSessionId, name: "Session", status: "idle" });
    await refreshCurrentSession();
    return;
  }
  await fetchSessionsList();
  if (currentSessionId) {
    await refreshCurrentSession();
  } else {
    const initialSession = getLatestActiveSession() || getLatestSession();
    if (initialSession) {
      attachSession(initialSession.id, initialSession);
    }
  }
}

async function setupPushNotifications() {
  if (visitorMode) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register(
      `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`,
      { updateViaCache: "none" },
    );
    await reg.update().catch(() => {});
    reg.installing?.postMessage({ type: "remotelab:clear-caches" });
    reg.waiting?.postMessage({ type: "remotelab:clear-caches" });
    reg.active?.postMessage({ type: "remotelab:clear-caches" });
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

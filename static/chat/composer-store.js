"use strict";

(function attachRemoteLabComposerStore(root) {
  function normalizeSessionId(value) {
    if (typeof value !== "string") return "";
    const normalized = value.trim();
    return normalized || "";
  }

  function normalizeDraftText(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return String(value);
  }

  function normalizeAttachments(attachments = []) {
    if (!Array.isArray(attachments)) return [];
    return attachments.filter((attachment) => attachment && typeof attachment === "object");
  }

  function normalizeDrafts(rawDrafts) {
    if (!rawDrafts || typeof rawDrafts !== "object") return {};
    const drafts = {};
    for (const [sessionId, text] of Object.entries(rawDrafts)) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) continue;
      const normalizedText = normalizeDraftText(text);
      if (!normalizedText) continue;
      drafts[normalizedSessionId] = normalizedText;
    }
    return drafts;
  }

  function normalizeAttachmentBuckets(rawBuckets) {
    if (!rawBuckets || typeof rawBuckets !== "object") return {};
    const buckets = {};
    for (const [sessionId, attachments] of Object.entries(rawBuckets)) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) continue;
      const normalizedAttachments = normalizeAttachments(attachments);
      if (normalizedAttachments.length === 0) continue;
      buckets[normalizedSessionId] = normalizedAttachments;
    }
    return buckets;
  }

  function normalizePendingSend(rawPendingSend) {
    if (!rawPendingSend || typeof rawPendingSend !== "object") return null;
    const sessionId = normalizeSessionId(rawPendingSend.sessionId);
    const requestId = normalizeSessionId(rawPendingSend.requestId);
    if (!sessionId || !requestId) return null;
    const baselineEventSeq = Number.isInteger(rawPendingSend.baselineEventSeq)
      && rawPendingSend.baselineEventSeq >= 0
      ? rawPendingSend.baselineEventSeq
      : 0;
    return {
      sessionId,
      requestId,
      text: normalizeDraftText(rawPendingSend.text),
      images: normalizeAttachments(rawPendingSend.images),
      baselineActivity:
        rawPendingSend.baselineActivity && typeof rawPendingSend.baselineActivity === "object"
          ? rawPendingSend.baselineActivity
          : null,
      baselineEventSeq,
      stage:
        rawPendingSend.stage === "uploading"
          ? "uploading"
          : rawPendingSend.stage === "checking"
            ? "checking"
          : rawPendingSend.stage === "processing"
            ? "processing"
            : "sending",
    };
  }

  function isBlockingPendingSend(pendingSend) {
    return !!pendingSend && pendingSend.stage !== "processing" && pendingSend.stage !== "checking";
  }

  function createState(state = {}) {
    return {
      activeSessionId: normalizeSessionId(state.activeSessionId),
      drafts: normalizeDrafts(state.drafts),
      attachmentsBySession: normalizeAttachmentBuckets(state.attachmentsBySession),
      pendingSend: normalizePendingSend(state.pendingSend),
    };
  }

  function resolveSessionId(state, sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (normalizedSessionId) return normalizedSessionId;
    return normalizeSessionId(state?.activeSessionId);
  }

  function getDraftText(state, sessionId = state?.activeSessionId) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return "";
    return typeof state?.drafts?.[normalizedSessionId] === "string"
      ? state.drafts[normalizedSessionId]
      : "";
  }

  function getAttachments(state, sessionId = state?.activeSessionId) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return [];
    const attachments = state?.attachmentsBySession?.[normalizedSessionId];
    return Array.isArray(attachments) ? attachments.slice() : [];
  }

  function getPendingSend(state) {
    return state?.pendingSend ? {
      ...state.pendingSend,
      images: normalizeAttachments(state.pendingSend.images),
    } : null;
  }

  function hasPendingSendForSession(state, sessionId = state?.activeSessionId) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    return !!normalizedSessionId
      && state?.pendingSend?.sessionId === normalizedSessionId
      && isBlockingPendingSend(state.pendingSend);
  }

  function hasUnsavedState(state, sessionId = state?.activeSessionId) {
    return hasPendingSendForSession(state, sessionId)
      || getAttachments(state, sessionId).length > 0
      || getDraftText(state, sessionId).trim().length > 0;
  }

  function hasAnyUnsavedState(state) {
    if (isBlockingPendingSend(state?.pendingSend)) return true;
    for (const text of Object.values(state?.drafts || {})) {
      if (normalizeDraftText(text).trim()) {
        return true;
      }
    }
    for (const attachments of Object.values(state?.attachmentsBySession || {})) {
      if (Array.isArray(attachments) && attachments.length > 0) {
        return true;
      }
    }
    return false;
  }

  function setActiveSession(state, sessionId) {
    return createState({
      ...state,
      activeSessionId: normalizeSessionId(sessionId),
    });
  }

  function setDraftText(state, text, { sessionId = state?.activeSessionId } = {}) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return createState(state);

    const nextDrafts = { ...state?.drafts };
    const normalizedText = normalizeDraftText(text);
    if (normalizedText) {
      nextDrafts[normalizedSessionId] = normalizedText;
    } else {
      delete nextDrafts[normalizedSessionId];
    }

    return createState({
      ...state,
      activeSessionId: normalizedSessionId,
      drafts: nextDrafts,
    });
  }

  function replaceAttachments(state, attachments, { sessionId = state?.activeSessionId } = {}) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return createState(state);

    const nextAttachmentsBySession = { ...state?.attachmentsBySession };
    const normalizedAttachments = normalizeAttachments(attachments);
    if (normalizedAttachments.length > 0) {
      nextAttachmentsBySession[normalizedSessionId] = normalizedAttachments;
    } else {
      delete nextAttachmentsBySession[normalizedSessionId];
    }

    return createState({
      ...state,
      activeSessionId: normalizedSessionId,
      attachmentsBySession: nextAttachmentsBySession,
    });
  }

  function addAttachments(state, attachments, { sessionId = state?.activeSessionId } = {}) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return createState(state);
    return replaceAttachments(
      state,
      getAttachments(state, normalizedSessionId).concat(normalizeAttachments(attachments)),
      { sessionId: normalizedSessionId },
    );
  }

  function removeAttachment(state, index, { sessionId = state?.activeSessionId } = {}) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return createState(state);

    const attachments = getAttachments(state, normalizedSessionId);
    if (!Number.isInteger(index) || index < 0 || index >= attachments.length) {
      return createState(state);
    }

    attachments.splice(index, 1);
    return replaceAttachments(state, attachments, { sessionId: normalizedSessionId });
  }

  function clearSessionState(
    state,
    sessionId,
    { clearDraft = true, clearAttachments = true, clearPendingSend = false } = {},
  ) {
    const normalizedSessionId = resolveSessionId(state, sessionId);
    if (!normalizedSessionId) return createState(state);

    const nextDrafts = clearDraft ? { ...state?.drafts } : state?.drafts;
    const nextAttachmentsBySession = clearAttachments ? { ...state?.attachmentsBySession } : state?.attachmentsBySession;

    if (clearDraft) {
      delete nextDrafts[normalizedSessionId];
    }
    if (clearAttachments) {
      delete nextAttachmentsBySession[normalizedSessionId];
    }

    const shouldClearPendingSend = clearPendingSend === true
      && state?.pendingSend?.sessionId === normalizedSessionId;

    return createState({
      ...state,
      drafts: clearDraft ? nextDrafts : state?.drafts,
      attachmentsBySession: clearAttachments ? nextAttachmentsBySession : state?.attachmentsBySession,
      pendingSend: shouldClearPendingSend ? null : state?.pendingSend,
    });
  }

  function setPendingSend(state, pendingSend) {
    const normalizedPendingSend = normalizePendingSend(pendingSend);
    return createState({
      ...state,
      activeSessionId: normalizedPendingSend?.sessionId || state?.activeSessionId,
      pendingSend: normalizedPendingSend,
    });
  }

  function patchPendingSend(state, patch = {}) {
    if (!state?.pendingSend) return createState(state);
    const nextPendingSend = normalizePendingSend({
      ...state.pendingSend,
      ...patch,
    });
    return createState({
      ...state,
      activeSessionId: nextPendingSend?.sessionId || state?.activeSessionId,
      pendingSend: nextPendingSend,
    });
  }

  function clearPendingSend(state, { requestId = "" } = {}) {
    if (!state?.pendingSend) return createState(state);
    const normalizedRequestId = normalizeSessionId(requestId);
    if (normalizedRequestId && state.pendingSend.requestId !== normalizedRequestId) {
      return createState(state);
    }
    return createState({
      ...state,
      pendingSend: null,
    });
  }

  function sameArray(a = [], b = []) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  function sameObject(a = {}, b = {}) {
    if (a === b) return true;
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  function sameAttachmentBuckets(a = {}, b = {}) {
    if (a === b) return true;
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!sameArray(a[key], b[key])) return false;
    }
    return true;
  }

  function samePendingSend(a, b) {
    if (a === b) return true;
    if (!a || !b) return !a && !b;
    return a.sessionId === b.sessionId
      && a.requestId === b.requestId
      && a.text === b.text
      && a.stage === b.stage
      && a.baselineEventSeq === b.baselineEventSeq
      && a.baselineActivity === b.baselineActivity
      && sameArray(a.images, b.images);
  }

  function areStatesEqual(a, b) {
    return a?.activeSessionId === b?.activeSessionId
      && sameObject(a?.drafts, b?.drafts)
      && sameAttachmentBuckets(a?.attachmentsBySession, b?.attachmentsBySession)
      && samePendingSend(a?.pendingSend, b?.pendingSend);
  }

  function createStore(initialState = {}) {
    let state = createState(initialState);
    const listeners = new Set();

    function getState() {
      return state;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function dispatch(action = {}) {
      let nextState = state;
      switch (action.type) {
        case "set-active-session":
          nextState = setActiveSession(state, action.sessionId);
          break;
        case "set-draft-text":
          nextState = setDraftText(state, action.text, action);
          break;
        case "replace-attachments":
          nextState = replaceAttachments(state, action.attachments, action);
          break;
        case "add-attachments":
          nextState = addAttachments(state, action.attachments, action);
          break;
        case "remove-attachment":
          nextState = removeAttachment(state, action.index, action);
          break;
        case "clear-session-state":
          nextState = clearSessionState(state, action.sessionId, action);
          break;
        case "set-pending-send":
          nextState = setPendingSend(state, action.pendingSend);
          break;
        case "patch-pending-send":
          nextState = patchPendingSend(state, action.patch);
          break;
        case "clear-pending-send":
          nextState = clearPendingSend(state, action);
          break;
        default:
          nextState = state;
          break;
      }

      if (areStatesEqual(state, nextState)) {
        return state;
      }

      const previousState = state;
      state = nextState;
      for (const listener of listeners) {
        listener(state, previousState, action);
      }
      return state;
    }

    return {
      getState,
      subscribe,
      dispatch,
    };
  }

  const store = createStore();

  function getComposerStore() {
    return store;
  }

  function getComposerStoreStateSnapshot() {
    return store.getState();
  }

  function dispatchComposerStore(action) {
    return store.dispatch(action);
  }

  function setComposerActiveSession(sessionId) {
    return dispatchComposerStore({
      type: "set-active-session",
      sessionId,
    });
  }

  function setComposerDraftTextState(text, options = {}) {
    return dispatchComposerStore({
      type: "set-draft-text",
      text,
      ...options,
    });
  }

  function replaceComposerAttachmentsState(attachments, options = {}) {
    return dispatchComposerStore({
      type: "replace-attachments",
      attachments,
      ...options,
    });
  }

  function addComposerAttachmentsState(attachments, options = {}) {
    return dispatchComposerStore({
      type: "add-attachments",
      attachments,
      ...options,
    });
  }

  function removeComposerAttachmentState(index, options = {}) {
    return dispatchComposerStore({
      type: "remove-attachment",
      index,
      ...options,
    });
  }

  function clearComposerSessionState(sessionId, options = {}) {
    return dispatchComposerStore({
      type: "clear-session-state",
      sessionId,
      ...options,
    });
  }

  function setComposerPendingSendState(pendingSend) {
    return dispatchComposerStore({
      type: "set-pending-send",
      pendingSend,
    });
  }

  function patchComposerPendingSendState(patch = {}) {
    return dispatchComposerStore({
      type: "patch-pending-send",
      patch,
    });
  }

  function clearComposerPendingSendState(requestId = "") {
    return dispatchComposerStore({
      type: "clear-pending-send",
      requestId,
    });
  }

  function getComposerDraftTextState(sessionId) {
    return getDraftText(getComposerStoreStateSnapshot(), sessionId);
  }

  function getComposerAttachmentsState(sessionId) {
    return getAttachments(getComposerStoreStateSnapshot(), sessionId);
  }

  function getComposerPendingSendState() {
    return getPendingSend(getComposerStoreStateSnapshot());
  }

  function hasComposerUnsavedState(sessionId) {
    return hasUnsavedState(getComposerStoreStateSnapshot(), sessionId);
  }

  function hasAnyComposerUnsavedState() {
    return hasAnyUnsavedState(getComposerStoreStateSnapshot());
  }

  const api = {
    createState,
    createStore,
    getDraftText,
    getAttachments,
    getPendingSend,
    hasPendingSendForSession,
    hasUnsavedState,
    hasAnyUnsavedState,
    setActiveSession,
    setDraftText,
    replaceAttachments,
    addAttachments,
    removeAttachment,
    clearSessionState,
    setPendingSend,
    patchPendingSend,
    clearPendingSend,
  };

  root.RemoteLabComposerStore = api;
  root.getComposerStore = getComposerStore;
  root.getComposerStoreStateSnapshot = getComposerStoreStateSnapshot;
  root.dispatchComposerStore = dispatchComposerStore;
  root.setComposerActiveSession = setComposerActiveSession;
  root.setComposerDraftTextState = setComposerDraftTextState;
  root.replaceComposerAttachmentsState = replaceComposerAttachmentsState;
  root.addComposerAttachmentsState = addComposerAttachmentsState;
  root.removeComposerAttachmentState = removeComposerAttachmentState;
  root.clearComposerSessionState = clearComposerSessionState;
  root.setComposerPendingSendState = setComposerPendingSendState;
  root.patchComposerPendingSendState = patchComposerPendingSendState;
  root.clearComposerPendingSendState = clearComposerPendingSendState;
  root.getComposerDraftTextState = getComposerDraftTextState;
  root.getComposerAttachmentsState = getComposerAttachmentsState;
  root.getComposerPendingSendState = getComposerPendingSendState;
  root.hasComposerUnsavedState = hasComposerUnsavedState;
  root.hasAnyComposerUnsavedState = hasAnyComposerUnsavedState;

  if (root.window && root.window !== root) {
    root.window.RemoteLabComposerStore = api;
    root.window.getComposerStore = getComposerStore;
    root.window.getComposerStoreStateSnapshot = getComposerStoreStateSnapshot;
    root.window.dispatchComposerStore = dispatchComposerStore;
    root.window.setComposerActiveSession = setComposerActiveSession;
    root.window.setComposerDraftTextState = setComposerDraftTextState;
    root.window.replaceComposerAttachmentsState = replaceComposerAttachmentsState;
    root.window.addComposerAttachmentsState = addComposerAttachmentsState;
    root.window.removeComposerAttachmentState = removeComposerAttachmentState;
    root.window.clearComposerSessionState = clearComposerSessionState;
    root.window.setComposerPendingSendState = setComposerPendingSendState;
    root.window.patchComposerPendingSendState = patchComposerPendingSendState;
    root.window.clearComposerPendingSendState = clearComposerPendingSendState;
    root.window.getComposerDraftTextState = getComposerDraftTextState;
    root.window.getComposerAttachmentsState = getComposerAttachmentsState;
    root.window.getComposerPendingSendState = getComposerPendingSendState;
    root.window.hasComposerUnsavedState = hasComposerUnsavedState;
    root.window.hasAnyComposerUnsavedState = hasAnyComposerUnsavedState;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');
const sessionCatalogSource = readFileSync(join(repoRoot, 'static/chat/bootstrap-session-catalog.js'), 'utf8');

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    throw new Error(`Missing start token: ${startToken}`);
  }
  const end = source.indexOf(endToken, start);
  if (end === -1) {
    throw new Error(`Missing end token: ${endToken}`);
  }
  return source.slice(start, end);
}

function createSessionActivity({
  runState = 'idle',
  phase = null,
  runId = null,
  queueState = 'idle',
  queueCount = 0,
  renameState = 'idle',
  renameError = null,
  compactState = 'idle',
} = {}) {
  return {
    run: {
      state: runState,
      phase,
      runId,
      cancelRequested: false,
    },
    queue: {
      state: queueState,
      count: queueCount,
    },
    rename: {
      state: renameState,
      error: renameError,
    },
    compact: {
      state: compactState,
    },
  };
}

function createBaseContext() {
  const context = {
    console,
    Date,
    JSON,
    Set,
    Map,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Math,
    Promise,
    encodeURIComponent,
    structuredClone,
    currentSessionId: null,
    hasAttachedSession: false,
    archivedSessionCount: 0,
    sessions: [],
    visitorMode: false,
    getEffectiveSessionSourceId(session) {
      return session?.sourceId || 'chat';
    },
    normalizeSessionReviewStamp(value) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) return '';
      const time = new Date(trimmed).getTime();
      return Number.isFinite(time) ? new Date(time).toISOString() : '';
    },
    getLocalSessionReviewedAt() {
      return '';
    },
    getSessionReviewBaselineAt() {
      return '';
    },
  };
  context.globalThis = context;
  return context;
}

const normalizeSessionRecordSnippet = sliceBetween(
  sessionHttpSource,
  'function normalizeSessionRecord',
  'function upsertSession',
);

const applyAttachedSessionStateSnippet = sliceBetween(
  sessionHttpSource,
  'function applyAttachedSessionState',
  'async function fetchSessionState',
);

const sessionReviewSnippet = sliceBetween(
  sessionHttpSource,
  'const pendingSessionReviewSyncs = new Map();',
  'function normalizeSessionRecord',
);

const sessionCatalogVisibilitySnippet = sliceBetween(
  sessionCatalogSource,
  'function getArchivedSessionSortTime',
  'function getLatestSession',
);

const dispatchActionSnippet = sliceBetween(
  realtimeSource,
  'async function dispatchAction',
  'function getCurrentSession',
);

const recordContext = createBaseContext();
vm.runInNewContext(
  normalizeSessionRecordSnippet,
  recordContext,
  { filename: 'chat-session-record-runtime.js' },
);

const restored = recordContext.normalizeSessionRecord(
  {
    id: 'session-restore',
    activity: createSessionActivity(),
    lastEventAt: '2026-03-12T12:00:00.000Z',
  },
  {
    id: 'session-restore',
    activity: createSessionActivity(),
    archived: true,
    archivedAt: '2026-03-12T11:59:00.000Z',
  },
);
assert.equal(restored.archived, undefined, 'stale archived flags should not survive a fresh session payload');
assert.equal(restored.archivedAt, undefined, 'stale archived timestamps should not survive a fresh session payload');
assert.equal(restored.activity.run.state, 'idle', 'session activity should preserve the backend run state');

const carriedQueue = recordContext.normalizeSessionRecord(
  {
    id: 'session-queue',
    activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
  },
  {
    id: 'session-queue',
    queuedMessages: [{ text: 'queued follow-up' }],
  },
);
assert.deepEqual(
  carriedQueue.queuedMessages,
  [{ text: 'queued follow-up' }],
  'queued message details should stay attached while the backend queue is still non-empty',
);

const clearedQueue = recordContext.normalizeSessionRecord(
  {
    id: 'session-queue',
    activity: createSessionActivity(),
  },
  {
    id: 'session-queue',
    queuedMessages: [{ text: 'queued follow-up' }],
  },
);
assert.equal(
  Object.prototype.hasOwnProperty.call(clearedQueue, 'queuedMessages'),
  false,
  'queued message details should clear once the backend queue drains',
);

const dispatchContext = createBaseContext();
let refreshCalls = 0;
let renderCalls = 0;
let savedPendingCalls = 0;
let clearedPendingCalls = 0;
let attentionRefreshes = 0;
let scheduledRefreshes = 0;
let appliedSession = null;
let requestPayload = null;
const acknowledgedRequestIds = [];
const finalizedRequestIds = [];

dispatchContext.currentSessionId = 'session-send';
dispatchContext.createRequestId = () => 'req-test';
dispatchContext.fetchSessionsList = async () => [];
dispatchContext.refreshCurrentSession = async () => {
  refreshCalls += 1;
  if (refreshCalls === 1) {
    throw new Error('temporary refresh failure');
  }
  return { ok: true };
};
dispatchContext.fetchJsonOrRedirect = async (url, options = {}) => {
  requestPayload = { url, options };
  return {
    queued: true,
    session: {
      id: 'session-send',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  };
};
dispatchContext.upsertSession = (value) => {
  dispatchContext.sessions = [value];
  return value;
};
dispatchContext.renderSessionList = () => {
  renderCalls += 1;
};
dispatchContext.applyAttachedSessionState = (id, session) => {
  appliedSession = { id, session };
};
dispatchContext.acknowledgeComposerPendingSend = (requestId) => {
  acknowledgedRequestIds.push(requestId);
  return true;
};
dispatchContext.finalizeComposerPendingSend = (requestId) => {
  finalizedRequestIds.push(requestId);
  return true;
};
dispatchContext.refreshSidebarSession = async () => null;
dispatchContext.savePendingMessage = () => {
  savedPendingCalls += 1;
};
dispatchContext.clearPendingMessage = () => {
  clearedPendingCalls += 1;
};
dispatchContext.refreshSessionAttentionUi = () => {
  attentionRefreshes += 1;
};
dispatchContext.setTimeout = (fn) => {
  scheduledRefreshes += 1;
  fn();
  return 1;
};

vm.runInNewContext(dispatchActionSnippet, dispatchContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const sendAccepted = await dispatchContext.dispatchAction({ action: 'send', text: 'hello world' });
assert.equal(sendAccepted, true, 'send should resolve successfully after server acceptance');
assert.equal(requestPayload?.url, '/api/sessions/session-send/messages');
assert.match(String(requestPayload?.options?.body || ''), /"requestId":"req-test"/);
assert.equal(renderCalls, 1, 'accepted sends should immediately reflect the backend session payload');
assert.deepEqual(
  appliedSession,
  {
    id: 'session-send',
    session: {
      id: 'session-send',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  },
  'accepted sends should apply the returned backend session state before the refresh finishes',
);
assert.equal(refreshCalls, 2, 'accepted sends should retry the session refresh after a transient failure');
assert.equal(scheduledRefreshes, 1, 'accepted sends should schedule exactly one async refresh retry');
assert.deepEqual(acknowledgedRequestIds, ['req-test'], 'accepted sends should immediately acknowledge the pending composer request from the HTTP acknowledgment');
assert.deepEqual(finalizedRequestIds, [], 'HTTP acceptance alone should not fully finalize the processing acknowledgment');
assert.equal(savedPendingCalls, 0, 'frontend should not persist pending-send state');
assert.equal(clearedPendingCalls, 0, 'frontend should not clear any pending-send cache because none exists');
assert.equal(attentionRefreshes, 0, 'frontend should not synthesize unread or send-failure attention state');

const detachedSendContext = createBaseContext();
let detachedCurrentRefreshes = 0;
let detachedSidebarRefreshes = 0;
let detachedRequestPayload = null;

detachedSendContext.currentSessionId = 'session-viewing';
detachedSendContext.createRequestId = () => 'req-detached';
detachedSendContext.fetchSessionsList = async () => [];
detachedSendContext.refreshCurrentSession = async () => {
  detachedCurrentRefreshes += 1;
  return { ok: true };
};
detachedSendContext.refreshSidebarSession = async (sessionId) => {
  detachedSidebarRefreshes += 1;
  return { id: sessionId };
};
detachedSendContext.fetchJsonOrRedirect = async (url, options = {}) => {
  detachedRequestPayload = { url, options };
  return {
    queued: true,
    session: {
      id: 'session-origin',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  };
};
detachedSendContext.upsertSession = (value) => value;
detachedSendContext.renderSessionList = () => {};
detachedSendContext.applyAttachedSessionState = () => {
  throw new Error('send should not reattach a different session while the user is viewing another one');
};
detachedSendContext.acknowledgeComposerPendingSend = () => true;
detachedSendContext.finalizeComposerPendingSend = () => true;
detachedSendContext.savePendingMessage = () => {};
detachedSendContext.clearPendingMessage = () => {};
detachedSendContext.refreshSessionAttentionUi = () => {};
detachedSendContext.setTimeout = () => 1;

vm.runInNewContext(dispatchActionSnippet, detachedSendContext, {
  filename: 'chat-dispatch-action-runtime-detached.js',
});

const detachedSendAccepted = await detachedSendContext.dispatchAction({
  action: 'send',
  sessionId: 'session-origin',
  text: 'send this from the original session',
});
assert.equal(detachedSendAccepted, true, 'session-bound sends should still succeed when the UI is attached elsewhere');
assert.equal(detachedRequestPayload?.url, '/api/sessions/session-origin/messages', 'send should target the explicit origin session instead of the currently attached one');
assert.equal(detachedCurrentRefreshes, 0, 'detached sends should not refresh the unrelated currently attached session');
assert.equal(detachedSidebarRefreshes, 1, 'detached sends should refresh the origin session in the sidebar instead');

const attachmentCompatContext = createBaseContext();
let attachmentCompatPayload = null;

attachmentCompatContext.currentSessionId = 'session-mobile-attachments';
attachmentCompatContext.createRequestId = () => 'req-mobile-attachment';
attachmentCompatContext.FormData = class MockFormData {
  constructor() {
    this.entries = [];
  }

  set(name, value) {
    this.entries = this.entries.filter((entry) => entry.name !== name);
    this.entries.push({ name, value, filename: null });
  }

  append(name, value, filename = null) {
    this.entries.push({ name, value, filename });
  }

  getAll(name) {
    return this.entries.filter((entry) => entry.name === name);
  }
};
attachmentCompatContext.fetchSessionsList = async () => [];
attachmentCompatContext.refreshCurrentSession = async () => ({ ok: true });
attachmentCompatContext.refreshSidebarSession = async () => null;
attachmentCompatContext.fetchJsonOrRedirect = async (url, options = {}) => {
  attachmentCompatPayload = { url, options };
  return {
    queued: false,
    session: {
      id: 'session-mobile-attachments',
      activity: createSessionActivity({ runState: 'running' }),
    },
  };
};
attachmentCompatContext.upsertSession = (value) => value;
attachmentCompatContext.renderSessionList = () => {};
attachmentCompatContext.applyAttachedSessionState = () => {};
attachmentCompatContext.acknowledgeComposerPendingSend = () => true;
attachmentCompatContext.finalizeComposerPendingSend = () => true;
attachmentCompatContext.savePendingMessage = () => {};
attachmentCompatContext.clearPendingMessage = () => {};
attachmentCompatContext.refreshSessionAttentionUi = () => {};
attachmentCompatContext.setTimeout = () => 1;

vm.runInNewContext(dispatchActionSnippet, attachmentCompatContext, {
  filename: 'chat-dispatch-action-attachment-compat-runtime.js',
});

const mobileAttachmentAccepted = await attachmentCompatContext.dispatchAction({
  action: 'send',
  text: 'inspect this photo',
  images: [{
    file: {
      name: 'mobile-photo.jpg',
      type: 'image/jpeg',
    },
    originalName: 'mobile-photo.jpg',
    mimeType: 'image/jpeg',
  }],
});
assert.equal(mobileAttachmentAccepted, true, 'attachment sends should still succeed when the browser lacks File.arrayBuffer');
assert.equal(attachmentCompatPayload?.url, '/api/sessions/session-mobile-attachments/messages', 'attachment sends should target the current session');
assert.ok(
  attachmentCompatPayload?.options?.body instanceof attachmentCompatContext.FormData,
  'attachment sends should use multipart FormData whenever local files are present',
);
assert.deepEqual(
  attachmentCompatPayload.options.body.getAll('attachments'),
  [{
    name: 'attachments',
    value: {
      name: 'mobile-photo.jpg',
      type: 'image/jpeg',
    },
    filename: 'mobile-photo.jpg',
  }],
  'multipart attachment sends should append the original file object and filename',
);

const attachReuseContext = createBaseContext();
let attachRefreshCalls = 0;
let attachStateCalls = 0;
let attachEventCalls = 0;
let attachRequested = null;

attachReuseContext.sessions = [
  {
    id: 'session-attach-existing',
    activity: createSessionActivity({ runState: 'idle', queueState: 'idle', queueCount: 0 }),
  },
];
attachReuseContext.getCurrentSession = () => attachReuseContext.sessions.find((session) => session.id === attachReuseContext.currentSessionId) || null;
attachReuseContext.getSessionRunState = (session) => session?.activity?.run?.state || 'idle';
attachReuseContext.fetchSessionEvents = async (sessionId, options = {}) => {
  attachEventCalls += 1;
  attachRequested = { sessionId, options };
  return [];
};
attachReuseContext.fetchSessionState = async () => {
  attachStateCalls += 1;
  return null;
};
attachReuseContext.refreshCurrentSession = async () => {
  attachRefreshCalls += 1;
  return null;
};

vm.runInNewContext(dispatchActionSnippet, attachReuseContext, {
  filename: 'chat-dispatch-action-attach-runtime.js',
});

const attachReused = await attachReuseContext.dispatchAction({ action: 'attach', sessionId: 'session-attach-existing' });
assert.equal(attachReused, true, 'attach should succeed when the session is already available in local state');
assert.equal(attachReuseContext.currentSessionId, 'session-attach-existing', 'attach should still update the current session id');
assert.equal(attachReuseContext.hasAttachedSession, true, 'attach should still mark the UI as attached');
assert.equal(attachEventCalls, 1, 'attach should fetch visible events for an already-known session');
assert.equal(attachStateCalls, 0, 'attach should skip the redundant detail fetch when the sidebar metadata is already present');
assert.equal(attachRefreshCalls, 0, 'attach should avoid the full refresh path when local metadata is already sufficient');
assert.equal(attachRequested?.sessionId, 'session-attach-existing', 'attach should request events for the selected session');
assert.equal(attachRequested?.options?.runState, 'idle', 'attach should carry the existing run state into the event refresh path');

const attachQueuedContext = createBaseContext();
let queuedAttachStateCalls = 0;
let queuedAttachEventCalls = 0;
let queuedAttachRefreshCalls = 0;

attachQueuedContext.sessions = [
  {
    id: 'session-attach-queued',
    activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 2 }),
  },
];
attachQueuedContext.getCurrentSession = () => attachQueuedContext.sessions.find((session) => session.id === attachQueuedContext.currentSessionId) || null;
attachQueuedContext.getSessionRunState = (session) => session?.activity?.run?.state || 'idle';
attachQueuedContext.fetchSessionEvents = async () => {
  queuedAttachEventCalls += 1;
  return [];
};
attachQueuedContext.fetchSessionState = async () => {
  queuedAttachStateCalls += 1;
  return {
    id: 'session-attach-queued',
    queuedMessages: [{ text: 'queued follow-up' }],
  };
};
attachQueuedContext.refreshCurrentSession = async () => {
  queuedAttachRefreshCalls += 1;
  return null;
};

vm.runInNewContext(dispatchActionSnippet, attachQueuedContext, {
  filename: 'chat-dispatch-action-attach-queued-runtime.js',
});

const attachQueued = await attachQueuedContext.dispatchAction({ action: 'attach', sessionId: 'session-attach-queued' });
assert.equal(attachQueued, true, 'attach should succeed for queued sessions');
assert.equal(queuedAttachEventCalls, 1, 'attach should still fetch events for queued sessions');
assert.equal(queuedAttachStateCalls, 1, 'attach should fetch detail only when queued follow-up bodies are actually needed');
assert.equal(queuedAttachRefreshCalls, 0, 'queued attach should still avoid the older full refresh path');

const reviewContext = createBaseContext();
let reviewRenderCalls = 0;

reviewContext.renderSessionList = () => {
  reviewRenderCalls += 1;
};
reviewContext.setLocalSessionReviewedAt = (_sessionId, stamp) => stamp;

vm.runInNewContext(sessionReviewSnippet, reviewContext, {
  filename: 'chat-session-review-runtime.js',
});

const numericTimestamp = 1767225600000;
const reviewSession = {
  id: 'session-reviewed',
  lastEventAt: numericTimestamp,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const reviewedSession = await reviewContext.markSessionReviewed(reviewSession, { sync: false, render: true });
assert.equal(
  reviewSession.localReviewedAt,
  new Date(numericTimestamp).toISOString(),
  'marking a session reviewed should accept numeric event timestamps from the backend',
);
assert.equal(
  reviewedSession.localReviewedAt,
  new Date(numericTimestamp).toISOString(),
  'markSessionReviewed should keep the normalized local review timestamp on the session record',
);
assert.equal(reviewRenderCalls, 1, 'markSessionReviewed should rerender the session list after storing a numeric review stamp');

const deferredReviewContext = createBaseContext();
let deferredReviewRenderCalls = 0;
let deferredReviewStored = [];

deferredReviewContext.currentSessionId = 'session-held';
deferredReviewContext.renderSessionList = () => {
  deferredReviewRenderCalls += 1;
};
deferredReviewContext.setLocalSessionReviewedAt = (sessionId, stamp) => {
  deferredReviewStored.push({ sessionId, stamp });
  return stamp;
};
deferredReviewContext.getChatStoreSession = (sessionId) => (
  deferredReviewContext.sessions.find((session) => session.id === sessionId) || null
);

vm.runInNewContext(sessionReviewSnippet, deferredReviewContext, {
  filename: 'chat-session-review-deferred-runtime.js',
});

const heldSession = {
  id: 'session-held',
  lastEventAt: '2026-03-12T12:30:00.000Z',
  lastAssistantMessageAt: '2026-03-12T12:29:00.000Z',
  updatedAt: '2026-03-12T12:30:00.000Z',
  workflowState: 'done',
  activity: createSessionActivity(),
};
deferredReviewContext.sessions = [heldSession];
deferredReviewContext.holdAttachedSessionSidebarState(heldSession);
deferredReviewContext.stageSessionReviewedForAttachedSession({
  ...heldSession,
  lastEventAt: '2026-03-12T12:35:00.000Z',
});
assert.deepEqual(
  deferredReviewStored,
  [],
  'staging the attached session review should not immediately store a local reviewed marker',
);
assert.notEqual(
  deferredReviewContext.getSessionSidebarListSnapshot({
    ...heldSession,
    archived: true,
    updatedAt: '2026-03-12T12:40:00.000Z',
  })?.archived,
  true,
  'the attached session should keep its held sidebar snapshot while the user is still viewing it',
);
await deferredReviewContext.settleAttachedSessionSidebarState({
  sessionId: 'session-held',
  sync: false,
  render: true,
});
assert.deepEqual(
  deferredReviewStored,
  [{
    sessionId: 'session-held',
    stamp: '2026-03-12T12:35:00.000Z',
  }],
  'settling the attached session should persist the deferred review marker on exit',
);
assert.equal(
  deferredReviewRenderCalls,
  1,
  'settling the attached session should rerender the sidebar once the hold is released',
);

const heldArchiveVisibilityContext = createBaseContext();
heldArchiveVisibilityContext.currentSessionId = 'session-current';
heldArchiveVisibilityContext.sessions = [
  {
    id: 'session-current',
    archived: true,
    archivedAt: '2026-03-12T10:00:00.000Z',
    updatedAt: '2026-03-12T08:00:00.000Z',
  },
  {
    id: 'session-other',
    updatedAt: '2026-03-12T09:00:00.000Z',
  },
];
heldArchiveVisibilityContext.getSessionSidebarListSnapshot = (session) => (
  session?.id === 'session-current'
    ? { ...session, archived: false, archivedAt: undefined }
    : session
);

vm.runInNewContext(sessionCatalogVisibilitySnippet, heldArchiveVisibilityContext, {
  filename: 'chat-session-catalog-visibility-runtime.js',
});

assert.deepEqual(
  heldArchiveVisibilityContext.getActiveSessions().map((session) => session.id),
  ['session-current', 'session-other'],
  'the held current session should stay in the active list even after an optimistic archive update',
);
assert.deepEqual(
  heldArchiveVisibilityContext.getArchivedSessions().map((session) => session.id),
  [],
  'the held current session should stay out of the archive bucket until the user leaves it',
);

const archiveContext = createBaseContext();
let archiveFilterRefreshes = 0;
let archiveRequest = null;
const archiveAppliedStates = [];

archiveContext.currentSessionId = 'session-archive';
archiveContext.sessions = [
  {
    id: 'session-newer',
    activity: createSessionActivity(),
    updatedAt: '2026-03-12T09:00:00.000Z',
  },
  {
    id: 'session-archive',
    activity: createSessionActivity(),
    pinned: true,
    updatedAt: '2026-03-12T08:00:00.000Z',
  },
];
archiveContext.sortSessionsInPlace = () => {
  archiveContext.sessions.sort((a, b) => (
    Number(b?.pinned === true) - Number(a?.pinned === true)
    || String(b?.lastEventAt || b?.updatedAt || b?.created || '').localeCompare(
      String(a?.lastEventAt || a?.updatedAt || a?.created || ''),
    )
  ));
};
archiveContext.refreshAppCatalog = () => {
  archiveFilterRefreshes += 1;
};
archiveContext.renderSessionList = () => {};
archiveContext.applyAttachedSessionState = (id, session) => {
  archiveAppliedStates.push({
    id,
    archived: session?.archived === true,
    pinned: session?.pinned === true,
  });
};
archiveContext.fetchSessionsList = async () => archiveContext.sessions;
archiveContext.refreshCurrentSession = async () => null;
archiveContext.refreshSidebarSession = async () => null;
archiveContext.fetchJsonOrRedirect = async (url, options = {}) => {
  archiveRequest = {
    url,
    options,
    optimisticSessions: archiveContext.sessions.map((session) => ({ ...session })),
    attachedStates: archiveAppliedStates.slice(),
  };
  return {
    session: {
      id: 'session-archive',
      activity: createSessionActivity(),
      archived: true,
      archivedAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T08:00:00.000Z',
    },
  };
};
archiveContext.upsertSession = (value) => {
  const index = archiveContext.sessions.findIndex((session) => session.id === value.id);
  if (index === -1) {
    archiveContext.sessions.push(value);
  } else {
    archiveContext.sessions[index] = value;
  }
  return value;
};

vm.runInNewContext(dispatchActionSnippet, archiveContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const archiveAccepted = await archiveContext.dispatchAction({ action: 'archive', sessionId: 'session-archive' });
assert.equal(archiveAccepted, true, 'archive should resolve successfully after server acceptance');
assert.equal(archiveRequest?.url, '/api/sessions/session-archive');
assert.match(String(archiveRequest?.options?.body || ''), /"archived":true/);
assert.equal(
  archiveRequest?.optimisticSessions.find((session) => session.id === 'session-archive')?.archived,
  true,
  'archive should hide the session from the active list before the request resolves',
);
assert.equal(
  archiveRequest?.optimisticSessions.find((session) => session.id === 'session-archive')?.pinned,
  undefined,
  'archive should immediately clear the pinned state in the optimistic sidebar model',
);
assert.deepEqual(
  archiveRequest?.attachedStates,
  [{ id: 'session-archive', archived: true, pinned: false }],
  'archiving the current session should update the attached view immediately',
);
assert.equal(archiveFilterRefreshes, 1, 'archive should refresh sidebar filter state during the optimistic update');

const archiveFailureContext = createBaseContext();
const archiveFailureAppliedStates = [];

archiveFailureContext.console = { ...console, error() {} };
archiveFailureContext.currentSessionId = 'session-failure';
archiveFailureContext.sessions = [{
  id: 'session-failure',
  activity: createSessionActivity(),
  pinned: true,
  updatedAt: '2026-03-12T08:00:00.000Z',
}];
archiveFailureContext.sortSessionsInPlace = () => {};
archiveFailureContext.refreshAppCatalog = () => {};
archiveFailureContext.renderSessionList = () => {};
archiveFailureContext.applyAttachedSessionState = (id, session) => {
  archiveFailureAppliedStates.push({
    id,
    archived: session?.archived === true,
    pinned: session?.pinned === true,
  });
};
archiveFailureContext.fetchSessionsList = async () => archiveFailureContext.sessions;
archiveFailureContext.refreshCurrentSession = async () => null;
archiveFailureContext.refreshSidebarSession = async () => null;
archiveFailureContext.fetchJsonOrRedirect = async () => {
  assert.equal(
    archiveFailureContext.sessions.find((session) => session.id === 'session-failure')?.archived,
    true,
    'failed archive should still apply the optimistic hidden state before the request rejects',
  );
  throw new Error('archive failed');
};
archiveFailureContext.upsertSession = (value) => value;

vm.runInNewContext(dispatchActionSnippet, archiveFailureContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const archiveRejected = await archiveFailureContext.dispatchAction({ action: 'archive', sessionId: 'session-failure' });
assert.equal(archiveRejected, false, 'failed archive should return a failed action result');
assert.equal(
  archiveFailureContext.sessions.find((session) => session.id === 'session-failure')?.archived,
  undefined,
  'failed archive should restore the pre-click sidebar state',
);
assert.equal(
  archiveFailureContext.sessions.find((session) => session.id === 'session-failure')?.pinned,
  true,
  'failed archive should restore the original pin state',
);
assert.deepEqual(
  archiveFailureAppliedStates,
  [
    { id: 'session-failure', archived: true, pinned: false },
    { id: 'session-failure', archived: false, pinned: true },
  ],
  'failed archive should roll the attached session view back after the optimistic update',
);

const attachContext = createBaseContext();
let attachStatusUpdate = null;
let queuedPanelSession = null;
let attachRenderCalls = 0;
let browserStateSyncs = 0;
let forkSyncs = 0;
let shareSyncs = 0;
let modelLoads = 0;
let draftRestores = 0;

attachContext.currentTokens = 99;
attachContext.contextTokens = { style: { display: 'block' } };
attachContext.compactBtn = { style: { display: 'block' } };
attachContext.dropToolsBtn = { style: { display: 'block' } };
attachContext.headerTitle = { textContent: '' };
attachContext.inlineToolSelect = { value: '' };
attachContext.selectedTool = 'claude';
attachContext.toolsList = [{ id: 'claude' }, { id: 'codex' }];
attachContext.getSessionDisplayName = (session) => session?.name || 'Session';
attachContext.updateStatus = (state, session) => {
  attachStatusUpdate = { state, session };
};
attachContext.renderQueuedMessagePanel = (session) => {
  queuedPanelSession = session;
};
attachContext.loadModelsForCurrentTool = () => {
  modelLoads += 1;
};
attachContext.restoreDraft = () => {
  draftRestores += 1;
};
attachContext.renderSessionList = () => {
  attachRenderCalls += 1;
};
attachContext.syncBrowserState = () => {
  browserStateSyncs += 1;
};
attachContext.syncForkButton = () => {
  forkSyncs += 1;
};
attachContext.syncShareButton = () => {
  shareSyncs += 1;
};

vm.runInNewContext(applyAttachedSessionStateSnippet, attachContext, {
  filename: 'chat-apply-attached-session-state-runtime.js',
});

const attachedSession = {
  id: 'session-attach',
  name: 'Render validation session',
  tool: 'codex',
  activity: createSessionActivity({ runState: 'idle' }),
};
attachContext.applyAttachedSessionState(attachedSession.id, attachedSession);

assert.equal(attachContext.currentSessionId, attachedSession.id, 'attaching a session should set the current session id');
assert.equal(attachContext.hasAttachedSession, true, 'attaching a session should mark the UI as attached');
assert.equal(attachContext.currentTokens, 0, 'attaching a session should reset the live-context token counter');
assert.equal(attachContext.headerTitle.textContent, 'Render validation session', 'attaching a session should refresh the header title');
assert.equal(attachContext.inlineToolSelect.value, 'codex', 'attaching a session should update the inline tool picker');
assert.equal(attachContext.selectedTool, 'codex', 'attaching a session should adopt the backend tool selection');
assert.equal(modelLoads, 1, 'attaching a session should refresh models when the tool changes');
assert.equal(draftRestores, 1, 'attaching a session should restore the local draft');
assert.equal(attachRenderCalls, 1, 'attaching a session should rerender the session list');
assert.equal(browserStateSyncs, 1, 'attaching a session should sync browser navigation state');
assert.equal(forkSyncs, 1, 'attaching a session should refresh fork affordances');
assert.equal(shareSyncs, 1, 'attaching a session should refresh share affordances');
assert.deepEqual(attachStatusUpdate, { state: 'connected', session: attachedSession }, 'attaching a session should update the status indicator');
assert.equal(queuedPanelSession, attachedSession, 'attaching a session should refresh the queued-message panel');

console.log('test-chat-session-state: ok');

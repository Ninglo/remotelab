import { dirname } from 'path';
import { createSessionCatalog } from '../lib/session-catalog.mjs';
import { createHash } from 'node:crypto';
import { CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  writeJsonAtomic,
} from './fs-utils.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionAgreements } from './session-agreements.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import { normalizeSessionWorkSummary } from './session-work-summary.mjs';
import {
  DEFAULT_SESSION_SOURCE_ID,
  formatSessionSourceNameFromId,
  normalizeSessionSourceId,
} from './session-source-resolution.mjs';
import { getConnectorDirectSessionName } from './session-naming.mjs';
import { normalizeSessionStarterPreset } from './session-starter-preset.mjs';
import { migrateLegacySessionRuntimeFields } from '../lib/legacy-micro-agent.mjs';
import { DEFAULT_PERSON_ID, DEFAULT_WEB_IDENTITY_ID, SYSTEM_IDENTITY_ID } from '../lib/auth-config.mjs';
import {
  normalizeSessionPersonViews,
  updateSessionPersonView,
} from './session-person-view.mjs';

let sessionsMetaCache = null;
const sessionPointCache = new Map();
const runSessionsMetaMutation = createSerialTaskQueue();


function normalizeStoredTimestamp(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeStoredSessionSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeStoredSessionSourceFields(normalized) {
  let changed = false;

  // Older visible handoffs copied the parent's origin without its routing.
  // Only repair independently delegated sessions with no external target.
  if (typeof normalized.delegatedFromSessionId === 'string' && normalized.delegatedFromSessionId.trim()
    && !normalized.internalRole
    && !normalized.conversation && !normalized.sourceContext && !normalized.externalTriggerId
    && !normalized.completionTargets?.length
    && normalized.sourceId !== DEFAULT_SESSION_SOURCE_ID) {
    normalized.sourceId = DEFAULT_SESSION_SOURCE_ID;
    normalized.sourceName = 'Chat';
    changed = true;
  }

  const explicitSourceId = normalizeSessionSourceId(normalized.sourceId);
  const nextSourceId = explicitSourceId || DEFAULT_SESSION_SOURCE_ID;

  if (normalized.sourceId !== nextSourceId) {
    normalized.sourceId = nextSourceId;
    changed = true;
  }

  const explicitSourceName = normalizeStoredSessionSourceName(normalized.sourceName);
  let nextSourceName = explicitSourceName;
  if (!nextSourceName && nextSourceId !== DEFAULT_SESSION_SOURCE_ID) {
    nextSourceName = formatSessionSourceNameFromId(nextSourceId);
  }

  if (nextSourceName) {
    if (normalized.sourceName !== nextSourceName) {
      normalized.sourceName = nextSourceName;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'sourceName')) {
    delete normalized.sourceName;
    changed = true;
  }

  return changed;
}

function normalizeStoredStarterPreset(normalized) {
  let changed = false;
  const nextStarterPreset = normalizeSessionStarterPreset(normalized.starterPreset);

  if (nextStarterPreset) {
    if (normalized.starterPreset !== nextStarterPreset) {
      normalized.starterPreset = nextStarterPreset;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'starterPreset')) {
    delete normalized.starterPreset;
    changed = true;
  }

  return changed;
}

function normalizeStoredTitleLock(normalized) {
  if (normalized.titleLocked === true) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'titleLocked')) {
    delete normalized.titleLocked;
    return true;
  }
  return false;
}

function normalizeStoredConnectorDirectTitle(session) {
  // Preserve explicit/manual titles. Adopt the stable identity for older
  // AI-named private chats without changing their activity timestamps.
  if (session.titleLocked === true) return false;
  const name = getConnectorDirectSessionName(session);
  if (!name) return false;
  session.name = name;
  session.autoRenamePending = false;
  session.titleLocked = true;
  return true;
}

function normalizeStoredSessionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { meta: null, changed: true };
  }

  const normalized = { ...meta };
  let changed = false;

  const migratedRuntime = migrateLegacySessionRuntimeFields(normalized);
  if (
    (normalized.tool || '') !== (migratedRuntime.tool || '')
    || (normalized.model || '') !== (migratedRuntime.model || '')
    || (normalized.effort || '') !== (migratedRuntime.effort || '')
    || (normalized.thinking || false) !== (migratedRuntime.thinking || false)
  ) {
    Object.assign(normalized, migratedRuntime);
    changed = true;
  }

  for (const legacyField of ['activeRun', 'status', 'queuedMessageCount', 'pendingCompact', 'pendingContinuationQueue', 'pendingPlanningQueue', 'renameState', 'renameError', 'recoverable']) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyField)) {
      delete normalized[legacyField];
      changed = true;
    }
  }

  for (const derivedField of ['managerState', 'workState']) {
    if (Object.prototype.hasOwnProperty.call(normalized, derivedField)) {
      delete normalized[derivedField];
      changed = true;
    }
  }

  changed = normalizeStoredSessionSourceFields(normalized) || changed;
  changed = normalizeStoredStarterPreset(normalized) || changed;
  changed = normalizeStoredTitleLock(normalized) || changed;
  changed = normalizeStoredConnectorDirectTitle(normalized) || changed;

  const identityId = typeof normalized.initiatedByIdentityId === 'string'
    ? normalized.initiatedByIdentityId.trim()
    : '';
  const nextIdentityId = identityId || (
    normalized.sourceId === DEFAULT_SESSION_SOURCE_ID
      ? DEFAULT_WEB_IDENTITY_ID
      : SYSTEM_IDENTITY_ID
  );
  if (normalized.initiatedByIdentityId !== nextIdentityId) {
    normalized.initiatedByIdentityId = nextIdentityId;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowState')) {
    const nextWorkflowState = normalizeSessionWorkflowState(normalized.workflowState || '');
    if (nextWorkflowState) {
      if (normalized.workflowState !== nextWorkflowState) {
        normalized.workflowState = nextWorkflowState;
        changed = true;
      }
    } else {
      delete normalized.workflowState;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowPriority')) {
    const nextWorkflowPriority = normalizeSessionWorkflowPriority(normalized.workflowPriority || '');
    if (nextWorkflowPriority) {
      if (normalized.workflowPriority !== nextWorkflowPriority) {
        normalized.workflowPriority = nextWorkflowPriority;
        changed = true;
      }
    } else {
      delete normalized.workflowPriority;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'lastReviewedAt')) {
    const nextLastReviewedAt = normalizeStoredTimestamp(normalized.lastReviewedAt);
    if (nextLastReviewedAt) {
      if (normalized.lastReviewedAt !== nextLastReviewedAt) {
        normalized.lastReviewedAt = nextLastReviewedAt;
        changed = true;
      }
    } else {
      delete normalized.lastReviewedAt;
      changed = true;
    }
  }

  const normalizedPersonViews = normalizeSessionPersonViews(normalized.personViews);
  if (JSON.stringify(normalized.personViews || {}) !== JSON.stringify(normalizedPersonViews)) {
    if (Object.keys(normalizedPersonViews).length > 0) normalized.personViews = normalizedPersonViews;
    else delete normalized.personViews;
    changed = true;
  }
  if (
    Object.prototype.hasOwnProperty.call(normalized, 'space')
    || Object.prototype.hasOwnProperty.call(normalized, 'group')
    || Object.prototype.hasOwnProperty.call(normalized, 'sidebarOrder')
  ) {
    changed = updateSessionPersonView(normalized, DEFAULT_PERSON_ID, {
      ...(Object.prototype.hasOwnProperty.call(normalized, 'space') ? { space: normalized.space } : {}),
      ...(Object.prototype.hasOwnProperty.call(normalized, 'group') ? { group: normalized.group } : {}),
      ...(Object.prototype.hasOwnProperty.call(normalized, 'sidebarOrder') ? { sidebarOrder: normalized.sidebarOrder } : {}),
    }) || changed;
    delete normalized.space;
    delete normalized.group;
    delete normalized.sidebarOrder;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'entryMode')) {
    const nextEntryMode = normalizeSessionEntryMode(normalized.entryMode);
    if (nextEntryMode) {
      if (normalized.entryMode !== nextEntryMode) {
        normalized.entryMode = nextEntryMode;
        changed = true;
      }
    } else {
      delete normalized.entryMode;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'activeAgreements')) {
    const nextActiveAgreements = normalizeSessionAgreements(normalized.activeAgreements);
    if (nextActiveAgreements.length > 0) {
      if (JSON.stringify(normalized.activeAgreements) !== JSON.stringify(nextActiveAgreements)) {
        normalized.activeAgreements = nextActiveAgreements;
        changed = true;
      }
    } else {
      delete normalized.activeAgreements;
      changed = true;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(normalized, 'workSummary')
    || Object.prototype.hasOwnProperty.call(normalized, 'taskCard')
  ) {
    const nextWorkSummary = normalizeSessionWorkSummary(normalized.workSummary || normalized.taskCard);
    if (nextWorkSummary) {
      if (JSON.stringify(normalized.workSummary) !== JSON.stringify(nextWorkSummary)) {
        normalized.workSummary = nextWorkSummary;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(normalized, 'workSummary')) {
      delete normalized.workSummary;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'taskCard')) {
      delete normalized.taskCard;
      changed = true;
    }
  }

  return { meta: normalized, changed };
}


async function saveSessionsMetaUnlocked(list) {
  const dir = dirname(CHAT_SESSIONS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(CHAT_SESSIONS_FILE, list);
  sessionsMetaCache = list;
  await catalog.adoptLegacy(list);
}

const catalog = createSessionCatalog(CHAT_SESSIONS_FILE, { normalize: value => normalizeStoredSessionMeta(value).meta });
export async function loadSessionsMeta() {
  const metas = await catalog.all();
  // Only publish the most recent snapshot to synchronous readers.
  const latest = await catalog.snapshot();
  if (await latest.list === metas) { sessionsMetaCache = metas; sessionPointCache.clear(); }
  return metas;
}

export async function pruneSessionCatalog() { return catalog.prune(); }

export function findSessionMetaCached(sessionId) {
  if (sessionPointCache.has(sessionId)) return sessionPointCache.get(sessionId);
  if (!Array.isArray(sessionsMetaCache)) return null;
  return sessionsMetaCache.find((meta) => meta.id === sessionId) || null;
}

// Detect writes made by another CLI/process without reprojection of every
// Session. Serialize metadata only when its durable file actually changes.
export async function loadSessionMetaVersionIndex() {
  const snapshot = await catalog.snapshot();
  if (snapshot.versionIndex) return snapshot.versionIndex;
  const indexed = !Array.isArray(snapshot.data);
  const metas = indexed ? null : await catalog.readSnapshot(snapshot);
  snapshot.versionIndex = indexed ? new Map(snapshot.data.order.map(id => [id, snapshot.data.records[id]]))
    : new Map(metas.map(meta => [meta.id, createHash('sha256').update(JSON.stringify(meta)).digest('hex')]));
  return snapshot.versionIndex;
}

export async function findSessionMeta(sessionId) {
  const result = await catalog.get(sessionId);
  sessionPointCache.set(sessionId, result);
  if (sessionPointCache.size > 8192) sessionPointCache.delete(sessionPointCache.keys().next().value);
  return result;
}

export async function findSessionByExternalTriggerId(externalTriggerId) {
  const normalized = typeof externalTriggerId === 'string' ? externalTriggerId.trim() : '';
  if (!normalized) return null;
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.externalTriggerId === normalized && !meta.archived) || null;
}

export async function withSessionsMetaMutation(mutator) {
  if (await catalog.enabled()) return catalog.mutateAll((metas, save) => mutator(metas, async list => {
    await save(list); sessionsMetaCache = list; sessionPointCache.clear();
  }));
  return runSessionsMetaMutation(async () => {
    const metas = await loadSessionsMeta();
    return mutator(metas.slice(), saveSessionsMetaUnlocked);
  });
}

export async function mutateSessionMeta(sessionId, mutator) {
  if (await catalog.enabled()) {
    const result = await catalog.mutateOne(sessionId, mutator);
    sessionPointCache.set(sessionId, result.meta); return result;
  }
  return withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const index = metas.findIndex((meta) => meta.id === sessionId);
    if (index === -1) return { meta: null, changed: false };

    const current = metas[index];
    const draft = { ...current };
    const changed = mutator(draft, current) === true;
    if (!changed) {
      return { meta: current, changed: false };
    }

    metas[index] = draft;
    await saveSessionsMeta(metas);
    return { meta: draft, changed: true };
  });
}

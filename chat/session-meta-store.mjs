import { dirname } from 'path';
import { CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { normalizeSessionWorkflowState } from './session-workflow-state.mjs';

let sessionsMetaCache = null;
let sessionsMetaCacheMtimeMs = null;
const runSessionsMetaMutation = createSerialTaskQueue();

function normalizeStoredSessionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { meta: null, changed: true };
  }

  const normalized = { ...meta };
  let changed = false;

  for (const legacyField of ['activeRun', 'status', 'queuedMessageCount', 'pendingCompact', 'renameState', 'renameError', 'recoverable']) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyField)) {
      delete normalized[legacyField];
      changed = true;
    }
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

  return { meta: normalized, changed };
}

function normalizeStoredSessionsMeta(list) {
  let changed = false;
  const normalized = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const result = normalizeStoredSessionMeta(entry);
    if (!result.meta) {
      changed = true;
      continue;
    }
    normalized.push(result.meta);
    changed = changed || result.changed;
  }
  return { list: normalized, changed };
}

async function saveSessionsMetaUnlocked(list) {
  const dir = dirname(CHAT_SESSIONS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(CHAT_SESSIONS_FILE, list);
  sessionsMetaCache = list;
  sessionsMetaCacheMtimeMs = (await statOrNull(CHAT_SESSIONS_FILE))?.mtimeMs ?? null;
}

export async function loadSessionsMeta() {
  const stats = await statOrNull(CHAT_SESSIONS_FILE);
  if (!stats) {
    sessionsMetaCache = [];
    sessionsMetaCacheMtimeMs = null;
    return sessionsMetaCache;
  }

  const mtimeMs = stats.mtimeMs;
  if (sessionsMetaCache && sessionsMetaCacheMtimeMs === mtimeMs) {
    return sessionsMetaCache;
  }

  const parsed = await readJson(CHAT_SESSIONS_FILE, []);
  const normalized = normalizeStoredSessionsMeta(parsed);
  sessionsMetaCache = normalized.list;
  if (normalized.changed) {
    await saveSessionsMetaUnlocked(sessionsMetaCache);
  } else {
    sessionsMetaCacheMtimeMs = mtimeMs;
  }
  return sessionsMetaCache;
}

export function findSessionMetaCached(sessionId) {
  if (!Array.isArray(sessionsMetaCache)) return null;
  return sessionsMetaCache.find((meta) => meta.id === sessionId) || null;
}

export async function findSessionMeta(sessionId) {
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.id === sessionId) || null;
}

export async function findSessionByExternalTriggerId(externalTriggerId) {
  const normalized = typeof externalTriggerId === 'string' ? externalTriggerId.trim() : '';
  if (!normalized) return null;
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.externalTriggerId === normalized && !meta.archived) || null;
}

export async function withSessionsMetaMutation(mutator) {
  return runSessionsMetaMutation(async () => {
    const metas = await loadSessionsMeta();
    return mutator(metas, saveSessionsMetaUnlocked);
  });
}

export async function mutateSessionMeta(sessionId, mutator) {
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

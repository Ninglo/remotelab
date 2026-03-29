import { dirname } from 'path';
import { SESSION_LABELS_FILE } from '../lib/config.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import {
  mutateSessionMeta,
  withSessionsMetaMutation,
} from './session-meta-store.mjs';
import { runAutoDistill } from './session-auto-distill.mjs';

// ---- Default label definitions ----

const DEFAULT_LABELS = [
  { id: 'started', name: 'Started', color: '#3b82f6' },
  { id: 'asked-for-restart', name: 'Asked for Restart', color: '#eab308' },
  { id: 'pending-review', name: 'Pending Review', color: '#f59e0b' },
  { id: 'planned', name: 'Planned', color: '#8b5cf6' },
  { id: 'done', name: 'Done', color: '#10b981' },
];

// ---- Persistence helpers ----

async function loadLabels() {
  const stored = await readJson(SESSION_LABELS_FILE, null);
  if (!Array.isArray(stored)) {
    await saveLabels([...DEFAULT_LABELS]);
    return [...DEFAULT_LABELS];
  }
  return stored;
}

async function saveLabels(labels) {
  await ensureDir(dirname(SESSION_LABELS_FILE));
  await writeJsonAtomic(SESSION_LABELS_FILE, labels);
}

// ---- Public API ----

export async function getLabels() {
  return loadLabels();
}

export async function addLabel(label) {
  const labels = await loadLabels();
  labels.push(label);
  await saveLabels(labels);
  return label;
}

export async function removeLabel(labelId) {
  const labels = await loadLabels();
  const idx = labels.findIndex((l) => l.id === labelId);
  if (idx === -1) return false;
  labels.splice(idx, 1);
  await saveLabels(labels);

  // Clear this label from any sessions that use it
  await withSessionsMetaMutation(async (metas, saveMetas) => {
    let changed = false;
    for (const m of metas) {
      if (m.label === labelId) {
        delete m.label;
        changed = true;
      }
    }
    if (changed) await saveMetas(metas);
  });
  return true;
}

export async function updateLabel(labelId, updates) {
  const labels = await loadLabels();
  const label = labels.find((l) => l.id === labelId);
  if (!label) return null;
  if (updates.name !== undefined) label.name = updates.name;
  if (updates.color !== undefined) label.color = updates.color;
  await saveLabels(labels);
  return label;
}

/**
 * Set or clear the label on a session.
 * Pass `null` or `undefined` to clear the label.
 * Returns the updated session meta, or null if the session was not found.
 */
export async function setSessionLabel(sessionId, labelId) {
  let oldLabel = null;
  const result = await mutateSessionMeta(sessionId, (draft, current) => {
    oldLabel = current.label || null;
    if (labelId === null || labelId === undefined) {
      if (!Object.prototype.hasOwnProperty.call(draft, 'label')) return false;
      delete draft.label;
    } else {
      if (draft.label === labelId) return false;
      draft.label = labelId;
    }
    return true;
  });

  // Auto-distill: when label transitions to done/pending-review, generate experience notes
  if (result.changed && result.meta) {
    const triggerLabels = ['done', 'pending-review'];
    if (triggerLabels.includes(labelId) && !triggerLabels.includes(oldLabel)) {
      const distillMeta = { ...result.meta };
      setTimeout(() => {
        runAutoDistill(sessionId, distillMeta).catch((e) => {
          console.error(`[session-labels] Auto-distill failed for session ${sessionId.slice(0, 8)}: ${e.message}`);
        });
      }, 2000);
    }
  }

  return result.meta;
}

/**
 * Boot-time recovery: convert all "asked-for-restart" labels back to "started".
 */
export async function recoverBootLabels() {
  await withSessionsMetaMutation(async (metas, saveMetas) => {
    let changed = false;
    for (const m of metas) {
      if (m.label === 'asked-for-restart') {
        m.label = 'started';
        changed = true;
      }
    }
    if (changed) {
      await saveMetas(metas);
      console.log('[session-labels] Boot: recovered asked-for-restart sessions → started');
    }
  });
}

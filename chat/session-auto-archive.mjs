import { getHistorySnapshot } from './history.mjs';
import {
  AUTO_ARCHIVE_RETENTION_HOURS,
  loadInstanceSettings,
  normalizeSessionAutoArchiveSettings,
} from './instance-settings.mjs';
import { listSessions, setSessionArchived } from './session-manager.mjs';

export { AUTO_ARCHIVE_RETENTION_HOURS, normalizeSessionAutoArchiveSettings };
const AUTO_ARCHIVE_INTERVAL_MS = 15 * 60 * 1000;

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function shouldAutoArchiveSession(session, settings, { now = Date.now() } = {}) {
  const normalized = normalizeSessionAutoArchiveSettings(settings);
  if (!normalized.enabled || !session || session.archived === true || session.pinned === true) return false;
  if (session.activeRunId || session.activity?.run?.state === 'running') return false;
  if (Number(session.activity?.queue?.count || 0) > 0 || (Array.isArray(session.followUpQueue) && session.followUpQueue.length > 0)) return false;
  if (session.visitorId || session.internalRole) return false;
  const activityAt = parseTimestamp(session.lastUserMessageAt)
    || parseTimestamp(session.lastEventAt)
    || parseTimestamp(session.updatedAt)
    || parseTimestamp(session.created);
  if (!Number.isFinite(activityAt)) return false;
  return now - activityAt >= normalized.inactiveAfterHours * 60 * 60 * 1000;
}

export async function runSessionAutoArchive({ now = Date.now() } = {}) {
  const settings = normalizeSessionAutoArchiveSettings((await loadInstanceSettings()).sessionAutoArchive);
  if (!settings.enabled) return { enabled: false, archived: [], checked: 0 };
  const sessions = await listSessions({ includeArchived: false });
  const archived = [];
  for (const session of sessions) {
    const snapshot = await getHistorySnapshot(session.id, { includeUserMessageAt: true });
    const candidate = { ...session, ...snapshot };
    if (!shouldAutoArchiveSession(candidate, settings, { now })) continue;
    const updated = await setSessionArchived(session.id, true);
    if (updated?.archived === true) archived.push(session.id);
  }
  return { enabled: true, archived, checked: sessions.length };
}

let autoArchiveTimer = null;

export function startSessionAutoArchive() {
  if (autoArchiveTimer) return;
  autoArchiveTimer = setInterval(() => {
    void runSessionAutoArchive().catch((error) => {
      console.error(`[session-auto-archive] ${error.message}`);
    });
  }, AUTO_ARCHIVE_INTERVAL_MS);
  autoArchiveTimer.unref?.();
  void runSessionAutoArchive().catch((error) => {
    console.error(`[session-auto-archive] ${error.message}`);
  });
}

export function stopSessionAutoArchive() {
  if (autoArchiveTimer) clearInterval(autoArchiveTimer);
  autoArchiveTimer = null;
}

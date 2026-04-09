import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function expandSessionFolder(folder) {
  const trimmed = trimString(folder);
  if (!trimmed || trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function resolveRunnableSessionFolder(folder) {
  const requestedCwd = expandSessionFolder(folder);
  if (existsSync(requestedCwd)) {
    return {
      cwd: requestedCwd,
      requestedCwd,
      repaired: false,
      reason: '',
    };
  }

  const fallbackHome = homedir();
  if (existsSync(fallbackHome)) {
    return {
      cwd: fallbackHome,
      requestedCwd,
      repaired: true,
      reason: 'missing-session-folder-fallback-home',
    };
  }

  throw new Error(`Session folder does not exist on this host: ${requestedCwd}`);
}

export function normalizeStoredSessionFolder(folder) {
  const trimmed = trimString(folder);
  if (!trimmed) {
    return { folder: trimmed, changed: false };
  }

  try {
    const resolved = resolveRunnableSessionFolder(trimmed);
    if (resolved.repaired && resolved.cwd !== trimmed) {
      return {
        folder: resolved.cwd,
        changed: true,
      };
    }
  } catch {
    // Keep unknown missing paths intact so the user can still see what was configured.
  }

  return { folder: trimmed, changed: false };
}

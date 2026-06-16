import { existsSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import {
  INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED,
  IS_INSTANCE_SCOPED,
  MANAGED_WORK_ROOT_DIR,
} from '../lib/config.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isPathWithinRoot(targetPath, rootPath) {
  const normalizedTargetPath = trimString(targetPath);
  const normalizedRootPath = trimString(rootPath);
  if (!normalizedTargetPath || !normalizedRootPath) return false;
  const resolvedTarget = resolve(normalizedTargetPath);
  const resolvedRoot = resolve(normalizedRootPath);
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function clampGuestSessionFolder(folder, options = {}) {
  const isGuestInstance = typeof options.isGuestInstance === 'boolean'
    ? options.isGuestInstance
    : IS_INSTANCE_SCOPED;
  const managedWorkRoot = trimString(options.managedWorkRoot) || MANAGED_WORK_ROOT_DIR;
  if (!isGuestInstance || !trimString(managedWorkRoot) || !INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED) {
    return {
      folder,
      clamped: false,
      reason: '',
    };
  }
  const resolvedFolder = resolve(trimString(folder) || managedWorkRoot);
  if (isPathWithinRoot(resolvedFolder, managedWorkRoot)) {
    return {
      folder: resolvedFolder,
      clamped: false,
      reason: '',
    };
  }
  return {
    folder: managedWorkRoot,
    clamped: true,
    reason: 'outside-guest-managed-work-root',
  };
}

export function expandSessionFolder(folder) {
  const trimmed = trimString(folder);
  if (!trimmed || trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function resolveRunnableSessionFolder(folder) {
  const requestedCwd = expandSessionFolder(folder);
  const guestBoundary = clampGuestSessionFolder(requestedCwd);
  if (guestBoundary.clamped) {
    return {
      cwd: guestBoundary.folder,
      requestedCwd,
      repaired: true,
      reason: guestBoundary.reason,
    };
  }
  if (existsSync(requestedCwd)) {
    return {
      cwd: requestedCwd,
      requestedCwd,
      repaired: false,
      reason: '',
    };
  }

  if (existsSync(MANAGED_WORK_ROOT_DIR)) {
    return {
      cwd: MANAGED_WORK_ROOT_DIR,
      requestedCwd,
      repaired: true,
      reason: 'missing-session-folder-fallback-managed-work-root',
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

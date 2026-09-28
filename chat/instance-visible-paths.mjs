import { realpath } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, isAbsolute, resolve } from 'path';

import {
  INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED,
  INSTANCE_ROOT,
  MANAGED_WORK_ROOT_DIR,
} from '../lib/config.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pushUnique(values, candidate) {
  const normalized = trimString(candidate);
  if (!normalized || values.includes(normalized)) return false;
  values.push(normalized);
  return true;
}

function isLocalAccessBoundaryEnforced(options = {}) {
  if (typeof options.enforceBoundary === 'boolean') {
    return options.enforceBoundary;
  }
  return INSTANCE_LOCAL_ACCESS_BOUNDARY_ENFORCED;
}

export function isPathWithinRoot(filePath, rootPath) {
  const normalizedFilePath = trimString(filePath);
  const normalizedRootPath = trimString(rootPath);
  if (!normalizedFilePath || !normalizedRootPath) return false;
  const resolvedFilePath = resolve(normalizedFilePath);
  const resolvedRootPath = resolve(normalizedRootPath);
  return resolvedFilePath === resolvedRootPath || resolvedFilePath.startsWith(`${resolvedRootPath}/`);
}

export function getScopedInstanceName(options = {}) {
  const instanceRoot = trimString(options.instanceRoot ?? INSTANCE_ROOT);
  return trimString(basename(instanceRoot)).toLowerCase();
}

export function isScopedInstanceUserSurface(options = {}) {
  if (typeof options.scoped === 'boolean') {
    return options.scoped;
  }
  const instanceRoot = trimString(options.instanceRoot ?? INSTANCE_ROOT);
  const instanceName = getScopedInstanceName({ instanceRoot });
  return !!instanceRoot && !!instanceName;
}

export function getDefaultUserVisibleRoot(options = {}) {
  if (!isScopedInstanceUserSurface(options)) {
    return homedir();
  }

  const workspaceRoot = trimString(options.workRoot ?? MANAGED_WORK_ROOT_DIR);
  if (workspaceRoot) {
    return resolve(workspaceRoot);
  }

  const instanceRoot = trimString(options.instanceRoot ?? INSTANCE_ROOT);
  if (instanceRoot) {
    return resolve(instanceRoot);
  }

  return resolve(homedir());
}

export function getUserVisibleRoots(options = {}) {
  if (!isScopedInstanceUserSurface(options)) {
    return [];
  }

  const roots = [];
  const defaultRoot = getDefaultUserVisibleRoot(options);
  pushUnique(roots, defaultRoot);

  const instanceRoot = trimString(options.instanceRoot ?? INSTANCE_ROOT);
  const tempRoot = trimString(options.tmpRoot ?? tmpdir());
  if (
    tempRoot
    && (
      isPathWithinRoot(tempRoot, defaultRoot)
      || (instanceRoot && isPathWithinRoot(tempRoot, instanceRoot))
    )
  ) {
    pushUnique(roots, resolve(tempRoot));
  }

  return roots;
}

export function isUserVisiblePathAllowed(filePath, options = {}) {
  const normalizedPath = trimString(filePath);
  if (!normalizedPath) return false;
  if (!isScopedInstanceUserSurface(options) || !isLocalAccessBoundaryEnforced(options)) return true;

  const resolvedPath = resolve(normalizedPath);
  return getUserVisibleRoots(options).some((rootPath) => isPathWithinRoot(resolvedPath, rootPath));
}

// Existing files can be named through either side of a workspace symlink.
// Compare resolved paths so an alias to the workspace works, while a symlink
// inside the workspace that escapes it remains outside the boundary.
export async function resolveExistingPathWithinRoots(filePath, rootPaths = []) {
  const normalizedPath = trimString(filePath);
  if (!normalizedPath) return null;
  let resolvedPath;
  try {
    resolvedPath = await realpath(normalizedPath);
  } catch {
    return null;
  }
  for (const rootPath of rootPaths) {
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(rootPath);
    } catch {
      continue;
    }
    if (isPathWithinRoot(resolvedPath, resolvedRoot)) return resolvedPath;
  }
  return null;
}

export async function resolveExistingUserVisiblePath(filePath, options = {}) {
  const normalizedPath = trimString(filePath);
  if (!normalizedPath) return null;
  if (isScopedInstanceUserSurface(options) && isLocalAccessBoundaryEnforced(options)) {
    return resolveExistingPathWithinRoots(normalizedPath, getUserVisibleRoots(options));
  }
  try {
    return await realpath(normalizedPath);
  } catch {
    return null;
  }
}

export function resolveUserVisiblePathInput(value, options = {}) {
  const normalizedValue = trimString(value);
  if (!isScopedInstanceUserSurface(options)) {
    if (!normalizedValue || normalizedValue === '~') return homedir();
    if (normalizedValue.startsWith('~/')) return resolve(homedir(), normalizedValue.slice(2));
    return isAbsolute(normalizedValue) ? resolve(normalizedValue) : resolve(normalizedValue);
  }

  const defaultRoot = getDefaultUserVisibleRoot(options);
  if (!normalizedValue || normalizedValue === '~') return defaultRoot;
  if (normalizedValue.startsWith('~/')) return resolve(defaultRoot, normalizedValue.slice(2));
  return isAbsolute(normalizedValue)
    ? resolve(normalizedValue)
    : resolve(defaultRoot, normalizedValue);
}

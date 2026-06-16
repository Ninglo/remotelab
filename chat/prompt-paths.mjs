import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

import {
  INSTANCE_ROOT,
  IS_INSTANCE_SCOPED,
  MANAGED_WORK_ROOT_DIR,
  MEMORY_DIR,
  SYSTEM_MEMORY_DIR,
} from '../lib/config.mjs';

export const BOOTSTRAP_MD = join(MEMORY_DIR, 'bootstrap.md');
export const GLOBAL_MD = join(MEMORY_DIR, 'global.md');
export const PROJECTS_MD = join(MEMORY_DIR, 'projects.md');
export const SKILLS_MD = join(MEMORY_DIR, 'skills.md');
export const TASKS_DIR = join(MEMORY_DIR, 'tasks');
export const MODEL_CONTEXT_DIR = join(MEMORY_DIR, 'model-context');
export const MEMORY_WRITEBACK_TARGETS_FILE = join(MEMORY_DIR, 'writeback-targets.json');
export const AUTO_USER_MEMORY_FILE = join(MODEL_CONTEXT_DIR, 'auto-user-memory.md');
export const AUTO_SYSTEM_MEMORY_FILE = join(SYSTEM_MEMORY_DIR, 'auto-system-memory.md');
export const SYSTEM_MEMORY_FILE = join(SYSTEM_MEMORY_DIR, 'system.md');
const GUEST_SHARED_SYSTEM_MEMORY_DIR_DISPLAY = '[platform-shared-memory]';
const GUEST_SHARED_SYSTEM_MEMORY_FILE_DISPLAY = '[platform-shared-memory]/system.md';
const GUEST_AUTO_SYSTEM_MEMORY_FILE_DISPLAY = '[platform-shared-memory]/auto-system-memory.md';
const GUEST_HIDDEN_HOST_PATH_DISPLAY = '[host-path-hidden-in-guest-instance]';

function isPathWithinRoot(targetPath, rootPath) {
  const normalizedTargetPath = typeof targetPath === 'string' ? targetPath.trim() : '';
  const normalizedRootPath = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!normalizedTargetPath || !normalizedRootPath) return false;
  const resolvedTargetPath = resolve(normalizedTargetPath);
  const resolvedRootPath = resolve(normalizedRootPath);
  const relativePath = relative(resolvedRootPath, resolvedTargetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function displayPromptPath(targetPath, home = homedir()) {
  const normalizedTarget = typeof targetPath === 'string' ? targetPath.trim() : '';
  const normalizedHome = typeof home === 'string' ? home.trim() : '';
  if (!normalizedTarget) return '';
  if (normalizedHome && normalizedTarget === normalizedHome) return '~';
  if (normalizedHome && normalizedTarget.startsWith(`${normalizedHome}/`)) {
    return `~${normalizedTarget.slice(normalizedHome.length)}`;
  }
  return normalizedTarget;
}

function displayGuestSafePromptPath(targetPath, home = homedir()) {
  const normalizedTargetPath = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!normalizedTargetPath) return '';

  const defaultDisplay = displayPromptPath(normalizedTargetPath, home);
  if (!IS_INSTANCE_SCOPED) return defaultDisplay;

  if (isPathWithinRoot(normalizedTargetPath, home)
    || isPathWithinRoot(normalizedTargetPath, INSTANCE_ROOT)
    || isPathWithinRoot(normalizedTargetPath, MANAGED_WORK_ROOT_DIR)
    || isPathWithinRoot(normalizedTargetPath, MEMORY_DIR)) {
    return defaultDisplay;
  }

  const resolvedTargetPath = resolve(normalizedTargetPath);
  if (resolvedTargetPath === resolve(SYSTEM_MEMORY_DIR)) {
    return GUEST_SHARED_SYSTEM_MEMORY_DIR_DISPLAY;
  }
  if (resolvedTargetPath === resolve(SYSTEM_MEMORY_FILE)) {
    return GUEST_SHARED_SYSTEM_MEMORY_FILE_DISPLAY;
  }
  if (resolvedTargetPath === resolve(AUTO_SYSTEM_MEMORY_FILE)) {
    return GUEST_AUTO_SYSTEM_MEMORY_FILE_DISPLAY;
  }

  return GUEST_HIDDEN_HOST_PATH_DISPLAY;
}

export function buildPromptPathMap(options = {}) {
  const home = typeof options.home === 'string' && options.home.trim()
    ? options.home.trim()
    : homedir();

  return {
    BOOTSTRAP_PATH: displayGuestSafePromptPath(BOOTSTRAP_MD, home),
    GLOBAL_PATH: displayGuestSafePromptPath(GLOBAL_MD, home),
    PROJECTS_PATH: displayGuestSafePromptPath(PROJECTS_MD, home),
    SKILLS_PATH: displayGuestSafePromptPath(SKILLS_MD, home),
    TASKS_PATH: displayGuestSafePromptPath(TASKS_DIR, home),
    MEMORY_DIR_PATH: displayGuestSafePromptPath(MEMORY_DIR, home),
    MODEL_CONTEXT_ROOT_PATH: displayGuestSafePromptPath(MODEL_CONTEXT_DIR, home),
    MEMORY_WRITEBACK_TARGETS_FILE_PATH: displayGuestSafePromptPath(MEMORY_WRITEBACK_TARGETS_FILE, home),
    AUTO_USER_MEMORY_FILE_PATH: displayGuestSafePromptPath(AUTO_USER_MEMORY_FILE, home),
    AUTO_SYSTEM_MEMORY_FILE_PATH: displayGuestSafePromptPath(AUTO_SYSTEM_MEMORY_FILE, home),
    WORK_ROOT_PATH: displayGuestSafePromptPath(MANAGED_WORK_ROOT_DIR, home),
    SYSTEM_MEMORY_DIR_PATH: displayGuestSafePromptPath(SYSTEM_MEMORY_DIR, home),
    SYSTEM_MEMORY_FILE_PATH: displayGuestSafePromptPath(SYSTEM_MEMORY_FILE, home),
  };
}

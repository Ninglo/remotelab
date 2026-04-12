import { homedir } from 'os';
import { join } from 'path';

import { MANAGED_WORK_ROOT_DIR, MEMORY_DIR, SYSTEM_MEMORY_DIR } from '../lib/config.mjs';

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

export function buildPromptPathMap(options = {}) {
  const home = typeof options.home === 'string' && options.home.trim()
    ? options.home.trim()
    : homedir();

  return {
    BOOTSTRAP_PATH: displayPromptPath(BOOTSTRAP_MD, home),
    GLOBAL_PATH: displayPromptPath(GLOBAL_MD, home),
    PROJECTS_PATH: displayPromptPath(PROJECTS_MD, home),
    SKILLS_PATH: displayPromptPath(SKILLS_MD, home),
    TASKS_PATH: displayPromptPath(TASKS_DIR, home),
    MEMORY_DIR_PATH: displayPromptPath(MEMORY_DIR, home),
    MODEL_CONTEXT_ROOT_PATH: displayPromptPath(MODEL_CONTEXT_DIR, home),
    MEMORY_WRITEBACK_TARGETS_FILE_PATH: displayPromptPath(MEMORY_WRITEBACK_TARGETS_FILE, home),
    AUTO_USER_MEMORY_FILE_PATH: displayPromptPath(AUTO_USER_MEMORY_FILE, home),
    AUTO_SYSTEM_MEMORY_FILE_PATH: displayPromptPath(AUTO_SYSTEM_MEMORY_FILE, home),
    WORK_ROOT_PATH: displayPromptPath(MANAGED_WORK_ROOT_DIR, home),
    SYSTEM_MEMORY_DIR_PATH: displayPromptPath(SYSTEM_MEMORY_DIR, home),
    SYSTEM_MEMORY_FILE_PATH: displayPromptPath(SYSTEM_MEMORY_FILE, home),
  };
}

import { readFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, relative, resolve } from 'path';

import { MEMORY_DIR, SYSTEM_MEMORY_DIR } from '../lib/config.mjs';
import { readJson } from './fs-utils.mjs';
import {
  AUTO_SYSTEM_MEMORY_FILE,
  AUTO_USER_MEMORY_FILE,
  MEMORY_WRITEBACK_TARGETS_FILE,
  MODEL_CONTEXT_DIR,
  SYSTEM_MEMORY_FILE,
  TASKS_DIR,
  displayPromptPath,
} from './prompt-paths.mjs';

export const USER_AUTO_MEMORY_TARGET_ID = 'user_auto_memory';
export const SYSTEM_AUTO_MEMORY_TARGET_ID = 'system_auto_memory';

const MAX_DISCOVERED_TASK_TARGETS = 24;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTargetId(value, fallback = '') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function expandHomePath(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/')) return join(homedir(), normalized.slice(2));
  return resolve(normalized);
}

function isPathInside(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return !!relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('../');
}

function isAllowedUserMemoryTargetPath(filePath) {
  const normalized = trimString(filePath);
  if (!normalized || !normalized.endsWith('.md')) return false;
  if (!isPathInside(MEMORY_DIR, normalized) && normalized !== MEMORY_DIR) return false;
  const relativePath = relative(MEMORY_DIR, normalized).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('archive/')) return false;
  if (relativePath.startsWith('model-context/session-learnings/')) return false;
  if (relativePath.startsWith('tasks/health/logs/')) return false;
  if (relativePath.endsWith('/README.md') || relativePath.endsWith('/log-template.md')) return false;
  return true;
}

function isAllowedSystemMemoryTargetPath(filePath) {
  const normalized = trimString(filePath);
  if (!normalized || !normalized.endsWith('.md')) return false;
  return isPathInside(SYSTEM_MEMORY_DIR, normalized);
}

async function readMarkdownTitle(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n').slice(0, 24);
    for (const rawLine of lines) {
      const line = trimString(rawLine);
      if (line.startsWith('#')) {
        return line.replace(/^#+\s*/, '').trim();
      }
    }
  } catch {}
  return '';
}

async function collectMarkdownFiles(rootPath) {
  const files = [];

  async function walk(currentPath) {
    let entries = [];
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(nextPath);
      }
    }
  }

  await walk(rootPath);
  return files;
}

async function buildTaskTargets() {
  const taskFiles = (await collectMarkdownFiles(TASKS_DIR))
    .filter((filePath) => isAllowedUserMemoryTargetPath(filePath))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_DISCOVERED_TASK_TARGETS);

  const targets = [];
  for (const filePath of taskFiles) {
    const title = await readMarkdownTitle(filePath);
    const relativePath = relative(MEMORY_DIR, filePath).replace(/\\/g, '/');
    const defaultId = normalizeTargetId(`task_${relativePath.replace(/[/.]+/g, '_')}`);
    targets.push({
      id: defaultId,
      path: filePath,
      layer: 'user',
      description: title
        ? `Recurring task/project note: ${title}. Use when the learning mainly belongs to this workstream.`
        : `Recurring task/project note: ${relativePath}. Use when the learning mainly belongs to this workstream.`,
      categories: ['workflow', 'decision', 'environment', 'solution'],
      kind: 'task_note',
    });
  }
  return targets;
}

async function buildDefaultTargets() {
  const targets = [
    {
      id: 'user_preferences',
      path: join(MODEL_CONTEXT_DIR, 'preferences.md'),
      layer: 'user',
      description: 'Durable user preferences and collaboration defaults across many tasks.',
      categories: ['preference', 'workflow', 'decision'],
      kind: 'preferences',
    },
    {
      id: 'user_global',
      path: join(MEMORY_DIR, 'global.md'),
      layer: 'user',
      description: 'Deeper local background facts that are stable but should not live in startup context.',
      categories: ['environment', 'decision', 'workflow'],
      kind: 'global',
    },
    {
      id: 'user_automation',
      path: join(MEMORY_DIR, 'automation.md'),
      layer: 'user',
      description: 'Reusable personal automation patterns and stable execution habits.',
      categories: ['workflow', 'solution', 'decision'],
      kind: 'automation',
    },
    {
      id: 'personal_identity',
      path: join(MEMORY_DIR, 'reference', 'personal', 'identity.md'),
      layer: 'user',
      description: 'Stable personal identity/background facts for self-description or recurring personal context.',
      categories: ['environment', 'decision'],
      kind: 'reference',
    },
    ...(await buildTaskTargets()),
    {
      id: USER_AUTO_MEMORY_TARGET_ID,
      path: AUTO_USER_MEMORY_FILE,
      layer: 'user',
      description: 'Safe fallback sink for durable user memory when no more specific user file is clearly correct.',
      categories: ['preference', 'workflow', 'decision', 'environment', 'solution'],
      kind: 'auto_fallback',
    },
    {
      id: SYSTEM_AUTO_MEMORY_TARGET_ID,
      path: AUTO_SYSTEM_MEMORY_FILE,
      layer: 'system',
      description: 'Safe fallback sink for cross-deployment RemoteLab learnings before any manual curation into system memory.',
      categories: ['workflow', 'decision', 'environment', 'solution'],
      kind: 'auto_fallback',
    },
  ];

  return targets.filter((target) => {
    if (target.id === USER_AUTO_MEMORY_TARGET_ID || target.id === SYSTEM_AUTO_MEMORY_TARGET_ID) return true;
    return target.layer === 'user'
      ? isAllowedUserMemoryTargetPath(target.path)
      : isAllowedSystemMemoryTargetPath(target.path);
  });
}

function normalizeCategoryList(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map((entry) => trimString(entry).toLowerCase())
    .filter((entry) => ['preference', 'workflow', 'decision', 'environment', 'solution'].includes(entry));
}

function normalizeConfiguredTarget(rawTarget = {}) {
  const id = normalizeTargetId(rawTarget.id);
  const path = expandHomePath(rawTarget.path);
  const layer = trimString(rawTarget.layer).toLowerCase() === 'system' ? 'system' : 'user';
  const description = trimString(rawTarget.description || rawTarget.notes);
  const categories = normalizeCategoryList(rawTarget.categories);
  const enabled = rawTarget.enabled !== false;

  if (!id || !path || !description || !enabled) return null;
  if (layer === 'user' && !isAllowedUserMemoryTargetPath(path)) return null;
  if (layer === 'system' && !isAllowedSystemMemoryTargetPath(path)) return null;

  return {
    id,
    path,
    layer,
    description,
    categories,
    kind: 'configured',
  };
}

async function readMemoryWritebackTargetsConfig() {
  const config = await readJson(MEMORY_WRITEBACK_TARGETS_FILE, null);
  if (!config || typeof config !== 'object') return null;
  return {
    disableDefaultTargetIds: Array.isArray(config.disableDefaultTargetIds)
      ? config.disableDefaultTargetIds.map((entry) => normalizeTargetId(entry)).filter(Boolean)
      : [],
    extraTargets: Array.isArray(config.extraTargets)
      ? config.extraTargets.map(normalizeConfiguredTarget).filter(Boolean)
      : [],
  };
}

export async function loadMemoryWritebackTargets() {
  const defaults = await buildDefaultTargets();
  const config = await readMemoryWritebackTargetsConfig();
  const disabledDefaults = new Set(config?.disableDefaultTargetIds || []);
  const targets = [];

  for (const target of defaults) {
    if (
      target.id !== USER_AUTO_MEMORY_TARGET_ID
      && target.id !== SYSTEM_AUTO_MEMORY_TARGET_ID
      && disabledDefaults.has(target.id)
    ) {
      continue;
    }
    targets.push(target);
  }

  for (const extraTarget of config?.extraTargets || []) {
    const existingIndex = targets.findIndex((target) => target.id === extraTarget.id);
    if (existingIndex !== -1) {
      targets[existingIndex] = extraTarget;
    } else {
      targets.push(extraTarget);
    }
  }

  const seen = new Set();
  return targets.filter((target) => {
    if (!target?.id || !target?.path) return false;
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  });
}

export function buildMemoryWritebackTargetMap(targets = []) {
  const map = new Map();
  for (const target of targets) {
    if (target?.id) {
      map.set(target.id, target);
    }
  }
  return map;
}

export function getFallbackMemoryWritebackTarget(targets = [], layer = 'user') {
  const fallbackId = layer === 'system' ? SYSTEM_AUTO_MEMORY_TARGET_ID : USER_AUTO_MEMORY_TARGET_ID;
  return targets.find((target) => target.id === fallbackId && target.layer === layer) || null;
}

export function resolveMemoryWritebackTarget(targets = [], learning = {}) {
  const targetMap = buildMemoryWritebackTargetMap(targets);
  const requestedTarget = targetMap.get(normalizeTargetId(learning?.targetId));
  if (requestedTarget && requestedTarget.layer === learning?.layer) {
    return requestedTarget;
  }
  return getFallbackMemoryWritebackTarget(targets, learning?.layer === 'system' ? 'system' : 'user');
}

export function formatMemoryWritebackTargetsForPrompt(targets = []) {
  return targets.map((target) => {
    const categories = Array.isArray(target.categories) && target.categories.length > 0
      ? ` | categories: ${target.categories.join(', ')}`
      : '';
    return `- ${target.id} | ${target.layer} | ${displayPromptPath(target.path)} | ${target.description}${categories}`;
  }).join('\n');
}

export function buildAutoMemorySectionHeading(target) {
  if (target?.kind === 'auto_fallback') {
    return '## Learnings';
  }
  return '## Auto-Promoted Learnings';
}

export async function buildNewMemoryTargetFilePreamble(target) {
  const title = await readMarkdownTitle(target.path);
  const fallbackTitle = title || basename(target.path, '.md').replace(/[-_]+/g, ' ').trim() || 'Memory Target';
  if (target?.kind === 'auto_fallback') {
    if (target.layer === 'system') {
      return [
        '# Auto-Promoted System Memory',
        '',
        '> Generated by RemoteLab post-turn memory writeback. Keep only cross-deployment learnings here.',
        '',
        '## Learnings',
      ].join('\n');
    }
    return [
      '# Auto-Promoted User Memory',
      '',
      '> Generated by RemoteLab post-turn memory writeback. Keep only durable user, machine, or workflow facts here.',
      '',
      '## Learnings',
    ].join('\n');
  }

  return [
    `# ${fallbackTitle}`,
    '',
    `> Auto-promoted durable memory target. ${target.description}`,
    '',
    '## Auto-Promoted Learnings',
  ].join('\n');
}

export { MEMORY_WRITEBACK_TARGETS_FILE, SYSTEM_MEMORY_FILE };

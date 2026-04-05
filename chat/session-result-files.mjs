/**
 * Result / artifact file detection from run output.
 *
 * Extracted from session-manager.mjs — pure functions for scanning
 * run output, resolving result file paths, and publishing result assets.
 */

import { basename, dirname, extname, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { statOrNull } from './fs-utils.mjs';
import {
  normalizeAttachmentSizeBytes,
  resolveAttachmentMimeType,
  sanitizeOriginalAttachmentName,
} from './session-attachments.mjs';

// ── Tiny shared helpers (duplicated to avoid circular deps) ──────────

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pushUnique(values, candidate) {
  const normalized = trimString(candidate);
  if (!normalized || values.includes(normalized)) return false;
  values.push(normalized);
  return true;
}

function expandHomePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

// ── Constants ────────────────────────────────────────────────────────

export const RESULT_FILE_COMMAND_OUTPUT_FLAGS = new Set(['-o', '--output', '--out', '--export']);

// ── Path candidate helpers ───────────────────────────────────────────

export function normalizeResultFilePathCandidate(value) {
  let candidate = trimString(value);
  if (!candidate) return '';
  candidate = candidate.replace(/^file:\/\//i, '');
  candidate = candidate.replace(/^[<('"`]+/, '').replace(/[>)'"`,;]+$/, '');
  return candidate.trim();
}

export function looksLikeResultFilePath(value) {
  const candidate = normalizeResultFilePathCandidate(value);
  if (!candidate || candidate.length > 4096) return false;
  if (/^(https?:|data:|blob:)/i.test(candidate)) return false;
  if (candidate.startsWith('/api/')) return false;
  if (/[\r\n]/.test(candidate)) return false;
  if (/[\\/]/.test(candidate) || candidate.startsWith('~/')) return true;
  return /\.[a-z0-9]{1,8}$/i.test(candidate);
}

// ── Shell / text scanning ────────────────────────────────────────────

export function tokenizeShellCommandLike(command) {
  const tokens = [];
  const source = typeof command === 'string' ? command : '';
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*)`|(\S+)/g;
  for (const match of source.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
  }
  return tokens.filter(Boolean);
}

export function normalizeSearchRootCandidate(value, fallbackRoot = '') {
  const trimmed = expandHomePath(value);
  if (!trimmed) return '';
  const resolvedPath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : (fallbackRoot ? resolve(fallbackRoot, trimmed) : '');
  if (!resolvedPath) return '';
  return extname(resolvedPath) ? dirname(resolvedPath) : resolvedPath;
}

export function extractSearchRootsFromText(text, fallbackRoot = '') {
  const roots = [];
  const source = typeof text === 'string' ? text : '';
  const matches = source.match(/(?:~\/|\/Users\/|\/home\/)[^\s"'`<>()]+/g) || [];
  for (const match of matches) {
    pushUnique(roots, normalizeSearchRootCandidate(match, fallbackRoot));
  }
  return roots;
}

export function extractSearchRootsFromCommand(command, fallbackRoot = '') {
  const roots = [];
  const tokens = tokenizeShellCommandLike(command);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'cd' && tokens[index + 1]) {
      pushUnique(roots, normalizeSearchRootCandidate(tokens[index + 1], fallbackRoot));
      index += 1;
      continue;
    }
    if (/^(?:~\/|\/Users\/|\/home\/)/.test(token)) {
      pushUnique(roots, normalizeSearchRootCandidate(token, fallbackRoot));
      continue;
    }
    if (/^[.]{1,2}\//.test(token) || token.includes('/')) {
      pushUnique(roots, normalizeSearchRootCandidate(token, fallbackRoot));
    }
  }
  return roots;
}

export function collectResultFileSearchRoots(manifest, command = '') {
  const roots = [];
  for (const root of extractSearchRootsFromCommand(command, trimString(manifest?.folder))) {
    pushUnique(roots, root);
  }
  for (const root of extractSearchRootsFromText(manifest?.prompt || '', trimString(manifest?.folder))) {
    pushUnique(roots, root);
  }
  if (trimString(manifest?.folder)) {
    pushUnique(roots, resolve(trimString(manifest.folder)));
  }
  return roots;
}

// ── Candidate extraction from output / command ───────────────────────

export function extractResultFileCandidatesFromOutput(output = '') {
  const candidates = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const arrowMatch = line.match(/(?:→|->)\s*(.+)$/);
    if (arrowMatch?.[1]) {
      pushUnique(candidates, normalizeResultFilePathCandidate(arrowMatch[1]));
      continue;
    }
    const toMatch = line.match(/\b(?:saved|written|exported|rendered|generated|output)\b.*?\bto\b\s+(.+)$/i);
    if (toMatch?.[1]) {
      pushUnique(candidates, normalizeResultFilePathCandidate(toMatch[1]));
    }
  }
  return candidates.filter(looksLikeResultFilePath);
}

export function extractCommandOutputPathCandidates(command = '') {
  const candidates = [];
  const tokens = tokenizeShellCommandLike(command);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (RESULT_FILE_COMMAND_OUTPUT_FLAGS.has(token) && tokens[index + 1]) {
      pushUnique(candidates, normalizeResultFilePathCandidate(tokens[index + 1]));
      index += 1;
      continue;
    }
    const eqMatch = token.match(/^--(?:output|out|export)=(.+)$/);
    if (eqMatch?.[1]) {
      pushUnique(candidates, normalizeResultFilePathCandidate(eqMatch[1]));
    }
  }
  return candidates.filter(looksLikeResultFilePath);
}

// ── Path resolution ──────────────────────────────────────────────────

export function isPathWithinRoot(filePath, root) {
  const normalizedFile = resolve(filePath);
  const normalizedRoot = resolve(root);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

export async function resolveExistingResultFilePath(candidate, searchRoots = [], minimumMtimeMs = 0) {
  const normalized = normalizeResultFilePathCandidate(candidate);
  if (!looksLikeResultFilePath(normalized)) return null;

  const attempts = [];
  const expanded = expandHomePath(normalized);
  if (expanded && isAbsolute(expanded)) {
    pushUnique(attempts, resolve(expanded));
  } else {
    for (const root of searchRoots) {
      pushUnique(attempts, resolve(root, normalized));
    }
  }

  const allowedRoots = [
    ...searchRoots.map((root) => resolve(root)),
    homedir(),
  ];

  for (const attempt of attempts) {
    if (!allowedRoots.some((root) => isPathWithinRoot(attempt, root))) {
      continue;
    }
    const stats = await statOrNull(attempt);
    if (!stats?.isFile()) continue;
    if (minimumMtimeMs > 0 && Number.isFinite(stats.mtimeMs) && stats.mtimeMs + 1000 < minimumMtimeMs) {
      continue;
    }
    if (!Number.isFinite(stats.size) || stats.size <= 0) continue;
    return attempt;
  }
  return null;
}

// ── Run-level result collection ──────────────────────────────────────

export async function collectGeneratedResultFilesFromRun(run, manifest, normalizedEvents = []) {
  const minimumMtimeMs = Date.parse(run?.startedAt || run?.createdAt || '') || 0;
  const filesByPath = new Map();
  let activeCommand = '';

  for (const event of normalizedEvents || []) {
    if (event?.type === 'tool_use' && event.toolName === 'bash') {
      activeCommand = trimString(event.toolInput);
      continue;
    }
    if (event?.type !== 'tool_result' || event.toolName !== 'bash') {
      continue;
    }
    if (Number.isInteger(event.exitCode) && event.exitCode !== 0) {
      activeCommand = '';
      continue;
    }

    const searchRoots = collectResultFileSearchRoots(manifest, activeCommand);
    const candidates = [
      ...extractResultFileCandidatesFromOutput(event.output || ''),
      ...extractCommandOutputPathCandidates(activeCommand),
    ];
    activeCommand = '';

    for (const candidate of candidates) {
      const localPath = await resolveExistingResultFilePath(candidate, searchRoots, minimumMtimeMs);
      if (!localPath || filesByPath.has(localPath)) continue;
      const originalName = sanitizeOriginalAttachmentName(candidate) || basename(localPath);
      filesByPath.set(localPath, {
        localPath,
        originalName,
        mimeType: resolveAttachmentMimeType('', originalName || basename(localPath)),
      });
    }
  }

  return [...filesByPath.values()];
}

// ── Published result asset helpers ───────────────────────────────────

export function normalizePublishedResultAssetAttachments(assets = []) {
  return (assets || [])
    .map((asset) => {
      const assetId = trimString(asset?.assetId || asset?.id);
      if (!assetId) return null;
      const originalName = sanitizeOriginalAttachmentName(asset?.originalName || '');
      const sizeBytes = normalizeAttachmentSizeBytes(asset?.sizeBytes);
      return {
        assetId,
        ...(originalName ? { originalName } : {}),
        mimeType: resolveAttachmentMimeType(asset?.mimeType, originalName),
        ...(sizeBytes ? { sizeBytes } : {}),
        renderAs: 'file',
      };
    })
    .filter(Boolean);
}

export function buildResultAssetReadyMessage(attachments = []) {
  return attachments.length === 1
    ? 'Generated file ready to download.'
    : 'Generated files ready to download.';
}

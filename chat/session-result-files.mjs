/**
 * Result / artifact file detection from run output.
 *
 * Extracted from session-manager.mjs — pure functions for scanning
 * run output, resolving result file paths, and publishing result assets.
 */

import { basename, dirname, extname, isAbsolute, resolve } from 'path';
import { homedir, tmpdir } from 'os';
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
const LOCAL_SEARCH_ROOT_PATH_RE = /(?:~\/|\/(?:Users|home|root|opt|private|var|tmp|Volumes|mnt)\/)[^\s"'`<>()]+/g;
const LOCAL_SEARCH_ROOT_PREFIX_RE = /^(?:~\/|\/(?:Users|home|root|opt|private|var|tmp|Volumes|mnt)\/)/;
const ASSISTANT_LOCAL_MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\r\n]+)\)/g;
const ASSISTANT_LOCAL_MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\r\n]+)\)/g;
const ASSISTANT_LOCAL_CODE_SPAN_RE = /`([^`\r\n]+)`/g;
const PRODUCT_LOCAL_ROUTE_RE = /^\/(?:api|share|share-asset|agent|visitor|login|logout|m|subscribe)(?:[/?#]|$)/i;
const EXTRA_RESULT_FILE_ALLOWED_ROOTS = Object.freeze(['/var/tmp', '/private/tmp']);
const ARTIFACT_BLOCK_HEADER_RE = /^(?:#{1,6}\s*|\*\*)?artifacts(?:\*\*)?\s*:?\s*$/i;

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
  if (PRODUCT_LOCAL_ROUTE_RE.test(candidate)) return false;
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
  const matches = source.match(LOCAL_SEARCH_ROOT_PATH_RE) || [];
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
    if (LOCAL_SEARCH_ROOT_PREFIX_RE.test(token)) {
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

function dedupeResultFileTextReferences(references = []) {
  const ordered = [...references].sort((left, right) => {
    if (left.index !== right.index) return left.index - right.index;
    return right.fullMatch.length - left.fullMatch.length;
  });
  const unique = [];
  let lastEnd = -1;
  for (const reference of ordered) {
    if (reference.index < lastEnd) continue;
    unique.push(reference);
    lastEnd = reference.index + reference.fullMatch.length;
  }
  return unique;
}

function resolveAssistantResultFileDisplayName(candidate, preferredName = '') {
  const sanitizedPreferred = sanitizeOriginalAttachmentName(preferredName || '');
  if (sanitizedPreferred && extname(sanitizedPreferred)) {
    return sanitizedPreferred;
  }
  return sanitizeOriginalAttachmentName(candidate) || basename(candidate);
}

export function extractAssistantResultFileReferences(text = '', options = {}) {
  const includeMarkdownLinks = options.includeMarkdownLinks !== false;
  const includeCodeSpans = options.includeCodeSpans !== false;
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];

  const references = [];

  if (includeMarkdownLinks) {
    ASSISTANT_LOCAL_MARKDOWN_LINK_RE.lastIndex = 0;
    let match;
    while ((match = ASSISTANT_LOCAL_MARKDOWN_LINK_RE.exec(source)) !== null) {
      const candidate = normalizeResultFilePathCandidate(match[2] || '');
      if (!looksLikeResultFilePath(candidate)) continue;
      references.push({
        kind: 'markdown_link',
        fullMatch: match[0],
        index: match.index,
        candidate,
        displayName: resolveAssistantResultFileDisplayName(candidate, match[1] || ''),
      });
    }
  }

  if (includeCodeSpans) {
    ASSISTANT_LOCAL_CODE_SPAN_RE.lastIndex = 0;
    let match;
    while ((match = ASSISTANT_LOCAL_CODE_SPAN_RE.exec(source)) !== null) {
      const candidate = normalizeResultFilePathCandidate(match[1] || '');
      if (!looksLikeResultFilePath(candidate)) continue;
      references.push({
        kind: 'code_span',
        fullMatch: match[0],
        index: match.index,
        candidate,
        displayName: resolveAssistantResultFileDisplayName(candidate, candidate),
      });
    }
  }

  return dedupeResultFileTextReferences(references);
}

export function extractAssistantResultFileCandidatesFromText(text = '', options = {}) {
  const candidates = [];
  for (const reference of extractAssistantResultFileReferences(text, options)) {
    pushUnique(candidates, reference.candidate);
  }
  return candidates;
}

export function extractAssistantLocalMarkdownImageReferences(text = '') {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];

  const references = [];
  ASSISTANT_LOCAL_MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match;
  while ((match = ASSISTANT_LOCAL_MARKDOWN_IMAGE_RE.exec(source)) !== null) {
    const candidate = normalizeResultFilePathCandidate(match[2] || '');
    if (!looksLikeResultFilePath(candidate)) continue;
    references.push({
      kind: 'markdown_image',
      fullMatch: match[0],
      index: match.index,
      candidate,
      altText: match[1] || '',
      displayName: resolveAssistantResultFileDisplayName(candidate, match[1] || ''),
    });
  }

  return dedupeResultFileTextReferences(references);
}

function normalizeArtifactBlockLine(line = '') {
  return String(line || '')
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

function isArtifactBlockBoundary(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed) return true;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z0-9 _/-]{0,80}:\s*$/.test(trimmed) && !ARTIFACT_BLOCK_HEADER_RE.test(trimmed)) {
    return true;
  }
  return false;
}

function extractArtifactBlockReferenceFromLine(line = '', index = 0) {
  const normalizedLine = normalizeArtifactBlockLine(line);
  if (!normalizedLine) return [];

  const directReferences = extractAssistantResultFileReferences(normalizedLine);
  if (directReferences.length > 0) {
    return directReferences.map((reference) => ({
      ...reference,
      kind: 'artifact_block',
      index: index + reference.index,
    }));
  }

  const normalizedCandidate = normalizeResultFilePathCandidate(normalizedLine);
  if (
    (/^(?:~\/|\/)/.test(normalizedCandidate) || normalizedCandidate.startsWith('./') || normalizedCandidate.startsWith('../'))
    && !/\s+(?:->|=>|\|)\s+/.test(normalizedLine)
    && !/^[^/]+:\s+/.test(normalizedLine)
    && looksLikeResultFilePath(normalizedCandidate)
  ) {
    return [{
      kind: 'artifact_block',
      fullMatch: normalizedLine,
      index,
      candidate: normalizedCandidate,
      displayName: resolveAssistantResultFileDisplayName(normalizedCandidate, normalizedCandidate),
    }];
  }

  const localPathMatch = normalizedLine.match(LOCAL_SEARCH_ROOT_PATH_RE)?.[0] || '';
  if (localPathMatch) {
    const candidate = normalizeResultFilePathCandidate(localPathMatch);
    if (looksLikeResultFilePath(candidate)) {
      return [{
        kind: 'artifact_block',
        fullMatch: normalizedLine,
        index,
        candidate,
        displayName: resolveAssistantResultFileDisplayName(candidate, candidate),
      }];
    }
  }

  const pathishParts = normalizedLine
    .split(/\s+(?:->|=>|\|)\s+|:\s+/)
    .map((part) => normalizeResultFilePathCandidate(part))
    .filter(Boolean);
  for (let partIndex = pathishParts.length - 1; partIndex >= 0; partIndex -= 1) {
    const candidate = pathishParts[partIndex];
    if (!looksLikeResultFilePath(candidate)) continue;
    const preferredName = partIndex > 0 ? pathishParts[0] : candidate;
    return [{
      kind: 'artifact_block',
      fullMatch: normalizedLine,
      index,
      candidate,
      displayName: resolveAssistantResultFileDisplayName(candidate, preferredName),
    }];
  }

  if (!looksLikeResultFilePath(normalizedCandidate)) {
    return [];
  }
  return [{
    kind: 'artifact_block',
    fullMatch: normalizedLine,
    index,
    candidate: normalizedCandidate,
    displayName: resolveAssistantResultFileDisplayName(normalizedCandidate, normalizedCandidate),
  }];
}

export function extractAssistantArtifactBlockReferences(text = '') {
  const source = typeof text === 'string' ? text : '';
  if (!source) return [];

  const lines = source.split(/\r?\n/);
  const references = [];
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const headerOffset = offset;
    offset += line.length + 1;
    if (!ARTIFACT_BLOCK_HEADER_RE.test(trimmed)) {
      continue;
    }

    let bodyOffset = offset;
    let sawCandidate = false;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      const bodyTrimmed = bodyLine.trim();
      if (!bodyTrimmed) {
        if (sawCandidate) break;
        bodyOffset += bodyLine.length + 1;
        continue;
      }
      if (isArtifactBlockBoundary(bodyLine) && !normalizeArtifactBlockLine(bodyLine).startsWith('~/') && !bodyTrimmed.startsWith('/')) {
        break;
      }
      const lineReferences = extractArtifactBlockReferenceFromLine(bodyLine, bodyOffset);
      if (lineReferences.length > 0) {
        sawCandidate = true;
        references.push(...lineReferences);
      } else if (sawCandidate) {
        break;
      }
      bodyOffset += bodyLine.length + 1;
    }

    if (sawCandidate) {
      continue;
    }
    offset = headerOffset + line.length + 1;
  }

  return dedupeResultFileTextReferences(references);
}

export function stripAssistantArtifactDeliveryHints(text = '') {
  const source = typeof text === 'string' ? text : '';
  if (!source) return source;

  const lines = source.split(/\r?\n/);
  const keptLines = [];
  let insideArtifactBlock = false;
  let sawArtifactCandidate = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideArtifactBlock && ARTIFACT_BLOCK_HEADER_RE.test(trimmed)) {
      insideArtifactBlock = true;
      sawArtifactCandidate = false;
      continue;
    }
    if (insideArtifactBlock) {
      if (!trimmed) {
        insideArtifactBlock = false;
        continue;
      }
      const hasArtifactReference = extractArtifactBlockReferenceFromLine(line).length > 0;
      if (hasArtifactReference) {
        sawArtifactCandidate = true;
        continue;
      }
      if (sawArtifactCandidate || isArtifactBlockBoundary(line)) {
        insideArtifactBlock = false;
      } else {
        continue;
      }
    }
    if (!insideArtifactBlock) {
      keptLines.push(line);
    }
  }

  let result = keptLines.join('\n');
  for (const reference of extractAssistantResultFileReferences(result).sort((left, right) => right.index - left.index)) {
    const replacement = reference.displayName || basename(reference.candidate);
    result = result.slice(0, reference.index) + replacement + result.slice(reference.index + reference.fullMatch.length);
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Path resolution ──────────────────────────────────────────────────

export function isPathWithinRoot(filePath, root) {
  const normalizedFile = resolve(filePath);
  const normalizedRoot = resolve(root);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function collectAllowedResultFileRoots(searchRoots = []) {
  const roots = [];
  for (const root of searchRoots || []) {
    pushUnique(roots, resolve(root));
  }
  pushUnique(roots, homedir());
  pushUnique(roots, resolve(tmpdir()));
  for (const root of EXTRA_RESULT_FILE_ALLOWED_ROOTS) {
    pushUnique(roots, resolve(root));
  }
  return roots;
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

  const allowedRoots = collectAllowedResultFileRoots(searchRoots);

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

async function maybeCollectResolvedResultFile(filesByPath, {
  candidate,
  searchRoots = [],
  minimumMtimeMs = 0,
  preferredName = '',
} = {}) {
  const localPath = await resolveExistingResultFilePath(candidate, searchRoots, minimumMtimeMs);
  if (!localPath || filesByPath.has(localPath)) return false;
  const originalName = resolveAssistantResultFileDisplayName(localPath, preferredName || candidate) || basename(localPath);
  filesByPath.set(localPath, {
    localPath,
    originalName,
    mimeType: resolveAttachmentMimeType('', originalName || basename(localPath)),
  });
  return true;
}

// ── Run-level result collection ──────────────────────────────────────

export async function collectGeneratedResultFilesFromRun(run, manifest, normalizedEvents = []) {
  const filesByPath = new Map();
  let activeCommand = '';
  const discoveredSearchRoots = collectResultFileSearchRoots(manifest, '');

  for (const event of normalizedEvents || []) {
    if (event?.type === 'tool_use' && event.toolName === 'bash') {
      activeCommand = trimString(event.toolInput);
      for (const root of collectResultFileSearchRoots(manifest, activeCommand)) {
        pushUnique(discoveredSearchRoots, root);
      }
      continue;
    }
    if (event?.type === 'message' && event.role === 'assistant') {
      const references = [
        ...extractAssistantArtifactBlockReferences(event.content || ''),
        ...extractAssistantResultFileReferences(event.content || ''),
      ];
      for (const reference of references) {
        await maybeCollectResolvedResultFile(filesByPath, {
          candidate: reference.candidate,
          searchRoots: discoveredSearchRoots,
          preferredName: reference.displayName,
        });
      }
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
    for (const root of searchRoots) {
      pushUnique(discoveredSearchRoots, root);
    }
    const candidates = [
      ...extractResultFileCandidatesFromOutput(event.output || ''),
      ...extractCommandOutputPathCandidates(activeCommand),
    ];
    activeCommand = '';

    for (const candidate of candidates) {
      await maybeCollectResolvedResultFile(filesByPath, {
        candidate,
        searchRoots,
      });
    }
  }

  return [...filesByPath.values()];
}

function collectDiscoveredResultFileSearchRoots(manifest, events = []) {
  const discoveredSearchRoots = collectResultFileSearchRoots(manifest, '');
  for (const event of events || []) {
    if (event?.type !== 'tool_use' || event.toolName !== 'bash') continue;
    for (const root of collectResultFileSearchRoots(manifest, trimString(event.toolInput))) {
      pushUnique(discoveredSearchRoots, root);
    }
  }
  return discoveredSearchRoots;
}

export function buildPublishedResultAssetDownloadUrl(assetId = '') {
  const normalized = trimString(assetId);
  if (!normalized) return '';
  return `/api/assets/${encodeURIComponent(normalized)}/download`;
}

export async function collectAssistantLocalMarkdownImageRewrites(manifest, events = [], publishedAssets = []) {
  const publishedAssetsByLocalPath = new Map();
  for (const asset of publishedAssets || []) {
    const assetId = trimString(asset?.assetId || asset?.id);
    const localPath = trimString(asset?.localPath);
    if (!assetId || !localPath) continue;
    const originalName = sanitizeOriginalAttachmentName(asset?.originalName || basename(localPath));
    const mimeType = resolveAttachmentMimeType(asset?.mimeType, originalName || basename(localPath));
    if (!mimeType.startsWith('image/')) continue;
    publishedAssetsByLocalPath.set(resolve(localPath), {
      assetId,
      url: buildPublishedResultAssetDownloadUrl(assetId),
    });
  }

  if (publishedAssetsByLocalPath.size === 0) {
    return [];
  }

  const searchRoots = collectDiscoveredResultFileSearchRoots(manifest, events);
  const rewrites = [];
  const seen = new Set();

  for (const event of events || []) {
    if (event?.type !== 'message' || event.role !== 'assistant') continue;
    if (!Number.isInteger(event.seq) || event.seq < 1) continue;
    for (const reference of extractAssistantLocalMarkdownImageReferences(event.content || '')) {
      const localPath = await resolveExistingResultFilePath(reference.candidate, searchRoots);
      if (!localPath) continue;
      const published = publishedAssetsByLocalPath.get(resolve(localPath));
      if (!published?.url) continue;
      const key = `${event.seq}:${reference.candidate}:${published.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rewrites.push({
        seq: event.seq,
        candidate: reference.candidate,
        assetId: published.assetId,
        url: published.url,
      });
    }
  }

  return rewrites;
}

// ── Published result asset helpers ───────────────────────────────────

export function rewriteAssistantLocalMarkdownImageTargets(text = '', assetUrlsByCandidate = null) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return source;

  const candidateMap = assetUrlsByCandidate instanceof Map
    ? assetUrlsByCandidate
    : new Map(
      (Array.isArray(assetUrlsByCandidate) ? assetUrlsByCandidate : [])
        .map((entry) => ([
          normalizeResultFilePathCandidate(entry?.candidate || ''),
          trimString(entry?.url),
        ]))
        .filter(([candidate, url]) => candidate && url),
    );

  if (candidateMap.size === 0) return source;

  let rewritten = false;
  let result = '';
  let cursor = 0;
  ASSISTANT_LOCAL_MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match;

  while ((match = ASSISTANT_LOCAL_MARKDOWN_IMAGE_RE.exec(source)) !== null) {
    const candidate = normalizeResultFilePathCandidate(match[2] || '');
    const nextUrl = candidateMap.get(candidate);
    if (!nextUrl) continue;
    const altText = match[1] || '';
    result += source.slice(cursor, match.index);
    result += `![${altText}](${nextUrl})`;
    cursor = match.index + match[0].length;
    rewritten = true;
  }

  if (!rewritten) return source;
  return result + source.slice(cursor);
}

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

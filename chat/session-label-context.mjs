import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { CHAT_SESSIONS_FILE, MEMORY_DIR } from '../lib/config.mjs';
import { getContextHead } from './history.mjs';
import { readJson } from './fs-utils.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import {
  DEFAULT_SESSION_NAME,
  normalizeSessionDescription,
  normalizeSessionGroup,
  normalizeSessionName,
} from './session-naming.mjs';

const PROJECTS_MD = join(MEMORY_DIR, 'projects.md');
const MAX_CONTEXT_SUMMARY_CHARS = 900;
const MAX_SCOPE_ROUTER_CHARS = 1400;
const MAX_SCOPE_ROUTER_ENTRIES = 6;
const MAX_SCOPE_ROUTER_TRIGGERS = 5;
const MAX_EXECUTION_SCOPE_ROUTER_CHARS = 1600;
const MAX_EXECUTION_SCOPE_ROUTER_ENTRIES = 3;
const MAX_SESSION_CATALOG_CHARS = 1600;
const MAX_SESSION_CATALOG_ENTRIES = 12;
const MAX_LINE_CHARS = 220;
const MAX_EXECUTION_LINE_CHARS = 280;
const MAX_RELATED_SESSION_IMPORT_CHARS = 2200;
const MAX_RELATED_SESSION_IMPORTS = 2;
const MAX_RELATED_SESSION_CANDIDATES = 6;
const MAX_RELATED_SESSION_REASONS = 3;
const MAX_RELATED_SESSION_TERMS = 8;
const MAX_RELATED_SESSION_LIST_ITEMS = 2;
const MAX_RELATED_SESSION_LINE_CHARS = 360;
const GENERIC_SEARCH_TERMS = new Set([
  'about',
  'current',
  'email',
  'follow-up',
  'followup',
  'from',
  'inbound',
  'mail',
  'message',
  'new',
  'reply',
  'subject',
  'thread',
  'user',
]);

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clipText(value, maxChars) {
  const text = normalizeInlineText(value);
  if (!text || !Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractInlineCodeTokens(value) {
  const tokens = [];
  String(value || '').replace(/`([^`]+)`/g, (_, token) => {
    const normalized = normalizeInlineText(token);
    if (normalized) tokens.push(normalized);
    return '';
  });
  return tokens;
}

function stripMarkdownNoise(value) {
  return normalizeInlineText(String(value || '').replace(/`([^`]+)`/g, '$1'));
}

function splitTriggerTerms(value) {
  return stripMarkdownNoise(value)
    .split(/[,，、;；]/)
    .map((term) => normalizeInlineText(term))
    .filter(Boolean);
}

function uniqueTerms(values, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0
    ? options.max
    : 24;
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeInlineText(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= max) break;
  }
  return result;
}

function splitSearchTerms(value, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0
    ? options.max
    : 24;
  const normalized = stripMarkdownNoise(value);
  if (!normalized) return [];

  const parts = [];
  if (normalized.length <= 64) {
    parts.push(normalized);
  }
  for (const term of normalized.split(/[\s,，、;；|/()（）[\]{}<>"'“”‘’]+/)) {
    const next = normalizeInlineText(term);
    if (!next || next.length < 2) continue;
    parts.push(next);
    if (parts.length >= max) break;
  }
  return uniqueTerms(parts, { max });
}

function collectObjectTextValues(value, result = [], maxItems = 12) {
  if (!value || result.length >= maxItems) return result;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const normalized = normalizeInlineText(value);
    if (normalized) result.push(normalized);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectTextValues(item, result, maxItems);
      if (result.length >= maxItems) break;
    }
    return result;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectObjectTextValues(item, result, maxItems);
      if (result.length >= maxItems) break;
    }
  }
  return result;
}

function extractPrefixedLineValue(text, label) {
  const match = String(text || '').match(new RegExp(`^\\s*-?\\s*${label}:\\s*(.+)$`, 'im'));
  return normalizeInlineText(match?.[1] || '');
}

function expandHomePath(path) {
  const normalized = normalizeInlineText(path);
  if (!normalized.startsWith('~/')) return normalized;
  return join(homedir(), normalized.slice(2));
}

function parseScopeRouterEntries(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let current = null;

  const pushCurrent = () => {
    if (!current?.title) return;
    sections.push(current);
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      pushCurrent();
      current = {
        title: normalizeInlineText(headingMatch[1]),
        bullets: [],
      };
      continue;
    }

    if (!current) continue;
    const bulletMatch = line.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      current.bullets.push(normalizeInlineText(bulletMatch[1]));
    }
  }
  pushCurrent();

  return sections
    .map((section) => {
      const findField = (pattern) => {
        const match = section.bullets.find((bullet) => pattern.test(bullet));
        if (!match) return '';
        return normalizeInlineText(match.replace(pattern, ''));
      };

      const type = findField(/^Type:\s*/i);
      const path = findField(/^Paths?:\s*/i);
      const triggers = splitTriggerTerms(findField(/^Triggers:\s*/i));
      const firstRead = findField(/^First read:\s*/i);
      const thenInspect = findField(/^Then inspect:\s*/i);
      const defaultAction = findField(/^Default action:\s*/i);
      const paths = extractInlineCodeTokens(path);

      return {
        title: section.title,
        type,
        path,
        paths,
        triggers,
        firstRead,
        thenInspect,
        defaultAction,
      };
    })
    .filter((entry) => entry.title && (entry.type || entry.path || entry.triggers.length > 0));
}

function selectScopeRouterEntries(entries, context = {}, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : MAX_SCOPE_ROUTER_ENTRIES;
  const allowFallback = options.allowFallback !== false;
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const scored = entries
    .map((entry, index) => ({
      entry,
      index,
      score: scoreScopeRouterEntry(entry, context),
    }))
    .sort((a, b) => (
      (b.score - a.score)
      || (a.index - b.index)
    ));

  const positive = scored.filter((entry) => entry.score > 0);
  const selected = positive.length > 0
    ? positive.slice(0, limit)
    : (allowFallback ? scored.slice(0, limit) : []);

  return selected.map(({ entry }) => entry);
}

function scoreScopeRouterEntry(entry, context = {}) {
  if (!entry) return 0;

  let score = 0;
  const haystack = normalizeInlineText([
    context.folder,
    context.name,
    context.group,
    context.description,
    context.turnText,
    context.contextSummary,
  ].filter(Boolean).join(' ')).toLowerCase();

  if (!haystack) return 0;

  const title = entry.title.toLowerCase();
  if (title && haystack.includes(title)) {
    score += 4;
  }

  let triggerHits = 0;
  for (const trigger of entry.triggers) {
    const normalized = trigger.toLowerCase();
    if (!normalized || normalized.length < 2) continue;
    if (haystack.includes(normalized)) {
      triggerHits += 1;
      if (triggerHits >= MAX_SCOPE_ROUTER_TRIGGERS) break;
    }
  }
  score += triggerHits * 2;

  const folder = normalizeInlineText(context.folder);
  if (folder) {
    for (const rawPath of entry.paths) {
      const expanded = expandHomePath(rawPath);
      if (expanded && folder.startsWith(expanded)) {
        score += 8;
        break;
      }
    }
  }

  return score;
}

function buildScopeRouterPromptContext(markdown, context = {}) {
  const entries = parseScopeRouterEntries(markdown);
  if (entries.length === 0) return '';

  const selected = selectScopeRouterEntries(entries, context, {
    limit: MAX_SCOPE_ROUTER_ENTRIES,
    allowFallback: true,
  });
  const lines = [];

  for (const entry of selected) {
    const parts = [entry.title];
    if (entry.type) parts.push(entry.type);
    if (entry.path) parts.push(clipText(entry.path, 72));
    if (entry.triggers.length > 0) {
      parts.push(`triggers: ${clipText(entry.triggers.slice(0, MAX_SCOPE_ROUTER_TRIGGERS).join(', '), 96)}`);
    }
    const line = clipText(`- ${parts.join(' — ')}`, MAX_LINE_CHARS);
    if (!line) continue;
    const nextText = lines.length === 0 ? line : `${lines.join('\n')}\n${line}`;
    if (nextText.length > MAX_SCOPE_ROUTER_CHARS) break;
    lines.push(line);
  }

  return lines.join('\n');
}

function selectExecutionScopeRouterEntries(markdown, context = {}) {
  const entries = parseScopeRouterEntries(markdown);
  if (entries.length === 0) return [];
  return selectScopeRouterEntries(entries, context, {
    limit: MAX_EXECUTION_SCOPE_ROUTER_ENTRIES,
    allowFallback: false,
  });
}

function buildExecutionScopeRouterPromptContextFromEntries(selected) {
  if (selected.length === 0) return '';

  const lines = [
    'Likely scope-router matches for this turn (backend-selected from projects.md):',
    'Treat these as high-priority cached context candidates. If one matches, inspect its referenced memory/files before broad filesystem search or machine-wide discovery.',
  ];

  for (const entry of selected) {
    const normalizedPath = stripMarkdownNoise(entry.path);
    const normalizedFirstRead = stripMarkdownNoise(entry.firstRead);
    const normalizedThenInspect = stripMarkdownNoise(entry.thenInspect);
    const parts = [entry.title];
    if (entry.type) parts.push(entry.type);
    if (entry.triggers.length > 0) {
      parts.push(`triggers: ${clipText(entry.triggers.slice(0, MAX_SCOPE_ROUTER_TRIGGERS).join(', '), 96)}`);
    }
    if (normalizedPath && normalizedPath !== normalizedFirstRead && normalizedPath !== normalizedThenInspect) {
      parts.push(`paths: ${clipText(normalizedPath, 112)}`);
    }
    if (normalizedFirstRead) {
      parts.push(`first read: ${clipText(normalizedFirstRead, 112)}`);
    }
    if (normalizedThenInspect) {
      parts.push(`then inspect: ${clipText(normalizedThenInspect, 112)}`);
    }
    if (entry.defaultAction) {
      parts.push(`default action: ${clipText(stripMarkdownNoise(entry.defaultAction), 144)}`);
    }
    const line = clipText(`- ${parts.join(' — ')}`, MAX_EXECUTION_LINE_CHARS);
    if (!line) continue;
    const nextText = `${lines.join('\n')}\n${line}`;
    if (nextText.length > MAX_EXECUTION_SCOPE_ROUTER_CHARS) break;
    lines.push(line);
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

function buildExecutionScopeRouterPromptContext(markdown, context = {}) {
  return buildExecutionScopeRouterPromptContextFromEntries(
    selectExecutionScopeRouterEntries(markdown, context),
  );
}

function isUsefulSearchTerm(value) {
  const normalized = normalizeInlineText(value).toLowerCase();
  if (!normalized || normalized.length < 2) return false;
  if (GENERIC_SEARCH_TERMS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  return true;
}

function buildTaskCardSearchParts(taskCard) {
  const normalized = normalizeSessionTaskCard(taskCard);
  if (!normalized) return [];
  return [
    normalized.summary,
    normalized.goal,
    ...normalized.background,
    ...normalized.rawMaterials,
    ...normalized.assumptions,
    ...normalized.knownConclusions,
    ...normalized.reusablePatterns,
    ...normalized.nextSteps,
    ...normalized.memory,
    ...normalized.needsFromUser,
  ].filter(Boolean);
}

function buildRelatedSessionHaystack(meta, contextHead = null) {
  const parts = [
    meta?.group,
    meta?.name,
    meta?.description,
    meta?.sourceId,
    meta?.sourceName,
    meta?.externalTriggerId,
    contextHead?.summary || '',
    ...collectObjectTextValues(meta?.sourceContext, []),
    ...buildTaskCardSearchParts(meta?.taskCard),
  ].filter(Boolean);
  return normalizeInlineText(parts.join(' ')).toLowerCase();
}

function addMatchReason(reasons, value) {
  const normalized = normalizeInlineText(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (reasons.some((entry) => entry.toLowerCase() === key)) return;
  reasons.push(normalized);
}

function buildExecutionRoutingTerms(sessionMeta, turnText) {
  const parts = [
    ...splitSearchTerms(extractPrefixedLineValue(turnText, 'From')),
    ...splitSearchTerms(extractPrefixedLineValue(turnText, 'Subject')),
    ...splitSearchTerms(sessionMeta?.description),
    ...splitSearchTerms(sessionMeta?.name),
    ...collectObjectTextValues(sessionMeta?.sourceContext, []).flatMap((value) => splitSearchTerms(value, { max: 4 })),
  ].filter(isUsefulSearchTerm);
  return uniqueTerms(parts, { max: MAX_RELATED_SESSION_TERMS });
}

function scoreScopeRouterRelatedSessionCandidate(
  meta,
  currentSessionMeta,
  selectedEntries,
  routingTerms,
  contextHead = null,
) {
  const haystack = buildRelatedSessionHaystack(meta, contextHead);
  if (!haystack) return { score: 0, reasons: [] };

  let score = 0;
  let textMatches = 0;
  const reasons = [];

  const currentTriggerId = normalizeInlineText(currentSessionMeta?.externalTriggerId).toLowerCase();
  const candidateTriggerId = normalizeInlineText(meta?.externalTriggerId).toLowerCase();
  if (currentTriggerId && candidateTriggerId && currentTriggerId === candidateTriggerId) {
    score += 10;
    textMatches += 1;
    addMatchReason(reasons, 'same thread');
  }

  for (const entry of selectedEntries) {
    const title = normalizeInlineText(entry?.title).toLowerCase();
    if (title && haystack.includes(title)) {
      score += 6;
      textMatches += 1;
      addMatchReason(reasons, entry.title);
    }
    let triggerHits = 0;
    for (const trigger of entry?.triggers || []) {
      const normalized = normalizeInlineText(trigger).toLowerCase();
      if (!normalized || normalized.length < 2) continue;
      if (!haystack.includes(normalized)) continue;
      score += 3;
      textMatches += 1;
      triggerHits += 1;
      addMatchReason(reasons, trigger);
      if (triggerHits >= MAX_SCOPE_ROUTER_TRIGGERS) break;
    }
  }

  let routingHits = 0;
  for (const term of routingTerms) {
    const normalized = normalizeInlineText(term).toLowerCase();
    if (!normalized || normalized.length < 2) continue;
    if (!haystack.includes(normalized)) continue;
    score += 1;
    textMatches += 1;
    routingHits += 1;
    addMatchReason(reasons, term);
    if (routingHits >= MAX_RELATED_SESSION_TERMS) break;
  }

  if (textMatches === 0) {
    return { score: 0, reasons: [] };
  }

  const currentSource = normalizeInlineText(currentSessionMeta?.sourceId).toLowerCase();
  const candidateSource = normalizeInlineText(meta?.sourceId).toLowerCase();
  if (currentSource && candidateSource && currentSource === candidateSource) {
    score += 3;
  }

  const currentGroup = normalizeInlineText(currentSessionMeta?.group).toLowerCase();
  const candidateGroup = normalizeInlineText(meta?.group).toLowerCase();
  if (currentGroup && candidateGroup && currentGroup === candidateGroup) {
    score += 2;
  }

  if (clipText(contextHead?.summary || '', MAX_CONTEXT_SUMMARY_CHARS)) {
    score += 4;
  }
  if (normalizeSessionTaskCard(meta?.taskCard)) {
    score += 2;
  }

  return {
    score,
    reasons: reasons.slice(0, MAX_RELATED_SESSION_REASONS),
  };
}

function hasRelatedSessionMemory(meta, contextHead = null) {
  if (clipText(contextHead?.summary || '', MAX_CONTEXT_SUMMARY_CHARS)) return true;
  return !!normalizeSessionTaskCard(meta?.taskCard);
}

function formatRecencyDay(value) {
  const time = Date.parse(String(value || '').trim());
  if (!Number.isFinite(time)) return '';
  return new Date(time).toISOString().slice(0, 10);
}

function buildRelatedSessionPromptContext(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '';

  const lines = [
    'Recent related session imports for this turn (backend-selected cross-session packet):',
    'Treat these as bounded carry-forward memory. Reuse them before broad search, but verify against the current sender, body, and attachments.',
  ];

  for (const match of matches) {
    const taskCard = normalizeSessionTaskCard(match?.meta?.taskCard);
    const label = match?.meta?.group
      ? `[${match.meta.group}] ${match.meta.name || '(unnamed)'}`
      : (match?.meta?.name || '(unnamed)');
    const updatedDay = formatRecencyDay(match?.meta?.updatedAt || match?.meta?.created);
    const contextSummary = clipText(match?.contextHead?.summary || '', 180);
    const taskCardSummary = clipText(taskCard?.summary || '', 140);
    const durableMemory = clipText(
      (taskCard?.memory || []).slice(0, MAX_RELATED_SESSION_LIST_ITEMS).join('; '),
      120,
    );
    const reusablePatterns = clipText(
      (taskCard?.reusablePatterns || []).slice(0, MAX_RELATED_SESSION_LIST_ITEMS).join('; '),
      120,
    );
    const knownConclusions = clipText(
      (taskCard?.knownConclusions || []).slice(0, MAX_RELATED_SESSION_LIST_ITEMS).join('; '),
      120,
    );
    const nextSteps = clipText(
      (taskCard?.nextSteps || []).slice(0, MAX_RELATED_SESSION_LIST_ITEMS).join('; '),
      120,
    );

    const parts = [label];
    if (updatedDay) parts.push(`updated ${updatedDay}`);
    if (Array.isArray(match?.reasons) && match.reasons.length > 0) {
      parts.push(`matched via: ${clipText(match.reasons.join(', '), 80)}`);
    }
    if (contextSummary) {
      parts.push(`summary: ${contextSummary}`);
    }
    if (taskCardSummary && taskCardSummary !== contextSummary) {
      parts.push(`task card: ${taskCardSummary}`);
    }
    if (reusablePatterns) {
      parts.push(`reusable patterns: ${reusablePatterns}`);
    }
    if (durableMemory) {
      parts.push(`durable memory: ${durableMemory}`);
    }
    const executionCue = knownConclusions
      ? `known conclusions: ${knownConclusions}`
      : (nextSteps ? `next steps: ${nextSteps}` : '');
    if (executionCue) {
      parts.push(executionCue);
    }

    const line = clipText(`- ${parts.join(' — ')}`, MAX_RELATED_SESSION_LINE_CHARS);
    if (!line) continue;
    const nextText = `${lines.join('\n')}\n${line}`;
    if (nextText.length > MAX_RELATED_SESSION_IMPORT_CHARS) break;
    lines.push(line);
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

async function loadExecutionRelatedSessionPromptContext(sessionMeta, turnText, selectedEntries) {
  if (!sessionMeta?.id || !Array.isArray(selectedEntries) || selectedEntries.length === 0) {
    return '';
  }

  const sessions = await loadSessionsMeta();
  const routingTerms = buildExecutionRoutingTerms(sessionMeta, turnText);
  const candidates = sessions
    .filter((meta) => meta && meta.id !== sessionMeta.id && meta.archived !== true && !meta.internalRole)
    .map((meta) => {
      const scored = scoreScopeRouterRelatedSessionCandidate(meta, sessionMeta, selectedEntries, routingTerms);
      return {
        meta,
        score: scored.score,
        reasons: scored.reasons,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (
      (b.score - a.score)
      || sortSessionsByRecency(a.meta, b.meta)
    ))
    .slice(0, MAX_RELATED_SESSION_CANDIDATES);

  if (candidates.length === 0) return '';

  const enriched = await Promise.all(candidates.map(async (entry) => {
    const contextHead = await getContextHead(entry.meta.id);
    const rescored = scoreScopeRouterRelatedSessionCandidate(
      entry.meta,
      sessionMeta,
      selectedEntries,
      routingTerms,
      contextHead,
    );
    return {
      meta: entry.meta,
      contextHead,
      score: rescored.score,
      reasons: rescored.reasons,
    };
  }));

  const matches = enriched
    .filter((entry) => entry.score > 0)
    .filter((entry) => hasRelatedSessionMemory(entry.meta, entry.contextHead))
    .sort((a, b) => (
      (b.score - a.score)
      || sortSessionsByRecency(a.meta, b.meta)
    ))
    .slice(0, MAX_RELATED_SESSION_IMPORTS);

  return buildRelatedSessionPromptContext(matches);
}

function sortSessionsByRecency(a, b) {
  const aTime = Date.parse(a.updatedAt || a.created || '') || 0;
  const bTime = Date.parse(b.updatedAt || b.created || '') || 0;
  return bTime - aTime;
}

function buildActiveSessionCatalogPrompt(sessions, currentSessionId) {
  if (!Array.isArray(sessions)) return '';

  const relevant = sessions
    .filter((session) => session && session.id !== currentSessionId && session.archived !== true)
    .map((session) => ({
      id: session.id,
      group: normalizeSessionGroup(session.group || ''),
      name: normalizeSessionName(session.name || ''),
      description: normalizeSessionDescription(session.description || ''),
      updatedAt: session.updatedAt || session.created || '',
      created: session.created || '',
    }))
    .filter((session) => (
      session.group
      || session.description
      || (session.name && session.name !== DEFAULT_SESSION_NAME)
    ))
    .sort((a, b) => {
      const groupDelta = Number(Boolean(b.group)) - Number(Boolean(a.group));
      return groupDelta || sortSessionsByRecency(a, b);
    });

  if (relevant.length === 0) return '';

  const groupCounts = new Map();
  for (const session of relevant) {
    if (!session.group) continue;
    groupCounts.set(session.group, (groupCounts.get(session.group) || 0) + 1);
  }

  const lines = [];
  if (groupCounts.size > 0) {
    const summary = [...groupCounts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([group, count]) => `${group} (${count})`)
      .join(', ');
    if (summary) {
      lines.push(`Known active groups: ${summary}`);
    }
  }

  for (const session of relevant.slice(0, MAX_SESSION_CATALOG_ENTRIES)) {
    const groupLabel = session.group || 'Ungrouped';
    const title = session.name || '(unnamed)';
    const description = session.description ? ` — ${session.description}` : '';
    const line = clipText(`- [${groupLabel}] ${title}${description}`, MAX_LINE_CHARS);
    if (!line) continue;
    const nextText = lines.length === 0 ? line : `${lines.join('\n')}\n${line}`;
    if (nextText.length > MAX_SESSION_CATALOG_CHARS) break;
    lines.push(line);
  }

  return lines.join('\n');
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function loadSessionLabelPromptContext(sessionMeta, turnText) {
  const sessionId = sessionMeta?.id || '';
  const [contextHead, sessions, projectsMarkdown] = await Promise.all([
    sessionId ? getContextHead(sessionId) : null,
    readJson(CHAT_SESSIONS_FILE, []),
    readOptionalText(PROJECTS_MD),
  ]);

  const contextSummary = clipText(contextHead?.summary || '', MAX_CONTEXT_SUMMARY_CHARS);
  const scopeRouter = buildScopeRouterPromptContext(projectsMarkdown, {
    folder: sessionMeta?.folder || '',
    name: sessionMeta?.name || '',
    group: sessionMeta?.group || '',
    description: sessionMeta?.description || '',
    turnText,
    contextSummary,
  });
  const existingSessions = buildActiveSessionCatalogPrompt(sessions, sessionId);

  return {
    contextSummary,
    scopeRouter,
    existingSessions,
  };
}

export async function loadExecutionMemoryPromptContext(sessionMeta, turnText) {
  const projectsMarkdown = await readOptionalText(PROJECTS_MD);
  const selected = selectExecutionScopeRouterEntries(projectsMarkdown, {
    folder: sessionMeta?.folder || '',
    name: sessionMeta?.name || '',
    group: sessionMeta?.group || '',
    description: sessionMeta?.description || '',
    turnText,
  });

  if (selected.length === 0) {
    return {
      scopeRouter: '',
      relatedSessions: '',
    };
  }

  const scopeRouter = buildExecutionScopeRouterPromptContextFromEntries(selected);
  const relatedSessions = await loadExecutionRelatedSessionPromptContext(sessionMeta, turnText, selected);
  return {
    scopeRouter,
    relatedSessions,
  };
}

export async function loadExecutionScopeRouterPromptContext(sessionMeta, turnText) {
  const promptContext = await loadExecutionMemoryPromptContext(sessionMeta, turnText);
  return promptContext.scopeRouter;
}

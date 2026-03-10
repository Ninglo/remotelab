import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { CHAT_SESSIONS_FILE, MEMORY_DIR } from '../lib/config.mjs';
import { getContextHead } from './history.mjs';
import { readJson } from './fs-utils.mjs';
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
const MAX_SESSION_CATALOG_CHARS = 1600;
const MAX_SESSION_CATALOG_ENTRIES = 12;
const MAX_LINE_CHARS = 220;

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
    .split(/[,，]/)
    .map((term) => normalizeInlineText(term))
    .filter(Boolean);
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
      const paths = extractInlineCodeTokens(path);

      return {
        title: section.title,
        type,
        path,
        paths,
        triggers,
      };
    })
    .filter((entry) => entry.title && (entry.type || entry.path || entry.triggers.length > 0));
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
  const selected = (positive.length > 0 ? positive : scored).slice(0, MAX_SCOPE_ROUTER_ENTRIES);
  const lines = [];

  for (const { entry } of selected) {
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

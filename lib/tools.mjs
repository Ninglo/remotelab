import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import {
  SHARED_TOOLS_DIR,
  TOOLS_ENABLED_FILE,
  TOOL_OVERLAYS_DIR,
  TOOLS_FILE,
} from './config.mjs';
import {
  fullPath,
  resolveExecutableCommandPath,
  resolveExecutableCommandPathAsync,
} from './user-shell-env.mjs';

console.log('[tools] Resolved PATH dirs:', fullPath.split(':').join('\n  '));

let customToolsCache = null;
let customToolsCacheMtimeMs = null;
let sharedToolsCache = null;
let sharedToolsCacheSignature = null;
let availableToolsCache = null;
const commandResolutionCache = new Map();

const BUILTIN_TOOLS = [
  { id: 'codex', name: 'CodeX', command: 'codex', runtimeFamily: 'codex-json' },
  { id: 'claude', name: 'Claude Code', command: 'claude', runtimeFamily: 'claude-stream-json' },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot' },
  { id: 'cline', name: 'Cline', command: 'cline' },
  { id: 'kilo-code', name: 'Kilo Code', command: 'kilo-code' },
];

const SIMPLE_RUNTIME_FAMILIES = new Set(['claude-stream-json', 'codex-json']);
const DEFAULT_CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_MICRO_AGENT_REASONING_LEVEL = 'medium';

function normalizeToolProfile(value) {
  const normalized = String(value || '').trim();
  return normalized === 'micro-agent' ? normalized : '';
}

function normalizeToolVisibility(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'private' ? 'private' : '';
}

function isFullContextMicroAgentRecord(tool, normalized = {}) {
  if (normalized.runtimeFamily !== 'codex-json') return false;
  if (normalized.command !== 'codex') return false;

  const toolProfile = normalizeToolProfile(tool?.toolProfile);
  if (toolProfile === 'micro-agent') return true;

  if (normalized.id === 'micro-agent') return true;

  const normalizedName = String(tool?.name || '').trim().toLowerCase();
  return normalizedName === 'micro agent';
}

function isCommandAvailable(command) {
  return !!resolveToolCommandPath(command);
}

function resolveToolCommandPath(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  if (commandResolutionCache.has(trimmed)) {
    return commandResolutionCache.get(trimmed);
  }

  const resolved = resolveExecutableCommandPath(trimmed);

  commandResolutionCache.set(trimmed, resolved);
  return resolved;
}

export async function resolveToolCommandPathAsync(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  if (commandResolutionCache.has(trimmed)) {
    return commandResolutionCache.get(trimmed);
  }

  const resolved = await resolveExecutableCommandPathAsync(trimmed);

  commandResolutionCache.set(trimmed, resolved);
  return resolved;
}

function loadCustomTools() {
  if (!existsSync(TOOLS_FILE)) {
    customToolsCache = [];
    customToolsCacheMtimeMs = null;
    return customToolsCache;
  }

  let mtimeMs = null;
  try {
    mtimeMs = statSync(TOOLS_FILE).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  if (customToolsCache && customToolsCacheMtimeMs === mtimeMs) {
    return customToolsCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.error('Failed to load tools.json: expected an array');
      customToolsCache = [];
      customToolsCacheMtimeMs = mtimeMs;
      availableToolsCache = null;
      return customToolsCache;
    }
    customToolsCache = parsed;
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  } catch (err) {
    console.error('Failed to load tools.json:', err.message);
    customToolsCache = [];
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  }
}

async function loadCustomToolsAsync() {
  const stats = await (async () => {
    try {
      return await stat(TOOLS_FILE);
    } catch {
      return null;
    }
  })();
  if (!stats) {
    customToolsCache = [];
    customToolsCacheMtimeMs = null;
    return customToolsCache;
  }

  const mtimeMs = stats.mtimeMs;
  if (customToolsCache && customToolsCacheMtimeMs === mtimeMs) {
    return customToolsCache;
  }
  try {
    const parsed = JSON.parse(await readFile(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.error('Failed to load tools.json: expected an array');
      customToolsCache = [];
      customToolsCacheMtimeMs = mtimeMs;
      availableToolsCache = null;
      return customToolsCache;
    }
    customToolsCache = parsed;
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  } catch (err) {
    console.error('Failed to load tools.json:', err.message);
    customToolsCache = [];
    customToolsCacheMtimeMs = mtimeMs;
    availableToolsCache = null;
    return customToolsCache;
  }
}

function safeStatMtimeSync(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function cleanMarkdownListToken(value) {
  return String(value || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function parseEnabledSharedToolIds(text) {
  const ids = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const candidate = line.match(/^[-*+]\s+(.+)$/)?.[1] || line;
    const cleaned = cleanMarkdownListToken(candidate);
    if (!cleaned) continue;
    if (cleaned === '*' || cleaned.toLowerCase() === 'all') return null;
    if (/^[a-zA-Z0-9-]+$/.test(cleaned)) {
      ids.add(cleaned);
    }
  }
  return ids.size > 0 ? ids : null;
}

function parseToolCardFrontmatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { fields: {}, body: source };
  }

  const lines = source.split(/\r?\n/);
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) {
    return { fields: {}, body: source };
  }

  const fields = {};
  for (const rawLine of lines.slice(1, endIndex)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') {
      fields[key] = true;
      continue;
    }
    if (value === 'false') {
      fields[key] = false;
      continue;
    }
    fields[key] = value;
  }

  return {
    fields,
    body: lines.slice(endIndex + 1).join('\n'),
  };
}

function inferToolCardName(body, fallback) {
  const heading = String(body || '').match(/^#\s+(.+)$/m)?.[1];
  return String(heading || fallback || '').trim();
}

function inferRuntimeFamilyFromCommand(command) {
  const name = basename(String(command || '').trim()).toLowerCase();
  if (name === 'codex') return 'codex-json';
  if (name === 'claude') return 'claude-stream-json';
  return '';
}

function resolveSharedToolCommand(command, toolDir) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return resolve(toolDir, trimmed);
  }
  return trimmed;
}

function findSharedToolOverlayPath(id) {
  for (const extension of ['yaml', 'yml', 'json', 'md']) {
    const candidate = join(TOOL_OVERLAYS_DIR, `${id}.${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildSharedToolsSignature() {
  const parts = [`enabled:${safeStatMtimeSync(TOOLS_ENABLED_FILE) ?? 'none'}`];
  if (!existsSync(SHARED_TOOLS_DIR)) {
    return parts.join('|');
  }

  const entries = [];
  try {
    for (const entry of readdirSync(SHARED_TOOLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardPath = join(SHARED_TOOLS_DIR, entry.name, 'TOOL.md');
      if (!existsSync(cardPath)) continue;
      entries.push(`${entry.name}:${safeStatMtimeSync(cardPath) ?? 'none'}`);
    }
  } catch (err) {
    console.error(`[tools] Failed to scan shared tools: ${err.message}`);
  }

  entries.sort();
  return `${parts.join('|')}|${entries.join('|')}`;
}

function attachInternalToolMeta(tool, meta) {
  Object.defineProperty(tool, '_meta', {
    value: Object.freeze({ ...(tool._meta || {}), ...meta }),
    enumerable: false,
    configurable: true,
  });
  return tool;
}

function loadSharedTools() {
  const signature = buildSharedToolsSignature();
  if (sharedToolsCache && sharedToolsCacheSignature === signature) {
    return sharedToolsCache;
  }

  let enabledIds = null;
  if (existsSync(TOOLS_ENABLED_FILE)) {
    try {
      enabledIds = parseEnabledSharedToolIds(readFileSync(TOOLS_ENABLED_FILE, 'utf8'));
    } catch (err) {
      console.error(`[tools] Failed to read tools-enabled.md: ${err.message}`);
    }
  }

  const sharedTools = [];
  if (existsSync(SHARED_TOOLS_DIR)) {
    try {
      for (const entry of readdirSync(SHARED_TOOLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const toolDir = join(SHARED_TOOLS_DIR, entry.name);
        const cardPath = join(toolDir, 'TOOL.md');
        if (!existsSync(cardPath)) continue;

        try {
          const card = parseToolCardFrontmatter(readFileSync(cardPath, 'utf8'));
          const rawId = String(card.fields.id || entry.name).trim() || entry.name;
          const id = /^[a-zA-Z0-9-]+$/.test(rawId)
            ? rawId
            : slugifyToolId(rawId || entry.name);
          if (enabledIds && !enabledIds.has(id)) continue;

          const command = resolveSharedToolCommand(card.fields.command, toolDir);
          if (!command) {
            throw new Error('Shared tool is missing a command in TOOL.md frontmatter');
          }

          const runtimeFamily = normalizeRuntimeFamily(card.fields.runtimeFamily)
            || inferRuntimeFamilyFromCommand(command);
          if (!runtimeFamily) {
            throw new Error('Shared tool must declare runtimeFamily unless the command is codex or claude');
          }

          const normalized = normalizeSimpleToolRecord({
            id,
            name: String(card.fields.name || inferToolCardName(card.body, id) || id).trim() || id,
            command,
            runtimeFamily,
            visibility: card.fields.visibility,
            toolProfile: card.fields.toolProfile,
            promptMode: card.fields.promptMode,
            flattenPrompt: card.fields.flattenPrompt === true,
          });
          if (!normalized) continue;

          sharedTools.push(attachInternalToolMeta(normalized, {
            sourceKind: 'shared',
            toolDir,
            cardPath,
            overlayPath: findSharedToolOverlayPath(id),
          }));
        } catch (err) {
          console.error(`[tools] Skipping shared tool "${entry.name}": ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[tools] Failed to load shared tools: ${err.message}`);
    }
  }

  sharedToolsCache = sharedTools;
  sharedToolsCacheSignature = signature;
  availableToolsCache = null;
  commandResolutionCache.clear();
  return sharedToolsCache;
}

function getToolSourceKind(tool) {
  const sharedSource = String(tool?._meta?.sourceKind || '').trim();
  if (sharedSource) return sharedSource;
  return tool?.builtin ? 'builtin' : 'custom';
}

export function buildToolProcessEnvOverrides(tool) {
  if (!tool || typeof tool !== 'object') return {};
  const id = String(tool.id || '').trim();
  if (!id) return {};

  const env = {
    REMOTELAB_TOOL_ID: id,
    REMOTELAB_TOOL_SOURCE: getToolSourceKind(tool),
  };

  const name = String(tool.name || '').trim();
  if (name) {
    env.REMOTELAB_TOOL_NAME = name;
  }

  const toolDir = String(tool?._meta?.toolDir || '').trim();
  if (toolDir) {
    env.REMOTELAB_SHARED_TOOL_DIR = toolDir;
  }

  const cardPath = String(tool?._meta?.cardPath || '').trim();
  if (cardPath) {
    env.REMOTELAB_SHARED_TOOL_CARD = cardPath;
  }

  const overlayPath = String(tool?._meta?.overlayPath || '').trim();
  if (overlayPath) {
    env.REMOTELAB_TOOL_OVERLAY = overlayPath;
  }

  return env;
}

function saveCustomTools(tools) {
  try {
    const dir = dirname(TOOLS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8');
    customToolsCache = tools;
    try {
      customToolsCacheMtimeMs = statSync(TOOLS_FILE).mtimeMs;
    } catch {
      customToolsCacheMtimeMs = null;
    }
    availableToolsCache = null;
    commandResolutionCache.clear();
  } catch (err) {
    console.error('Failed to save tools.json:', err.message);
  }
}

async function saveCustomToolsAsync(tools) {
  try {
    const dir = dirname(TOOLS_FILE);
    await mkdir(dir, { recursive: true });
    await writeFile(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8');
    customToolsCache = tools;
    try {
      customToolsCacheMtimeMs = (await stat(TOOLS_FILE)).mtimeMs;
    } catch {
      customToolsCacheMtimeMs = null;
    }
    availableToolsCache = null;
    commandResolutionCache.clear();
  } catch (err) {
    console.error('Failed to save tools.json:', err.message);
  }
}

function validateToolId(id) {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

function validateCommand(command) {
  // Reject shell metacharacters
  return !/[;|&$`\\(){}<>]/.test(command) && command.trim().length > 0;
}

function slugifyToolId(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'tool';
}

function normalizeRuntimeFamily(runtimeFamily) {
  return SIMPLE_RUNTIME_FAMILIES.has(runtimeFamily) ? runtimeFamily : null;
}

function normalizeSimpleModels(models, reasoning) {
  if (!Array.isArray(models)) return [];

  const seen = new Set();
  const normalized = [];

  for (const entry of models) {
    const modelId = String(entry?.id || entry || '').trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);

    const model = {
      id: modelId,
      label: String(entry?.label || modelId).trim() || modelId,
    };

    const defaultReasoning = String(entry?.defaultReasoning || entry?.defaultEffort || '').trim();
    if (reasoning?.kind === 'enum' && defaultReasoning) {
      model.defaultReasoning = defaultReasoning;
    }

    normalized.push(model);
  }

  return normalized;
}

function normalizeSimpleReasoning(reasoning, runtimeFamily) {
  const fallbackKind = runtimeFamily === 'codex-json' ? 'enum' : 'toggle';
  const allowedKinds = runtimeFamily === 'codex-json'
    ? new Set(['none', 'enum'])
    : new Set(['none', 'toggle']);

  const kind = String(reasoning?.kind || fallbackKind).trim();
  if (!allowedKinds.has(kind)) {
    throw new Error(`Reasoning kind "${kind}" is not supported by ${runtimeFamily}`);
  }

  const label = String(reasoning?.label || 'Thinking').trim() || 'Thinking';

  if (kind === 'enum') {
    const rawLevels = Array.isArray(reasoning?.levels)
      ? reasoning.levels
      : DEFAULT_CODEX_REASONING_LEVELS;
    const levels = [...new Set(rawLevels.map(level => String(level || '').trim()).filter(Boolean))];
    if (levels.length === 0) {
      throw new Error('Reasoning levels are required for enum reasoning');
    }
    const defaultValue = String(reasoning?.default || levels[0]).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }

  if (kind === 'toggle') {
    return { kind, label };
  }

  return { kind, label };
}

function buildMicroAgentReasoningPreset(reasoning) {
  const rawLevels = Array.isArray(reasoning?.levels)
    ? reasoning.levels.map((level) => String(level || '').trim()).filter(Boolean)
    : [];
  const levels = rawLevels.includes(DEFAULT_MICRO_AGENT_REASONING_LEVEL)
    ? [...new Set(rawLevels)]
    : DEFAULT_CODEX_REASONING_LEVELS;
  return {
    kind: 'enum',
    label: String(reasoning?.label || 'Thinking').trim() || 'Thinking',
    levels,
    default: DEFAULT_MICRO_AGENT_REASONING_LEVEL,
  };
}

function buildMicroAgentModelPresets(models) {
  if (!Array.isArray(models)) return models;
  return models.map((model) => {
    if (!model || typeof model !== 'object') return model;
    return {
      ...model,
      defaultReasoning: DEFAULT_MICRO_AGENT_REASONING_LEVEL,
    };
  });
}

function normalizeSimpleToolRecord(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const command = String(tool.command || '').trim();
  if (!command) return null;

  const hasRuntimeFamily = Object.hasOwn(tool, 'runtimeFamily');
  const runtimeFamily = normalizeRuntimeFamily(tool.runtimeFamily);
  if (hasRuntimeFamily && !runtimeFamily) {
    throw new Error(`Unsupported runtimeFamily "${tool.runtimeFamily}"`);
  }

  const configuredId = String(tool.id || '').trim();
  const id = configuredId && validateToolId(configuredId)
    ? configuredId
    : slugifyToolId(command);
  const toolProfile = normalizeToolProfile(tool.toolProfile);
  const visibility = normalizeToolVisibility(tool.visibility);
  const treatAsFullContextMicroAgent = isFullContextMicroAgentRecord(tool, {
    id,
    command,
    runtimeFamily,
  });
  const normalizedReasoningSource = treatAsFullContextMicroAgent && runtimeFamily === 'codex-json'
    ? buildMicroAgentReasoningPreset(tool.reasoning)
    : tool.reasoning;
  const normalizedModelsSource = treatAsFullContextMicroAgent && runtimeFamily === 'codex-json'
    ? buildMicroAgentModelPresets(tool.models)
    : tool.models;
  const reasoning = runtimeFamily
    ? normalizeSimpleReasoning(normalizedReasoningSource, runtimeFamily)
    : undefined;
  const models = runtimeFamily
    ? normalizeSimpleModels(normalizedModelsSource, reasoning)
    : undefined;
  const promptMode = String(tool.promptMode || '').trim();
  const normalizedPromptMode = !treatAsFullContextMicroAgent && promptMode === 'bare-user'
    ? 'bare-user'
    : null;
  const flattenPrompt = !treatAsFullContextMicroAgent && tool.flattenPrompt === true;

  return {
    id,
    name: String(tool.name || command).trim() || command,
    command,
    ...(toolProfile ? { toolProfile } : {}),
    ...(visibility ? { visibility } : {}),
    ...(runtimeFamily ? { runtimeFamily, models, reasoning } : {}),
    ...(normalizedPromptMode ? { promptMode: normalizedPromptMode } : {}),
    ...(flattenPrompt ? { flattenPrompt: true } : {}),
  };
}

export function getAvailableTools() {
  const customTools = loadCustomTools();
  const sharedTools = loadSharedTools();
  if (availableToolsCache) {
    return availableToolsCache;
  }

  const builtins = BUILTIN_TOOLS.map(t => {
    const available = isCommandAvailable(t.command);
    console.log(`[tools] ${t.id} (${t.command}): ${available ? 'available' : 'NOT FOUND'}`);
    return { ...t, builtin: true, available };
  });

  const customs = [];
  for (const tool of customTools) {
    try {
      const normalized = normalizeSimpleToolRecord(tool);
      if (!normalized) continue;
      customs.push({
        ...normalized,
        builtin: false,
        available: isCommandAvailable(normalized.command),
      });
    } catch (err) {
      const label = String(tool?.name || tool?.command || tool?.id || 'unknown tool').trim();
      console.error(`[tools] Skipping custom tool "${label}": ${err.message}`);
    }
  }

  const takenIds = new Set([...builtins, ...customs].map((tool) => tool.id));
  const shared = [];
  for (const tool of sharedTools) {
    if (takenIds.has(tool.id)) {
      console.error(`[tools] Skipping shared tool "${tool.id}": id already exists`);
      continue;
    }
    takenIds.add(tool.id);
    shared.push(attachInternalToolMeta({
      ...tool,
      builtin: false,
      available: isCommandAvailable(tool.command),
    }, tool._meta || {}));
  }

  availableToolsCache = [...builtins, ...customs, ...shared];
  return availableToolsCache;
}

export async function getAvailableToolsAsync() {
  const customTools = await loadCustomToolsAsync();
  const sharedTools = loadSharedTools();
  if (availableToolsCache) {
    return availableToolsCache;
  }

  const builtins = await Promise.all(BUILTIN_TOOLS.map(async (tool) => {
    const available = !!await resolveToolCommandPathAsync(tool.command);
    console.log(`[tools] ${tool.id} (${tool.command}): ${available ? 'available' : 'NOT FOUND'}`);
    return { ...tool, builtin: true, available };
  }));

  const customs = [];
  for (const tool of customTools) {
    try {
      const normalized = normalizeSimpleToolRecord(tool);
      if (!normalized) continue;
      customs.push({
        ...normalized,
        builtin: false,
        available: !!await resolveToolCommandPathAsync(normalized.command),
      });
    } catch (err) {
      const label = String(tool?.name || tool?.command || tool?.id || 'unknown tool').trim();
      console.error(`[tools] Skipping custom tool "${label}": ${err.message}`);
    }
  }

  const takenIds = new Set([...builtins, ...customs].map((tool) => tool.id));
  const shared = [];
  for (const tool of sharedTools) {
    if (takenIds.has(tool.id)) {
      console.error(`[tools] Skipping shared tool "${tool.id}": id already exists`);
      continue;
    }
    takenIds.add(tool.id);
    shared.push(attachInternalToolMeta({
      ...tool,
      builtin: false,
      available: !!await resolveToolCommandPathAsync(tool.command),
    }, tool._meta || {}));
  }

  availableToolsCache = [...builtins, ...customs, ...shared];
  return availableToolsCache;
}

export async function getToolDefinitionAsync(id) {
  const all = await getAvailableToolsAsync();
  return all.find((tool) => tool.id === id) || null;
}

export async function getToolProcessEnvOverridesAsync(id) {
  const tool = await getToolDefinitionAsync(id);
  return buildToolProcessEnvOverrides(tool);
}

export function addTool({ id, name, command }) {
  if (!validateToolId(id)) {
    throw new Error('Invalid tool id: must match /^[a-zA-Z0-9-]+$/');
  }
  if (!validateCommand(command)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }
  if (!name || !name.trim()) {
    throw new Error('Name is required');
  }

  const allTools = getAvailableTools();
  if (allTools.some(t => t.id === id)) {
    throw new Error(`Tool with id "${id}" already exists`);
  }

  const customs = loadCustomTools();
  customs.push({ id, name: name.trim(), command: command.trim() });
  saveCustomTools(customs);
  return { id, name: name.trim(), command: command.trim(), builtin: false, available: isCommandAvailable(command.trim()) };
}

export function removeTool(id) {
  if (BUILTIN_TOOLS.some(t => t.id === id)) {
    throw new Error('Cannot remove a builtin tool');
  }
  const customs = loadCustomTools();
  const index = customs.findIndex(t => t.id === id);
  if (index === -1) {
    throw new Error(`Tool "${id}" not found`);
  }
  customs.splice(index, 1);
  saveCustomTools(customs);
}

export function isToolValid(id) {
  if (id === 'shell') return true;
  const all = getAvailableTools();
  return all.some(t => t.id === id);
}

export async function getToolCommandAsync(id) {
  const tool = await getToolDefinitionAsync(id);
  return tool ? tool.command : 'claude';
}

export async function saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning, visibility }) {
  const trimmedCommand = String(command || '').trim();
  if (!validateCommand(trimmedCommand)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }

  const normalizedFamily = normalizeRuntimeFamily(runtimeFamily);
  if (!normalizedFamily) {
    throw new Error('runtimeFamily must be one of: claude-stream-json, codex-json');
  }

  const builtinConflict = BUILTIN_TOOLS.find((tool) => tool.command === trimmedCommand);
  if (builtinConflict) {
    throw new Error(`Command "${trimmedCommand}" is already handled by builtin tool "${builtinConflict.id}"`);
  }

  const normalizedReasoning = normalizeSimpleReasoning(reasoning, normalizedFamily);
  const normalizedModels = normalizeSimpleModels(models, normalizedReasoning);
  const toolName = String(name || trimmedCommand).trim() || trimmedCommand;

  const customs = await loadCustomToolsAsync();
  const existingIndex = customs.findIndex((tool) => String(tool.command || '').trim() === trimmedCommand);
  const existing = existingIndex >= 0 ? customs[existingIndex] : null;
  let id = existingIndex >= 0
    ? String(customs[existingIndex].id || slugifyToolId(trimmedCommand)).trim()
    : slugifyToolId(trimmedCommand);

  if (existingIndex === -1) {
    let suffix = 2;
    while (BUILTIN_TOOLS.some((tool) => tool.id === id) || customs.some((tool) => tool.id === id)) {
      id = `${slugifyToolId(trimmedCommand)}-${suffix}`;
      suffix += 1;
    }
  }

  const normalizedVisibility = normalizeToolVisibility(visibility || existing?.visibility);

  const record = {
    id,
    name: toolName,
    command: trimmedCommand,
    ...(normalizedVisibility ? { visibility: normalizedVisibility } : {}),
    runtimeFamily: normalizedFamily,
    models: normalizedModels,
    reasoning: normalizedReasoning,
  };

  if (existingIndex >= 0) {
    customs[existingIndex] = record;
  } else {
    customs.push(record);
  }
  await saveCustomToolsAsync(customs);
  return {
    ...record,
    builtin: false,
    available: !!await resolveToolCommandPathAsync(trimmedCommand),
  };
}

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { TOOLS_FILE } from './config.mjs';
import {
  fullPath,
  resolveExecutableCommandPath,
  resolveExecutableCommandPathAsync,
} from './user-shell-env.mjs';

console.log('[tools] Resolved PATH dirs:', fullPath.split(':').join('\n  '));

let customToolsCache = null;
let customToolsCacheMtimeMs = null;
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

function normalizeToolProfile(value) {
  const normalized = String(value || '').trim();
  return normalized === 'micro-agent' ? normalized : '';
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

function normalizeSimpleToolRecord(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const command = String(tool.command || '').trim();
  if (!command) return null;

  const hasRuntimeFamily = Object.hasOwn(tool, 'runtimeFamily');
  const runtimeFamily = normalizeRuntimeFamily(tool.runtimeFamily);
  if (hasRuntimeFamily && !runtimeFamily) {
    throw new Error(`Unsupported runtimeFamily "${tool.runtimeFamily}"`);
  }

  const reasoning = runtimeFamily
    ? normalizeSimpleReasoning(tool.reasoning, runtimeFamily)
    : undefined;
  const models = runtimeFamily
    ? normalizeSimpleModels(tool.models, reasoning)
    : undefined;

  const configuredId = String(tool.id || '').trim();
  const id = configuredId && validateToolId(configuredId)
    ? configuredId
    : slugifyToolId(command);
  const toolProfile = normalizeToolProfile(tool.toolProfile);
  const treatAsFullContextMicroAgent = isFullContextMicroAgentRecord(tool, {
    id,
    command,
    runtimeFamily,
  });
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
    ...(runtimeFamily ? { runtimeFamily, models, reasoning } : {}),
    ...(normalizedPromptMode ? { promptMode: normalizedPromptMode } : {}),
    ...(flattenPrompt ? { flattenPrompt: true } : {}),
  };
}

export function getAvailableTools() {
  const customTools = loadCustomTools();
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

  availableToolsCache = [...builtins, ...customs];
  return availableToolsCache;
}

export async function getAvailableToolsAsync() {
  const customTools = await loadCustomToolsAsync();
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

  availableToolsCache = [...builtins, ...customs];
  return availableToolsCache;
}

export async function getToolDefinitionAsync(id) {
  const all = await getAvailableToolsAsync();
  return all.find((tool) => tool.id === id) || null;
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

export async function saveSimpleToolAsync({ name, command, runtimeFamily, models, reasoning }) {
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

  const record = {
    id,
    name: toolName,
    command: trimmedCommand,
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

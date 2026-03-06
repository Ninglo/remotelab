import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { TOOLS_FILE } from './config.mjs';

// Resolve the user's full login shell PATH at startup so that tools installed
// in user-specific locations (e.g. ~/.local/bin, /opt/homebrew/bin) are found
// even when this process is launched by a service manager with a minimal PATH.
export let fullPath = process.env.PATH || '';
try {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  fullPath = execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
} catch {
  // ignore - will be supplemented below
}

// Always ensure common tool directories are present, regardless of
// whether the login shell PATH was resolved or not. Tools like claude
// are often installed in ~/.local/bin which may only be added in
// ~/.zshrc / ~/.bashrc (not sourced by non-interactive login shells under
// launchd on macOS or systemd on Linux).
const home = process.env.HOME || '';
const isMac = process.platform === 'darwin';
const nodeBinDir = process.execPath ? dirname(process.execPath) : '';
const extras = [
  // npm global CLIs installed alongside the Node binary running RemoteLab
  nodeBinDir,
  `${home}/.local/bin`,
  // macOS-specific: pnpm global bin and Homebrew
  ...(isMac ? [
    `${home}/Library/pnpm`,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ] : [
    // Linux-specific: snap, nvm, fnm, cargo, go
    '/snap/bin',
    `${home}/.nvm/versions/node/current/bin`,
    `${home}/.cargo/bin`,
    `${home}/go/bin`,
  ]),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];
for (const dir of extras) {
  if (dir && !fullPath.split(':').includes(dir)) {
    fullPath = `${fullPath}:${dir}`;
  }
}

console.log('[tools] Resolved PATH dirs:', fullPath.split(':').join('\n  '));

const BUILTIN_TOOLS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', runtimeFamily: 'claude-stream-json' },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot' },
  { id: 'codex', name: 'OpenAI Codex', command: 'codex', runtimeFamily: 'codex-json' },
  { id: 'cline', name: 'Cline', command: 'cline' },
  { id: 'kilo-code', name: 'Kilo Code', command: 'kilo-code' },
];

const SIMPLE_RUNTIME_FAMILIES = new Set(['claude-stream-json', 'codex-json']);
const DEFAULT_CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];

function isCommandAvailable(command) {
  try {
    execFileSync('which', [command], {
      stdio: 'ignore',
      env: { ...process.env, PATH: fullPath },
    });
    return true;
  } catch {
    return false;
  }
}

function loadCustomTools() {
  try {
    if (!existsSync(TOOLS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.error('Failed to load tools.json: expected an array');
      return [];
    }
    return parsed;
  } catch (err) {
    console.error('Failed to load tools.json:', err.message);
    return [];
  }
}

function saveCustomTools(tools) {
  try {
    const dir = dirname(TOOLS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2), 'utf8');
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

  return {
    id,
    name: String(tool.name || command).trim() || command,
    command,
    ...(runtimeFamily ? { runtimeFamily, models, reasoning } : {}),
  };
}

export function getAvailableTools() {
  const customTools = loadCustomTools();

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

  return [...builtins, ...customs];
}

export function getToolDefinition(id) {
  const all = getAvailableTools();
  return all.find(tool => tool.id === id) || null;
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

export function updateTool(id, { name, command }) {
  if (BUILTIN_TOOLS.some(t => t.id === id)) {
    throw new Error('Cannot modify a builtin tool');
  }
  if (command !== undefined && !validateCommand(command)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }
  const customs = loadCustomTools();
  const tool = customs.find(t => t.id === id);
  if (!tool) {
    throw new Error(`Tool "${id}" not found`);
  }
  if (name !== undefined) tool.name = name.trim();
  if (command !== undefined) tool.command = command.trim();
  saveCustomTools(customs);
  return { ...tool, builtin: false, available: isCommandAvailable(tool.command) };
}

export function isToolValid(id) {
  if (id === 'shell') return true;
  const all = getAvailableTools();
  return all.some(t => t.id === id);
}

export function getToolCommand(id) {
  const tool = getToolDefinition(id);
  return tool ? tool.command : 'claude';
}

export function saveSimpleTool({ name, command, runtimeFamily, models, reasoning }) {
  const trimmedCommand = String(command || '').trim();
  if (!validateCommand(trimmedCommand)) {
    throw new Error('Invalid command: must not contain shell metacharacters');
  }

  const normalizedFamily = normalizeRuntimeFamily(runtimeFamily);
  if (!normalizedFamily) {
    throw new Error('runtimeFamily must be one of: claude-stream-json, codex-json');
  }

  const builtinConflict = BUILTIN_TOOLS.find(t => t.command === trimmedCommand);
  if (builtinConflict) {
    throw new Error(`Command "${trimmedCommand}" is already handled by builtin tool "${builtinConflict.id}"`);
  }

  const normalizedReasoning = normalizeSimpleReasoning(reasoning, normalizedFamily);
  const normalizedModels = normalizeSimpleModels(models, normalizedReasoning);
  const toolName = String(name || trimmedCommand).trim() || trimmedCommand;

  const customs = loadCustomTools();
  const existingIndex = customs.findIndex(t => String(t.command || '').trim() === trimmedCommand);
  let id = existingIndex >= 0
    ? String(customs[existingIndex].id || slugifyToolId(trimmedCommand)).trim()
    : slugifyToolId(trimmedCommand);

  if (existingIndex === -1) {
    let suffix = 2;
    while (BUILTIN_TOOLS.some(t => t.id === id) || customs.some(t => t.id === id)) {
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
  saveCustomTools(customs);
  return {
    ...record,
    builtin: false,
    available: isCommandAvailable(trimmedCommand),
  };
}

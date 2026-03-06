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
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot' },
  { id: 'codex', name: 'OpenAI Codex', command: 'codex' },
  { id: 'cline', name: 'Cline', command: 'cline' },
  { id: 'kilo-code', name: 'Kilo Code', command: 'kilo-code' },
];

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
    return JSON.parse(readFileSync(TOOLS_FILE, 'utf8'));
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

export function getAvailableTools() {
  const customTools = loadCustomTools();
  const customIds = new Set(customTools.map(t => t.id));

  const builtins = BUILTIN_TOOLS.map(t => {
    const available = isCommandAvailable(t.command);
    console.log(`[tools] ${t.id} (${t.command}): ${available ? 'available' : 'NOT FOUND'}`);
    return { ...t, builtin: true, available };
  });

  const customs = customTools.map(t => ({
    ...t,
    builtin: false,
    available: isCommandAvailable(t.command),
  }));

  return [...builtins, ...customs];
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
  const all = getAvailableTools();
  const tool = all.find(t => t.id === id);
  return tool ? tool.command : 'claude';
}

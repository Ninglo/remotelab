#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { TOOLS_FILE } from '../lib/config.mjs';

const HOME = homedir();
const DEFAULT_TOOL_ID = 'micro-agent';
const DEFAULT_TOOL_NAME = 'Micro Agent';
const DEFAULT_COMMAND = 'codex';
const DEFAULT_MODEL = 'gpt-5.4';
const PERSONAL_CODEX_CONFIG_PATH = join(HOME, '.codex', 'config.toml');
const LEGACY_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'micro-agent.json');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage(exitCode = 0, errorMessage = '') {
  const output = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  output(`Usage:
  node scripts/install-micro-agent.mjs [options]

Options:
  --model <id>             Codex / GPT model id (default: detected from ~/.codex/config.toml, else ${DEFAULT_MODEL})
  --command <cmd>          Command used to launch the runtime (default: ${DEFAULT_COMMAND})
  --tool-id <id>           RemoteLab tool id (default: ${DEFAULT_TOOL_ID})
  --tool-name <name>       RemoteLab tool label (default: ${DEFAULT_TOOL_NAME})
  -h, --help               Show this help

This installer no longer writes a separate micro-agent runtime config.
It simply registers a thin Codex-backed tool preset in ~/.config/remotelab/tools.json.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    model: '',
    command: DEFAULT_COMMAND,
    toolId: DEFAULT_TOOL_ID,
    toolName: DEFAULT_TOOL_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--model':
        result.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--command':
        result.command = argv[index + 1] || DEFAULT_COMMAND;
        index += 1;
        break;
      case '--tool-id':
        result.toolId = argv[index + 1] || DEFAULT_TOOL_ID;
        index += 1;
        break;
      case '--tool-name':
        result.toolName = argv[index + 1] || DEFAULT_TOOL_NAME;
        index += 1;
        break;
      case '-h':
      case '--help':
        printUsage(0);
        break;
      default:
        break;
    }
  }

  return result;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadToolsFile() {
  try {
    const raw = await readFile(TOOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveToolsFile(tools) {
  await mkdir(dirname(TOOLS_FILE), { recursive: true });
  await writeFile(TOOLS_FILE, `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
}

async function detectCodexModel() {
  if (!(await pathExists(PERSONAL_CODEX_CONFIG_PATH))) return '';
  const raw = await readFile(PERSONAL_CODEX_CONFIG_PATH, 'utf8');
  const match = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  return trimString(match?.[1] || '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = trimString(args.model)
    || trimString(process.env.CODEX_MODEL)
    || await detectCodexModel()
    || DEFAULT_MODEL;
  const record = {
    id: trimString(args.toolId) || DEFAULT_TOOL_ID,
    name: trimString(args.toolName) || DEFAULT_TOOL_NAME,
    toolProfile: 'micro-agent',
    command: trimString(args.command) || DEFAULT_COMMAND,
    runtimeFamily: 'codex-json',
    models: [
      {
        id: model,
        label: model,
      },
    ],
    reasoning: {
      kind: 'none',
      label: 'Thinking',
    },
  };

  const tools = await loadToolsFile();
  const existingIndex = tools.findIndex((tool) => tool?.id === record.id);
  if (existingIndex >= 0) {
    tools[existingIndex] = record;
  } else {
    tools.push(record);
  }
  await saveToolsFile(tools);

  console.log('Installed Micro Agent.');
  console.log(`- Tool id: ${record.id}`);
  console.log(`- Command: ${record.command}`);
  console.log(`- Runtime: ${record.runtimeFamily}`);
  console.log(`- Model: ${model}`);
  if (await pathExists(LEGACY_CONFIG_PATH)) {
    console.log(`- Note: legacy config still exists at ${LEGACY_CONFIG_PATH} but is no longer used.`);
  }
}

await main();

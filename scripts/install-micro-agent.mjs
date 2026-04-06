#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { TOOLS_FILE } from '../lib/config.mjs';

const HOME = homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_TOOL_ID = 'micro-agent';
const DEFAULT_TOOL_NAME = 'Micro Agent';
const DEFAULT_COMMAND = 'codex';
const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_REASONING_LEVEL = 'medium';
const DEFAULT_CLAUDE_REASONING_LEVELS = ['low', 'medium', 'high'];
const PERSONAL_CODEX_CONFIG_PATH = join(HOME, '.codex', 'config.toml');
const LEGACY_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'micro-agent.json');
const DEFAULT_PROVIDER = 'hybrid';
const HYBRID_RUNTIME_COMMAND = join(REPO_ROOT, 'scripts', 'micro-agent-router.mjs');

const HYBRID_CLAUDE_MODELS = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
];

const HYBRID_DOUBAO_MODELS = [
  { id: 'doubao-seed-2-0-pro-260215', label: 'Doubao Pro' },
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildReasoningModelRecord({ id, label, levels = null, defaultReasoning = '' }) {
  const record = { id, label };
  if (Array.isArray(levels) && levels.length > 0) {
    record.reasoningKind = 'enum';
    record.supportedReasoningLevels = levels;
    record.defaultReasoning = defaultReasoning || levels[0];
  }
  return record;
}

function buildHybridModelRecords(primaryModel) {
  return [
    buildReasoningModelRecord({
      id: primaryModel,
      label: primaryModel,
      levels: DEFAULT_REASONING_LEVELS,
      defaultReasoning: DEFAULT_REASONING_LEVEL,
    }),
    ...HYBRID_CLAUDE_MODELS.map((entry) => buildReasoningModelRecord({
      id: entry.id,
      label: entry.label,
      levels: DEFAULT_CLAUDE_REASONING_LEVELS,
      defaultReasoning: DEFAULT_REASONING_LEVEL,
    })),
    ...HYBRID_DOUBAO_MODELS.map((entry) => ({ id: entry.id, label: entry.label })),
  ];
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
  --provider <id>          Runtime provider: hybrid | codex (default: ${DEFAULT_PROVIDER})
  --model <id>             Codex / GPT model id (default: detected from ~/.codex/config.toml, else ${DEFAULT_MODEL})
  --command <cmd>          Command used to launch the runtime in codex mode (default: ${DEFAULT_COMMAND})
  --tool-id <id>           RemoteLab tool id (default: ${DEFAULT_TOOL_ID})
  --tool-name <name>       RemoteLab tool label (default: ${DEFAULT_TOOL_NAME})
  -h, --help               Show this help

By default this installer registers a hybrid Micro Agent preset in ~/.config/remotelab/tools.json.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    provider: DEFAULT_PROVIDER,
    model: '',
    command: DEFAULT_COMMAND,
    toolId: DEFAULT_TOOL_ID,
    toolName: DEFAULT_TOOL_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--provider':
        result.provider = argv[index + 1] || DEFAULT_PROVIDER;
        index += 1;
        break;
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

function normalizeProvider(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === 'codex' ? 'codex' : 'hybrid';
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
  const provider = normalizeProvider(args.provider);
  let model = '';
  let record = null;

  if (provider === 'codex') {
    model = trimString(args.model)
      || trimString(process.env.CODEX_MODEL)
      || await detectCodexModel()
      || DEFAULT_MODEL;
    record = {
      id: trimString(args.toolId) || DEFAULT_TOOL_ID,
      name: trimString(args.toolName) || DEFAULT_TOOL_NAME,
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: trimString(args.command) || DEFAULT_COMMAND,
      runtimeFamily: 'codex-json',
      models: [
        {
          id: model,
          label: model,
          defaultReasoning: DEFAULT_REASONING_LEVEL,
        },
      ],
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: DEFAULT_REASONING_LEVELS,
        default: DEFAULT_REASONING_LEVEL,
      },
    };
  } else {
    model = trimString(args.model)
      || trimString(process.env.CODEX_MODEL)
      || await detectCodexModel()
      || DEFAULT_MODEL;
    await chmod(HYBRID_RUNTIME_COMMAND, 0o755).catch(() => {});
    record = {
      id: trimString(args.toolId) || DEFAULT_TOOL_ID,
      name: trimString(args.toolName) || DEFAULT_TOOL_NAME,
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: HYBRID_RUNTIME_COMMAND,
      runtimeFamily: 'claude-stream-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: buildHybridModelRecords(model),
      reasoning: {
        kind: 'none',
        label: 'Thinking',
      },
    };
  }

  const tools = await loadToolsFile();
  const existingIndex = tools.findIndex((tool) => tool?.id === record.id);
  if (existingIndex >= 0) {
    tools[existingIndex] = record;
  } else {
    tools.push(record);
  }
  await saveToolsFile(tools);

  console.log('Installed Micro Agent.');
  console.log(`- Provider: ${provider}`);
  console.log(`- Tool id: ${record.id}`);
  console.log(`- Command: ${record.command}`);
  console.log(`- Runtime: ${record.runtimeFamily}`);
  console.log(`- Model: ${model}`);
  if (provider === 'codex') {
    console.log(`- Thinking default: ${DEFAULT_REASONING_LEVEL}`);
  }
  if (await pathExists(LEGACY_CONFIG_PATH)) {
    console.log(`- Note: legacy config still exists at ${LEGACY_CONFIG_PATH} but is no longer used.`);
  }
}

await main();

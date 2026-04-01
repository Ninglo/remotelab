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
const PERSONAL_CODEX_CONFIG_PATH = join(HOME, '.codex', 'config.toml');
const LEGACY_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'micro-agent.json');
const DEFAULT_PROVIDER = 'hybrid';
const ANTHROPIC_RUNTIME_COMMAND = join(REPO_ROOT, 'scripts', 'anthropic-fast-agent.mjs');
const HYBRID_RUNTIME_COMMAND = join(REPO_ROOT, 'scripts', 'micro-agent-router.mjs');
const DEFAULT_ANTHROPIC_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'anthropic-fast-agent.json');
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_HYBRID_CODEX_MODEL = 'gpt-5.4';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

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
  --provider <id>          Runtime provider: hybrid | codex | anthropic (default: ${DEFAULT_PROVIDER})
  --model <id>             Codex / GPT model id (default: detected from ~/.codex/config.toml, else ${DEFAULT_MODEL})
  --command <cmd>          Command used to launch the runtime (default: ${DEFAULT_COMMAND})
  --api-key <key>          Anthropic API key when --provider anthropic
  --base-url <url>         Anthropic API base URL (default: ${DEFAULT_ANTHROPIC_BASE_URL})
  --config <path>          Anthropic runtime config path (default: ${DEFAULT_ANTHROPIC_CONFIG_PATH})
  --tool-id <id>           RemoteLab tool id (default: ${DEFAULT_TOOL_ID})
  --tool-name <name>       RemoteLab tool label (default: ${DEFAULT_TOOL_NAME})
  -h, --help               Show this help

By default this installer registers a hybrid Micro Agent preset in ~/.config/remotelab/tools.json.
When --provider anthropic is used, it also writes an Anthropic fast-agent runtime config.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    provider: DEFAULT_PROVIDER,
    model: '',
    command: DEFAULT_COMMAND,
    apiKey: '',
    baseUrl: '',
    configPath: '',
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
      case '--api-key':
        result.apiKey = argv[index + 1] || '';
        index += 1;
        break;
      case '--base-url':
        result.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--config':
        result.configPath = argv[index + 1] || '';
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

function normalizeProvider(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'hybrid') return 'hybrid';
  return normalized === 'anthropic' ? 'anthropic' : 'codex';
}

async function writeAnthropicConfig({ apiKey, baseUrl, model, configPath }) {
  const config = {
    apiKey,
    baseUrl,
    model,
    maxIterations: 2,
    maxTokens: 8192,
    requestTimeoutMs: 20000,
    bashTimeoutMs: 12000,
    maxToolOutputChars: 12000,
    maxDirectoryEntries: 200,
    maxToolCallsPerTurn: 4,
    tools: {
      bash: true,
      list_dir: true,
      read_file: true,
      clipboard_read: true,
      clipboard_write: true,
      open_app: true,
      notify: true,
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await chmod(configPath, 0o600);
  await chmod(ANTHROPIC_RUNTIME_COMMAND, 0o755).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = normalizeProvider(args.provider);
  let model = '';
  let record = null;

  if (provider === 'anthropic') {
    model = trimString(args.model)
      || trimString(process.env.ANTHROPIC_MODEL)
      || DEFAULT_ANTHROPIC_MODEL;
    const apiKey = trimString(args.apiKey) || trimString(process.env.ANTHROPIC_API_KEY);
    const baseUrl = trimString(args.baseUrl)
      || trimString(process.env.ANTHROPIC_BASE_URL)
      || DEFAULT_ANTHROPIC_BASE_URL;
    const configPath = trimString(args.configPath) || DEFAULT_ANTHROPIC_CONFIG_PATH;

    if (!apiKey) {
      printUsage(1, 'Missing Anthropic API key. Pass --api-key or set ANTHROPIC_API_KEY first.');
    }

    await writeAnthropicConfig({ apiKey, baseUrl, model, configPath });
    record = {
      id: trimString(args.toolId) || DEFAULT_TOOL_ID,
      name: trimString(args.toolName) || DEFAULT_TOOL_NAME,
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: ANTHROPIC_RUNTIME_COMMAND,
      runtimeFamily: 'claude-stream-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: ANTHROPIC_MODELS.map((entry) => ({
        id: entry.id,
        label: entry.label,
      })),
      reasoning: {
        kind: 'none',
        label: 'Thinking',
      },
    };
  } else if (provider === 'hybrid') {
    model = trimString(args.model)
      || trimString(process.env.CODEX_MODEL)
      || await detectCodexModel()
      || DEFAULT_HYBRID_CODEX_MODEL;
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
      models: [
        {
          id: model,
          label: model,
        },
        ...ANTHROPIC_MODELS.map((entry) => ({
          id: entry.id,
          label: entry.label,
        })),
      ],
      reasoning: {
        kind: 'none',
        label: 'Thinking',
      },
    };
  } else {
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
  } else {
    console.log(`- Thinking: provider-side thinking toggle disabled in this runtime`);
  }
  if (await pathExists(LEGACY_CONFIG_PATH)) {
    console.log(`- Note: legacy config still exists at ${LEGACY_CONFIG_PATH} but is no longer used.`);
  }
}

await main();

#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { TOOLS_FILE } from '../lib/config.mjs';
import {
  buildMicroAgentToolRecord,
  detectPreferredCodexModel,
  MICRO_AGENT_DEFAULT_CODEX_COMMAND,
  MICRO_AGENT_DEFAULT_MODEL,
  MICRO_AGENT_DEFAULT_PROVIDER,
  MICRO_AGENT_DEFAULT_REASONING_LEVEL,
  MICRO_AGENT_DEFAULT_TOOL_ID,
  MICRO_AGENT_DEFAULT_TOOL_NAME,
  MICRO_AGENT_LEGACY_CONFIG_PATH,
  normalizeMicroAgentProvider,
} from '../lib/micro-agent-tool.mjs';

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
  --provider <id>          Runtime provider: hybrid | codex (default: ${MICRO_AGENT_DEFAULT_PROVIDER})
  --model <id>             Codex / GPT model id (default: detected from ~/.codex/config.toml, else ${MICRO_AGENT_DEFAULT_MODEL})
  --command <cmd>          Command used to launch the runtime in codex mode (default: ${MICRO_AGENT_DEFAULT_CODEX_COMMAND})
  --tool-id <id>           RemoteLab tool id (default: ${MICRO_AGENT_DEFAULT_TOOL_ID})
  --tool-name <name>       RemoteLab tool label (default: ${MICRO_AGENT_DEFAULT_TOOL_NAME})
  -h, --help               Show this help

By default this installer registers a hybrid Micro Agent preset in ~/.config/remotelab/tools.json.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    provider: MICRO_AGENT_DEFAULT_PROVIDER,
    model: '',
    command: MICRO_AGENT_DEFAULT_CODEX_COMMAND,
    toolId: MICRO_AGENT_DEFAULT_TOOL_ID,
    toolName: MICRO_AGENT_DEFAULT_TOOL_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--provider':
        result.provider = argv[index + 1] || MICRO_AGENT_DEFAULT_PROVIDER;
        index += 1;
        break;
      case '--model':
        result.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--command':
        result.command = argv[index + 1] || MICRO_AGENT_DEFAULT_CODEX_COMMAND;
        index += 1;
        break;
      case '--tool-id':
        result.toolId = argv[index + 1] || MICRO_AGENT_DEFAULT_TOOL_ID;
        index += 1;
        break;
      case '--tool-name':
        result.toolName = argv[index + 1] || MICRO_AGENT_DEFAULT_TOOL_NAME;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = normalizeMicroAgentProvider(args.provider);
  const model = trimString(args.model)
    || trimString(process.env.CODEX_MODEL)
    || await detectPreferredCodexModel()
    || MICRO_AGENT_DEFAULT_MODEL;
  const { record } = await buildMicroAgentToolRecord({
    provider,
    model,
    toolId: trimString(args.toolId) || MICRO_AGENT_DEFAULT_TOOL_ID,
    toolName: trimString(args.toolName) || MICRO_AGENT_DEFAULT_TOOL_NAME,
    command: trimString(args.command) || MICRO_AGENT_DEFAULT_CODEX_COMMAND,
  });

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
    console.log(`- Thinking default: ${MICRO_AGENT_DEFAULT_REASONING_LEVEL}`);
  }
  if (await pathExists(MICRO_AGENT_LEGACY_CONFIG_PATH)) {
    console.log(`- Note: legacy config still exists at ${MICRO_AGENT_LEGACY_CONFIG_PATH} but is no longer used.`);
  }
}

await main();

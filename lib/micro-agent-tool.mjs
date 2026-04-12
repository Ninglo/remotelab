import { chmod, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HOME = homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const MICRO_AGENT_DEFAULT_TOOL_ID = 'micro-agent';
export const MICRO_AGENT_DEFAULT_TOOL_NAME = 'Micro Agent';
export const MICRO_AGENT_DEFAULT_CODEX_COMMAND = 'codex';
export const MICRO_AGENT_DEFAULT_MODEL = 'gpt-5.4';
export const MICRO_AGENT_DEFAULT_PROVIDER = 'hybrid';
export const MICRO_AGENT_DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
export const MICRO_AGENT_DEFAULT_REASONING_LEVEL = 'medium';
export const MICRO_AGENT_CLAUDE_REASONING_LEVELS = ['low', 'medium', 'high'];
export const MICRO_AGENT_PERSONAL_CODEX_CONFIG_PATH = join(HOME, '.codex', 'config.toml');
export const MICRO_AGENT_LEGACY_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'micro-agent.json');
export const MICRO_AGENT_HYBRID_RUNTIME_COMMAND = join(REPO_ROOT, 'scripts', 'micro-agent-router.mjs');

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

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
      levels: MICRO_AGENT_DEFAULT_REASONING_LEVELS,
      defaultReasoning: MICRO_AGENT_DEFAULT_REASONING_LEVEL,
    }),
    ...HYBRID_CLAUDE_MODELS.map((entry) => buildReasoningModelRecord({
      id: entry.id,
      label: entry.label,
      levels: MICRO_AGENT_CLAUDE_REASONING_LEVELS,
      defaultReasoning: MICRO_AGENT_DEFAULT_REASONING_LEVEL,
    })),
    ...HYBRID_DOUBAO_MODELS.map((entry) => ({ id: entry.id, label: entry.label })),
  ];
}

export function normalizeMicroAgentProvider(value) {
  return trimString(value).toLowerCase() === 'codex' ? 'codex' : 'hybrid';
}

export async function detectPreferredCodexModel() {
  if (!(await pathExists(MICRO_AGENT_PERSONAL_CODEX_CONFIG_PATH))) return '';
  const raw = await readFile(MICRO_AGENT_PERSONAL_CODEX_CONFIG_PATH, 'utf8');
  const match = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  return trimString(match?.[1] || '');
}

export async function buildMicroAgentToolRecord({
  provider = MICRO_AGENT_DEFAULT_PROVIDER,
  model = '',
  toolId = MICRO_AGENT_DEFAULT_TOOL_ID,
  toolName = MICRO_AGENT_DEFAULT_TOOL_NAME,
  command = MICRO_AGENT_DEFAULT_CODEX_COMMAND,
} = {}) {
  const normalizedProvider = normalizeMicroAgentProvider(provider);
  const resolvedModel = trimString(model)
    || trimString(process.env.CODEX_MODEL)
    || await detectPreferredCodexModel()
    || MICRO_AGENT_DEFAULT_MODEL;

  if (normalizedProvider === 'codex') {
    return {
      provider: normalizedProvider,
      model: resolvedModel,
      record: {
        id: trimString(toolId) || MICRO_AGENT_DEFAULT_TOOL_ID,
        name: trimString(toolName) || MICRO_AGENT_DEFAULT_TOOL_NAME,
        visibility: 'private',
        toolProfile: 'micro-agent',
        command: trimString(command) || MICRO_AGENT_DEFAULT_CODEX_COMMAND,
        runtimeFamily: 'codex-json',
        models: [
          {
            id: resolvedModel,
            label: resolvedModel,
            defaultReasoning: MICRO_AGENT_DEFAULT_REASONING_LEVEL,
          },
        ],
        reasoning: {
          kind: 'enum',
          label: 'Thinking',
          levels: MICRO_AGENT_DEFAULT_REASONING_LEVELS,
          default: MICRO_AGENT_DEFAULT_REASONING_LEVEL,
        },
      },
    };
  }

  await chmod(MICRO_AGENT_HYBRID_RUNTIME_COMMAND, 0o755).catch(() => {});
  return {
    provider: normalizedProvider,
    model: resolvedModel,
    record: {
      id: trimString(toolId) || MICRO_AGENT_DEFAULT_TOOL_ID,
      name: trimString(toolName) || MICRO_AGENT_DEFAULT_TOOL_NAME,
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: MICRO_AGENT_HYBRID_RUNTIME_COMMAND,
      runtimeFamily: 'claude-stream-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: buildHybridModelRecords(resolvedModel),
      reasoning: {
        kind: 'none',
        label: 'Thinking',
      },
    },
  };
}

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getToolDefinitionAsync } from '../lib/tools.mjs';

// Claude Code has no model cache file — hardcode the known aliases.
// These alias names are stable; the full model IDs behind them update automatically.
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'opus',   label: 'Opus 4.6'   },
  { id: 'haiku',  label: 'Haiku 4.5'  },
];
let codexModelsCache = null;

function cloneReasoning(reasoning, fallbackLabel = 'Thinking') {
  if (!reasoning || typeof reasoning !== 'object') return null;
  const kind = String(reasoning.kind || '').trim().toLowerCase();
  const label = String(reasoning.label || fallbackLabel).trim() || fallbackLabel;
  if (kind === 'enum') {
    const levels = [...new Set(
      (Array.isArray(reasoning.levels) ? reasoning.levels : [])
        .map((level) => String(level || '').trim())
        .filter(Boolean),
    )];
    if (levels.length === 0) return null;
    const defaultValue = String(reasoning.default || reasoning.defaultReasoning || reasoning.defaultEffort || levels[0]).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === 'toggle' || kind === 'none') {
    return { kind, label };
  }
  return null;
}

function buildModelReasoning(model, fallbackReasoning = null) {
  const fallbackLabel = String(fallbackReasoning?.label || 'Thinking').trim() || 'Thinking';
  if (model?.reasoning && typeof model.reasoning === 'object') {
    return cloneReasoning(model.reasoning, fallbackLabel);
  }
  if (Array.isArray(model?.effortLevels) && model.effortLevels.length > 0) {
    return cloneReasoning({
      kind: 'enum',
      label: fallbackLabel,
      levels: model.effortLevels,
      default: model.defaultReasoning || model.defaultEffort || model.effortLevels[0],
    }, fallbackLabel);
  }
  return cloneReasoning(fallbackReasoning, fallbackLabel);
}

function buildResponseModel(model, fallbackReasoning = null) {
  const reasoning = buildModelReasoning(model, fallbackReasoning);
  return {
    id: model.id,
    label: model.label,
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning?.kind === 'enum'
      ? {
        defaultEffort: reasoning.default,
        effortLevels: [...reasoning.levels],
      }
      : {}),
  };
}

/**
 * Returns { models, effortLevels } for a given tool.
 * - models: [{ id, label, defaultEffort?, effortLevels? }]
 * - effortLevels: string[] | null (null means tool uses a binary thinking toggle)
 */
export async function getModelsForTool(toolId) {
  if (toolId === 'claude') {
    const reasoning = { kind: 'toggle', label: 'Thinking' };
    return {
      models: CLAUDE_MODELS.map((model) => ({
        ...model,
        reasoning,
      })),
      effortLevels: null,
      defaultModel: null,
      reasoning,
    };
  }
  if (toolId === 'codex') {
    return getCodexModels();
  }

  const tool = await getToolDefinitionAsync(toolId);
  if (tool?.runtimeFamily) {
    const toolReasoning = cloneReasoning(tool.reasoning || { kind: 'none', label: 'Thinking' }) || { kind: 'none', label: 'Thinking' };
    const models = (tool.models || []).map((model) => buildResponseModel(model, toolReasoning));
    const defaultReasoning = models[0]?.reasoning || toolReasoning;

    return {
      models,
      effortLevels: defaultReasoning.kind === 'enum' ? defaultReasoning.levels || [] : null,
      defaultModel: models[0]?.id || null,
      reasoning: defaultReasoning,
    };
  }

  return {
    models: [],
    effortLevels: null,
    defaultModel: null,
    reasoning: { kind: 'none', label: 'Thinking' },
  };
}

async function getCodexModels() {
  if (codexModelsCache) {
    return codexModelsCache;
  }
  try {
    const raw = await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf-8');
    const data = JSON.parse(raw);
    const models = (data.models || [])
      .filter(m => m.visibility === 'list')
      .map(m => ({
        id: m.slug,
        label: m.display_name,
        defaultEffort: m.default_reasoning_level || 'medium',
        effortLevels: (m.supported_reasoning_levels || []).map(r => r.effort),
        reasoning: {
          kind: 'enum',
          label: 'Thinking',
          levels: (m.supported_reasoning_levels || []).map(r => r.effort),
          default: m.default_reasoning_level || 'medium',
        },
      }));
    // Union of all effort levels across all visible models
    const effortLevels = [...new Set(models.flatMap(m => m.effortLevels))];
    codexModelsCache = {
      models,
      effortLevels,
      defaultModel: null,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: effortLevels,
        default: models[0]?.defaultEffort || effortLevels[0] || 'medium',
      },
    };
    return codexModelsCache;
  } catch {
    codexModelsCache = {
      models: [],
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultModel: null,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: ['low', 'medium', 'high', 'xhigh'],
        default: 'medium',
      },
    };
    return codexModelsCache;
  }
}

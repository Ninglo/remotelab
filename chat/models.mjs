import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { getToolDefinition } from '../lib/tools.mjs';

// Claude Code has no model cache file — hardcode the known aliases.
// These alias names are stable; the full model IDs behind them update automatically.
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'opus',   label: 'Opus 4.6'   },
  { id: 'haiku',  label: 'Haiku 4.5'  },
];

/**
 * Returns { models, effortLevels } for a given tool.
 * - models: [{ id, label, defaultEffort?, effortLevels? }]
 * - effortLevels: string[] | null (null means tool uses a binary thinking toggle)
 */
export async function getModelsForTool(toolId) {
  if (toolId === 'claude') {
    return {
      models: CLAUDE_MODELS,
      effortLevels: null,
      defaultModel: null,
      reasoning: { kind: 'toggle', label: 'Thinking' },
    };
  }
  if (toolId === 'codex') {
    return getCodexModels();
  }

  const tool = getToolDefinition(toolId);
  if (tool?.runtimeFamily) {
    const reasoning = tool.reasoning || { kind: 'none', label: 'Thinking' };
    const models = (tool.models || []).map(model => ({
      id: model.id,
      label: model.label,
      ...(reasoning.kind === 'enum'
        ? { defaultEffort: model.defaultReasoning || reasoning.default || null }
        : {}),
    }));

    return {
      models,
      effortLevels: reasoning.kind === 'enum' ? reasoning.levels || [] : null,
      defaultModel: models[0]?.id || null,
      reasoning,
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
      }));
    // Union of all effort levels across all visible models
    const effortLevels = [...new Set(models.flatMap(m => m.effortLevels))];
    return {
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
  } catch {
    return {
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
  }
}

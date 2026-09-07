import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { resolveCodexHomeDir } from '../lib/codex-home.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { discoverPiModels } from './pi-models.mjs';
import { CODEX_MODEL_CATALOG } from '../lib/codex-model-catalog.mjs';
import {
  PRODUCT_DEFAULT_CODEX_EFFORT,
  PRODUCT_DEFAULT_CODEX_MODEL,
  isStaleCodexModelId,
} from '../lib/legacy-micro-agent.mjs';

// Claude Code has no model cache file — hardcode the known aliases.
// These alias names are stable; the full model IDs behind them update automatically.
const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet 4.6' },
  { id: 'opus',   label: 'Opus 4.6'   },
  { id: 'haiku',  label: 'Haiku 4.5'  },
];
const DEFAULT_CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_CODEX_REASONING = Object.freeze({
  kind: 'enum',
  label: 'Thinking',
  levels: DEFAULT_CODEX_REASONING_LEVELS,
  default: PRODUCT_DEFAULT_CODEX_EFFORT,
});
const HARDCODED_CODEX_MODELS = CODEX_MODEL_CATALOG;
const HARDCODED_CODEX_MODEL_IDS = HARDCODED_CODEX_MODELS.map((model) => model.id);
const MAX_CODEX_RECENT_SESSION_FILES = 24;
const MAX_CODEX_RECENT_MODELS = 8;
let codexModelsCache = null;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
    const defaultValue = String(
      reasoning.default
      || reasoning.defaultReasoning
      || reasoning.defaultEffort
      || levels[0],
    ).trim();
    return {
      kind,
      label,
      levels,
      default: levels.includes(defaultValue) ? defaultValue : levels[0],
    };
  }
  if (kind === 'none') {
    return { kind, label };
  }
  return null;
}

function buildModelReasoning(model, fallbackReasoning = null) {
  const fallbackLabel = String(fallbackReasoning?.label || 'Thinking').trim() || 'Thinking';
  // Prefer explicit reasoning object on the model.
  if (model?.reasoning && typeof model.reasoning === 'object') {
    return cloneReasoning(model.reasoning, fallbackLabel);
  }
  // Fall back to flat fields: supportedReasoningLevels + reasoningKind.
  const levels = Array.isArray(model?.supportedReasoningLevels)
    ? model.supportedReasoningLevels
    : Array.isArray(model?.effortLevels) ? model.effortLevels : [];
  const kind = String(model?.reasoningKind || '').trim().toLowerCase();
  if (levels.length > 0) {
    return cloneReasoning({
      kind: 'enum',
      label: fallbackLabel,
      levels,
      default: model.defaultReasoning || levels[0],
    }, fallbackLabel);
  }
  if (kind === 'none') {
    return cloneReasoning({ kind: 'none', label: fallbackLabel }, fallbackLabel);
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

function buildCodexReasoning(levels = DEFAULT_CODEX_REASONING_LEVELS, defaultValue = PRODUCT_DEFAULT_CODEX_EFFORT) {
  const normalizedLevels = [...new Set(
    (Array.isArray(levels) ? levels : [])
      .map((level) => trimString(level))
      .filter(Boolean),
  )];
  const finalLevels = normalizedLevels.length > 0
    ? normalizedLevels
    : [...DEFAULT_CODEX_REASONING_LEVELS];
  const resolvedDefault = trimString(defaultValue);
  return {
    kind: 'enum',
    label: 'Thinking',
    levels: finalLevels,
    default: finalLevels.includes(resolvedDefault)
      ? resolvedDefault
      : (finalLevels.includes(DEFAULT_CODEX_REASONING.default)
        ? DEFAULT_CODEX_REASONING.default
        : finalLevels[0]),
  };
}

function buildCodexCacheModel(rawModel) {
  const id = trimString(rawModel?.slug);
  if (!id) return null;
  const reasoning = buildCodexReasoning(
    (rawModel?.supported_reasoning_levels || []).map((level) => level?.effort),
    id === PRODUCT_DEFAULT_CODEX_MODEL
      ? PRODUCT_DEFAULT_CODEX_EFFORT
      : rawModel?.default_reasoning_level || DEFAULT_CODEX_REASONING.default,
  );
  return {
    id,
    label: trimString(rawModel?.display_name) || id,
    defaultEffort: reasoning.default,
    effortLevels: [...reasoning.levels],
    reasoning,
  };
}

function buildHardcodedCodexModel(modelSpec) {
  const id = trimString(modelSpec?.id);
  if (!id) return null;
  const reasoning = buildCodexReasoning(
    modelSpec?.effortLevels || DEFAULT_CODEX_REASONING.levels,
    modelSpec?.defaultEffort || DEFAULT_CODEX_REASONING.default,
  );
  return {
    id,
    label: trimString(modelSpec?.label) || id,
    defaultEffort: reasoning.default,
    effortLevels: [...reasoning.levels],
    reasoning,
  };
}

function buildDetectedCodexModel(modelId) {
  const id = trimString(modelId);
  if (!id) return null;
  return {
    id,
    label: id,
    defaultEffort: DEFAULT_CODEX_REASONING.default,
    effortLevels: [...DEFAULT_CODEX_REASONING.levels],
    reasoning: {
      kind: DEFAULT_CODEX_REASONING.kind,
      label: DEFAULT_CODEX_REASONING.label,
      levels: [...DEFAULT_CODEX_REASONING.levels],
      default: DEFAULT_CODEX_REASONING.default,
    },
  };
}

function createBaseCodexModelMap() {
  return new Map(
    HARDCODED_CODEX_MODELS
      .map((modelSpec) => buildHardcodedCodexModel(modelSpec))
      .filter(Boolean)
      .map((model) => [model.id, model]),
  );
}

function buildCodexResponse(models = [], preferredDefaultModel = '', preferredDefaultEffort = '') {
  const normalizedModels = Array.isArray(models)
    ? models.filter((model) => model && typeof model === 'object' && trimString(model.id))
    : [];
  const defaultModel = trimString(preferredDefaultModel);
  const defaultModelRecord = defaultModel
    ? normalizedModels.find((model) => trimString(model.id) === defaultModel)
    : null;
  const defaultModelLevels = Array.isArray(defaultModelRecord?.effortLevels)
    ? defaultModelRecord.effortLevels.map((level) => trimString(level)).filter(Boolean)
    : [];
  const configuredEffort = trimString(preferredDefaultEffort);
  const resolvedDefaultEffort = configuredEffort && (
    defaultModelLevels.length === 0 || defaultModelLevels.includes(configuredEffort)
  )
    ? configuredEffort
    : (
      defaultModelRecord?.defaultEffort
      || normalizedModels[0]?.defaultEffort
      || DEFAULT_CODEX_REASONING.default
    );
  const responseLevels = [...new Set(
    normalizedModels.flatMap((model) => (
      Array.isArray(model?.effortLevels) ? model.effortLevels : []
    ))
      .map((level) => trimString(level))
      .filter(Boolean),
  )];
  const reasoning = buildCodexReasoning(
    responseLevels.length > 0 ? responseLevels : DEFAULT_CODEX_REASONING.levels,
    resolvedDefaultEffort,
  );
  return {
    models: normalizedModels,
    effortLevels: [...reasoning.levels],
    defaultModel: defaultModel && normalizedModels.some((model) => trimString(model.id) === defaultModel)
      ? defaultModel
      : null,
    reasoning,
  };
}

function resolveCodexDefaultModel(configuredModel = '', recentModels = []) {
  for (const candidate of [configuredModel, ...(Array.isArray(recentModels) ? recentModels : [])]) {
    const normalized = trimString(candidate);
    if (normalized && !isStaleCodexModelId(normalized)) {
      return normalized;
    }
  }
  return PRODUCT_DEFAULT_CODEX_MODEL;
}

async function readCodexConfiguredSettings(codexHomeDir) {
  try {
    const raw = await readFile(join(codexHomeDir, 'config.toml'), 'utf-8');
    const modelMatch = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const effortMatch = raw.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m);
    return {
      model: trimString(modelMatch?.[1]),
      effort: trimString(effortMatch?.[1]),
    };
  } catch {
    return { model: '', effort: '' };
  }
}

async function collectRecentCodexSessionFiles(dirPath, files = []) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectRecentCodexSessionFiles(entryPath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const info = await stat(entryPath);
      files.push({ path: entryPath, mtimeMs: info.mtimeMs || 0 });
    } catch {
      // Ignore session files that disappear mid-scan.
    }
  }
  return files;
}

async function readCodexRecentModels(codexHomeDir) {
  const sessionFiles = await collectRecentCodexSessionFiles(join(codexHomeDir, 'sessions'));
  sessionFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const models = [];
  const seen = new Set();
  for (const sessionFile of sessionFiles.slice(0, MAX_CODEX_RECENT_SESSION_FILES)) {
    let raw;
    try {
      raw = await readFile(sessionFile.path, 'utf-8');
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== 'turn_context') continue;
      const modelId = trimString(record?.payload?.model);
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      models.push(modelId);
      if (models.length >= MAX_CODEX_RECENT_MODELS) {
        return models;
      }
    }
  }
  return models;
}

/**
 * Returns { models, effortLevels } for a given tool.
 * - models: [{ id, label, defaultEffort?, effortLevels? }]
 * - effortLevels: string[] | null (null means the tool has no reasoning control)
 */
export async function getModelsForTool(toolId, options = {}) {
  if (toolId === 'claude') {
    const levels = ['none', 'low', 'medium', 'high'];
    const defaultReasoning = {
      kind: 'enum',
      label: 'Thinking',
      levels,
      default: 'medium',
    };
    return {
      models: CLAUDE_MODELS.map((model) => ({
        ...model,
        reasoning: defaultReasoning,
        defaultEffort: 'medium',
        effortLevels: levels,
      })),
      effortLevels: levels,
      defaultModel: null,
      reasoning: defaultReasoning,
    };
  }
  if (toolId === 'codex') {
    return getCodexModels();
  }
  if (toolId === 'pi') {
    return discoverPiModels({ refresh: options.refresh === true });
  }

  const tool = await getToolDefinitionAsync(toolId);
  if (tool?.runtimeFamily) {
    const toolReasoning = cloneReasoning(tool.reasoning || { kind: 'none', label: 'Thinking' })
      || { kind: 'none', label: 'Thinking' };
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
  const codexHomeDir = resolveCodexHomeDir();
  const configuredSettings = await readCodexConfiguredSettings(codexHomeDir);
  const configuredModel = configuredSettings.model;
  const recentModels = await readCodexRecentModels(codexHomeDir);
  const defaultModel = resolveCodexDefaultModel(configuredModel, recentModels);
  const modelMap = createBaseCodexModelMap();

  try {
    const raw = await readFile(join(codexHomeDir, 'models_cache.json'), 'utf-8');
    const data = JSON.parse(raw);
    for (const cacheModel of (data.models || [])) {
      if (cacheModel?.visibility !== 'list') continue;
      const normalizedModel = buildCodexCacheModel(cacheModel);
      if (!normalizedModel) continue;
      modelMap.set(normalizedModel.id, normalizedModel);
    }
  } catch {
    // Missing/invalid cache is expected on some machines.
  }

  for (const detectedModel of [configuredModel, ...recentModels]) {
    const fallbackModel = buildDetectedCodexModel(detectedModel);
    if (!fallbackModel || modelMap.has(fallbackModel.id)) continue;
    modelMap.set(fallbackModel.id, fallbackModel);
  }

  const prioritizedModelIds = [...new Set(
    [defaultModel, configuredModel, ...recentModels, ...HARDCODED_CODEX_MODEL_IDS]
      .map((modelId) => trimString(modelId))
      .filter(Boolean),
  )];
  const orderedModels = [
    ...prioritizedModelIds
      .map((modelId) => modelMap.get(modelId))
      .filter(Boolean),
    ...[...modelMap.values()].filter((model) => !prioritizedModelIds.includes(model.id)),
  ];
  codexModelsCache = buildCodexResponse(
    orderedModels,
    defaultModel || HARDCODED_CODEX_MODEL_IDS[0] || '',
    configuredSettings.effort || PRODUCT_DEFAULT_CODEX_EFFORT,
  );
  return codexModelsCache;
}

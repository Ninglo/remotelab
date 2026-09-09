import {
  PRODUCT_DEFAULT_TOOL_ID,
  normalizeCodexModelId,
} from './legacy-micro-agent.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// A command stores a complete snapshot, separate from the last running model.
export function normalizeExternalRuntimeOverride(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.tool !== 'string' || !value.tool.trim()
    || typeof value.model !== 'string' || typeof value.effort !== 'string'
    || typeof value.thinking !== 'boolean') {
    throw new Error('feishuRuntimeSelection must be null or an object with tool, model, effort and thinking');
  }
  return { tool: value.tool.trim(), model: value.model.trim(), effort: value.effort.trim(), thinking: value.thinking };
}

function normalizeModelForTool(toolId, modelId) {
  const normalizedTool = trimString(toolId);
  const normalizedModel = trimString(modelId);
  return normalizedTool === PRODUCT_DEFAULT_TOOL_ID
    ? normalizeCodexModelId(normalizedModel)
    : normalizedModel;
}

export function normalizeExternalRuntimeSelectionMode(value, fallback = 'ui') {
  const normalized = trimString(value).toLowerCase().replace(/_/g, '-');
  if (normalized === 'pinned' || normalized === 'fixed') {
    return 'pinned';
  }
  if (
    normalized === 'ui'
    || normalized === 'inherit'
    || normalized === 'inherit-ui'
    || normalized === 'current-ui'
  ) {
    return 'ui';
  }
  return fallback;
}

export function resolveExternalRuntimeSelection({
  uiSelection = null,
  mode = 'ui',
  fallback = {},
  defaultTool = 'codex',
} = {}) {
  const resolvedMode = normalizeExternalRuntimeSelectionMode(mode);
  const fallbackTool = trimString(fallback?.tool) || trimString(defaultTool) || 'codex';
  const fallbackModel = normalizeModelForTool(fallbackTool, fallback?.model);
  const fallbackEffort = trimString(fallback?.effort);
  const fallbackThinking = fallback?.thinking === true;

  if (resolvedMode === 'pinned') {
    return {
      mode: 'pinned',
      tool: fallbackTool,
      model: fallbackModel,
      effort: fallbackEffort,
      thinking: fallbackThinking,
    };
  }

  const selectedTool = trimString(uiSelection?.selectedTool);
  const selectedModel = normalizeModelForTool(selectedTool, uiSelection?.selectedModel);
  const selectedEffort = trimString(uiSelection?.selectedEffort);
  const reasoningKind = trimString(uiSelection?.reasoningKind).toLowerCase();
  const effectiveTool = selectedTool || fallbackTool;
  const uiMatchesEffectiveTool = !!selectedTool && selectedTool === effectiveTool;

  return {
    mode: 'ui',
    tool: effectiveTool,
    model: uiMatchesEffectiveTool ? selectedModel : fallbackModel,
    effort: uiMatchesEffectiveTool
      ? (reasoningKind === 'enum' ? selectedEffort : '')
      : fallbackEffort,
    thinking: uiMatchesEffectiveTool ? false : fallbackThinking,
  };
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  defaultTool = 'claude',
} = {}) {
  const resolvedMode = normalizeExternalRuntimeSelectionMode(mode);
  const fallbackTool = trimString(fallback?.tool) || trimString(defaultTool) || 'claude';
  const fallbackModel = trimString(fallback?.model);
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
  const selectedModel = trimString(uiSelection?.selectedModel);
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
    thinking: uiMatchesEffectiveTool
      ? (reasoningKind === 'toggle' && uiSelection?.thinkingEnabled === true)
      : fallbackThinking,
  };
}

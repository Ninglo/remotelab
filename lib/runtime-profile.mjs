import { clampReasoningEffort } from './reasoning-effort-policy.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

export const RUNTIME_PROFILE_FIELDS = Object.freeze(['tool', 'model', 'effort']);

// Harness is stored as `tool` for API compatibility. Keep these three values
// together whenever runtime intent crosses a persistence or scheduling boundary.
export function normalizeRuntimeProfile(value = {}) {
  return {
    tool: trim(value?.tool || value?.harness),
    model: trim(value?.model),
    effort: clampReasoningEffort(value?.effort),
  };
}

export function runtimeProfileFromUiSelection(value = {}) {
  return normalizeRuntimeProfile({
    tool: value?.selectedTool,
    model: value?.selectedModel,
    effort: value?.selectedEffort,
  });
}

export function runtimeProfileToUiSelection(profile = {}, reasoningKind = 'none') {
  const normalized = normalizeRuntimeProfile(profile);
  const normalizedReasoningKind = trim(reasoningKind).toLowerCase() === 'enum' ? 'enum' : 'none';
  return {
    selectedTool: normalized.tool,
    selectedModel: normalized.model,
    selectedEffort: normalizedReasoningKind === 'enum' ? normalized.effort : '',
    reasoningKind: normalizedReasoningKind,
  };
}

// Apply partial intent without ever carrying model/effort across Harness or
// model boundaries. Missing dependent values are completed from that Harness's
// catalog by completeRuntimeProfile().
export function resolveRuntimeProfile(saved = {}, requested = {}, defaultTool = 'codex') {
  const current = normalizeRuntimeProfile(saved);
  const override = normalizeRuntimeProfile(requested);
  const tool = override.tool || current.tool || trim(defaultTool);
  const sameTool = tool === current.tool;
  const model = override.model || (sameTool ? current.model : '');
  const sameModel = sameTool && (!override.model || model === current.model);
  const effort = override.effort || (sameModel ? current.effort : '');
  return { tool, model, effort };
}

export function reasoningForRuntimeProfile(catalog = {}, model = '') {
  return catalog.models?.find(candidate => trim(candidate?.id) === trim(model))?.reasoning
    || catalog.reasoning
    || { kind: 'none' };
}

export function completeRuntimeProfile(profile = {}, catalog = {}) {
  const normalized = normalizeRuntimeProfile(profile);
  const model = normalized.model || trim(catalog.defaultModel);
  const reasoning = reasoningForRuntimeProfile(catalog, model);
  return {
    tool: normalized.tool,
    model,
    effort: reasoning.kind === 'enum'
      ? (reasoning.levels || []).includes(normalized.effort)
        ? normalized.effort
        : trim(reasoning.default)
      : '',
  };
}

import { IS_GUEST_INSTANCE } from './config.mjs';

export const GUEST_MAX_REASONING_EFFORT = 'xhigh';

const REASONING_EFFORT_ORDER = Object.freeze([
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const trim = value => typeof value === 'string' ? value.trim() : '';

export function clampReasoningEffort(value, {
  isGuestInstance = IS_GUEST_INSTANCE,
  maxEffort = GUEST_MAX_REASONING_EFFORT,
} = {}) {
  const effort = trim(value);
  if (!effort || !isGuestInstance) return effort;
  const effortIndex = REASONING_EFFORT_ORDER.indexOf(effort);
  const maxIndex = REASONING_EFFORT_ORDER.indexOf(trim(maxEffort));
  if (effortIndex < 0 || maxIndex < 0 || effortIndex <= maxIndex) return effort;
  return trim(maxEffort);
}

export function limitReasoningDescriptor(reasoning, options = {}) {
  if (!reasoning || typeof reasoning !== 'object' || reasoning.kind !== 'enum') {
    return reasoning;
  }
  const isGuestInstance = options.isGuestInstance ?? IS_GUEST_INSTANCE;
  if (!isGuestInstance) return reasoning;
  const maxEffort = trim(options.maxEffort) || GUEST_MAX_REASONING_EFFORT;
  const maxIndex = REASONING_EFFORT_ORDER.indexOf(maxEffort);
  if (maxIndex < 0) return reasoning;
  const levels = [...new Set(
    (Array.isArray(reasoning.levels) ? reasoning.levels : [])
      .map((level) => trim(level))
      .filter((level) => {
        if (!level) return false;
        const index = REASONING_EFFORT_ORDER.indexOf(level);
        return index < 0 || index <= maxIndex;
      }),
  )];
  if (levels.length === 0) return { ...reasoning, levels: [], default: '' };
  const clampedDefault = clampReasoningEffort(reasoning.default, { isGuestInstance, maxEffort });
  return {
    ...reasoning,
    levels,
    default: levels.includes(clampedDefault) ? clampedDefault : levels[levels.length - 1],
  };
}

function limitModel(model, options) {
  if (!model || typeof model !== 'object') return model;
  const reasoning = limitReasoningDescriptor(model.reasoning, options);
  if (!reasoning || reasoning.kind !== 'enum') return { ...model, ...(reasoning ? { reasoning } : {}) };
  return {
    ...model,
    reasoning,
    effortLevels: [...reasoning.levels],
    defaultEffort: reasoning.default,
  };
}

export function limitReasoningCatalog(catalog, options = {}) {
  if (!catalog || typeof catalog !== 'object') return catalog;
  const isGuestInstance = options.isGuestInstance ?? IS_GUEST_INSTANCE;
  if (!isGuestInstance) return catalog;
  const models = Array.isArray(catalog.models)
    ? catalog.models.map((model) => limitModel(model, { ...options, isGuestInstance }))
    : [];
  const reasoning = limitReasoningDescriptor(catalog.reasoning, { ...options, isGuestInstance });
  return {
    ...catalog,
    models,
    ...(reasoning ? { reasoning } : {}),
    effortLevels: reasoning?.kind === 'enum' ? [...reasoning.levels] : catalog.effortLevels,
  };
}

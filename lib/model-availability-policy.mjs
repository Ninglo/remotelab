const trim = value => typeof value === 'string' ? value.trim() : '';

function normalizeModelId(value) {
  return trim(value).toLowerCase().split('/').pop() || '';
}

export function getDisabledModelIds(value = process.env.REMOTELAB_DISABLED_MODELS) {
  return new Set(
    trim(value)
      .split(',')
      .map(normalizeModelId)
      .filter(Boolean),
  );
}

export function isRuntimeModelAllowed(_tool, model, options = {}) {
  const id = normalizeModelId(model);
  if (!id) return true;
  const disabled = options.disabledModels instanceof Set
    ? options.disabledModels
    : getDisabledModelIds(options.disabledModels);
  return !disabled.has(id);
}

export function limitModelCatalog(catalog, options = {}) {
  if (!catalog || typeof catalog !== 'object') return catalog;
  const models = Array.isArray(catalog.models)
    ? catalog.models.filter(model => isRuntimeModelAllowed(catalog.tool, model?.id, options))
    : [];
  const defaultModel = isRuntimeModelAllowed(catalog.tool, catalog.defaultModel, options)
    ? catalog.defaultModel
    : models[0]?.id || '';
  return { ...catalog, models, defaultModel };
}

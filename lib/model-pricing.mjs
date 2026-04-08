const MODEL_PRICING = Object.freeze({
  'gpt-5.4': Object.freeze({
    pricingModel: 'gpt-5.4',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
    costSource: 'estimated_gpt_5_4',
    inputIncludesCachedTokens: true,
  }),
  'gpt-5.4-mini': Object.freeze({
    pricingModel: 'gpt-5.4-mini',
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
    costSource: 'estimated_gpt_5_4_mini',
    inputIncludesCachedTokens: true,
  }),
  'gpt-5.4-nano': Object.freeze({
    pricingModel: 'gpt-5.4-nano',
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25,
    costSource: 'estimated_gpt_5_4_nano',
    inputIncludesCachedTokens: true,
  }),
  'claude-sonnet-4.6': Object.freeze({
    pricingModel: 'claude-sonnet-4.6',
    inputUsdPerMillion: 3,
    cacheWriteUsdPerMillion: 3.75,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    costSource: 'estimated_claude_sonnet_4_6',
    inputIncludesCachedTokens: false,
  }),
  'claude-sonnet-4.5': Object.freeze({
    pricingModel: 'claude-sonnet-4.5',
    inputUsdPerMillion: 3,
    cacheWriteUsdPerMillion: 3.75,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    costSource: 'estimated_claude_sonnet_4_5',
    inputIncludesCachedTokens: false,
  }),
  'claude-sonnet-4': Object.freeze({
    pricingModel: 'claude-sonnet-4',
    inputUsdPerMillion: 3,
    cacheWriteUsdPerMillion: 3.75,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 15,
    costSource: 'estimated_claude_sonnet_4',
    inputIncludesCachedTokens: false,
  }),
  'claude-opus-4.6': Object.freeze({
    pricingModel: 'claude-opus-4.6',
    inputUsdPerMillion: 5,
    cacheWriteUsdPerMillion: 6.25,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    costSource: 'estimated_claude_opus_4_6',
    inputIncludesCachedTokens: false,
  }),
  'claude-opus-4.5': Object.freeze({
    pricingModel: 'claude-opus-4.5',
    inputUsdPerMillion: 5,
    cacheWriteUsdPerMillion: 6.25,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
    costSource: 'estimated_claude_opus_4_5',
    inputIncludesCachedTokens: false,
  }),
  'claude-opus-4.1': Object.freeze({
    pricingModel: 'claude-opus-4.1',
    inputUsdPerMillion: 15,
    cacheWriteUsdPerMillion: 18.75,
    cachedInputUsdPerMillion: 1.5,
    outputUsdPerMillion: 75,
    costSource: 'estimated_claude_opus_4_1',
    inputIncludesCachedTokens: false,
  }),
  'claude-opus-4': Object.freeze({
    pricingModel: 'claude-opus-4',
    inputUsdPerMillion: 15,
    cacheWriteUsdPerMillion: 18.75,
    cachedInputUsdPerMillion: 1.5,
    outputUsdPerMillion: 75,
    costSource: 'estimated_claude_opus_4',
    inputIncludesCachedTokens: false,
  }),
  'claude-haiku-4.5': Object.freeze({
    pricingModel: 'claude-haiku-4.5',
    inputUsdPerMillion: 1,
    cacheWriteUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 5,
    costSource: 'estimated_claude_haiku_4_5',
    inputIncludesCachedTokens: false,
  }),
  'claude-haiku-3': Object.freeze({
    pricingModel: 'claude-haiku-3',
    inputUsdPerMillion: 0.25,
    cacheWriteUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.03,
    outputUsdPerMillion: 1.25,
    costSource: 'estimated_claude_haiku_3',
    inputIncludesCachedTokens: false,
  }),
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTokenCount(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

export function roundUsdMicros(value) {
  return Math.round(Number(value || 0) * 1e6) / 1e6;
}

function normalizeModelId(value) {
  return trimString(value).toLowerCase();
}

function matchExactModel(model, ...candidates) {
  return candidates.includes(model);
}

function matchModelPrefix(model, ...prefixes) {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

function resolveClaudePricingModel(normalizedModel) {
  if (!normalizedModel) return null;

  if (matchExactModel(normalizedModel, 'sonnet', 'claude-sonnet', 'claude-sonnet-latest')
    || matchModelPrefix(normalizedModel, 'claude-sonnet-4.6', 'claude-sonnet-4-6')) {
    return 'claude-sonnet-4.6';
  }
  if (matchModelPrefix(normalizedModel, 'claude-sonnet-4.5', 'claude-sonnet-4-5')) {
    return 'claude-sonnet-4.5';
  }
  if (matchModelPrefix(normalizedModel, 'claude-sonnet-4-', 'claude-sonnet-4.')) {
    return 'claude-sonnet-4';
  }

  if (matchExactModel(normalizedModel, 'opus', 'claude-opus', 'claude-opus-latest')
    || matchModelPrefix(normalizedModel, 'claude-opus-4.6', 'claude-opus-4-6')) {
    return 'claude-opus-4.6';
  }
  if (matchModelPrefix(normalizedModel, 'claude-opus-4.5', 'claude-opus-4-5')) {
    return 'claude-opus-4.5';
  }
  if (matchModelPrefix(normalizedModel, 'claude-opus-4.1', 'claude-opus-4-1')) {
    return 'claude-opus-4.1';
  }
  if (matchModelPrefix(normalizedModel, 'claude-opus-4-', 'claude-opus-4.')) {
    return 'claude-opus-4';
  }

  if (matchExactModel(normalizedModel, 'haiku', 'claude-haiku', 'claude-haiku-latest')
    || matchModelPrefix(normalizedModel, 'claude-haiku-4.5', 'claude-haiku-4-5')) {
    return 'claude-haiku-4.5';
  }
  if (matchModelPrefix(normalizedModel, 'claude-haiku-3-', 'claude-haiku-3.')) {
    return 'claude-haiku-3';
  }

  return null;
}

export function resolvePricingMetadata(model, options = {}) {
  const normalizedModel = normalizeModelId(model);
  const normalizedTool = normalizeModelId(options.tool);

  if (matchExactModel(normalizedModel, 'gpt-5.4')) {
    return MODEL_PRICING['gpt-5.4'];
  }
  if (matchExactModel(normalizedModel, 'gpt-5.4-mini')) {
    return MODEL_PRICING['gpt-5.4-mini'];
  }
  if (matchExactModel(normalizedModel, 'gpt-5.4-nano')) {
    return MODEL_PRICING['gpt-5.4-nano'];
  }

  const claudePricingModel = resolveClaudePricingModel(normalizedModel);
  if (claudePricingModel) {
    return MODEL_PRICING[claudePricingModel];
  }
  if (normalizedTool === 'claude' && !normalizedModel) {
    return MODEL_PRICING['claude-sonnet-4.6'];
  }

  return null;
}

export function getPricingMetadataForModel(model, options = {}) {
  return resolvePricingMetadata(model, options);
}

export function estimateUsageCost({
  model,
  tool,
  inputTokens,
  cachedInputTokens,
  cacheCreationInputTokens,
  outputTokens,
} = {}) {
  const pricing = resolvePricingMetadata(model, { tool });
  if (!pricing) return null;

  const input = normalizeTokenCount(inputTokens);
  const cachedRead = normalizeTokenCount(cachedInputTokens);
  const cachedWrite = normalizeTokenCount(cacheCreationInputTokens);
  const output = normalizeTokenCount(outputTokens);
  if (input === null && cachedRead === null && cachedWrite === null && output === null) {
    return null;
  }

  const normalizedInput = input || 0;
  const normalizedCachedRead = cachedRead || 0;
  const normalizedCachedWrite = cachedWrite || 0;
  const normalizedOutput = output || 0;
  const inputBilledAtStandardRate = pricing.inputIncludesCachedTokens
    ? Math.max(0, normalizedInput - Math.min(normalizedInput, normalizedCachedRead))
    : normalizedInput;

  const cost = (
    (inputBilledAtStandardRate * pricing.inputUsdPerMillion)
    + (normalizedCachedRead * (pricing.cachedInputUsdPerMillion || 0))
    + (normalizedCachedWrite * (pricing.cacheWriteUsdPerMillion || pricing.inputUsdPerMillion || 0))
    + (normalizedOutput * pricing.outputUsdPerMillion)
  ) / 1_000_000;

  return {
    estimatedCostUsd: roundUsdMicros(cost),
    pricingModel: pricing.pricingModel,
    costSource: pricing.costSource,
  };
}

export function estimateGpt54CostUsd({
  inputTokens,
  cachedInputTokens,
  outputTokens,
} = {}) {
  return estimateUsageCost({
    model: 'gpt-5.4',
    inputTokens,
    cachedInputTokens,
    outputTokens,
  })?.estimatedCostUsd ?? null;
}

export function getGpt54PricingMetadata() {
  return MODEL_PRICING['gpt-5.4'];
}

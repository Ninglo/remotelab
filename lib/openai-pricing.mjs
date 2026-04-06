const GPT_5_4_PRICING = Object.freeze({
  pricingModel: 'gpt-5.4',
  inputUsdPerMillion: 2.5,
  cachedInputUsdPerMillion: 0.25,
  outputUsdPerMillion: 15,
});

function pickNonNegativeInt(value) {
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

export function estimateGpt54CostUsd({
  inputTokens,
  cachedInputTokens,
  outputTokens,
} = {}) {
  const input = pickNonNegativeInt(inputTokens);
  const output = pickNonNegativeInt(outputTokens);
  if (input === null && output === null) return null;

  const normalizedInput = input || 0;
  const normalizedCached = Math.min(
    normalizedInput,
    pickNonNegativeInt(cachedInputTokens) || 0,
  );
  const normalizedOutput = output || 0;
  const uncachedInput = Math.max(0, normalizedInput - normalizedCached);

  const cost = (
    (uncachedInput * GPT_5_4_PRICING.inputUsdPerMillion)
    + (normalizedCached * GPT_5_4_PRICING.cachedInputUsdPerMillion)
    + (normalizedOutput * GPT_5_4_PRICING.outputUsdPerMillion)
  ) / 1_000_000;

  return roundUsdMicros(cost);
}

export function getGpt54PricingMetadata() {
  return {
    pricingModel: GPT_5_4_PRICING.pricingModel,
    costSource: 'estimated_gpt_5_4',
  };
}

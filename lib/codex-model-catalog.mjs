import { resolvePricingMetadata } from './model-pricing.mjs';

// Product baseline shared by Codex and Pi. Native catalogs may add more models.
export const CODEX_MODEL_CATALOG = Object.freeze([
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', contextWindow: 1050000 },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', contextWindow: 272000 },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', contextWindow: 272000 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', contextWindow: 272000 },
  { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', contextWindow: 272000 },
  { id: 'gpt-5.2', label: 'GPT-5.2', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', contextWindow: 400000 },
]);

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function getPiBaselineModels() {
  return CODEX_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.label,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    reasoning: true,
    // Pi cannot select Codex's ultra level. Do not advertise unsupported controls.
    thinkingLevelMap: Object.fromEntries(PI_THINKING_LEVELS.map((level) => [
      level, model.effortLevels.includes(level) ? level : null,
    ])),
    input: ['text', 'image'],
    contextWindow: model.contextWindow,
    maxTokens: 128000,
    cost: buildPiCost(model.id),
    compat: {
      supportsOpenAIGrammarTools: true,
      ...(model.id !== 'gpt-5.2' ? { supportsToolSearch: true } : {}),
      ...(model.effortLevels.includes('max') ? { supportsAdditionalTools: true } : {}),
    },
  }));
}

function buildPiCost(modelId) {
  const pricing = resolvePricingMetadata(modelId);
  const cost = {
    input: pricing.inputUsdPerMillion,
    output: pricing.outputUsdPerMillion,
    cacheRead: pricing.cachedInputUsdPerMillion,
    cacheWrite: pricing.cacheWriteUsdPerMillion || 0,
  };
  if (modelId !== 'gpt-5.2') {
    const scaledRate = (rate, multiplier) => Math.round(rate * multiplier * 1_000_000) / 1_000_000;
    cost.tiers = [{
      inputTokensAbove: 272000,
      input: scaledRate(cost.input, 2),
      output: scaledRate(cost.output, 1.5),
      cacheRead: scaledRate(cost.cacheRead, 2),
      cacheWrite: scaledRate(cost.cacheWrite, 2),
    }];
  }
  return cost;
}

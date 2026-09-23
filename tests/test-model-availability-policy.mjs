import assert from 'node:assert/strict';

process.env.REMOTELAB_DISABLED_MODELS = 'gpt-6-astra';

const { limitModelCatalog } = await import('../lib/model-availability-policy.mjs');
const {
  PRODUCT_DEFAULT_CODEX_MODEL,
  normalizeRuntimeModelForTool,
} = await import('../lib/legacy-micro-agent.mjs');
const { buildCodexArgs } = await import('../chat/adapters/codex.mjs');
const { buildPiArgs } = await import('../chat/adapters/pi.mjs');

assert.equal(normalizeRuntimeModelForTool('codex', 'gpt-6-astra'), PRODUCT_DEFAULT_CODEX_MODEL);
assert.equal(
  normalizeRuntimeModelForTool('pi', 'openai-codex/gpt-6-astra'),
  `openai-codex/${PRODUCT_DEFAULT_CODEX_MODEL}`,
);

const catalog = limitModelCatalog({
  tool: 'codex',
  defaultModel: 'gpt-6-astra',
  models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-sol' }],
});
assert.deepEqual(catalog.models.map(model => model.id), ['gpt-6-sol']);
assert.equal(catalog.defaultModel, 'gpt-6-sol');

const codexArgs = buildCodexArgs('test', { model: 'gpt-6-astra' });
assert.equal(codexArgs[codexArgs.indexOf('-m') + 1], PRODUCT_DEFAULT_CODEX_MODEL);
const piArgs = buildPiArgs('test', { provider: 'openai-codex', model: 'gpt-6-astra' });
assert.equal(piArgs[piArgs.indexOf('--model') + 1], PRODUCT_DEFAULT_CODEX_MODEL);

console.log('model availability policy: catalog, persistence and final process boundaries passed');

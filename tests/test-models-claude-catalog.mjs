#!/usr/bin/env node
import assert from 'assert/strict';
import { getModelsForTool } from '../chat/models.mjs';
import { getPricingMetadataForModel } from '../lib/model-pricing.mjs';
import { completeRuntimeProfile } from '../lib/runtime-profile.mjs';

const catalog = await getModelsForTool('claude');
const models = new Map(catalog.models.map((model) => [model.id, model]));
const fullEffort = ['low', 'medium', 'high', 'xhigh', 'max'];
assert.equal(catalog.models[0].id, 'sonnet', 'preserve the existing UI model default');
assert.deepEqual(
  completeRuntimeProfile({ tool: 'claude' }, catalog),
  { tool: 'claude', model: '', effort: '' },
  'a caller without a selected model should keep the native Claude Code defaults',
);

for (const id of ['fable', 'claude-fable-5-1', 'claude-fable-5', 'opus', 'claude-opus-5-5', 'sonnet', 'claude-sonnet-5']) {
  assert.deepEqual(models.get(id)?.effortLevels, fullEffort, `${id} should expose its supported effort levels`);
}
assert.equal(models.get('claude-opus-5-5')?.defaultEffort, 'medium');
assert.equal(models.get('claude-fable-5-1')?.defaultEffort, 'high');
assert.equal(models.get('claude-opus-4-7')?.defaultEffort, 'xhigh');
assert.deepEqual(models.get('claude-opus-4-6')?.effortLevels, ['low', 'medium', 'high', 'max']);
assert.deepEqual(models.get('claude-sonnet-4-6')?.effortLevels, ['low', 'medium', 'high', 'max']);
assert.equal(models.get('haiku')?.reasoning.kind, 'none');
assert.equal(models.get('claude-haiku-4-5-20251001')?.reasoning.kind, 'none');
assert.equal(catalog.effortLevels, null);

for (const [id, expectedPricingModel] of [
  ['fable', 'claude-fable-5-1'],
  ['claude-fable-5-1', 'claude-fable-5-1'],
  ['claude-fable-5', 'claude-fable-5'],
  ['opus', 'claude-opus-5-5'],
  ['claude-opus-5-5', 'claude-opus-5-5'],
  ['claude-opus-4-8', 'claude-opus-4.8'],
  ['claude-opus-4-7', 'claude-opus-4.7'],
  ['', 'claude-opus-5-5'],
]) {
  assert.equal(getPricingMetadataForModel(id, { tool: 'claude' })?.pricingModel, expectedPricingModel);
}

console.log('test-models-claude-catalog: ok');

#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  completeRuntimeProfile,
  normalizeRuntimeProfile,
  resolveRuntimeProfile,
  runtimeProfileFromUiSelection,
  runtimeProfileToUiSelection,
} from '../lib/runtime-profile.mjs';
import {
  GUEST_MAX_REASONING_EFFORT,
  clampReasoningEffort,
  limitReasoningCatalog,
} from '../lib/reasoning-effort-policy.mjs';

const catalog = {
  defaultModel: 'default-model',
  reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' },
  models: [
    { id: 'default-model', reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' } },
    { id: 'strong-model', reasoning: { kind: 'enum', levels: ['high'], default: 'high' } },
    { id: 'plain-model', reasoning: { kind: 'none' } },
  ],
};

assert.equal(GUEST_MAX_REASONING_EFFORT, 'xhigh');
assert.equal(clampReasoningEffort('ultra', { isGuestInstance: true }), 'xhigh');
assert.equal(clampReasoningEffort('max', { isGuestInstance: true }), 'xhigh');
assert.equal(clampReasoningEffort('xhigh', { isGuestInstance: true }), 'xhigh');
assert.equal(clampReasoningEffort('ultra', { isGuestInstance: false }), 'ultra');

const limitedCatalog = limitReasoningCatalog({
  models: [{
    id: 'sol',
    reasoning: {
      kind: 'enum',
      label: 'Thinking',
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      default: 'ultra',
    },
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'ultra',
  }],
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  reasoning: {
    kind: 'enum',
    label: 'Thinking',
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    default: 'ultra',
  },
}, { isGuestInstance: true });

assert.deepEqual(limitedCatalog.effortLevels, ['low', 'medium', 'high', 'xhigh']);
assert.deepEqual(limitedCatalog.models[0].effortLevels, ['low', 'medium', 'high', 'xhigh']);
assert.equal(limitedCatalog.models[0].defaultEffort, 'xhigh');
assert.equal(limitedCatalog.reasoning.default, 'xhigh');

assert.deepEqual(normalizeRuntimeProfile({ harness: ' codex ', model: ' model ', effort: ' high ' }), {
  tool: 'codex', model: 'model', effort: 'high',
});

assert.deepEqual(runtimeProfileFromUiSelection({
  selectedTool: 'claude', selectedModel: 'opus', selectedEffort: 'high',
}), { tool: 'claude', model: 'opus', effort: 'high' });

assert.deepEqual(runtimeProfileToUiSelection({ tool: 'codex', model: 'model', effort: 'high' }, 'none'), {
  selectedTool: 'codex', selectedModel: 'model', selectedEffort: '', reasoningKind: 'none',
});

const saved = { tool: 'codex', model: 'saved-model', effort: 'high' };
assert.deepEqual(resolveRuntimeProfile(saved, {}), saved, 'an absent override keeps the complete profile');
assert.deepEqual(resolveRuntimeProfile(saved, { tool: 'claude' }), {
  tool: 'claude', model: '', effort: '',
}, 'changing Harness must not carry model or effort across the boundary');
assert.deepEqual(resolveRuntimeProfile(saved, { model: 'new-model' }), {
  tool: 'codex', model: 'new-model', effort: '',
}, 'changing model must not carry effort across the boundary');
assert.deepEqual(resolveRuntimeProfile(saved, { effort: 'low' }), {
  tool: 'codex', model: 'saved-model', effort: 'low',
}, 'an effort-only override stays inside the saved Harness/model pair');

assert.deepEqual(completeRuntimeProfile({ tool: 'fake' }, catalog), {
  tool: 'fake', model: 'default-model', effort: 'low',
});
assert.deepEqual(completeRuntimeProfile({ tool: 'fake', model: 'strong-model' }, catalog), {
  tool: 'fake', model: 'strong-model', effort: 'high',
});
assert.deepEqual(completeRuntimeProfile({ tool: 'fake', model: 'plain-model', effort: 'high' }, catalog), {
  tool: 'fake', model: 'plain-model', effort: '',
});
assert.deepEqual(completeRuntimeProfile({ tool: 'fake', model: 'strong-model', effort: 'ultra' }, catalog), {
  tool: 'fake', model: 'strong-model', effort: 'high',
}, 'unsupported effort values must resolve to the selected model default');

console.log('runtime profile tests passed');

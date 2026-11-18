import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRuntimeExperiment, validateRuntimeExperiments } from '../chat/runtime-experiments.mjs';

const personId = 'person_test_alex';
const identityId = 'identity_alex_web';
const otherIdentityId = 'identity_other';
const document = { people: [
  { id: personId, identities: [{ id: identityId }, { id: 'identity_alex_feishu' }] },
  { id: 'person_other', identities: [{ id: otherIdentityId }] },
] };
const session = { id: 'example-session', creatorIdentityId: identityId };
const options = { usageActorKind: 'human', viewPersonId: personId, initiatedByIdentityId: 'identity_alex_feishu' };
const baseline = { tool: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh' };
const route = { ...baseline, thinking: false,
  autoRoutingReceipt: { status: 'routed', decision: { tier: 'sota' }, route: baseline } };
const rule = { id: 'test-v1', enabled: true, personIds: [personId], probability: 0.5, override: { tool: 'pi' } };
const tools = {
  read: async () => [rule], getDocument: () => document,
  loadTool: async () => ({ available: true }),
  loadModels: async () => ({ models: [{ id: 'openai-codex/gpt-6.2-astra', reasoning: { levels: ['low', 'xhigh'] } }] }),
};

function profile(result) {
  return { tool: result.tool, model: result.model, effort: result.effort };
}

test('50% assignment is per Session and retains the selected model, effort and tier', async () => {
  const results = await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const candidate = { ...session, id: `test-session-${index}` };
    const result = await applyRuntimeExperiment(route, candidate, options, tools);
    assert.deepEqual(await applyRuntimeExperiment(route, candidate, options, tools), result);
    const receipt = result.autoRoutingReceipt;
    assert.equal(receipt.decision.tier, 'sota');
    assert.deepEqual(receipt.experiment.baseline, baseline);
    assert.deepEqual(receipt.route, profile(result));
    assert.equal(result.thinking, false);
    if (receipt.experiment.arm === 'control') assert.deepEqual(profile(result), baseline);
    else assert.deepEqual(profile(result), { ...baseline, tool: 'pi', model: 'openai-codex/gpt-6.2-astra' });
    return receipt.experiment.arm;
  }));
  const variantCount = results.filter(arm => arm === 'variant').length;
  assert.ok(variantCount > 104 && variantCount < 152, `variant count ${variantCount}`);
});

test('eligibility uses both verified sender and ownership, even across identity channels', async () => {
  for (const [candidate, input] of [
    [session, { ...options, initiatedByIdentityId: otherIdentityId }],
    [{ ...session, creatorIdentityId: otherIdentityId }, options],
    [{ ...session, groupFeed: true }, options],
    [{ ...session, autoRouting: route.autoRoutingReceipt }, options],
    [session, { ...options, usageActorKind: 'agent' }],
  ]) {
    assert.equal(await applyRuntimeExperiment(route, candidate, input, tools), route);
  }
  assert.equal(await applyRuntimeExperiment(route, session, options,
    { ...tools, read: async () => [{ ...rule, enabled: false }] }), route);
});

test('tier filters can change model and effort, including the quality fallback', async () => {
  const overrides = [{ ...rule, probability: 1, tiers: ['quality'], override: { model: 'gpt-6.2-sol', effort: 'low' } }];
  const dependencies = { ...tools, read: async () => overrides,
    loadModels: async () => ({ models: [{ id: 'gpt-6.2-sol', reasoning: { levels: ['low'] } }] }) };
  assert.equal(await applyRuntimeExperiment(route, session, options, dependencies), route);
  const fallback = { ...route, autoRoutingReceipt: { status: 'fallback', route: baseline } };
  const result = await applyRuntimeExperiment(fallback, session, options, dependencies);
  assert.deepEqual(profile(result), { tool: 'codex', model: 'gpt-6.2-sol', effort: 'low' });
  assert.equal(result.autoRoutingReceipt.experiment.tier, 'quality');
  assert.throws(() => validateRuntimeExperiments({ experiments: [rule, rule] }));
  assert.throws(() => validateRuntimeExperiments({ experiments: [{ ...rule, personIds: [] }] }));
});

test('an unavailable tool or unsupported effort retains the baseline and labels the receipt', async () => {
  const read = async () => [{ ...rule, probability: 1 }];
  const scenarios = [
    [{ loadTool: async () => ({ available: false }) }, 'tool_unavailable'],
    [{ loadModels: async () => ({ models: [{ id: 'openai-codex/gpt-6.2-astra', reasoning: { levels: ['low'] } }] }) }, 'effort_unavailable'],
  ];
  for (const [changes, reason] of scenarios) {
    const result = await applyRuntimeExperiment(route, session, options, { ...tools, read, ...changes });
    assert.deepEqual(profile(result), baseline);
    assert.equal(result.autoRoutingReceipt.experiment.arm, 'variant');
    assert.equal(result.autoRoutingReceipt.experiment.status, 'unavailable');
    assert.equal(result.autoRoutingReceipt.experiment.reason, reason);
  }
});

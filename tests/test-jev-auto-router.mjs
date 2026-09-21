import assert from 'node:assert/strict';
import test from 'node:test';
import { applyJevAutoPolicy, resolveJevAutoRoute } from '../lib/jev-auto-router.mjs';

function choice(selected, confidence, options) {
  const selectedProbability = confidence >= 0.6 ? 0.8 : 0.45;
  const remainder = (1 - selectedProbability) / (options.length - 1);
  return {
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(options.map(option => [
      option,
      option === selected ? selectedProbability : remainder,
    ])),
  };
}

function answers({ model = 'luna', modelConfidence = 0.9, depth = 'quick', depthConfidence = 0.9,
  risk = 'low', riskConfidence = 0.9 } = {}) {
  return {
    model_tier: choice(model, modelConfidence, ['luna', 'sol', 'astra']),
    depth: choice(depth, depthConfidence, ['quick', 'balanced', 'deep', 'maximum']),
    risk: choice(risk, riskConfidence, ['low', 'medium', 'high']),
  };
}

test('low-risk mechanical work routes to Luna at low effort', () => {
  const route = applyJevAutoPolicy(answers());
  assert.deepEqual(
    { tool: route.tool, model: route.model, effort: route.effort },
    { tool: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
  );
});

test('uncertainty only escalates model and effort', () => {
  const route = applyJevAutoPolicy(answers({
    model: 'luna',
    modelConfidence: 0.4,
    depth: 'deep',
    depthConfidence: 0.3,
  }));
  assert.equal(route.model, 'gpt-5.6-sol');
  assert.equal(route.effort, 'high');
  assert.deepEqual(route.policy.reasons, ['model_uncertain', 'depth_uncertain']);
});

test('high or materially probable high risk uses the Astra safety floor', () => {
  assert.equal(applyJevAutoPolicy(answers({ risk: 'high' })).model, 'gpt-6-astra');
  const uncertain = applyJevAutoPolicy(answers({ model: 'luna', riskConfidence: 0.4 }));
  assert.equal(uncertain.model, 'gpt-6-astra');
  assert.equal(uncertain.effort, 'high');
  assert.equal(uncertain.policy.reasons[0], 'high_risk_probability');
});

test('ordinary medium risk below the safety threshold keeps the selected tier', () => {
  const input = answers({ model: 'sol', depth: 'balanced', risk: 'medium' });
  input.risk = {
    choice: 'medium',
    confidence: 0.46,
    probabilities: { low: 0.32, medium: 0.46, high: 0.22 },
  };
  const route = applyJevAutoPolicy(input);
  assert.equal(route.model, 'gpt-5.6-sol');
  assert.equal(route.effort, 'medium');
  assert.deepEqual(route.policy.reasons, []);
});

test('successful API decisions return a bounded receipt without prompt or key', async () => {
  const route = await resolveJevAutoRoute('Read package.json and return the version.', {
    apiKey: 'private-test-key',
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.authorization, 'Bearer private-test-key');
      return {
        ok: true,
        json: async () => ({ model: 'jev-test', answers: answers() }),
      };
    },
  });
  assert.equal(route.model, 'gpt-5.6-luna');
  assert.equal(route.autoRoutingReceipt.status, 'routed');
  const serialized = JSON.stringify(route.autoRoutingReceipt);
  assert.doesNotMatch(serialized, /private-test-key|package\.json/);
});

test('API failures fall back to Astra without throwing', async () => {
  const route = await resolveJevAutoRoute('Do work', {
    apiKey: 'private-test-key',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(route.model, 'gpt-6-astra');
  assert.equal(route.effort, 'high');
  assert.equal(route.autoRoutingReceipt.reason, 'http_503');
});

test('concrete runtime selections do not invoke Jev', async () => {
  const { resolveSessionRuntimeSelection } = await import('../chat/session-runtime-selection.mjs');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Jev must not be called'); };
  try {
    const route = await resolveSessionRuntimeSelection({
      tool: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
    }, { autoRoutingText: 'Implement a feature.' });
    assert.equal(route.model, 'gpt-5.6-sol');
    assert.equal(route.effort, 'medium');
    assert.equal(route.autoRoutingReceipt, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

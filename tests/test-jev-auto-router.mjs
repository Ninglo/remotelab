import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'remotelab-jev-routing-'));
setIsolatedTestHome(testHome);
test.after(() => rm(testHome, { recursive: true, force: true }));
const {
  applyJevAutoPolicy,
  getJevRoutingSettings,
  normalizeJevTierProfiles,
  resolveJevAutoRoute,
  resolveJevTierPreset,
  updateJevRoutingSettings,
} = await import('../lib/jev-auto-router.mjs');

function answer(tier = 'quality', confidence = 0.9, probabilities = null) {
  const defaults = {
    quick: { quick: 0.92, sota: 0.005, quality: 0.055, balanced: 0.015, economy: 0.005 },
    sota: { sota: 0.92, quality: 0.06, balanced: 0.015, economy: 0.005 },
    quality: { sota: 0.01, quality: 0.9, balanced: 0.07, economy: 0.02 },
    balanced: { sota: 0.005, quality: 0.095, balanced: 0.85, economy: 0.05 },
    economy: { sota: 0.005, quality: 0.015, balanced: 0.03, economy: 0.95 },
  };
  return {
    service_tier: {
      choice: tier,
      confidence,
      probabilities: { quick: 0, ...(probabilities || defaults[tier]) },
    },
  };
}

test('five service tiers map to fixed model and effort profiles', () => {
  assert.deepEqual(
    (({ model, effort }) => ({ model, effort }))(applyJevAutoPolicy(answer('quick'))),
    { model: 'gpt-6-sol', effort: 'low' },
  );
  assert.deepEqual(
    (({ tool, model, effort }) => ({ tool, model, effort }))(applyJevAutoPolicy(answer('sota'))),
    { tool: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
  );
  assert.deepEqual(
    (({ tool, model, effort }) => ({ tool, model, effort }))(applyJevAutoPolicy(answer('quality'))),
    { tool: 'codex', model: 'gpt-6-sol', effort: 'xhigh' },
  );
  assert.deepEqual(
    (({ model, effort }) => ({ model, effort }))(applyJevAutoPolicy(answer('balanced'))),
    { model: 'gpt-6-sol', effort: 'medium' },
  );
  assert.deepEqual(
    (({ model, effort }) => ({ model, effort }))(applyJevAutoPolicy(answer('economy'))),
    { model: 'gpt-6-luna', effort: 'low' },
  );
});

test('uncertain downgrade and material quality probability return to quality', () => {
  const uncertain = applyJevAutoPolicy(answer('economy', 0.4, {
    sota: 0, quality: 0.3, balanced: 0.15, economy: 0.55,
  }));
  assert.equal(uncertain.policy.tier, 'quality');
  assert.deepEqual(uncertain.policy.reasons, ['tier_uncertain']);

  const mixed = applyJevAutoPolicy(answer('balanced', 0.9, {
    sota: 0, quality: 0.26, balanced: 0.7, economy: 0.04,
  }));
  assert.equal(mixed.policy.tier, 'quality');
  assert.deepEqual(mixed.policy.reasons, ['quality_probability']);

  const riskyQuick = applyJevAutoPolicy(answer('quick', 0.9, {
    quick: 0.72, sota: 0, quality: 0.22, balanced: 0.06, economy: 0,
  }));
  assert.equal(riskyQuick.policy.tier, 'quality');
});

test('uncertain SOTA requests return to quality', () => {
  const route = applyJevAutoPolicy(answer('sota', 0.6, {
    sota: 0.6, quality: 0.35, balanced: 0.04, economy: 0.01,
  }));
  assert.equal(route.policy.tier, 'quality');
  assert.deepEqual(route.policy.reasons, ['sota_uncertain']);
});

test('tier profiles are configurable while invalid fields keep safe defaults', () => {
  const profiles = normalizeJevTierProfiles({
    sota: { model: 'frontier', effort: 'xhigh' },
    quality: { model: 'future-sota', effort: 'high' },
    balanced: { model: 'sweet-spot', effort: 'medium' },
    economy: { model: '', effort: 'invalid' },
  });
  assert.deepEqual(profiles, {
    quick: { model: 'gpt-6-sol', effort: 'low' },
    sota: { model: 'frontier', effort: 'xhigh' },
    quality: { model: 'future-sota', effort: 'high' },
    balanced: { model: 'sweet-spot', effort: 'medium' },
    economy: { model: 'gpt-6-luna', effort: 'low' },
  });
});

test('successful API decisions use the tier config file and return a bounded receipt', async () => {
  const tierConfigFile = join(testHome, 'jev-routing.json');
  await writeFile(tierConfigFile, JSON.stringify({
    sota: { model: 'frontier', effort: 'xhigh' },
    quality: { model: 'future-sota', effort: 'high' },
    balanced: { model: 'sweet-spot', effort: 'medium' },
    economy: { model: 'cheap-model', effort: 'low' },
  }));
  const route = await resolveJevAutoRoute('Read package.json and return the version.', {
    apiKey: 'private-test-key',
    tierConfigFile,
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.authorization, 'Bearer private-test-key');
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body.questions), ['service_tier']);
      assert.match(body.questions.service_tier.instructions, /Choose quality if context/);
      assert.ok(body.questions.service_tier.criteria.quick);
      return {
        ok: true,
        json: async () => ({ model: 'jev-test', answers: answer('balanced') }),
      };
    },
  });
  assert.equal(route.model, 'sweet-spot');
  assert.equal(route.effort, 'medium');
  assert.equal(route.autoRoutingReceipt.decision.tier, 'balanced');
  const serialized = JSON.stringify(route.autoRoutingReceipt);
  assert.doesNotMatch(serialized, /private-test-key|package\.json/);
});

test('session presets resolve through the same configurable tier map', async () => {
  const tierConfigFile = join(testHome, 'preset-routing.json');
  await writeFile(tierConfigFile, JSON.stringify({
    sota: { model: 'future-frontier', effort: 'xhigh' },
    quality: { model: 'future-quality', effort: 'high' },
  }));
  assert.deepEqual(await resolveJevTierPreset('sota', { tierConfigFile }), {
    tier: 'sota', tool: 'codex', model: 'future-frontier', effort: 'xhigh', thinking: false,
  });
  await assert.rejects(() => resolveJevTierPreset('auto', { tierConfigFile }), /Unknown Jev tier/);
  await assert.rejects(() => resolveJevTierPreset('unknown', { tierConfigFile }), /Unknown Jev tier/);
});

test('routing settings persist five tiers and the Quick prompt without exposing credentials', async () => {
  const tierConfigFile = join(testHome, 'settings-routing.json');
  const settings = await updateJevRoutingSettings({
    tiers: { quick: { model: 'gpt-6-sol', effort: 'low' } },
    quickPrompt: 'Answer briefly and use tools when needed.',
  }, { tierConfigFile });
  assert.equal(settings.tiers.quick.effort, 'low');
  assert.equal((await getJevRoutingSettings({ tierConfigFile })).quickPrompt, 'Answer briefly and use tools when needed.');
  await assert.rejects(() => updateJevRoutingSettings({ tiers: { quick: { model: 'auto', effort: 'low' } } }, { tierConfigFile }), /Invalid model or effort/);
});

test('API failures fall back to the configured quality tier without throwing', async () => {
  const route = await resolveJevAutoRoute('Do work', {
    apiKey: 'private-test-key',
    tierProfiles: { quality: { model: 'configured-quality', effort: 'high' } },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(route.model, 'configured-quality');
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

test('routing receipts survive run creation and status updates on disk', async () => {
  const { createRun, updateRun, runDir } = await import('../chat/runs.mjs');
  const receipt = { provider: 'typesafe', status: 'routed', route: { model: 'gpt-5.6-luna', effort: 'low' } };
  const run = await createRun({
    status: { sessionId: 'jev-test', autoRoutingReceipt: receipt },
    manifest: { autoRoutingReceipt: receipt },
  });
  await updateRun(run.id, current => ({ ...current, state: 'running' }));
  const persisted = JSON.parse(await readFile(join(runDir(run.id), 'status.json'), 'utf8'));
  assert.deepEqual(persisted.autoRoutingReceipt, receipt);
});

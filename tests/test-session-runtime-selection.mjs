import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-session-runtime-'));
setIsolatedTestHome(home);
try {
  const { resolveSessionRuntimeSelection } = await import('../chat/session-runtime-selection.mjs');
  const defaults = { tool: 'codex', model: 'gpt-5.6-sol', effort: 'low', thinking: false };
  const autoDefault = await resolveSessionRuntimeSelection({ tool: 'codex' });
  assert.deepEqual(
    { tool: autoDefault.tool, model: autoDefault.model, effort: autoDefault.effort, thinking: autoDefault.thinking },
    { tool: 'codex', model: 'gpt-5.6-sol', effort: 'high', thinking: false },
    'an incomplete new Codex Session starts from Auto and safely falls back to quality',
  );
  assert.equal(autoDefault.autoRoutingReceipt.status, 'fallback');
  assert.deepEqual(await resolveSessionRuntimeSelection({ tool: 'codex' }, { model: 'gpt-5.6-sol', effort: 'xhigh' }), {
    ...defaults, model: 'gpt-5.6-sol', effort: 'xhigh',
  });
  assert.deepEqual(await resolveSessionRuntimeSelection({ ...defaults, effort: 'ultra' }), { ...defaults, effort: 'ultra' });
  assert.deepEqual(
    await resolveSessionRuntimeSelection({ tool: 'codex', model: 'gpt-6-astra', effort: 'ultra' }),
    { ...defaults, model: 'gpt-6-astra', effort: 'ultra' },
    'explicit Astra Session snapshots should remain on Astra',
  );
  assert.deepEqual(
    await resolveSessionRuntimeSelection({ tool: 'pi', model: 'openai-codex/gpt-6-astra', effort: 'max' }),
    { tool: 'pi', model: 'openai-codex/gpt-6-astra', effort: 'max', thinking: false },
    'explicit Astra Pi snapshots should keep the Codex subscription route',
  );
  const switchedToCodex = await resolveSessionRuntimeSelection(
    { tool: 'claude', model: 'opus', effort: 'high' },
    { tool: 'codex' },
  );
  assert.deepEqual(
    { tool: switchedToCodex.tool, model: switchedToCodex.model, effort: switchedToCodex.effort },
    { tool: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    'switching to Codex without a concrete model starts from Auto',
  );
  assert.equal((await resolveSessionRuntimeSelection({ ...defaults, effort: 'ultra' }, { model: 'gpt-5.6-luna' })).effort, 'medium', 'a different model resolves its own default effort');
  assert.equal((await resolveSessionRuntimeSelection({ tool: 'unlisted-tool' })).model, '', 'unknown runtime defaults remain explicitly unresolved');
  const migratedAuto = await resolveSessionRuntimeSelection({ tool: 'micro-agent' });
  assert.deepEqual(
    { tool: migratedAuto.tool, model: migratedAuto.model, effort: migratedAuto.effort },
    { tool: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
  );
  const previousFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = 'private-test-key';
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        model: 'jev-test',
        answers: {
          service_tier: { choice: 'economy', confidence: 0.9, probabilities: { sota: 0, quality: 0.02, balanced: 0.03, economy: 0.95 } },
        },
      }),
    });
    const auto = await resolveSessionRuntimeSelection(
      { tool: 'codex', model: 'auto' },
      { autoRoutingText: 'Read package.json and return the version.' },
    );
    assert.deepEqual(
      { tool: auto.tool, model: auto.model, effort: auto.effort },
      { tool: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
    );
    assert.equal(auto.autoRoutingReceipt.status, 'routed');
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.TYPESAFE_API_KEY;
  }
  assert.deepEqual(
    await resolveSessionRuntimeSelection(
      { executionProfile: 'quick', tool: 'claude', model: 'opus', effort: 'high', thinking: true },
      { tool: 'pi', model: 'provider/model', effort: 'max', thinking: true },
    ),
    { tool: 'codex', model: 'gpt-5.6-terra', effort: 'low', thinking: false },
    'Quick Sessions ignore every per-message and persisted runtime override',
  );
  const pinned = { tool: 'codex', model: 'gpt-5.6-sol', effort: 'high', thinking: false };
  const session = { ...defaults, feishuRuntimeSelection: pinned };
  const inherited = { tool: 'claude', model: 'opus', effort: '', sourceContext: { connector: 'feishu' } };
  assert.deepEqual(await resolveSessionRuntimeSelection(session, inherited), pinned,
    'a Session snapshot wins over later connector defaults');
  assert.deepEqual(await resolveSessionRuntimeSelection(session, { ...defaults, sourceContext: { connector: 'wechat' } }), pinned,
    'the Session snapshot applies to every connector surface');
  assert.deepEqual(await resolveSessionRuntimeSelection(session, defaults), defaults,
    'Web UI requests can still make their own explicit selection');
  assert.equal((await resolveSessionRuntimeSelection({ ...session, feishuRuntimeSelection: null }, inherited)).tool, 'codex',
    'clearing the legacy field does not change the generic Session snapshot');
  assert.deepEqual(await resolveSessionRuntimeSelection(session, { ...inherited, sourceContext: undefined, sourceDelivery: { connector: 'feishu' } }), pinned);
  assert.deepEqual(
    await resolveSessionRuntimeSelection(pinned, { sourceContext: { connector: 'feishu' } }),
    pinned,
    'the generic Session runtime snapshot applies to Feishu without a connector-specific override',
  );
  assert.deepEqual(
    await resolveSessionRuntimeSelection(pinned, { sourceContext: { connector: 'wechat' } }),
    pinned,
    'the generic Session runtime snapshot applies consistently to every connector',
  );
  assert.deepEqual(
    await resolveSessionRuntimeSelection({ ...defaults, feishuRuntimeSelection: pinned }, { sourceContext: { connector: 'wechat' } }),
    pinned,
    'legacy connector snapshots are treated as Session snapshots during migration',
  );
  const noEffort = { tool: 'unlisted-tool', model: 'plain', effort: '', thinking: false };
  assert.deepEqual(await resolveSessionRuntimeSelection({ ...noEffort, effort: 'high', feishuRuntimeSelection: noEffort }, inherited), noEffort,
    'an explicit empty effort must not inherit the last running model effort');
  console.log('test-session-runtime-selection: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

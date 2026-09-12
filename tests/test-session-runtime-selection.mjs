import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-session-runtime-'));
setIsolatedTestHome(home);
try {
  const { resolveSessionRuntimeSelection } = await import('../chat/session-runtime-selection.mjs');
  const defaults = { tool: 'codex', model: 'gpt-6-astra', effort: 'low', thinking: false };
  assert.deepEqual(await resolveSessionRuntimeSelection({ tool: 'codex' }), defaults);
  assert.deepEqual(await resolveSessionRuntimeSelection({ tool: 'codex' }, { model: 'gpt-5.6-sol', effort: 'xhigh' }), {
    ...defaults, model: 'gpt-5.6-sol', effort: 'xhigh',
  });
  assert.deepEqual(await resolveSessionRuntimeSelection({ ...defaults, effort: 'ultra' }), { ...defaults, effort: 'ultra' });
  assert.deepEqual(await resolveSessionRuntimeSelection({ tool: 'claude', model: 'opus', effort: 'high' }, { tool: 'codex' }), defaults);
  assert.equal((await resolveSessionRuntimeSelection({ ...defaults, effort: 'ultra' }, { model: 'gpt-5.6-luna' })).effort, 'medium', 'a different model resolves its own default effort');
  assert.equal((await resolveSessionRuntimeSelection({ tool: 'unlisted-tool' })).model, '', 'unknown runtime defaults remain explicitly unresolved');
  assert.deepEqual(await resolveSessionRuntimeSelection({ tool: 'micro-agent' }), defaults);
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

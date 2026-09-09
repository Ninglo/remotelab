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
  console.log('test-session-runtime-selection: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

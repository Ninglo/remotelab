import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-visible-delegation-'));
setIsolatedTestHome(home);
try {
  await mkdir(join(home, '.config/remotelab'), { recursive: true });
  await writeFile(join(home, '.config/remotelab/tools.json'), JSON.stringify([
    { id: 'bare-test', command: 'echo', runtimeFamily: 'claude-stream-json', promptMode: 'bare-user' },
  ]));
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  for (const tool of ['codex', 'claude', 'pi']) {
    const source = { id: 'parent', tool, systemPrompt: '', activeAgreements: [] };
    const snapshot = { userMessageCount: 1, events: [], latestSeq: 0 };
    for (const resumed of [false, true]) {
      const session = { ...source, ...(resumed ? { codexThreadId: 'codex-thread', claudeSessionId: 'claude-thread' } : {}) };
      const prompt = await buildPrompt('parent', session, 'Inspect the work', tool, tool, snapshot,
        { freshThread: !resumed, skipSessionContinuation: true });
      assert.match(prompt, /session-spawn --guide/, `${tool} ${resumed ? 'resumed' : 'fresh'} exposes the shipped guide`);
      assert.match(prompt, /user-visible independent session/, `${tool} exposes visible delegation semantics`);
      assert.match(prompt, /sessionUrl/, 'the receipt link is the handoff, not a promised callback');
      assert.doesNotMatch(prompt, /--internal --output-mode final-only/, 'normal discovery must not recommend hiding work');
    }
    const child = await buildPrompt('child', { ...source, delegationDepth: 1 }, 'Execute this task', tool, tool, snapshot,
      { skipSessionContinuation: true });
    assert.doesNotMatch(child, /session-spawn --guide/, 'children do not get recursive delegation discovery');
  }
  const bare = await buildPrompt('bare', { tool: 'bare-test' }, 'Plain input', 'bare-test', 'bare-test',
    { userMessageCount: 0, latestSeq: 0 }, { skipSessionContinuation: true });
  assert.equal(bare, 'Plain input', 'custom bare-user runtimes keep their opt-out');
  const { resolveDelegationRuntime } = await import('../chat/session-delegation-runtime.mjs');
  const source = { id: 'parent', tool: 'codex', model: 'gpt-6-astra', effort: 'low' };
  const running = { sessionId: 'parent', tool: 'codex', model: 'gpt-5.6-sol', effort: 'high', thinking: false };
  const getRun = async id => id === 'parent-run' ? running : id === 'other-run' ? { ...running, sessionId: 'other' } : null;
  assert.deepEqual(await resolveDelegationRuntime(source, { sourceRunId: 'parent-run' }, getRun),
    { tool: 'codex', model: 'gpt-5.6-sol', effort: 'high', thinking: false }, 'inherit the invoking run, not changed global/session defaults');
  const switched = await resolveDelegationRuntime(source, { sourceRunId: 'parent-run', tool: 'claude' }, getRun);
  assert.equal(switched.tool, 'claude');
  assert.notEqual(switched.model, running.model, 'cross-Harness delegation resets incompatible model');
  await assert.rejects(resolveDelegationRuntime(source, { sourceRunId: 'other-run' }, getRun), /source session/);
  await assert.rejects(resolveDelegationRuntime(source, { sourceRunId: 'missing' }, getRun), /source session/);
  const { runSessionSpawnCommand } = await import('../lib/session-spawn-command.mjs');
  let guide = '';
  assert.equal(await runSessionSpawnCommand(['--guide'], { stdout: { write: s => { guide += s; } } }), 0);
  assert.match(guide, /session-spawn/);
  assert.match(guide, /sessionUrl/);
  assert.match(guide, /--task-file/);
  console.log('test-visible-session-delegation: ok');
} finally { await rm(home, { recursive: true, force: true }); }

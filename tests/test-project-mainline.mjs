import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initMainline, checkpointMainline, showMainline, mainlineHook, mainlineFinalAllowed, reviseMainline, projectMainlineHooks } from '../lib/project-mainline.mjs';
const dir = await mkdtemp(join(tmpdir(), 'project-mainline-'));
const session = 'fixture';
const sop = { goal: 'Verify two outputs', scope: 'fixture only', sourceRequestId: 'human-1', nodes: [
  { id: 'a', title: 'A', method: 'write evidence', dependsOn: [], acceptance: ['file is valid'] },
  { id: 'b', title: 'B', method: 'read A', dependsOn: ['a'], acceptance: ['B validated'] },
] };
try {
  assert.deepEqual(projectMainlineHooks('unbound', dir), []);
  await initMainline({ id: 'project', title: 'Fixture', projectId: 'real-device', sessionId: session, sop }, dir);
  await assert.rejects(initMainline({ id: 'project', title: 'Fixture', projectId: 'real-device', sessionId: session, sop }, dir), /Already registered/);
  const begin = () => mainlineHook(session, { hook_event_name: 'UserPromptSubmit', turn_id: 'turn' }, dir);
  const stop = () => mainlineHook(session, { hook_event_name: 'Stop', turn_id: 'turn' }, dir);
  assert.match(JSON.stringify(await begin()), /Verify two outputs/);
  assert.equal((await stop()).decision, 'block', 'cannot finish without checkpoint');
  const checkpoint = async patch => {
    const shown = await showMainline(session, dir);
    return checkpointMainline(session, { expectedRevision: shown.state.revision, inputToken: shown.inputToken,
      sourceRequestId: 'human-1', summary: 'fixture update', decision: 'continue', nextAction: 'next step', ...patch }, dir);
  };
  await assert.rejects(checkpoint({ decision: 'complete' }), /Project incomplete/);
  await assert.rejects(checkpoint({ nodes: [{ id: 'b', status: 'running', note: 'premature' }] }), /Dependency incomplete/);
  await assert.rejects(checkpoint({ nodes: [{ id: 'a', status: 'done', note: 'asserted' }] }), /criteria need evidence/);
  await assert.rejects(checkpoint({ decision: 'wait', wait: { kind: 'external' } }), /wait.owner required/);
  await checkpoint({ nodes: [{ id: 'a', status: 'running', note: 'working' }] });
  assert.equal((await stop()).decision, 'block', 'continue decision cannot end the project turn');
  await checkpoint({ decision: 'wait', wait: { kind: 'human', owner: 'operator', reason: 'fixture', resumeWhen: 'human answers', wakeRef: 'this conversation' } });
  assert.deepEqual(await stop(), {}); assert(mainlineFinalAllowed(session, 'turn', dir));
  const old = await showMainline(session, dir);
  await begin();
  assert.equal((await stop()).decision, 'block', 'new input invalidates old checkpoint');
  await assert.rejects(checkpointMainline(session, { expectedRevision: old.state.revision, inputToken: old.inputToken }, dir), /inputToken/);
  await mainlineHook(session, { hook_event_name: 'Interrupt', turn_id: 'turn' }, dir);
  await assert.rejects(checkpoint({}), /explicit resume source/);
  await checkpoint({ decision: 'paused', pauseReason: 'human stopped' });
  assert.deepEqual(await stop(), {});
  const artifact = join(dir, 'evidence.json'); await writeFile(artifact, '{"verified":true}');
  const evidence = { path: artifact, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') };
  const done = id => ({ id, status: 'done', note: 'verified fixture', checks: [{ index: 0, passed: true, evidence: [evidence] }] });
  await checkpoint({ resumeSourceRequestId: 'human-2', nodes: [done('a'), done('b')], decision: 'complete' });
  assert.deepEqual(await stop(), {});
  assert.equal((await showMainline(session, dir)).state.status, 'completed');
  const current = await showMainline(session, dir);
  await assert.rejects(checkpointMainline(session, { expectedRevision: 1 }, dir), /Stale/);
  const newSop = structuredClone(sop); newSop.nodes[1].acceptance = ['new criterion'];
  await reviseMainline(session, { expectedRevision: current.state.revision, reason: 'human changes criterion', sop: newSop }, dir);
  const revised = await showMainline(session, dir);
  assert.equal(revised.state.progress.a.status, 'done'); assert.equal(revised.state.progress.b.status, 'pending');
  assert.equal(revised.state.status, 'active'); assert(revised.state.history.some(x => x.previousSop));
  await begin(); await stop(); await stop(); assert.equal((await stop()).continue, false, 'unchanged invalid stop loop is finite');
  assert.equal(mainlineFinalAllowed(session, 'turn', dir), false);
  console.log('project-mainline: state, evidence, dependencies, pause, revision, readback and bounded failure passed');
} finally { await rm(dir, { recursive: true, force: true }); }

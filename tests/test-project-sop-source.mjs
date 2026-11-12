import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessProjectRequest, readSopDocument } from '../lib/project-sop-source.mjs';
import { initMainline, showMainline, checkpointMainline, reviseMainline, mainlineHook,
  projectMainlineHooks, mainlineFinalAllowed, setMainlineBinding, runProjectTrack } from '../lib/project-mainline.mjs';

const dir = await mkdtemp(join(tmpdir(), 'sop-source-fixture-'));
const human = { sourceRequestId: 'human-fixture', evidence: 'Complete a real-device experiment and keep its progress' };
const projectRequest = { ...human, kind: 'project', domain: 'real_device', object: 'Fixture robot and task', goal: 'Verify the experiment', needsTracking: true };
try {
  // These validate structured routing; they do not claim an NLP classification score.
  for (const kind of ['discussion', 'status', 'framework']) assert.equal(assessProjectRequest({ ...human, kind }).route, 'ordinary');
  assert.equal(assessProjectRequest({ ...human, kind: 'atomic' }).route, 'atomic');
  assert.equal(assessProjectRequest({ ...projectRequest, domain: 'simulation' }).route, 'ordinary');
  assert.equal(assessProjectRequest({ ...projectRequest, object: '' }).route, 'needs_context');
  assert.equal(assessProjectRequest({ ...projectRequest, needsTracking: false }).route, 'needs_context');
  assert.equal(assessProjectRequest(projectRequest).route, 'bind_sop');
  assert.equal(assessProjectRequest({ ...human, kind: 'followup', sameProject: true }).route, 'needs_context');
  assert.throws(() => assessProjectRequest({ ...projectRequest, evidence: '' }), /human evidence/);

  const source = join(dir, 'source.md');
  const original = '# Fixture SOP\n## Data\nPrepare the fixture dataset.\n## Test\nRun the fixture test.\n';
  await writeFile(source, original);
  const sop = { goal: projectRequest.goal, scope: 'Synthetic fixture; no real equipment', sourceRequestId: human.sourceRequestId,
    document: { kind: 'local', path: source }, nodes: [
      { id: 'data', title: 'Data', method: 'fixture only', source: '## Data', dependsOn: [], acceptance: ['data verified'] },
      { id: 'test', title: 'Test', method: 'fixture only', source: '## Test', dependsOn: ['data'], acceptance: ['test verified'] },
    ] };
  const init = { id: 'experiment', title: 'Synthetic project', projectId: 'fixture-group', sessionId: 'fixture', sop, request: projectRequest };
  await assert.rejects(initMainline({ ...init, request: { ...human, kind: 'discussion' } }, dir), /requires.*project request/);
  const bound = await initMainline(init, dir);
  assert.equal(bound.binding.enabled, false, 'recognition and binding do not enable an experiment');
  assert.deepEqual(projectMainlineHooks('fixture', dir), []);
  assert.equal(assessProjectRequest({ ...human, kind: 'followup', sameProject: true }, bound).action, 'keep_disabled');
  assert.equal(assessProjectRequest(projectRequest, bound).route, 'needs_context', 'do not overwrite a different project');
  await assert.rejects(initMainline(init, dir), /Already registered/);
  const read = await showMainline('fixture', dir);
  assert.equal(read.sopDocument.content, original);
  assert.equal(read.sopDocument.writeback, 'deferred');
  assert.equal(read.sopDocument.changed, false);
  assert.match(read.readback, /SOP 写回：待接入/);
  await setMainlineBinding('fixture', { enabled: true, ...human, reason: 'Explicit isolated fixture experiment' }, dir);
  assert.equal(projectMainlineHooks('fixture', dir).length, 4);
  await mainlineHook('fixture', { hook_event_name: 'UserPromptSubmit', turn_id: 'fixture-turn' }, dir);
  const check = async changes => {
    const current = await showMainline('fixture', dir);
    return checkpointMainline('fixture', { expectedRevision: current.state.revision, inputToken: current.inputToken,
      ...human, summary: 'fixture result', decision: 'continue', nextAction: 'fixture test', ...changes }, dir);
  };
  const progress = await check({ nodes: [{ id: 'data', status: 'running', note: 'fixture in progress' }] });
  assert.equal(progress.sopDocument.content, original, 'checkpoint returns the original SOP and todo');
  assert.equal(await readFile(source, 'utf8'), original, 'deferred writer never changes source');
  await assert.rejects(check({ decision: 'complete' }), /incomplete/);
  await writeFile(source, original + '\nChanged acceptance\n');
  const changed = await showMainline('fixture', dir);
  assert.equal(changed.sopDocument.changed, true);
  assert.equal(changed.state.turns.fixture.readRevision, 0);
  await assert.rejects(check({}), /SOP changed/);
  await reviseMainline('fixture', { expectedRevision: changed.state.revision, reason: 'Review source changes', sop }, dir);
  assert.equal((await showMainline('fixture', dir)).sopDocument.changed, false);
  await rm(source);
  assert.match((await showMainline('fixture', dir)).sopDocument.error, /ENOENT/);
  await check({ decision: 'paused', pauseReason: 'Human paused the experiment' });
  assert.deepEqual(await mainlineHook('fixture', { hook_event_name: 'Stop', turn_id: 'fixture-turn' }, dir), {});
  await setMainlineBinding('fixture', { enabled: false, ...human, reason: 'Keep experimental feature disabled' }, dir);
  assert.deepEqual(await mainlineHook('fixture', { hook_event_name: 'Stop', turn_id: 'fixture-turn' }, dir), {});
  assert(mainlineFinalAllowed('fixture', 'fixture-turn', dir), 'disable does not strand an active response');
  assert.equal((await showMainline('fixture', dir)).state.status, 'paused');
  assert.equal((await runProjectTrack(['assess', '--session', 'fixture', '--file', await (async () => {
    const p = join(dir, 'request.json'); await writeFile(p, JSON.stringify({ ...human, kind: 'followup', sameProject: true })); return p;
  })()], dir)).action, 'keep_disabled');

  let argv;
  const remote = await readSopDocument({ kind: 'feishu', url: 'https://example.feishu.cn/docx/Fixture', profile: 'bot-test' }, {
    run: async (command, args) => { assert.equal(command, 'lark-cli'); argv = args;
      return { stdout: JSON.stringify({ ok: true, data: { document: { document_id: 'Fixture', revision_id: 3, content: original } } }) }; },
  });
  assert.equal(remote.revision, 3); assert.equal(remote.content, original);
  assert(argv.includes('bot')); assert(argv.includes('+fetch')); assert(!argv.includes('+update'));
  await assert.rejects(readSopDocument({ kind: 'feishu', url: 'https://example.feishu.cn/docx/Fixture', profile: 'bot-test' }, {
    run: async () => ({ stdout: JSON.stringify({ ok: false }) }),
  }), /fetch failed/);
  console.log('project-sop-source: routing, single binding, disabled default, original SOP readback, source changes, missing source, pause and no-write passed');
} finally { await rm(dir, { recursive: true, force: true }); }

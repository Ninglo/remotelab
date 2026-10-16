import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'web-topic-context-'));
setIsolatedTestHome(home);
try {
  const { MEMORY_DIR, CONFIG_DIR } = await import('../lib/config.mjs');
  await mkdir(MEMORY_DIR, { recursive: true }); await mkdir(CONFIG_DIR, { recursive: true });
  const brief = join(home, 'evaluation.md'), otherBrief = join(home, 'remote.md');
  await writeFile(brief, '# 具身评测\n\n明确决定：对齐动作语义后比较，旧速度结论已撤销。\n');
  await writeFile(otherBrief, '# RemoteLab\n\n网页规则只适用于本产品。\n');
  const configPath = join(MEMORY_DIR, 'project-runtime.json');
  const config = { schemaVersion: 1, enabled: true, contextEnabled: true, directoryEnabled: true,
    reviewEnabled: false, releaseId: 'fixture', indexPath: join(MEMORY_DIR, 'projects.md'),
    ledgerPath: join(home, 'ledger.md'), workflowPath: join(home, 'workflow.md'),
    projects: [{ id: 'eval', name: '具身评测', briefPath: brief }, { id: 'real', name: '真机评测', status: 'paused',
      pauseReason: '等待明确恢复', briefPath: join(home, 'missing.md') },
    { id: 'remote', name: 'RemoteLab', briefPath: otherBrief }],
    groups: [{ sourceRouteId: 'bot', chatId: 'eval-chat', projectIds: ['eval'] }],
    sessionBindings: [{ sessionId: 'bound', projectIds: ['remote'] }] };
  await writeFile(configPath, JSON.stringify(config));
  const actor = { personId: 'person_web', identityId: 'identity_web' };
  const authDocument = { version: 2, primaryPersonId: actor.personId, people: [{ id: actor.personId, name: '网页验证者',
    identities: [{ id: actor.identityId, kind: 'web', subjectId: 'web' }] }] };
  await writeFile(join(CONFIG_DIR, 'auth.json'), JSON.stringify(authDocument));
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  await writeFile(join(MEMORY_DIR, 'learning-policy.json'), JSON.stringify({ version: 1, enabled: true,
    profiles: false, handbook: true, context: true, personIds: [actor.personId] }));
  const learning = await import('../chat/memory-learning.mjs');
  const learned = await learning.applyLearningUpdates({ ...actor, authDocument, memoryDir: MEMORY_DIR, project: 'eval',
    updates: [{ key: 'eval-interface', kind: 'method', scope: 'project', content: '评测前核对动作接口，仅适用具身评测。',
      cues: ['评测'], conditions: '具身评测比较时', exceptions: '其他项目不适用', tested: true,
      evidence: [{ seq: 2, quote: '"code":0' }] }],
    sources: learning.learningTurnEvidence({ sessionId: 'evidence', runId: 'run_evidence', userMessage: '核对接口',
      sourceEventSeq: 1, turnEvents: [{ type: 'tool_result', runId: 'run_evidence', seq: 2, output: '{"code":0}', exitCode: 0 }] }) });
  assert.equal(learned.results[0].status, 'verified');
  const sessions = [{ id: 'web', name: '具身评测' }, { id: 'group', conversation: { connector: 'feishu',
    sourceRouteId: 'bot', target: { chatId: 'eval-chat' } } },
  { id: 'child', delegatedFromSessionId: 'group' }, { id: 'bound', delegatedFromSessionId: 'group' }];
  const sessionFile = join(CONFIG_DIR, 'chat-sessions.json');
  await writeFile(sessionFile, JSON.stringify(sessions));
  const { readProjectTopicContext, buildWebTopicDiscoveryPrompt } = await import('../chat/project-topic-context.mjs');
  const { readProjectWorkDirectory } = await import('../chat/project-work-directory.mjs');
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  const independent = await readProjectTopicContext(sessions[0], null, { query: '讨论评测', sessions });
  assert.equal(independent.association, 'not-inferred'); assert.deepEqual(independent.confirmedProjectIds, []);
  assert.equal(independent.candidates.length, 2); assert.equal(independent.selected.length, 0);
  assert.equal(independent.candidates.find(p => p.projectId === 'real').status, 'paused');
  const inherited = await readProjectTopicContext(sessions[2], null, { query: '评测', sessions });
  assert.deepEqual(inherited.confirmedProjectIds, ['eval']); assert.equal(inherited.scopeSessionId, 'group');
  const bound = await readProjectTopicContext(sessions[3], null, { query: '评测', sessions });
  assert.deepEqual(bound.confirmedProjectIds, ['remote']);
  const external = await readProjectTopicContext(sessions[2], { connector: 'feishu', chatId: 'unknown', sourceRouteId: 'bot' }, { sessions });
  assert.deepEqual(external.confirmedProjectIds, [], 'an unrelated input cannot borrow the parent project');
  const selected = await readProjectTopicContext(sessions[0], null, { query: '评测', projectId: 'eval', sessions });
  assert.equal(selected.association, 'explicit-reference-selection');
  assert.match(selected.selected[0].source.body, /旧速度结论已撤销/);
  assert.equal(selected.selected[0].source.lineStart, 1);
  assert.equal((await readProjectTopicContext(sessions[0], null, { projectId: 'eval', sessions, maxChars: 1 })).result, 'partial');
  const paused = await readProjectTopicContext(sessions[0], null, { projectId: 'real', sessions });
  assert.equal(paused.result, 'partial'); assert.equal(paused.selected[0].source.status, 'not-recorded');
  await writeFile(brief, '# 具身评测\n\n更正：暂停比较，先核对新动作接口。\n');
  const fresh = await readProjectTopicContext(sessions[0], null, { projectId: 'eval', sessions });
  assert.notEqual(fresh.selected[0].source.hash, selected.selected[0].source.hash);
  assert.match(fresh.selected[0].source.body, /暂停比较/);
  const switched = await readProjectTopicContext(sessions[0], null, { projectId: 'remote', sessions });
  assert.doesNotMatch(JSON.stringify(switched.selected), /动作|暂停比较/);
  const directoryOptions = { config, sessions, referenceProjectId: 'eval', history: async () => ({}), run: async () => null };
  const directory = await readProjectWorkDirectory(sessions[0], null, directoryOptions);
  assert.equal(directory.association, 'explicit-reference-selection');
  assert.deepEqual(directory.confirmedProjectIds, []);
  assert.deepEqual(directory.entries.map(e => e.sessionId).sort(), ['child', 'group']);
  assert.equal((await readProjectWorkDirectory(sessions[0], null, { ...directoryOptions, referenceProjectId: '' })).reason, 'no-confirmed-project');
  assert.equal(await readFile(sessionFile, 'utf8'), JSON.stringify(sessions), 'reference reads never bind or mutate Sessions');
  await assert.rejects(readProjectTopicContext(sessions[0], null, { projectId: 'invented', sessions }), /Unknown registered project/);
  await assert.rejects(readProjectWorkDirectory(sessions[0], null, { ...directoryOptions, referenceProjectId: 'invented' }), /Unknown registered project/);
  const hook = await buildTurnContextHook(sessions[0], { query: '评测' });
  assert.match(hook, /Web topic background lookup/); assert.match(hook, /work context --query/);
  assert.doesNotMatch(hook, /更正：暂停比较|网页规则只适用于/);
  assert.equal(await buildWebTopicDiscoveryPrompt(sessions[0], { automated: true }), '');
  assert.equal(await buildWebTopicDiscoveryPrompt(sessions[0], { sourceContext: { connector: 'feishu' } }), '');
  const { handleWorkAwarenessRoutes } = await import('../chat/router-work-awareness.mjs');
  async function get(path) {
    let result;
    const parsedUrl = new URL(path, 'http://fixture'); const req = Readable.from([]); req.method = 'GET';
    await handleWorkAwarenessRoutes({ req, res: {}, pathname: parsedUrl.pathname, parsedUrl,
      authSession: { authKind: 'web', ...actor }, writeJson: (_, status, json) => { result = { status, json }; } });
    return result;
  }
  const webRead = await get('/api/work-awareness?sessionId=web&query=评测&project=eval');
  assert.equal(webRead.status, 200); assert.match(webRead.json.projectBackground.selected[0].source.body, /暂停比较/);
  assert.match(webRead.json.background.context, /仅适用具身评测/);
  assert.doesNotMatch((await get('/api/work-awareness?sessionId=web&query=评测&project=remote')).json.background.context, /仅适用具身评测/);
  assert.doesNotMatch((await get('/api/work-awareness?sessionId=web&query=评测')).json.background.context, /仅适用具身评测/);
  assert.match((await get('/api/work-awareness?sessionId=child&query=评测')).json.background.context, /仅适用具身评测/);
  assert.equal((await get('/api/work-awareness/directory?sessionId=web&project=eval')).json.association, 'explicit-reference-selection');
  assert.equal((await get('/api/work-awareness?sessionId=web&project=invented')).status, 400);
  assert.equal((await get('/api/work-awareness?sessionId=web&includeBackground=false')).json.projectBackground, undefined);
  await writeFile(configPath, JSON.stringify({ ...config, contextEnabled: false }));
  assert.equal((await readProjectTopicContext(sessions[0], null)).result, 'not-enabled');
  assert.equal(await buildWebTopicDiscoveryPrompt(sessions[0]), '');
  await writeFile(configPath, '{broken');
  assert.equal((await readProjectTopicContext(sessions[0], null)).result, 'source-unavailable');
  console.log('WEB_TOPIC_CONTEXT_VERIFIED: ambiguous candidates; explicit/parent scope; reference-only briefs and directories; current corrections; project switch; paused/missing/budget/disabled/broken sources; real route and pointer-only input hook.');
} finally { await rm(home, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'project-directory-'));
setIsolatedTestHome(home);
const { CONFIG_DIR, MEMORY_DIR } = await import('../lib/config.mjs');
await mkdir(CONFIG_DIR, { recursive: true }); await mkdir(MEMORY_DIR, { recursive: true });
const { readProjectWorkDirectory: read, projectDirectoryPrompt: prompt, projectDirectoryScope: scope } = await import('../chat/project-work-directory.mjs');
const now = Date.parse('2026-10-15T12:00:00Z');
const config = { schemaVersion: 1, enabled: true, contextEnabled: true, directoryEnabled: true, reviewEnabled: false,
  releaseId: 'test', indexPath: join(home, 'index.md'), ledgerPath: join(home, 'ledger.md'), workflowPath: join(home, 'workflow.md'),
  projects: [{ id: 'a', name: 'A', briefPath: join(home, 'brief.md') }, { id: 'b' }],
  groups: [{ sourceRouteId: 'bot', chatId: 'discussion', projectIds: ['a'] },
    { sourceRouteId: 'bot', chatId: 'work', projectIds: ['a'] }, { sourceRouteId: 'bot', chatId: 'other', projectIds: ['b'] }],
  sessionBindings: [{ sessionId: 'explicit', projectIds: ['a'] }, { sessionId: 'override', projectIds: ['b'] }] };
const convo = chatId => ({ connector: 'feishu', sourceRouteId: 'bot', target: { chatId, conversationKind: 'thread' } });
const session = (id, chatId, extra = {}) => ({ id, name: id, created: '2026-10-01T00:00:00Z', tool: 'codex',
  ...(chatId ? { conversation: convo(chatId) } : {}), ...extra });
const root = session('root', 'discussion', { activeRunId: 'run-root', workAwareness: { executionPlans: [
  { id: 'p', branches: [{ id: 'retry', sessionId: 'child', task: 'Investigate retry; never drop stop supplements', state: 'running' }] },
] } });
const sessions = [root, session('peer', 'work'), session('old', 'work'), session('archived', 'work', { archived: true }),
  session('child', null, { delegatedFromSessionId: 'root' }), session('grandchild', null, { delegatedFromSessionId: 'child' }),
  session('override', null, { delegatedFromSessionId: 'root' }), session('explicit'),
  session('unrelated', 'other'), session('same-name', null, { name: 'A discussion' }),
  session('private-worker', 'work', { internalRole: 'hidden' }), session('main-feed', 'work', { groupFeed: true }),
  session('cycle-a', null, { delegatedFromSessionId: 'cycle-b' }), session('cycle-b', null, { delegatedFromSessionId: 'cycle-a' }),
  session('completed', 'work', { workAwareness: { works: [{ goal: 'Done work', status: 'completed', updatedAt: '2026-10-14T18:00:00Z' }] } }),
];
const options = { config, sessions, now, history: async id => ({ lastUserMessageAt: id === 'old'
  ? Date.parse('2026-09-01T00:00:00Z') : Date.parse('2026-10-14T12:00:00Z') }),
  run: async () => ({ state: 'running' }) };
try {
  const directory = await read(root, null, options), ids = directory.entries.map(e => e.sessionId);
  assert.deepEqual(new Set(ids), new Set(['root', 'peer', 'old', 'archived', 'child', 'grandchild', 'explicit', 'completed']));
  assert.equal(directory.entries.find(e => e.sessionId === 'child').goal, 'Investigate retry; never drop stop supplements');
  assert.equal(directory.entries.find(e => e.sessionId === 'old').priority, 'historical');
  assert.equal(directory.entries.find(e => e.sessionId === 'completed').priority, 'historical');
  assert.equal(directory.entries.find(e => e.sessionId === 'root').priority, 'active');
  assert.equal(directory.projects[0].groups.length, 2, 'paired groups reuse the explicit project association');
  assert.deepEqual(scope(config, sessions[4], null, sessions).projectIds, ['a']);
  assert.deepEqual(scope(config, root, { connector: 'feishu', sourceRouteId: 'bot', chatId: 'unknown' }, sessions).projectIds, []);
  assert.equal((await read(sessions[9], null, options)).enabled, false, 'a similar title does not bind a project');
  assert.equal((await read(root, null, { ...options, config: { ...config, directoryEnabled: false } })).enabled, false);
  const later = await read(root, null, { ...options, now: now + 60000, sessions: sessions.map(s => ({ ...s, updatedAt: 'tool-event-now' })) });
  assert.equal(later.version, directory.version, 'wall clock and tool metadata do not invalidate the directory');
  const recentAgain = await read(root, null, { ...options, history: async () => ({ lastUserMessageAt: now }) });
  assert.equal(recentAgain.entries.find(e => e.sessionId === 'old').priority, 'recent');
  assert.notEqual(recentAgain.version, directory.version);
  const missing = await read(root, null, { ...options, history: async () => { throw Error('unavailable'); } });
  assert(missing.entries.every(e => e.priority === 'unknown' && !e.sourceAvailable));
  const text = prompt(directory, { sessionId: 'child', maxEntries: 3 });
  assert.match(text, /隐藏的项目工作目录/); assert.match(text, /work directory/);
  const data = JSON.parse(text.split('\n').at(-1));
  assert(data.entries.every(e => !('sessionUrl' in e) && !('chatId' in e) && !('createdAt' in e)));
  assert(directory.entries.some(e => e.sessionUrl && e.createdAt), 'full query retains details');
  assert.equal(data.entries.length, 3); assert(data.entries.some(e => e.sessionId === 'root'));
  assert.equal(data.selection, 'current-links'); assert(!text.includes('unrelated'));
  assert(!data.entries.some(e => e.sessionId === 'peer'), 'same-project recency is not an automatic link');
  const metadataOnly = { ...directory, entries: directory.entries.map(e => ({ ...e,
    createdAt: '2026-10-15T00:00:00Z', lastUserMessageAt: '2026-10-15T01:00:00Z', sessionUrl: 'https://new.example/' })) };
  assert.equal(prompt(metadataOnly, { sessionId: 'child', maxEntries: 3 }), text,
    'unchanged projected directory is stable when only full-query metadata changes');
  const oldFamily = Array.from({ length: 20 }, (_, i) => ({ ...directory.entries[0], sessionId: 'old-child-' + i,
    parentSessionId: 'root', priority: 'historical' }));
  const crowded = JSON.parse(prompt({ ...directory, entries: [directory.entries[0], ...oldFamily, ...directory.entries.slice(1)] },
    { sessionId: 'root', maxEntries: 8 }).split('\n').at(-1));
  assert(crowded.entries.some(e => e.sessionId === 'child'), 'old children must not hide the active branch');
  assert(!crowded.entries.some(e => e.sessionId === 'peer'), 'unrelated recent work stays queryable, not preloaded');
  const peerChanges = { ...directory, entries: [...directory.entries.map(e => e.sessionId === 'peer'
    ? { ...e, goal: 'A different unrelated goal', status: 'running' } : e),
    { ...directory.entries.find(e => e.sessionId === 'peer'), sessionId: 'new-peer' }] };
  assert.equal(prompt(peerChanges, { sessionId: 'child', maxEntries: 3 }), text,
    'unrelated goal, status and total-count changes do not resend the current links');
  const autoReads = [];
  const local = await read(root, null, { ...options, projection: 'links', history: async id => {
    autoReads.push(id); return { lastUserMessageAt: now };
  } });
  assert.equal(local.selection, 'current-links');
  assert.deepEqual(new Set(autoReads), new Set(['root', 'child']), 'ordinary input does not read peer metadata');
  assert.equal(local.scopeEntryCount, directory.entries.length);
  const returnedChild = directory.entries.find(e => e.sessionId === 'child');
  const returned = JSON.parse(prompt({ ...directory, entries: directory.entries.map(e => e === returnedChild
    ? { ...e, priority: 'historical', status: 'completed', planState: 'running' } : e) },
  { sessionId: 'root' }).split('\n').at(-1));
  assert(returned.entries.some(e => e.sessionId === 'child'), 'completed branch awaiting parent review remains discoverable');
  const settled = JSON.parse(prompt({ ...directory, entries: directory.entries.map(e => e === returnedChild
    ? { ...e, priority: 'recent', planState: 'reviewed' } : e) }, { sessionId: 'root' }).split('\n').at(-1));
  assert(!settled.entries.some(e => e.sessionId === 'child'), 'reviewed old plans are not preloaded');
  const sibling = { ...returnedChild, sessionId: 'same-plan-sibling', priority: 'historical',
    status: 'completed', planState: 'running' };
  const otherPlan = { ...sibling, sessionId: 'other-plan-sibling', planId: 'unrelated-plan', priority: 'active' };
  const siblings = JSON.parse(prompt({ ...directory, entries: [...directory.entries, sibling, otherPlan] },
    { sessionId: 'child' }).split('\n').at(-1));
  assert(siblings.entries.some(e => e.sessionId === sibling.sessionId), 'same active-plan result is available to the related branch');
  assert(!siblings.entries.some(e => e.sessionId === otherPlan.sessionId), 'sharing a parent alone does not relate two plans');
  const querySessions = [...sessions.map(s => s.id !== root.id ? s : { ...s, workAwareness: {
    ...s.workAwareness, works: [
      { id: 'root-current', goal: 'Current unrelated work', object: 'unrelated-stale-object', status: 'active' },
      { id: 'root-old', goal: 'Earlier normalization decision', object: 'root/old-work', status: 'completed' },
    ],
  } }), session('jenga-old', 'work', { name: 'Jenga评分原因', archived: true,
    workAwareness: { works: [{ id: 'jenga-original', goal: '核对Jenga评分和checkpoint',
      object: 'run/jenga-012', status: 'completed', updatedAt: '2026-09-01T00:00:00Z' }] } }),
    session('weak', 'work', { name: '每日进度', workAwareness: { works: [{ id: 'weak',
      goal: '汇报每日进度', object: 'unrelated-stale-object', status: 'active' }] } }),
    session('letterbox', 'work', { name: 'Letterbox图像对齐' }),
    session('outside', 'other', { name: 'Jenga其他项目', workAwareness: { works: [{ id: 'outside',
      goal: '核对Jenga评分', object: 'run/jenga-012', status: 'active' }] } })];
  const queryReads = [];
  const queried = await read(root, null, { ...options, sessions: querySessions, query: 'Jenga',
    history: async id => { queryReads.push(id); return { lastUserMessageAt: now }; } });
  assert.equal(queried.selection, 'query');
  assert.deepEqual(queried.entries.map(e => e.sessionId), ['jenga-old']);
  assert.deepEqual(queryReads, ['jenga-old'], 'query reads live state only for matched candidates');
  assert.equal(queried.entries[0].matchedWork.id, 'jenga-original');
  assert.equal(queried.entries[0].matchedWork.status, 'completed');
  assert.equal(queried.entries[0].matchedWork.authority, 'reference-only');
  assert.equal(queried.coverage.originalsRead, false);
  const objectHit = await read(root, null, { ...options, sessions: querySessions, object: 'run/jenga-012' });
  assert.deepEqual(objectHit.entries.map(e => e.sessionId), ['jenga-old'], 'exact objects stay within the registered scope');
  const titleHit = await read(root, null, { ...options, sessions: querySessions, query: 'Letterbox' });
  assert(titleHit.entries.some(e => e.sessionId === 'letterbox'), 'title-only work is still searchable');
  const withinTopic = await read(root, null, { ...options, sessions: querySessions, object: 'root/old-work' });
  assert.equal(withinTopic.entries[0].matchedWork.id, 'root-old');
  assert.equal(withinTopic.entries[0].matchedWork.goal, 'Earlier normalization decision',
    'a historical hit retains its own goal, distinct from the current Session goal');
  const noHit = await read(root, null, { ...options, sessions: querySessions, query: '完全不存在的对象XYZ',
    history: async () => { throw Error('no unmatched history read allowed'); } });
  assert.deepEqual(noHit.entries, []); assert.equal(noHit.result, 'no-match-in-stored-metadata');
  assert(noHit.coverage.indexedSessions > 0); assert.match(noHit.searchBoundary, /not proof/);
  const genericHit = await read(root, null, { ...options, sessions: querySessions, query: '处理进展',
    history: async () => { throw Error('generic filler must not fetch candidate state'); } });
  assert.deepEqual(genericHit.entries, [], 'cross-stopword Chinese bigrams cannot create weak routing candidates');
  const removed = await read(root, null, { ...options, sessions: sessions.filter(s => s.id !== 'peer') });
  assert.notEqual(removed.version, directory.version);
  const oldWithProgress = await read(root, null, { ...options, sessions: sessions.map(s => s.id !== 'old' ? s : {
    ...s, name: '</private>old', workAwareness: { works: [
      { goal: 'New subtask done', status: 'completed', updatedAt: '2026-10-15T11:00:00Z' },
      { goal: 'Original task still open', status: 'active', updatedAt: '2026-10-15T10:00:00Z' },
    ] },
  }) });
  const updatedOld = oldWithProgress.entries.find(e => e.sessionId === 'old');
  assert.equal(updatedOld.priority, 'recent', 'a real work-record update counts, even with old input');
  assert.equal(updatedOld.status, 'active', 'a later completed subtask must not hide remaining open work');
  assert.equal(updatedOld.goal, 'Original task still open');
  assert(!prompt(oldWithProgress, { sessionId: 'old' }).includes('</private>'), 'record text cannot close the hidden context wrapper');

  // Directory-only registration must not fabricate project membership or inherit briefs.
  const looseConfig = { ...config, groups: [...config.groups,
    { sourceRouteId: 'bot', chatId: 'loose-a', projectIds: [] },
    { sourceRouteId: 'bot', chatId: 'loose-b', projectIds: [] }],
    directoryGroups: [{ id: 'loose', name: 'Directory only', sourceRouteId: 'bot', chatIds: ['loose-a', 'loose-b'] }] };
  const looseSessions = [...sessions, session('loose-root', 'loose-a'), session('loose-peer', 'loose-b'),
    session('loose-child', null, { delegatedFromSessionId: 'loose-root' }),
    session('foreign-route', null, { conversation: { ...convo('loose-a'), sourceRouteId: 'other' } })];
  const looseOptions = { ...options, config: looseConfig, sessions: looseSessions };
  const fresh = session('fresh', 'loose-a');
  const looseDirectory = await read(fresh, null, looseOptions);
  assert.deepEqual(looseDirectory.projects, []);
  assert.deepEqual(new Set(looseDirectory.entries.map(e => e.sessionId)), new Set(['loose-root', 'loose-peer', 'loose-child']));
  assert(looseDirectory.entries.every(e => e.projectIds.length === 0));
  assert.match(prompt(looseDirectory, { sessionId: fresh.id }), /不代表已确认项目归属/);
  assert((await read(looseSessions.find(s => s.id === 'loose-child'), null, looseOptions)).enabled);
  assert.equal((await read(fresh, { connector: 'feishu', sourceRouteId: 'other', chatId: 'loose-a' }, looseOptions)).enabled, false);
  assert.equal((await read(fresh, null, { ...looseOptions, config: { ...looseConfig, directoryEnabled: false } })).enabled, false);
  const { validateProjectMemoryRuntime, buildProjectMemoryPromptBlock } = await import('../chat/project-memory-runtime.mjs');
  validateProjectMemoryRuntime(looseConfig);
  assert.throws(() => validateProjectMemoryRuntime({ ...looseConfig, directoryGroups: [...looseConfig.directoryGroups, { ...looseConfig.directoryGroups[0], id: 'duplicate' }] }), /Invalid directory group member/);
  assert.throws(() => validateProjectMemoryRuntime({ ...looseConfig, directoryGroups: [{ ...looseConfig.directoryGroups[0], chatIds: ['not-registered'] }] }), /Invalid directory group member/);

  // Exercise the actual fresh/resumed prompt assembler and parent inheritance.
  await writeFile(join(MEMORY_DIR, 'project-runtime.json'), JSON.stringify(config));
  await writeFile(config.projects[0].briefPath, 'CURRENT_PROJECT_BRIEF_CONTENT');
  await writeFile(join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify(sessions));
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const child = sessions.find(s => s.id === 'child');
  const built = await buildPrompt(child.id, child, 'check', '', 'codex', { userMessageCount: 0 }, { skipSessionContinuation: true, workboardEnabled: false });
  assert.doesNotMatch(built, /CURRENT_PROJECT_BRIEF_CONTENT/);
  assert(built.includes(config.projects[0].briefPath));
  assert.match(built, /Hidden project work directory/);
  assert.match(built, /Investigate retry/);
  assert.doesNotMatch(built, /"sessionId":"unrelated"/);
  await writeFile(join(MEMORY_DIR, 'project-runtime.json'), JSON.stringify(looseConfig));
  await writeFile(join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify([...looseSessions, fresh]));
  const freshBuilt = await buildPrompt(fresh.id, fresh, 'check', '', 'codex', { userMessageCount: 0 }, { skipSessionContinuation: true, workboardEnabled: false });
  assert.doesNotMatch(freshBuilt, /loose-peer/, 'fresh input gets a lookup entrance, not unrelated recent topics');
  assert.match(freshBuilt, /work directory --query/);
  assert.doesNotMatch(freshBuilt, /CURRENT_PROJECT_BRIEF_CONTENT/);
  assert.doesNotMatch(freshBuilt, /"sessionId":"unrelated"/);
  await writeFile(join(MEMORY_DIR, 'project-runtime.json'), JSON.stringify(config));
  await writeFile(join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify(sessions));
  const { handleWorkAwarenessRoutes } = await import('../chat/router-work-awareness.mjs');
  let response;
  await handleWorkAwarenessRoutes({ req: { method: 'GET' }, res: {}, pathname: '/api/work-awareness/directory',
    parsedUrl: new URL('http://localhost/api/work-awareness/directory?sessionId=child'), authSession: {},
    writeJson: (_, status, data) => { assert.equal(status, 200); response = data; } });
  assert(response.enabled); assert(response.entries.some(e => e.sessionId === 'peer'));
  await writeFile(join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify(querySessions));
  await handleWorkAwarenessRoutes({ req: { method: 'GET' }, res: {}, pathname: '/api/work-awareness/directory',
    parsedUrl: new URL('http://localhost/api/work-awareness/directory?sessionId=root&query=Jenga&object=run%2Fjenga-012'), authSession: {},
    writeJson: (_, status, data) => { assert.equal(status, 200); response = data; } });
  assert.equal(response.query, 'Jenga'); assert.equal(response.object, 'run/jenga-012');
  assert.deepEqual(response.entries.map(e => e.sessionId), ['jenga-old']);
  const { runWorkAwarenessCommand } = await import('../lib/work-awareness-command.mjs');
  let requested;
  await runWorkAwarenessCommand(['directory', '--session', 'child', '--query', 'Jenga', '--object', 'run/jenga-012', '--json'], { stdout: { write() {} }, client: {
    request: async path => { requested = path; return { response: { ok: true }, json: response }; },
  } });
  assert.match(requested, /^\/api\/work-awareness\/directory\?/);
  const passed = new URL('http://localhost' + requested);
  assert.equal(passed.searchParams.get('query'), 'Jenga'); assert.equal(passed.searchParams.get('object'), 'run/jenga-012');
  console.log('PROJECT_DIRECTORY_VERIFIED: explicit group scope, child inheritance, hidden prompt, age/state, bounded index, stable versions, live read API and CLI.');
} finally { await rm(home, { recursive: true, force: true }); }

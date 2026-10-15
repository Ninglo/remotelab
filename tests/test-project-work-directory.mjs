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
  assert.equal(data.entries.length, 3); assert(data.entries.some(e => e.sessionId === 'root'));
  assert(data.omittedCount > 0); assert(!text.includes('unrelated'));
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

  // Exercise the actual fresh/resumed prompt assembler and parent inheritance.
  await writeFile(join(MEMORY_DIR, 'project-runtime.json'), JSON.stringify(config));
  await writeFile(config.projects[0].briefPath, 'CURRENT_PROJECT_BRIEF_CONTENT');
  await writeFile(join(CONFIG_DIR, 'chat-sessions.json'), JSON.stringify(sessions));
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const child = sessions.find(s => s.id === 'child');
  const built = await buildPrompt(child.id, child, 'check', '', 'codex', { userMessageCount: 0 }, { skipSessionContinuation: true, workboardEnabled: false });
  assert.match(built, /CURRENT_PROJECT_BRIEF_CONTENT/);
  assert.match(built, /Hidden project work directory/);
  assert.match(built, /Investigate retry/);
  assert.doesNotMatch(built, /"sessionId":"unrelated"/);
  const { handleWorkAwarenessRoutes } = await import('../chat/router-work-awareness.mjs');
  let response;
  await handleWorkAwarenessRoutes({ req: { method: 'GET' }, res: {}, pathname: '/api/work-awareness/directory',
    parsedUrl: new URL('http://localhost/api/work-awareness/directory?sessionId=child'), authSession: {},
    writeJson: (_, status, data) => { assert.equal(status, 200); response = data; } });
  assert(response.enabled); assert(response.entries.some(e => e.sessionId === 'peer'));
  const { runWorkAwarenessCommand } = await import('../lib/work-awareness-command.mjs');
  let requested;
  await runWorkAwarenessCommand(['directory', '--session', 'child', '--json'], { stdout: { write() {} }, client: {
    request: async path => { requested = path; return { response: { ok: true }, json: response }; },
  } });
  assert.match(requested, /^\/api\/work-awareness\/directory\?/);
  console.log('PROJECT_DIRECTORY_VERIFIED: explicit group scope, child inheritance, hidden prompt, age/state, bounded index, stable versions, live read API and CLI.');
} finally { await rm(home, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-personal-workspace-')); setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { updateAuthDocument, loadAuthDocument } = await import('../lib/auth-config.mjs');
const { createPersonalWorkspace } = await import('../chat/feishu-personal-workspace.mjs');
const { handleFeishuPersonalWorkspace } = await import('../chat/router-feishu-personal-workspace.mjs');
const connections = await import('../chat/feishu-web-settings.mjs');
await updateAuthDocument(d => { d.people = ['alice', 'bob'].map(name => ({ id: 'person_' + name, name, credentials: [], preferences: {}, identities: [{ id: 'identity_' + name, kind: 'web', realm: 'remotelab', subjectId: name }] })); d.primaryPersonId = 'person_alice'; });
const actor = name => ({ personId: 'person_' + name, identityId: 'identity_' + name });
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), group = 'd'.repeat(32);
function fixture() {
  const sessions = [{ id: a, initiatedByIdentityId: 'identity_alice', tool: 'codex', model: 'fixture-model', effort: 'high', conversation: { connector: 'feishu', target: { chatType: 'p2p', chatId: 'alice-only' } } },
    { id: b, initiatedByIdentityId: 'identity_bob', conversation: { connector: 'feishu', target: { chatType: 'p2p' } } },
    { id: group, initiatedByIdentityId: 'identity_alice', conversation: { connector: 'feishu', target: { chatType: 'group' } }, workAwareness: { works: [
      { actor: actor('alice'), projects: [{ projectId: 'remotelab', status: 'confirmed' }, { projectId: 'paused', status: 'confirmed' }, { projectId: 'candidate', status: 'candidate' }] },
      { actor: actor('bob'), projects: [{ projectId: 'bob-project', status: 'confirmed' }] } ] } }];
  const records = new Map(), history = new Map(), submitted = []; let created = 0;
  const deps = { sessions: async () => sessions, auth: () => loadAuthDocument({ persistMigration: false }),
    todos: async personId => [{ id: 'todo_personal', title: personId, status: 'todo', sourceSessionId: a }],
    sources: async () => ({ config: { projects: ['remotelab', 'paused', 'bob-project', 'candidate'].map(id => ({ id, status: id === 'paused' ? 'paused' : 'active' })) }, date: '2026-10-10', url: 'https://fixture.feishu.cn/docx/report',
      index: '| remotelab | RemoteLab | 项目 | — | link |\n| paused | 暂停项目 | 项目 | — | link |\n| bob-project | Bob Project | 项目 | — | link |\n| candidate | Candidate | 项目 | — | link |', daily: '## RemoteLab\n已有成果仍待实测。\n## 暂停项目\n保持暂停。\n## Bob Project\nBob private source.' }),
    create: async (folder, tool, name, extra) => { created++; const s = { id: c, folder, tool, name, ...extra }; sessions.push(s); return s; },
    session: async id => sessions.find(s => s.id === id), head: async () => 0, events: async id => history.get(id) || [],
    latestAssistant: async id => (history.get(id) || []).findLast(e => e.role === 'assistant') || null,
    latestUser: async id => (history.get(id) || []).findLast(e => e.role === 'user') || null,
    request: async (id, requestId) => records.get(id + ':' + requestId),
    submit: async (id, text, images, options) => { submitted.push({ id, text, options }); const record = { requestId: options.requestId, acceptedAt: '2026-10-10T05:00:00Z' }; records.set(id + ':' + record.requestId, record); history.set(id, [...(history.get(id) || []), { type: 'message', role: 'user', content: options.recordedUserText || text, requestId: record.requestId }]); return record; } };
  return { api: createPersonalWorkspace(deps), deps, sessions, records, history, submitted, created: () => created };
}
test('personal views preserve p2p identity, reuse Index and filter confirmed participation and todos', async () => {
  const f = fixture(), data = await f.api.context(actor('alice'));
  assert.equal(data.todos[0].title, 'person_alice'); assert.deepEqual(data.projects.map(p => p.id), ['remotelab', 'paused']); assert.equal(data.projects[1].status, 'paused');
  assert(!JSON.stringify(data).includes('Bob private source'));
  assert.equal((await f.api.view(actor('alice'), 'index')).session.id, a); assert.equal((await f.api.view(actor('alice'), 'index')).session.id, a); assert.equal(f.created(), 0);
  assert.equal((await f.api.view(actor('bob'), 'index')).session.id, b);
  await assert.rejects(f.api.context({ ...actor('alice'), identityId: 'identity_bob' }), /本人/);
  await assert.rejects(f.api.view({ ...actor('alice'), authKind: 'service' }, 'index'), /本人/);
});
test('explicit analysis uses a normal persistent Session, carries source dates, and deduplicates uncertain retries', async () => {
  const f = fixture(), input = { requestId: 'request_analyze_000001', text: '' };
  const [first, second] = await Promise.all([f.api.send(actor('alice'), 'thinking', input), f.api.send(actor('alice'), 'thinking', input)]);
  assert.equal(first.sessionId, c); assert.equal(second.duplicate, true); assert.equal(f.created(), 1); assert.equal(f.submitted.length, 1);
  const sent = f.submitted[0]; assert(sent.text.includes('2026-10-10')); assert(sent.text.includes('## 接着推进')); assert(sent.text.includes('保持暂停')); assert(!sent.text.includes('Bob private source'));
  assert.equal(sent.options.suppressSourceDelivery, true); assert.equal(sent.options.viewPersonId, 'person_alice'); assert.equal(sent.options.initiatedByIdentityId, 'identity_alice'); assert(!sent.options.internalOperation);
  assert.equal(f.sessions.at(-1).model, 'fixture-model');
  await assert.rejects(f.api.send(actor('alice'), 'thinking', { ...input, requestId: 'request_analyze_000002' }), /仍在执行/);
  const record = f.records.get(c + ':' + input.requestId); record.result = { state: 'completed', payload: { text: '## 当前重点\n先核验。\n## 接着推进\n读原任务。' } };
  const view = await f.api.view(actor('alice'), 'thinking', input.requestId); assert.equal(view.activity.state, 'completed'); assert(view.activity.final.includes('读原任务'));
  await f.api.send(actor('alice'), 'thinking', { requestId: 'request_analyze_000003', text: '只有两小时' }); assert.equal(f.created(), 1);
});
test('source failures remain distinguishable from an empty list; unavailable data cannot start a fake analysis', async () => {
  const f = fixture(); f.deps.todos = async () => { throw Error('todo unavailable'); }; f.deps.sources = async () => { throw Error('report unavailable'); };
  const api = createPersonalWorkspace(f.deps), data = await api.context(actor('alice'));
  assert.equal(data.errors.todos, 'todo unavailable'); assert.equal(data.errors.projects, 'report unavailable');
  await assert.rejects(api.send(actor('alice'), 'thinking', { requestId: 'request_no_sources_001', text: '' }), /都不可读/); assert.equal(f.submitted.length, 0);
  await assert.rejects(api.send(actor('alice'), 'index', { requestId: 'request_injection_001', text: 'hello', personId: 'person_bob' }), /请输入/);
});
test('workspace connection is separate from settings, exact-account bound, revocable and incapable of settings APIs', async () => {
  const input = { origin: 'https://fixture.feishu.cn', nativeAccount: '1000000000000000001', confirm: true };
  const settings = await connections.connectFeishuWebSettings(input, actor('alice')), personal = await connections.connectFeishuWebSettings(input, actor('alice'), 'workspace');
  assert.equal((await connections.authorizeFeishuWebSettings(settings.token, input.origin, input.nativeAccount)).personId, 'person_alice');
  await assert.rejects(connections.authorizeFeishuWebSettings(personal.token, input.origin, input.nativeAccount), /连接/);
  await assert.rejects(connections.authorizeFeishuWebSettings(settings.token, input.origin, input.nativeAccount, 'workspace'), /连接/);
  await assert.rejects(connections.authorizeFeishuWebSettings(personal.token, input.origin, '1000000000000000002', 'workspace'), /失效/);
  const connected = await connections.authorizeFeishuWebSettings(personal.token, input.origin, input.nativeAccount, 'workspace');
  let called = 0;
  async function route(path, method = 'GET', headers = {}) { let status, value; const req = Readable.from([]); Object.assign(req, { method, url: path, headers }); const res = { setHeader() {}, writeHead(code) { status = code; }, end() {} };
    await handleFeishuPersonalWorkspace({ req, res, pathname: path.split('?')[0], nonce: 'fixture', writeJson(_res, code, data) { status = code; value = data; }, workspace: { context: async who => { called++; return { personId: who.personId }; } } }); return { status, value }; }
  const url = '/api/feishu-web-workspace/context'; assert.equal((await route(url)).status, 401); assert.equal(called, 0);
  const headers = { authorization: 'Bearer ' + personal.token, 'x-feishu-origin': input.origin, 'x-feishu-account': input.nativeAccount };
  const own = await route(url + '?personId=person_bob', 'GET', headers); assert.equal(own.value.personId, 'person_alice');
  assert.equal((await route('/api/feishu-web-workspace/files', 'GET', headers)).status, 404);
  await connections.disconnectFeishuWebSettings(connected); await assert.rejects(connections.authorizeFeishuWebSettings(personal.token, input.origin, input.nativeAccount, 'workspace'), /失效/);
  assert.equal((await connections.authorizeFeishuWebSettings(settings.token, input.origin, input.nativeAccount)).personId, 'person_alice');
});

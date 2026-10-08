import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'person-progress-'));
setIsolatedTestHome(root);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { AUTH_FILE, CONFIG_DIR, CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(AUTH_FILE, JSON.stringify({ version: 2, serviceToken: 'fixture', primaryPersonId: 'a', people: [
  ...['a', 'b'].map(id => ({ id, name: id.toUpperCase(), preferences: { unrelated: id }, credentials: [], identities: [
    { id: `${id}-web`, kind: 'web', subjectId: id },
    { id: `${id}-feishu`, kind: 'feishu', realm: 'bot', subjectId: `open-${id}` },
  ] })),
] }));
const conversation = { connector: 'feishu', sourceRouteId: 'bot',
  target: { chatId: 'group', chatType: 'group', conversationKind: 'thread', threadId: 'thread' } };
await writeFile(CHAT_SESSIONS_FILE, JSON.stringify(['old', 'unknown'].map(id => ({ id, folder: root,
  tool: 'codex', conversation, workboardPilot: true, initiatedByIdentityId: 'a-feishu' }))));
const { loadAuthDocument, findIdentity } = await import('../lib/auth-config.mjs');
const { updatePerson } = await import('../lib/auth.mjs');
const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
const { updateSessionProgressPolicy } = await import('../chat/session-progress-policy.mjs');
const { resolveProgressActor, progressDefaultForTurn } = await import('../chat/person-progress-preference.mjs');
const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
const { handleFeishuProgressPolicyAction } = await import('../connectors/feishu/progress-policy-actions.mjs');
const { progressCardControls } = await import('../connectors/feishu/progress-card-controls.mjs');
const { collectFeishuInstanceWorkboardCycles } = await import('../connectors/feishu/workboard-pilot.mjs');
const { sessionProgressMode, progressPolicyForTask } = await import('../lib/session-progress-policy.mjs');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const source = id => ({ connector: 'feishu', sourceRouteId: 'bot', chatId: 'group', chatType: 'group',
  messageId: `input-${id}`, sender: { senderType: 'user', openId: `open-${id}` } });
const turn = id => ({ viewPersonId: id, initiatedByIdentityId: `${id}-feishu`, feishuConnectorAuthenticated: true,
  sourceContext: source(id), sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot', target: conversation.target } });
const preference = async id => (await loadAuthDocument({ persistMigration: false })).people.find(p => p.id === id).preferences;
async function api(pathname, body, authSession = { authKind: 'service' }) {
  const req = Readable.from([JSON.stringify(body)]); req.method = pathname.includes('/people/') ? 'PATCH' : 'POST'; req.headers = {};
  let status, payload;
  const res = { writeHead(code) { status = code; }, setHeader() {}, end(value) { payload = JSON.parse(value); } };
  assert.equal(await handleControlRoutes({ req, res, pathname, authSession, requireSessionAccess: async () => true,
    writeJson: (response, code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); } }), true);
  return { status, json: payload, response: { ok: status === 200 } };
}
let controller;
const pending = new Map(); let nextId = 0;
const rpc = (action, ...args) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); controller.send({ id, action, args });
});
try {
  const controls = progressCardControls({ sessionId: 'old', progressPolicy: { feishuProgressMode: 'card' } });
  const buttons = controls[1].columns.map(c => c.elements[0]);
  assert.deepEqual(buttons.map(b => b.behaviors[0].value.mode), ['messages', 'card']);
  assert.doesNotMatch(JSON.stringify(controls), /恢复默认|仅当前会话/);
  const stateDir = join(root, 'cards'); await mkdir(stateDir);
  await writeFile(join(stateDir, 'bot.json'), JSON.stringify({ sourceRouteId: 'bot', sessions: {
    old: { chatId: 'group', cards: [{ messageId: 'card-original' }] },
  } }));
  let actionNumber = 0;
  async function click(id, mode, revision) {
    return handleFeishuProgressPolicyAction({ config: { sourceRouteId: 'bot' } }, {
      header: { event_id: `click-${++actionNumber}` }, event: {
        operator: { open_id: `open-${id}` }, context: { open_chat_id: 'group', open_message_id: 'card-original' },
        action: { value: { namespace: 'session-progress', sessionId: 'old', mode, revision } },
      },
    }, { stateDir, authorize: async () => true, request: async (path, options) => options?.method === 'POST'
      ? api(path, options.body) : { response: { ok: true }, json: { session: await findSessionMeta('old') } } });
  }
  assert.equal((await click('b', 'card', 0)).toast.type, 'success');
  assert.equal((await preference('b')).feishuProgressMode, 'card', 'callback saves actual B, not creator A');
  assert.equal((await preference('a')).feishuProgressMode, undefined, 'feedback itself never presets A');
  await click('b', 'card', 1);
  assert.equal((await findSessionMeta('old')).feishuProgressRevision, 1, 'fresh same-option click is idempotent');
  await click('a', 'messages', 1); await click('a', 'messages', 2);
  assert.equal((await findSessionMeta('old')).feishuProgressRevision, 2);
  assert.equal((await preference('a')).feishuProgressMode, 'messages');
  assert.equal((await preference('b')).feishuProgressMode, 'card');
  await click('a', 'card', 2); await click('a', 'messages', 3);
  await click('a', 'default', 4); // Old cards remain usable; no third button in new cards.
  assert.equal((await findSessionMeta('old')).feishuProgressMode, undefined);
  assert.equal((await preference('a')).feishuProgressMode, 'messages', 'legacy reset does not erase personal settings');
  const beforeUnknown = await readFile(AUTH_FILE, 'utf8');
  const unknown = await api('/api/sessions/unknown/progress-policy', { mode: 'card', expectedRevision: 0,
    changeId: 'unknown-click', sourceContext: source('unregistered') });
  assert.equal(unknown.status, 200); assert.equal(unknown.json.personalPreferenceSaved, false);
  assert.equal(await readFile(AUTH_FILE, 'utf8'), beforeUnknown);
  assert.equal(await resolveProgressActor({ authKind: 'service' }, { ...source('a'), sourceRouteId: 'wrong' }, conversation), null);
  assert.equal(await progressDefaultForTurn({ ...turn('a'), viewPersonId: 'b' }, conversation), null);
  assert.equal((await api('/api/people/b', { feishuProgressMode: 'messages' }, { personId: 'a', identityId: 'a-web' })).status, 403);
  const web = await api('/api/sessions/old/progress-policy', { mode: 'messages', expectedRevision: 5,
    changeId: 'web-forged-source', sourceContext: source('b') }, { personId: 'a', identityId: 'a-web' });
  assert.equal(web.status, 200); assert.equal((await preference('b')).feishuProgressMode, 'card', 'HTTP body cannot impersonate B');
  await updatePerson('b', { name: 'B renamed' });
  assert.equal((await preference('b')).feishuProgressMode, 'card', 'unrelated preference writes retain progress mode');
  assert.equal((await preference('b')).unrelated, 'b');
  const fresh = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const {progressDefaultForTurn}=await import('./chat/person-progress-preference.mjs');console.log(JSON.stringify(await progressDefaultForTurn(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]))))",
    JSON.stringify(turn('b')), JSON.stringify(conversation)], { cwd: repo });
  assert.equal(JSON.parse(fresh.stdout).mode, 'card', 'new process reloads saved personal default');

  // Exercise the real admission path with the existing isolated native fixture.
  const bin = join(root, 'bin'); await mkdir(bin);
  await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
  await chmod(join(bin, 'fake-native'), 0o755);
  await writeFile(join(CONFIG_DIR, 'tools.json'), JSON.stringify([{ id: 'fake-native', command: 'fake-native',
    runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' }]));
  await writeFile(join(CONFIG_DIR, 'workboard-opt-ins.json'), JSON.stringify({ defaultEnabled: true }));
  controller = fork(join(repo, 'tests/fixtures/native-codex-controller.mjs'), [], { cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REMOTELAB_PROJECT_ROOT: repo,
      REMOTELAB_MEMORY_WRITEBACK: 'off', REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({
        shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; controller.stderr.on('data', data => errors += data);
  controller.on('message', message => { const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id); message.error ? p.reject(new Error(message.error)) : p.resolve(message.value); });
  controller.on('exit', () => { for (const p of pending.values()) p.reject(new Error(errors)); pending.clear(); });
  await Promise.race([once(controller, 'message'), once(controller, 'exit').then(() => { throw new Error(errors); })]);
  async function admit(id, name) {
    const session = await rpc('create', { sourceId: 'feishu', conversation: { ...conversation,
      target: { ...conversation.target, threadId: name } }, initiatedByIdentityId: 'a-feishu' });
    const receipt = await rpc('accept', session.id, 'isolate preference admission', [], { ...turn(id),
      requestId: name, tool: 'fake-native', promptMode: 'bare-user' });
    return { session: await rpc('session', session.id), receipt };
  }
  const newB = await admit('b', 'new-b');
  assert.equal(newB.session.feishuProgressDefault.mode, 'card', 'new Session inherits actual sender B even when creator is A');
  const newA = await admit('a', 'new-a');
  assert.equal(newA.session.feishuProgressDefault.mode, 'messages');
  const shared = await rpc('accept', newB.session.id, 'A follow-up', [], { ...turn('a'), requestId: 'shared-a',
    tool: 'fake-native', promptMode: 'bare-user' });
  assert.equal((await rpc('session', newB.session.id)).feishuProgressDefault.mode, 'messages', 'same-group A task uses A default');
  assert.equal((await preference('b')).feishuProgressMode, 'card');
  const defaultB = await progressDefaultForTurn(turn('b'), conversation);
  const cycles = collectFeishuInstanceWorkboardCycles([
    { type: 'message', role: 'user', seq: 1, runId: 'b-task', sourceContext: source('b'), feishuProgressDefault: defaultB,
      workboardAdmission: { personId: 'b', identityId: 'b-feishu', sourceRouteId: 'bot', senderOpenId: 'open-b' } },
    { type: 'message', role: 'assistant', phase: 'commentary', seq: 2, runId: 'b-task', timestamp: 1,
      content: '<progress>current B task</progress>' },
  ], { scope: 'instance', sourceRouteId: 'bot', progressStartedAt: 0, cards: [] },
  { ...newB.session, feishuProgressDefault: { mode: 'messages' } });
  assert.equal(cycles.length, 1);
  assert.equal(sessionProgressMode(cycles[0].progressPolicy), 'card', 'current card uses its task author rather than the last submitter');
  // A different task's admission must not change B's already accepted task.
  let record = { key: 'outbox', sessionId: newB.session.id, runId: newB.receipt.run.id,
    options: { feishuProgressDefault: await progressDefaultForTurn(turn('b'), conversation) }, deliveries: [] };
  const store = { get: async () => record, mutate: async (_key, fn) => record = fn(record) };
  const event = seq => ({ type: 'message', role: 'assistant', phase: 'commentary', seq, runId: record.runId,
    providerMessageId: `progress-${seq}`, content: `<progress>verified progress ${seq}</progress>` });
  const publish = events => publishLiveAssistantReplies(record, events, { store, plan: { connector: 'feishu', target: conversation.target } });
  await publish([event(100)]); assert.equal(record.deliveries.length, 0, 'card only does not admit progress messages');
  record.options.feishuProgressDefault = await progressDefaultForTurn(turn('a'), conversation);
  // Deliberately make the Session's last-task default differ from this task.
  const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
  await mutateSessionMeta(newB.session.id, s => { s.feishuProgressDefault = { mode: 'card' }; return true; });
  await publish([event(101)]); await publish([event(101)]);
  assert.equal(record.deliveries.length, 1, 'card plus messages publishes once using this task, including under the admission lock');
  await updateSessionProgressPolicy(newB.session.id, { mode: 'card', expectedRevision: 0, changeId: 'manual-legacy' });
  await publish([event(102)]); assert.equal(record.deliveries.length, 1, 'old Session explicit setting wins over A default');
  assert.equal(sessionProgressMode(progressPolicyForTask(await findSessionMeta(newB.session.id), { feishuProgressDefault: { mode: 'messages' } })), 'card');
  assert.equal(sessionProgressMode({ workboardPilot: false, feishuProgressDefault: { mode: 'card' } }), 'messages');
  const actor = findIdentity(await loadAuthDocument({ persistMigration: false }), 'b-feishu');
  await updateSessionProgressPolicy(newB.session.id, { mode: 'messages', expectedRevision: 1, changeId: 'save-new-mode' }, { actor });
  await updatePerson('b', { feishuProgressMode: 'card' });
  await updateSessionProgressPolicy(newB.session.id, { mode: 'messages', expectedRevision: 1, changeId: 'save-new-mode' }, { actor });
  assert.equal((await preference('b')).feishuProgressMode, 'card', 'an old callback retry cannot overwrite a later saved default');
  console.log('PASS: two choices, repeat clicks, actual operators, Person persistence/reload, real new-Session admission, shared A/B isolation, unknown identity, legacy reset, HTTP identity guard and exactly-once progress.');
} finally {
  if (controller && controller.exitCode === null) {
    await rpc('shutdown').catch(() => {});
    await rpc('stop').catch(() => {});
    const exited = once(controller, 'exit'); controller.kill('SIGTERM'); await exited;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

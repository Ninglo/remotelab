import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseUrl } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-strict-start-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument, loadAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(document => {
    document.people = ['alice', 'bob'].map(name => ({ id: `person_${name}`, name, handle: name, credentials: [],
      identities: ['web', 'feishu'].map(kind => ({ id: `${kind}_${name}`, kind, realm: 'fixture', subjectId: name })) }));
    document.primaryPersonId = 'person_alice';
  });
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { resolveMessageReplyPolicy } = await import('../chat/message-reply-settings.mjs');
  const { strictStartCheckPrompt } = await import('../chat/strict-start-check.mjs');
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');
  const { runMessageReplyCommand } = await import('../lib/message-reply-command.mjs');
  const alice = { personId: 'person_alice', identityId: 'web_alice' };
  const bobBefore = await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' });
  const display = { opening: false, checklist: true, progress: 'card_all' };
  assert.equal((await loadPersonMessageReplies(alice)).choices.strictStartCheck, false);
  await changePersonMessageReplies({ action: 'apply', expectedRevision: 0, confirm: true, choices: display }, alice);
  const record = (await requests.accept({ sessionId: 'strict-session', requestId: 'human', text: '为我开启开工严格检查',
    options: { viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId, usageSurface: 'web' } })).record;
  const path = '/api/message-reply-settings/current-run';
  async function call(url, body, authSession = { authKind: 'service' }) {
    const parsedUrl = parseUrl(url, true);
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    let result;
    assert(await handleMessageReplySettings({ req, res: {}, pathname: parsedUrl.pathname, parsedUrl, authSession,
      writeJson(_res, status, json) { result = { status, json }; } }));
    return result;
  }
  const client = { request: async (url, options) => {
    const result = await call(url, options?.body);
    return { response: { ok: result.status === 200 }, json: result.json };
  } };
  assert.equal((await call(path)).status, 403);
  assert.equal((await call(`${path}?runId=${record.runId}&runId=run_unknown`)).status, 403);
  let output = '';
  const io = { runId: record.runId, client, stdout: { write: value => { output = value; } } };
  await runMessageReplyCommand(['strict-start', 'on', '--json'], io);
  const enabled = JSON.parse(output).settings;
  assert.equal(enabled.personId, alice.personId);
  assert.deepEqual(enabled.choices, { ...display, strictStartCheck: true });
  assert.deepEqual(await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' }), bobBefore);
  const document = await loadAuthDocument({ persistMigration: false });
  assert.equal(document.people.find(p => p.id === alice.personId).preferences.messageReplies.audit.at(-1).requestId, 'human');

  for (const surface of ['web', 'p2p', 'group', 'thread']) {
    const options = { viewPersonId: alice.personId, initiatedByIdentityId: surface === 'web' ? 'web_alice' : 'feishu_alice' };
    if (surface === 'web') options.usageSurface = 'web';
    else Object.assign(options, { feishuConnectorAuthenticated: true,
      sourceContext: { connector: 'feishu', sourceRouteId: 'fixture', chatType: surface === 'p2p' ? 'p2p' : 'group',
        chatId: 'oc_fixture', messageId: 'om_human', sender: { openId: 'alice', senderType: 'user' } },
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'oc_fixture',
        conversationKind: surface === 'thread' ? 'thread' : 'main' } } });
    const policy = await resolveMessageReplyPolicy(options);
    assert.equal(policy.strictStartCheck, true, surface);
    assert.equal(await resolveMessageReplyPolicy({ ...options, automationTitle: 'scheduled work' }), null);
    assert.equal(await resolveMessageReplyPolicy({ ...options, initiatedByIdentityId: 'web_bob' }), null);
  }
  const snapshot = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  for (const resumed of [false, true]) {
    const prompt = await buildPrompt('strict-session', { id: 'strict-session', systemPrompt: '',
      ...(resumed ? { codexThreadId: 'existing-thread' } : {}) }, '开始修改当前功能', 'codex', 'codex', null, { messageReplyPolicy: snapshot });
    assert.match(prompt, /开工严格检查 \(personal trial\)/);
    assert.match(prompt, /work context --query/);
    assert.match(prompt, /does not expand the single-group routing pilot/);
    assert.match(prompt, /independent/);
    assert.match(prompt, /disabled the opening text/);
  }
  assert.equal(strictStartCheckPrompt({ ...snapshot, scope: 'group' }), '');
  assert.equal(strictStartCheckPrompt(null), '');
  // A stale frontend that doesn't know the new field cannot accidentally turn it off.
  const applied = await changePersonMessageReplies({ action: 'apply', expectedRevision: enabled.revision,
    confirm: true, choices: display }, alice);
  assert.equal(applied.active.strictStartCheck, true);
  await assert.rejects(changePersonMessageReplies({ action: 'apply', expectedRevision: applied.revision,
    confirm: true, choices: { ...display, strictStartCheck: 'yes' } }, alice));
  const payload = { runId: record.runId, expectedRevision: applied.revision, enabled: false, confirm: true };
  assert.equal((await call(path, { ...payload, personId: 'person_bob' })).status, 400);
  assert.equal((await call(path, payload, { authKind: 'web', personId: 'person_bob' })).status, 403);
  assert.equal((await call(path, { ...payload, runId: 'run_missing' })).status, 403);
  assert.equal((await call(path, { ...payload, confirm: false })).status, 400);
  assert.equal((await call(path, { ...payload, expectedRevision: 0 })).status, 409);
  await runMessageReplyCommand(['strict-start', 'off', '--json'], io);
  assert.deepEqual(JSON.parse(output).settings.choices, { ...display, strictStartCheck: false });
  assert.equal(snapshot.strictStartCheck, true, 'already accepted work keeps its immutable policy');
  const off = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  assert.equal(strictStartCheckPrompt(off), '');
  const offPrompt = await buildPrompt('strict-session', { id: 'strict-session', systemPrompt: '', codexThreadId: 'existing-thread' },
    '继续', 'codex', 'codex', null, { messageReplyPolicy: off });
  assert.doesNotMatch(offPrompt, /开工严格检查 \(personal trial\)/);
  assert.match(offPrompt, /Strict work-start check is OFF/);
  const bobPrompt = await buildPrompt('strict-session', { id: 'strict-session', systemPrompt: '', codexThreadId: 'existing-thread' },
    '另一位成员开始新的工作', 'codex', 'codex', null, { viewPersonId: 'person_bob', initiatedByIdentityId: 'web_bob' });
  assert.doesNotMatch(bobPrompt, /开工严格检查 \(personal trial\)/);
  assert.match(bobPrompt, /do not inherit it from Session history/);
  await requests.mutate(record.key, r => ({ ...r, result: { state: 'completed' } }));
  assert.equal((await call(path, { ...payload, expectedRevision: JSON.parse(output).settings.revision })).status, 403);
  const analytics = JSON.parse(await readFile(join(home, '.config/remotelab/usage-settings/current.json'), 'utf8'));
  assert(Object.values(analytics.rows).some(row => row.setting === 'reply.strict_start_check' && row.value === 'off'));
  console.log('strict-start: personal isolation, all surfaces, frozen prompt, rollback, run attribution and analytics passed');
} finally { await rm(home, { recursive: true, force: true }); }

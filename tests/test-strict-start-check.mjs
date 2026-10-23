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
  const { strictStartCheckPrompt, captureStrictStartRule, strictStartCheckProvenance } = await import('../chat/strict-start-check.mjs');
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');
  const { runMessageReplyCommand } = await import('../lib/message-reply-command.mjs');
  const alice = { personId: 'person_alice', identityId: 'web_alice' };
  const bobBefore = await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' });
  const display = { opening: false, checklist: true, progress: 'card_all', routing: 'none', parallelWork: false, selfReview: false };
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
  await runMessageReplyCommand(['input-trial', 'on', '--json'], io);
  assert.equal(JSON.parse(output).settings.enabled, true);
  assert.equal(JSON.parse(output).settings.personId, alice.personId);
  await runMessageReplyCommand(['input-trial', 'off', '--json'], io);
  assert.equal(JSON.parse(output).settings.enabled, false);
  assert.deepEqual((await loadPersonMessageReplies(alice)).choices, enabled.choices);

  assert.equal(enabled.personId, alice.personId);
  assert.deepEqual(enabled.choices, { ...display, strictStartCheck: true });
  assert.deepEqual(await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' }), bobBefore);
  const document = await loadAuthDocument({ persistMigration: false });
  assert.equal(document.people.find(p => p.id === alice.personId).preferences.messageReplies.audit.at(-1).requestId, 'human');

  const surfaceOptions = surface => {
    const options = { viewPersonId: alice.personId, initiatedByIdentityId: surface === 'web' ? 'web_alice' : 'feishu_alice' };
    if (surface === 'web') options.usageSurface = 'web';
    else Object.assign(options, { feishuConnectorAuthenticated: true,
      sourceContext: { connector: 'feishu', sourceRouteId: 'fixture', chatType: surface === 'p2p' ? 'p2p' : 'group',
        chatId: 'oc_fixture', messageId: 'om_human', sender: { openId: 'alice', senderType: 'user' } },
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'oc_fixture',
        conversationKind: surface === 'thread' ? 'thread' : 'main' } } });
    return options;
  };
  for (const surface of ['web', 'p2p', 'group', 'thread']) {
    const options = surfaceOptions(surface);
    const policy = await resolveMessageReplyPolicy(options);
    assert.equal(policy.strictStartCheck, true, surface);
    assert.equal(await resolveMessageReplyPolicy({ ...options, automationTitle: 'scheduled work' }), null);
    assert.equal(await resolveMessageReplyPolicy({ ...options, initiatedByIdentityId: 'web_bob' }), null);
  }
  const snapshot = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  for (const resumed of [false, true]) {
    const prompt = await buildPrompt('strict-session', { id: 'strict-session', systemPrompt: '',
      ...(resumed ? { codexThreadId: 'existing-thread' } : {}) }, '开始修改当前功能', 'codex', 'codex', null, { messageReplyPolicy: snapshot, viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
    assert.match(prompt, /开工严格检查 \(personal trial\)/);
    assert.match(prompt, /# 开工检查 v1/);
    assert.equal(snapshot.strictStartRule.version, 'v1');
    assert.match(prompt, /person_alice\.md/);
    assert.doesNotMatch(prompt, /person_bob\.md/);
    assert.match(prompt, /work context --query/, 'the opted-in request receives its selected rule body');
    assert.match(prompt, /disabled the opening text/);
  }
  assert.equal(strictStartCheckPrompt({ ...snapshot, scope: 'group' }), '');
  assert.equal(strictStartCheckPrompt(null), '');
  assert.match(strictStartCheckPrompt(snapshot, { ...alice, identityId: 'web_bob' }), /no matching verified requester/);
  assert.match(strictStartCheckPrompt(snapshot, { personId: 'person_bob', identityId: 'web_bob' }), /no matching verified requester/);
  assert.match(strictStartCheckPrompt(snapshot), /no matching verified requester/);
  let reads = 0;
  const readAsset = async () => { reads++; return 'FROZEN_RULE_BODY'; };
  for (const [policy, context] of [[null, alice], [{ ...snapshot, strictStartCheck: false }, alice],
    [snapshot, {}], [snapshot, { ...alice, identityId: 'web_bob' }],
    [{ ...snapshot, scope: 'group' }, alice]]) {
    assert.equal(await captureStrictStartRule(policy, context, { readAsset }), undefined);
  }
  assert.equal(reads, 0, 'disabled, absent, unknown and mismatched identities do not read the asset');
  const frozen = await captureStrictStartRule(snapshot, { ...alice, requestId: 'origin', sessionId: 'strict-session' }, { readAsset });
  assert.equal(reads, 1);
  assert.equal(frozen.origin.requestId, 'origin');
  const frozenPolicy = { ...snapshot, strictStartRule: frozen };
  assert.match(strictStartCheckPrompt(frozenPolicy, alice), /FROZEN_RULE_BODY/);
  assert.equal(reads, 1, 'projection reuses the captured body without a file read');
  assert.doesNotMatch(strictStartCheckPrompt({ ...frozenPolicy,
    strictStartRule: { ...frozen, content: 'TAMPERED_BODY' } }, alice), /TAMPERED_BODY/);
  const unavailable = await captureStrictStartRule(snapshot, alice, { readAsset: async () => { throw new Error('missing'); } });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(strictStartCheckPrompt({ ...snapshot, strictStartRule: unavailable }, alice), /unavailable/);
  assert.equal((await captureStrictStartRule({ ...snapshot, strictStartRuleVersion: '../outside' }, alice, { readAsset })).reason, 'unknown-version');
  assert.equal((await captureStrictStartRule({ ...snapshot, strictStartRuleVersion: 'constructor' }, alice, { readAsset })).reason, 'unknown-version');
  assert.equal(reads, 1, 'unknown versions cannot select arbitrary files');
  const legacy = { ...snapshot }; delete legacy.strictStartRule;
  assert.match(strictStartCheckPrompt(legacy, alice), /legacy accepted work/);
  const oldChoices = (await loadPersonMessageReplies(alice)).choices;
  await runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'v2', '--json'], io);
  assert.equal(JSON.parse(output).settings.active.strictStartRuleVersion, 'v2');
  assert.deepEqual((await loadPersonMessageReplies(alice)).choices, oldChoices, 'version selection retains all personal display choices');
  const v2 = await resolveMessageReplyPolicy({ usageSurface: 'web', ...{ viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId } });
  assert.equal(v2.strictStartRule.version, 'v2'); assert.match(v2.strictStartRule.content, /--focus work/);
  assert.equal(snapshot.strictStartRule.version, 'v1', 'accepted old work is never migrated');
  assert.equal((await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' })).revision, bobBefore.revision);
  await assert.rejects(runMessageReplyCommand(['routing', 'on', '--rule-version', 'v2'], io), /strict-start/);
  await assert.rejects(runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'constructor'], io), /strict-start/);
  assert.equal((await call(path, { runId: record.runId, setting: 'strict-start', enabled: true,
    expectedRevision: (await loadPersonMessageReplies(alice)).revision, confirm: true, ruleVersion: 'constructor' })).status, 400);
  await runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'v3', '--json'], io);
  assert.equal(JSON.parse(output).settings.active.strictStartRuleVersion, 'v3');
  const v3 = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId,
    initiatedByIdentityId: alice.identityId });
  assert.equal(v3.strictStartRule.version, 'v3');
  assert.match(v3.strictStartRule.content, /work-start\/v2\.md/);
  assert.doesNotMatch(v3.strictStartRule.content, /--focus work|--focus project/,
    'operational query syntax stays in the on-demand guide');
  const v3Next = { ...v3, strictStartRule: { ...v3.strictStartRule,
    origin: { ...v3.strictStartRule.origin, requestId: 'different-input' } } };
  assert.equal(strictStartCheckPrompt(v3, alice), strictStartCheckPrompt(v3Next, alice),
    'per-input provenance cannot invalidate the stable procedure');
  assert.match(strictStartCheckProvenance(v3Next, alice), /different-input/);
  assert.equal(strictStartCheckProvenance(v2, alice), '', 'legacy provenance remains in the exact old prompt');
  assert.equal(strictStartCheckProvenance(v3, { ...alice, identityId: 'web_bob' }), '');
  assert.equal(strictStartCheckProvenance({ ...v3, strictStartCheck: false }, alice), '');
  assert.equal(strictStartCheckProvenance({ ...v3, strictStartRule: {
    ...v3.strictStartRule, content: 'tampered' } }, alice), '');
  const v3Prompt = await buildPrompt('strict-session', { id: 'strict-session', codexThreadId: 'existing-thread' },
    '继续', 'codex', 'codex', null, { messageReplyPolicy: v3Next,
      viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  assert.match(v3Prompt, /Current work-start provenance/);
  assert.match(v3Prompt, /different-input/);
  assert.match(v3Prompt, /# 开工检查 v3/);
  assert.ok(strictStartCheckPrompt(v3, alice).length + strictStartCheckProvenance(v3, alice).length
    < strictStartCheckPrompt(v2, alice).length, 'count provenance as well as the procedure when checking savings');
  assert.equal(v2.strictStartRule.version, 'v2', 'new selection never rewrites existing v2 work');
  assert.deepEqual((await loadPersonMessageReplies(alice)).choices, oldChoices);
  await runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'v4', '--json'], io);
  assert.equal(JSON.parse(output).settings.active.strictStartRuleVersion, 'v4');
  const v4 = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId,
    initiatedByIdentityId: alice.identityId });
  assert.equal(v4.strictStartRule.version, 'v4');
  for (const surface of ['web', 'p2p', 'group', 'thread']) {
    const options = surfaceOptions(surface);
    assert.equal((await resolveMessageReplyPolicy(options)).strictStartRule.version, 'v4', surface);
    assert.equal(await resolveMessageReplyPolicy({ ...options, automationTitle: 'scheduled work' }), null);
    assert.equal(await resolveMessageReplyPolicy({ ...options, initiatedByIdentityId: 'web_bob' }), null);
  }
  assert.deepEqual((await loadPersonMessageReplies(alice)).choices, oldChoices);
  assert.deepEqual(await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' }), bobBefore,
    'selecting the pilot for one Person never enables or migrates another Person');
  assert.equal(v3.strictStartRule.version, 'v3', 'accepted work retains its captured version');
  assert.ok(Buffer.byteLength(v4.strictStartRule.content) <= Buffer.byteLength(v3.strictStartRule.content),
    'the pilot replaces the existing prompt within its byte budget, without claiming token equivalence');
  const v4Next = { ...v4, strictStartRule: { ...v4.strictStartRule,
    origin: { ...v4.strictStartRule.origin, requestId: 'next-v4-input' } } };
  assert.equal(strictStartCheckPrompt(v4, alice), strictStartCheckPrompt(v4Next, alice));
  assert.equal(JSON.parse(strictStartCheckProvenance(v4Next, alice)).version, 'v4');
  assert.doesNotMatch(strictStartCheckPrompt(v4, { personId: 'person_bob', identityId: 'web_bob' }), /# 已存信息主动调用/);
  assert.equal(strictStartCheckProvenance(v4, { personId: 'person_bob', identityId: 'web_bob' }), '');
  const v4Prompt = await buildPrompt('strict-session', { id: 'strict-session', codexThreadId: 'existing-thread' },
    '按已有方法继续', 'codex', 'codex', null, { messageReplyPolicy: v4,
      viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  assert.match(v4Prompt, /# 已存信息主动调用 v4/);
  await runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'v5', '--json'], io);
  const v5 = await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId,
    initiatedByIdentityId: alice.identityId });
  assert.equal(v5.strictStartRule.version, 'v5');
  assert.match(v5.strictStartRule.content, /work retrieve/);
  assert.match(strictStartCheckPrompt(v5, alice), /# 已存信息按需调用 v5/);
  assert.equal(JSON.parse(strictStartCheckProvenance(v5, alice)).version, 'v5');
  assert.deepEqual(await loadPersonMessageReplies({ personId: 'person_bob', identityId: 'web_bob' }), bobBefore);
  const workerPrompt = await buildPrompt('strict-session', { id: 'strict-session' }, '只读检索任务',
    'codex', 'codex', null, { internalOperation: 'context_retrieval', skipSessionContinuation: true,
      messageReplyPolicy: v5, viewPersonId: alice.personId, initiatedByIdentityId: alice.identityId });
  assert.equal(workerPrompt, '只读检索任务', 'worker receives its task without copying personal rules or main-thread history');
  await runMessageReplyCommand(['strict-start', 'on', '--rule-version', 'v3', '--json'], io);
  assert.equal((await resolveMessageReplyPolicy({ usageSurface: 'web', viewPersonId: alice.personId,
    initiatedByIdentityId: alice.identityId })).strictStartRule.version, 'v3', 'rollback uses the same personal selector');
  assert.equal(v4.strictStartRule.version, 'v4', 'rollback does not rewrite already accepted pilot work');
  const { projectRuleContext } = await import('../chat/rule-context.mjs');
  const ruleSlots = policy => [{ id: 'strict_start_check', content: strictStartCheckPrompt(policy, alice) },
    { id: 'strict_start_origin', content: strictStartCheckProvenance(policy, alice) }];
  const ruleOptions = { enabled: true, identity: { field: 'codexThreadId', id: 'thread-v3' },
    recovery: 'codex-session-start', requestId: 'current', personId: alice.personId, identityId: alice.identityId };
  const deps = { head: async () => 1, history: async () => [], snapshot: async () => {} };
  for (const [policy, nextPolicy] of [[v3, v3Next], [v4, v4Next]]) {
    const first = await projectRuleContext('strict-session', ruleSlots(policy), ruleOptions, deps);
    const next = await projectRuleContext('strict-session', ruleSlots(nextPolicy), ruleOptions, { ...deps,
      history: async () => [{ type: 'message', role: 'user', requestId: 'previous' }],
      request: async () => ({ runId: 'previous-run', nativeReceipt: { accepted: true } }),
      run: async () => ({ id: 'previous-run', sessionId: 'strict-session', codexThreadId: 'thread-v3' }),
      manifest: async () => ({ ruleContextDelivery: first.receipt }) });
    assert.equal(next.receipt.mode, 'reference');
    assert.deepEqual(next.receipt.changedIds, []);
    assert.equal(next.slots.some(s => s.id === 'strict_start_check'), false);
    assert.equal(next.slots.find(s => s.id === 'strict_start_origin').content,
      strictStartCheckProvenance(nextPolicy, alice), 'new origin reaches the input without repeating the stable rule');
  }
  assert.doesNotMatch(strictStartCheckPrompt(legacy, alice), /# 开工检查 v1/);
  const bob = { personId: 'person_bob', identityId: 'web_bob' };
  const bobPolicy = { ...snapshot, personId: bob.personId, policyId: 'reply_bob' };
  bobPolicy.strictStartRule = await captureStrictStartRule(bobPolicy, bob);
  const bobOn = await buildPrompt('strict-session', { id: 'strict-session', systemPrompt: '', codexThreadId: 'existing-thread' },
    '开始我的工作', 'codex', 'codex', null, { viewPersonId: bob.personId, initiatedByIdentityId: bob.identityId, messageReplyPolicy: bobPolicy });
  assert.match(bobOn, /# 开工检查 v1/);
  assert.doesNotMatch(bobOn, /person_alice/);

  // A stale frontend that doesn't know the new field cannot accidentally turn it off.
  const applied = await changePersonMessageReplies({ action: 'apply', expectedRevision: (await loadPersonMessageReplies(alice)).revision,
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
  assert.doesNotMatch(bobPrompt, /# 开工检查 v1/);
  assert.doesNotMatch(offPrompt, /# 开工检查 v1/);
  await requests.mutate(record.key, r => ({ ...r, result: { state: 'completed' } }));
  assert.equal((await call(path, { ...payload, expectedRevision: JSON.parse(output).settings.revision })).status, 403);
  const analytics = JSON.parse(await readFile(join(home, '.config/remotelab/usage-settings/current.json'), 'utf8'));
  assert(Object.values(analytics.rows).some(row => row.setting === 'reply.strict_start_check' && row.value === 'off'));
  console.log('strict-start: conditional reads, immutable version/body, missing/tampered rules, legacy continuation, personal isolation and rollback passed');
} finally { await rm(home, { recursive: true, force: true }); }

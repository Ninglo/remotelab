import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-parallel-settings-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { captureMessageRoutingOptions } = await import('../chat/message-routing-policy.mjs');
  const { buildParallelWorkContext } = await import('../chat/parallel-work-policy.mjs');
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  const { routeGroupWork } = await import('../chat/group-routing.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const actor = name => ({ personId: `person_${name}`, identityId: `identity_${name}` });
  await updateAuthDocument(doc => {
    doc.people = ['alice', 'bob'].map(name => ({ id: actor(name).personId, name, handle: name,
      identities: [{ id: actor(name).identityId, kind: 'feishu', realm: 'bot', subjectId: name }] }));
    doc.primaryPersonId = 'person_alice';
  });
  const dir = join(home, '.config/remotelab');
  await mkdir(dir, { recursive: true });
  const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: {
    chatId: 'oc_pilot', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'om_source' } };
  const session = { id: 'main', folder: home, conversation };
  await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([session]));
  await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 2, enabled: true,
    trialId: 'parallel', personalOptIn: true,
    groups: [{ sourceRouteId: 'bot', chatId: 'oc_pilot', tenantKey: 'tenant', folder: home }] }));
  const input = name => ({ viewPersonId: actor(name).personId, initiatedByIdentityId: actor(name).identityId,
    feishuConnectorAuthenticated: true, sourceDelivery: conversation, sourceContext: { connector: 'feishu', sourceRouteId: 'bot',
      chatType: 'group', chatId: 'oc_pilot', messageId: 'om_source', sender: { openId: name, senderType: 'user' } } });
  const capture = (name = 'alice', extra = {}) => captureMessageRoutingOptions(session, { ...input(name), ...extra });
  const defaults = await loadPersonMessageReplies(actor('alice'));
  assert.equal(defaults.choices.parallelWork, false);
  const off = await capture('alice', { parallelWorkPolicy: { version: 1, enabled: true },
    routingPilotMainline: true, messageRoutingPolicy: { version: 1, mechanism: 'experimental' } });
  assert.equal(off.parallelWorkPolicy.enabled, false, 'untrusted options cannot enable parallel work');
  assert.equal(off.messageRoutingPolicy.mechanism, 'none');
  assert.equal(off.routingPilotMainline, undefined);
  assert.equal(await buildParallelWorkContext(session, off.sourceContext, off), '');

  // Read old saved choices without mutating configuration or enrolling anybody new.
  await updateAuthDocument(doc => { doc.people[0].preferences = { messageReplies: { version: 1, revision: 1,
    active: { ...defaults.choices, parallelWork: undefined, routing: 'experimental', version: 3,
      scope: 'person', personId: 'person_alice', policyId: 'old' } } }; });
  const before = await readFile(join(dir, 'auth.json'), 'utf8');
  let settings = await loadPersonMessageReplies(actor('alice'));
  assert.equal(settings.choices.parallelWork, true);
  assert.equal(settings.choices.routing, 'none');
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), before, 'no read-time migration');
  assert.equal((await loadPersonMessageReplies(actor('bob'))).choices.parallelWork, false);
  const on = await capture();
  assert.equal(on.parallelWorkPolicy.enabled, true);
  assert.equal(on.parallelWorkPolicy.trialId, 'parallel');
  assert.equal(on.messageRoutingPolicy.mechanism, 'none');
  assert.equal(on.routingPilotMainline, undefined);
  const context = await buildTurnContextHook(session, { sourceContext: on.sourceContext,
    personId: 'person_alice', identityId: 'identity_alice', ...on });
  assert.match(context, /本人的多项工作并行试用/);
  assert.doesNotMatch(context, /## 新输入与当前工作的关系|## 本群分流试点|误发归属不清用work discover/);
  const denied = (await requests.accept({ sessionId: session.id, requestId: 'on', text: 'a matter', options: on, deliveryPlan: conversation })).record;
  await assert.rejects(routeGroupWork(denied, { mode: 'new', task: 'a matter', reason: 'new' }), /routing is disabled/);
  for (const extra of [ { initiatedByIdentityId: 'identity_bob' }, { feishuConnectorAuthenticated: false },
    { automationTitle: 'scheduled' }, { internalOperation: true },
    { sourceContext: { ...input('alice').sourceContext, sender: { openId: 'alice', senderType: 'bot' } } } ]) {
    assert.equal((await capture('alice', extra)).parallelWorkPolicy.enabled, false);
  }
  assert.equal((await capture('bob', { messageReplyPolicy: settings.active })).parallelWorkPolicy.enabled, false);
  const outside = await captureMessageRoutingOptions({ ...session, conversation: { ...conversation,
    target: { ...conversation.target, chatId: 'oc_other' } } }, input('alice'));
  assert.equal(outside.parallelWorkPolicy.enabled, false);
  settings = await changePersonMessageReplies({ action: 'strict-start', enabled: true,
    expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal(settings.choices.parallelWork, true);
  const { routing, parallelWork, ...displayOnly } = settings.choices;
  settings = await changePersonMessageReplies({ action: 'apply', choices: displayOnly,
    expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal(settings.choices.parallelWork, true, 'older display-only saves preserve the choice');
  settings = await changePersonMessageReplies({ action: 'parallel-work', enabled: false,
    expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal((await capture()).parallelWorkPolicy.enabled, false);
  assert.deepEqual(await captureMessageRoutingOptions(session, input('alice'), { options: on }), on,
    'accepted work and retries retain their snapshot');
  const legacy = { ...on, parallelWorkPolicy: undefined, messageRoutingPolicy: {
    version: 1, mechanism: 'experimental', personId: 'person_alice', trialId: 'parallel', trialVersion: 2 } };
  assert.match(await buildParallelWorkContext(session, legacy.sourceContext, legacy), /多项工作并行/);
  assert.equal(await buildParallelWorkContext(session, legacy.sourceContext, {
    ...legacy, parallelWorkPolicy: { version: 1, enabled: false } }), '', 'explicit new off wins over legacy routing');
  const runtimeSelection = { tool: 'codex', model: 'fixture' };
  assert.equal(canForwardNativeRequest({ key: 'a', options: on, runtimeSelection }, { key: 'b', options: off, runtimeSelection }), false);
  assert.equal(canForwardNativeRequest({ key: 'a', options: on, runtimeSelection }, { key: 'b', options: on, runtimeSelection }), true,
    'ordinary steer is unchanged');
  await assert.rejects(changePersonMessageReplies({ action: 'parallel-work', enabled: true,
    expectedRevision: settings.revision, confirm: true }, { ...actor('alice'), identityId: 'identity_bob' }), /本人/);
  console.log('Parallel isolation verified: legacy read-only compatibility, default off, independent settings, actual context, retired routing, identity/group scope, retry and ordinary steer.');
} finally { await rm(home, { recursive: true, force: true }); }

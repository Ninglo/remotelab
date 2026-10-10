import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-message-routing-'));
setIsolatedTestHome(home);
try {
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { captureMessageRoutingOptions } = await import('../chat/message-routing-policy.mjs');
  const { buildGroupRoutingContext, routeGroupWork, replyGroupInput } = await import('../chat/group-routing.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { buildReplyPreview } = await import('../static/chat/message-reply-model.js');
  const actor = name => ({ personId: `person_${name}`, identityId: `identity_${name}` });
  await updateAuthDocument(doc => {
    doc.people = ['alice', 'bob'].map(name => ({ id: actor(name).personId, name, handle: name,
      identities: [{ id: actor(name).identityId, kind: 'feishu', realm: 'fixture', subjectId: name }] }));
    doc.primaryPersonId = 'person_alice';
  });
  const dir = join(home, '.config/remotelab');
  await mkdir(dir, { recursive: true });
  const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: {
    chatId: 'oc_pilot', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'om_source' } };
  const session = { id: 'main', folder: home, conversation };
  await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([session]));
  await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
    groups: [{ sourceRouteId: 'bot', chatId: 'oc_pilot', tenantKey: 'tenant', folder: home }] }));
  const input = name => ({ viewPersonId: actor(name).personId, initiatedByIdentityId: actor(name).identityId,
    feishuConnectorAuthenticated: true, sourceDelivery: conversation, sourceContext: { connector: 'feishu', sourceRouteId: 'bot',
      chatType: 'group', chatId: 'oc_pilot', messageId: 'om_source', sender: { openId: name, senderType: 'user' } } });
  const capture = (name = 'alice', extra = {}) => captureMessageRoutingOptions(session, { ...input(name), ...extra });
  const defaults = await loadPersonMessageReplies(actor('alice'));
  assert.equal(defaults.choices.routing, 'none');
  const off = await capture('alice', { routingPilotMainline: true, messageRoutingPolicy: { version: 1, mechanism: 'experimental' } });
  assert.equal(off.messageRoutingPolicy.mechanism, 'none', 'caller cannot invent a preference');
  assert.equal(off.routingPilotMainline, undefined, 'enabled group alone never opts a person in');
  assert.match(await buildGroupRoutingContext(session, off.sourceContext, off), /本条消息不分流/);
  const denied = (await requests.accept({ sessionId: session.id, requestId: 'off', text: 'a matter', options: off, deliveryPlan: conversation })).record;
  await assert.rejects(routeGroupWork(denied, { mode: 'new', task: 'a matter', reason: 'new' }), /routing is disabled/);
  await assert.rejects(replyGroupInput(denied, { text: 'status' }), /routing is disabled/);
  const choices = { ...defaults.choices, routing: 'experimental', progress: 'card_all', strictStartCheck: true };
  let settings = await changePersonMessageReplies({ action: 'apply', choices, expectedRevision: 0, confirm: true }, actor('alice'));
  assert.equal((await loadPersonMessageReplies(actor('alice'))).choices.routing, 'experimental');
  assert.equal((await loadPersonMessageReplies(actor('bob'))).choices.routing, 'none');
  const on = await capture();
  assert.equal(on.routingPilotMainlineProtocol, 2);
  assert.match(await buildGroupRoutingContext(session, on.sourceContext, { messageRoutingPolicy: on.messageRoutingPolicy, inputReplyContract: true }), /本群分流试点/);
  assert.equal((await capture('bob', { messageReplyPolicy: settings.active })).routingPilotMainline, undefined,
    'another sender sharing execution cannot inherit the routing preference of its head');
  for (const extra of [ { initiatedByIdentityId: 'identity_bob' }, { feishuConnectorAuthenticated: false },
    { automationTitle: 'scheduled' }, { internalOperation: true },
    { sourceContext: { ...input('alice').sourceContext, sender: { openId: 'alice', senderType: 'bot' } } } ]) {
    assert.equal((await capture('alice', extra)).messageRoutingPolicy.mechanism, 'none');
  }
  const outside = await captureMessageRoutingOptions({ ...session, conversation: { ...conversation,
    target: { ...conversation.target, chatId: 'oc_other' } } }, input('alice'));
  assert.equal(outside.routingPilotMainline, undefined, 'the choice does not authorize additional groups');
  settings = await changePersonMessageReplies({ action: 'strict-start', enabled: false,
    expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal(settings.choices.routing, 'experimental', 'strict-start toggle preserves the routing choice');
  const { routing, ...olderClient } = settings.choices;
  settings = await changePersonMessageReplies({ action: 'apply', choices: olderClient,
    expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal(settings.choices.routing, 'experimental', 'older display-only clients cannot erase the selected mechanism');
  await assert.rejects(changePersonMessageReplies({ action: 'apply', choices: { ...settings.choices, routing: 'everything' },
    expectedRevision: settings.revision, confirm: true }, actor('alice')), /无效/);
  await changePersonMessageReplies({ action: 'reset', expectedRevision: settings.revision, confirm: true }, actor('alice'));
  assert.equal((await capture()).messageRoutingPolicy.mechanism, 'none');
  assert.deepEqual(await captureMessageRoutingOptions(session, input('alice'), { options: on }), on,
    'already accepted requests retain their contract after a setting change');
  const handedOff = await captureMessageRoutingOptions({ ...session, id: 'work-topic' }, input('alice'), { sessionId: session.id, options: on });
  assert.deepEqual(handedOff.messageRoutingPolicy, on.messageRoutingPolicy);
  assert.equal(handedOff.routingPilotMainline, undefined, 'work-topic results are not settled as source-mainline inputs');
  const legacy = { ...on }; delete legacy.messageRoutingPolicy;
  assert.equal((await captureMessageRoutingOptions(session, input('bob'), { options: legacy })).messageRoutingPolicy, undefined);
  assert.equal((await captureMessageRoutingOptions(session, input('bob'), { options: legacy })).routingPilotMainline, true);
  const runtimeSelection = { tool: 'codex', model: 'fixture' };
  assert.equal(canForwardNativeRequest({ key: 'a', options: on, runtimeSelection }, { key: 'b', options: off, runtimeSelection }), false,
    'experimental and default inputs must not share a context with conflicting routing instructions');
  assert.equal(canForwardNativeRequest({ key: 'a', options: off, runtimeSelection }, { key: 'b', options: off, runtimeSelection }), true);
  assert.equal(buildReplyPreview({ ...defaults.choices, groups: [] })[0].text.includes('不分流'), true);
  // Existing display choices missing the new field also read as no routing.
  await updateAuthDocument(doc => {
    doc.people.find(p => p.id === 'person_alice').preferences.messageReplies.active = { ...choices,
      routing: undefined, version: 3, scope: 'person', personId: 'person_alice' };
  });
  assert.equal((await loadPersonMessageReplies(actor('alice'))).choices.routing, 'none');
  console.log('message routing: defaults, personal isolation, persistence, admission, scope, server guards and accepted contracts passed');
} finally { await rm(home, { recursive: true, force: true }); }

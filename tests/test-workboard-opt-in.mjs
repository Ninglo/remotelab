import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWorkboardOptedIn, isWorkboardTurnEnabled, loadWorkboardOptIns, resolveWorkboardPeople, workboardAdmission } from '../lib/workboard-opt-in.mjs';

const people = [{
  personId: 'zhang', identityIds: ['zhang-web', 'zhang-feishu'],
  feishuPrivateChats: [{ sourceRouteId: 'bot-2', chatId: 'zhang-private' }],
  feishuGroupSenders: [{ sourceRouteId: 'bot-2', openId: 'open-zhang' }],
}];
const turn = { viewPersonId: 'zhang', initiatedByIdentityId: 'zhang-web' };
const personal = { sourceId: 'chat', initiatedByIdentityId: 'zhang-web' };

test('workboard opt-in stays with one Person and their own private conversations', () => {
  assert.equal(isWorkboardOptedIn(personal, turn, people), true);
  assert.equal(isWorkboardTurnEnabled(personal, turn, people), true);
  assert.equal(isWorkboardTurnEnabled({ ...personal, workboardPilot: true,
    workboardOptInPersonId: 'zhang' }, turn, []), false,
  'removing the Person opt-in must stop future checklist decisions');
  assert.equal(isWorkboardOptedIn(personal, { ...turn, viewPersonId: 'other' }, people), false);
  assert.equal(isWorkboardTurnEnabled(personal, { ...turn, initiatedByIdentityId: 'other' }, people), false);
  assert.equal(isWorkboardOptedIn(personal, { ...turn, initiatedByIdentityId: 'other' }, people), false);
  assert.equal(isWorkboardOptedIn({ ...personal, initiatedByIdentityId: 'other' }, turn, people), false);
  assert.equal(isWorkboardOptedIn({ ...personal, groupFeed: true }, turn, people), false);
  assert.equal(isWorkboardOptedIn({ ...personal, sourceId: 'feishu' }, turn, people), false);
  const feishuTurn = { viewPersonId: 'zhang', initiatedByIdentityId: 'zhang-feishu' };
  const feishu = { sourceId: 'feishu', initiatedByIdentityId: 'zhang-feishu', conversation: {
    connector: 'feishu', sourceRouteId: 'bot-2',
    target: { chatId: 'zhang-private', chatType: 'p2p', conversationKind: 'main' },
  } };
  assert.equal(isWorkboardOptedIn(feishu, feishuTurn, people), true);
  assert.equal(isWorkboardTurnEnabled(feishu, feishuTurn, people), true);
  assert.equal(isWorkboardOptedIn({ ...feishu, conversation: {
    ...feishu.conversation, target: { ...feishu.conversation.target, chatType: 'group' },
  } }, feishuTurn, people), false);
  assert.equal(isWorkboardTurnEnabled({ ...feishu, workboardPilot: true, conversation: {
    ...feishu.conversation, target: { ...feishu.conversation.target, chatType: 'group' },
  } }, feishuTurn, people), false, 'an old Session flag must not enable group replies');
  assert.equal(isWorkboardOptedIn({ ...feishu, conversation: {
    ...feishu.conversation, target: { ...feishu.conversation.target, chatId: 'other-private' },
  } }, feishuTurn, people), false);
});

test('a Feishu group turn follows its verified sender, not the Session creator', () => {
  const group = { sourceId: 'feishu', initiatedByIdentityId: 'other', conversation: {
    connector: 'feishu', sourceRouteId: 'bot-2',
    target: { chatId: 'group-1', chatType: 'group', conversationKind: 'thread', tenantKey: 'tenant-1' },
  } };
  const sourceContext = { connector: 'feishu', sourceRouteId: 'bot-2',
    chatId: 'group-1', chatType: 'group', tenantKey: 'tenant-1', messageId: 'message-1',
    sender: { openId: 'open-zhang' } };
  const groupTurn = { viewPersonId: 'zhang', initiatedByIdentityId: 'zhang-feishu',
    feishuConnectorAuthenticated: true, sourceContext,
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot-2',
      target: { chatId: 'group-1' } } };
  assert.equal(isWorkboardOptedIn(group, groupTurn, people), true);
  assert.equal(isWorkboardTurnEnabled(group, groupTurn, people), true);
  assert.equal(isWorkboardTurnEnabled({ ...group, workboardPilot: true,
    workboardOptInPersonId: 'zhang' }, { ...groupTurn, viewPersonId: 'other' }, people), false);
  assert.equal(isWorkboardOptedIn(group, { ...groupTurn, feishuConnectorAuthenticated: false }, people), false);
  assert.equal(isWorkboardOptedIn(group, { ...groupTurn,
    sourceContext: { ...sourceContext, sender: { openId: 'open-other' } } }, people), false);
  assert.equal(isWorkboardOptedIn(group, { ...groupTurn,
    sourceDelivery: { ...groupTurn.sourceDelivery, target: { chatId: 'another-group' } } }, people), false);
  assert.equal(isWorkboardOptedIn({ ...group, groupFeed: true }, groupTurn, people), false);
  assert.equal(isWorkboardOptedIn({ ...group, conversation: { ...group.conversation,
    sourceRouteId: 'other-bot' } }, groupTurn, people), false);
  assert.equal(isWorkboardOptedIn(group, groupTurn, []), false);
});

test('an absent opt-in file never enables another person', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workboard-opt-in-'));
  try {
    assert.deepEqual(await loadWorkboardOptIns(join(root, 'missing.json')), []);
    await writeFile(join(root, 'people.json'), JSON.stringify({ people }));
    assert.deepEqual(await loadWorkboardOptIns(join(root, 'people.json')), people);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const registered = ['zhang', 'other'].map(id => ({ id, identities: [
  { id: `${id}-web`, kind: 'web', realm: 'remotelab', subjectId: id },
  { id: `${id}-feishu`, kind: 'feishu', realm: 'bot-2', subjectId: `open-${id}` },
] }));

test('instance default includes current and future registered people, with explicit exclusions', async () => {
  const policy = { defaultEnabled: true, people };
  const all = resolveWorkboardPeople(policy, registered);
  assert.equal(isWorkboardTurnEnabled(personal, { viewPersonId: 'other', initiatedByIdentityId: 'other-web' }, all), true,
    'a shared web Session follows the actual authenticated user');
  assert.equal(isWorkboardTurnEnabled(personal, { viewPersonId: 'zhang', initiatedByIdentityId: 'other-web' }, all), false);
  assert.equal(resolveWorkboardPeople(policy, [...registered, { id: 'future', identities: [] }]).length, 3);
  assert.equal(resolveWorkboardPeople({ ...policy, excludedPersonIds: ['other'] }, registered).length, 1);
  assert.equal(resolveWorkboardPeople({ ...policy, people: [{ personId: 'other', enabled: false }] }, registered).length, 1);
  assert.equal(resolveWorkboardPeople(policy, [...registered, { id: 'person_system', identities: [] }]).length, 2);
  const root = await mkdtemp(join(tmpdir(), 'workboard-default-'));
  try {
    const path = join(root, 'policy.json');
    await writeFile(path, JSON.stringify(policy));
    assert.equal((await loadWorkboardOptIns(path, async () => registered)).length, 2);
    await writeFile(path, JSON.stringify({ people }));
    assert.deepEqual(await loadWorkboardOptIns(path, async () => { throw new Error('must not load auth'); }), people,
      'rollback retains the previous exact opt-ins');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('instance Feishu activation verifies each actual inbound sender and destination, including new private chats', () => {
  const all = resolveWorkboardPeople({ defaultEnabled: true }, registered);
  for (const chatType of ['p2p', 'group']) {
    const session = { sourceId: 'feishu', initiatedByIdentityId: 'someone-else', conversation: {
      connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'new-chat', chatType, conversationKind: 'main', tenantKey: 'tenant-1' },
    } };
    const options = { viewPersonId: 'other', initiatedByIdentityId: 'other-feishu', feishuConnectorAuthenticated: true,
      sourceContext: { connector: 'feishu', sourceRouteId: 'bot-2', chatType, chatId: 'new-chat', tenantKey: 'tenant-1',
        messageId: 'message', sender: { openId: 'open-other' } },
      sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'new-chat' } } };
    assert.equal(isWorkboardTurnEnabled(session, options, all), true);
    assert.equal(isWorkboardTurnEnabled(session, { ...options, feishuConnectorAuthenticated: false }, all), false);
    assert.equal(isWorkboardTurnEnabled(session, { ...options, viewPersonId: 'zhang' }, all), false);
    for (const [key, value] of [['sourceRouteId', 'other-bot'], ['chatId', 'other-chat'], ['tenantKey', 'wrong'], ['messageId', '']]) {
      assert.equal(isWorkboardTurnEnabled(session, { ...options, sourceContext: { ...options.sourceContext, [key]: value } }, all), false);
    }
    assert.equal(isWorkboardTurnEnabled(session, { ...options, sourceContext: { ...options.sourceContext,
      sender: { openId: 'open-zhang' } } }, all), false);
    assert.equal(isWorkboardTurnEnabled(session, { ...options, sourceDelivery: { ...options.sourceDelivery,
      target: { chatId: 'wrong' } } }, all), false);
    assert.equal(isWorkboardTurnEnabled({ ...session, groupFeed: true }, options, all), false);
    assert.equal(workboardAdmission(options), null);
    assert.deepEqual(workboardAdmission({ ...options, workboardEnabled: true }), {
      personId: 'other', identityId: 'other-feishu', sourceRouteId: 'bot-2', senderOpenId: 'open-other',
    });
  }
});

test('authenticated Web continuation of a Feishu Session enables cards without admitting Feishu publication', () => {
  const all = resolveWorkboardPeople({ defaultEnabled: true }, registered);
  const webTurn = { viewPersonId: 'other', initiatedByIdentityId: 'other-web', workboardEnabled: true };
  for (const chatType of ['p2p', 'group']) {
    const session = { sourceId: 'feishu', initiatedByIdentityId: 'zhang-feishu', workboardPilot: true,
      workboardOptInPersonId: 'zhang', conversation: { connector: 'feishu', sourceRouteId: 'bot-2',
        target: { chatId: 'shared-chat', chatType, conversationKind: chatType === 'group' ? 'thread' : 'main' } } };
    assert.equal(isWorkboardTurnEnabled(session, webTurn, all), true,
      'the current Web member can continue a connector-origin Session');
    assert.equal(workboardAdmission(webTurn), null, 'Web activation must not authorize a Feishu send');
    assert.equal(isWorkboardTurnEnabled(session, { ...webTurn, viewPersonId: 'zhang' }, all), false);
    assert.equal(isWorkboardTurnEnabled(session, { ...webTurn, initiatedByIdentityId: 'other-feishu' }, all), false);
    assert.equal(isWorkboardTurnEnabled(session, { ...webTurn, sourceContext: { connector: 'feishu' } }, all), false,
      'connector input still requires its verified receipt and sender');
    assert.equal(isWorkboardTurnEnabled(session, { ...webTurn, feishuConnectorAuthenticated: true }, all), false);
    assert.equal(isWorkboardTurnEnabled({ ...session, groupFeed: true }, webTurn, all), false);
    assert.equal(isWorkboardTurnEnabled(session, webTurn, resolveWorkboardPeople({ defaultEnabled: true,
      excludedPersonIds: ['other'] }, registered)), false);
    assert.equal(isWorkboardTurnEnabled(session, webTurn, people), false,
      'the previous personal opt-in keeps its exact-chat activation scope');
  }
});

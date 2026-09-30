import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWorkboardOptedIn, isWorkboardTurnEnabled, loadWorkboardOptIns } from '../lib/workboard-opt-in.mjs';

const people = [{
  personId: 'zhang', identityIds: ['zhang-web', 'zhang-feishu'],
  feishuPrivateChats: [{ sourceRouteId: 'bot-2', chatId: 'zhang-private' }],
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

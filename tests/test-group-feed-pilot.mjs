import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

setIsolatedTestHome(await mkdtemp(join(tmpdir(), 'remotelab-group-feed-pilot-')));
const { normalizeFeishuGroups, resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
const { buildGroupFeedReview, nextGroupFeedReviewAt } = await import('../chat/group-feed-review.mjs');

const pilotChatId = 'oc_pilot';
const groups = normalizeFeishuGroups({
  [pilotChatId]: { participationMode: 'ambient', groupFeed: true, responseMode: 'all' },
  oc_legacy: { participationMode: 'ambient', responseMode: 'all' },
  oc_rolled_back: { participationMode: 'ambient', groupFeed: false, responseMode: 'all' },
});
const config = { groups, responsePolicy: { group: 'mention_only' } };
assert.equal(resolveFeishuGroupSettings(config, {
  chatId: pilotChatId, chatType: 'group', conversationKind: 'main',
}).groupFeed, true);
assert.equal(resolveFeishuGroupSettings(config, {
  chatId: 'oc_legacy', chatType: 'group', conversationKind: 'main',
}).groupFeed, undefined, 'other groups keep their existing route');
assert.equal(resolveFeishuGroupSettings(config, {
  chatId: 'oc_rolled_back', chatType: 'group', conversationKind: 'main',
}).groupFeed, false, 'an explicit false setting can roll a pilot back');
assert.equal(resolveFeishuGroupSettings(config, {
  chatId: pilotChatId, chatType: 'group', conversationKind: 'thread', threadId: 'om_thread',
}).groupFeed, undefined, 'a work thread stays outside the group mainline');
assert.throws(() => normalizeFeishuGroups({ oc_bad: { groupFeed: true } }), /requires ambient/);

const session = {
  id: 'session-one', name: 'pilot', conversation: { target: { chatId: pilotChatId } },
  workSummary: { summary: 'One open decision' },
};
const review = buildGroupFeedReview(session, null, [
  { seq: 1, type: 'message', role: 'user', content: 'A group decision',
    sourceContext: { messageId: 'om_first', sender: { name: 'Sender' } } },
  { seq: 2, type: 'message', role: 'assistant', content: 'Acknowledged' },
], 2, new Date('2026-09-28T15:30:00Z'));
assert.equal(review.throughSeq, 2);
assert.equal(review.newMessageCount, 1);
assert.equal(review.recentMessages[0].messageId, 'om_first');
assert.deepEqual(review.projectState, session.workSummary);
const replay = buildGroupFeedReview(session, review, [], 2, new Date('2026-09-28T15:31:00Z'));
assert.equal(replay.scannedMessageCount, 1, 'a replay must not count an old message again');
assert.equal(nextGroupFeedReviewAt(new Date('2026-09-28T15:00:00Z')).toISOString(), '2026-09-28T15:30:00.000Z');
assert.equal(nextGroupFeedReviewAt(new Date('2026-09-28T15:30:00Z')).toISOString(), '2026-09-29T15:30:00.000Z');
console.log('PASS: one-group opt-in, legacy routing, daily checkpoint and replay boundaries');

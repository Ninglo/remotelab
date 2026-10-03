import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeishuWorkboardService, upgradeFeishuWorkboardState } from '../connectors/feishu/workboard-runtime.mjs';

test('route-wide state migration preserves private/group receipts, fences and uncertain creates', () => {
  const previous = { sourceRouteId: 'bot-2', senderOpenId: 'old-sender', sessionId: 'private', chatId: 'p2p',
    startedAfterSeq: 30, protocolAfterSeq: 40, cards: [{ anchorSeq: 50, messageId: 'old-card', latestSeq: 55 }],
    groupSessions: { group: { chatId: 'group-chat', cards: [{ anchorSeq: 10, pendingCreate: true }], protocolAfterSeq: 5 } } };
  const state = upgradeFeishuWorkboardState(previous, { sourceRouteId: 'bot-2', botConfigPath: '/private/config.json' });
  assert.equal(state.scope, 'instance');
  assert.deepEqual(state.sessions.group, previous.groupSessions.group);
  assert.deepEqual(state.sessions.private.cards, previous.cards);
  assert.equal(state.sessions.private.startedAfterSeq, 30);
  assert.equal(state.legacySenderOpenId, 'old-sender');
  assert.equal(state.expiresAt, undefined);
  assert.deepEqual(upgradeFeishuWorkboardState(state, { sourceRouteId: 'bot-2', botConfigPath: '/private/config.json' }), state);
  assert.throws(() => upgradeFeishuWorkboardState(previous, { sourceRouteId: 'other', botConfigPath: '/config' }), /route cannot change/);
  assert.deepEqual(upgradeFeishuWorkboardState({}, { sourceRouteId: 'default', botConfigPath: '/config' }).sessions, {});
  assert.notEqual(state.sessions.group.cards, previous.groupSessions.group.cards);
});

test('managed route service remains enabled across logout, crash and restart without a stop-time disable', () => {
  const text = buildFeishuWorkboardService({ node: '/bin/node', projectRoot: '/work/my project',
    statePath: '/config/route.json', configDir: '/config', sourceFreezePath: '/etc/source-frozen' });
  assert.match(text, /Restart=on-failure/);
  assert.match(text, /RuntimeMaxSec=infinity/);
  assert.match(text, /WorkingDirectory=\/work\/my project\n/);
  assert.match(text, /ConditionPathExists=!\/etc\/source-frozen\n/);
  assert.match(text, /WantedBy=default.target/);
  assert.match(text, /UMask=0077/);
  assert.match(text, /REMOTELAB_CONFIG_DIR=\/config/);
  assert.match(text, /"\/work\/my project\/scripts\/feishu-workboard-pilot.mjs"/);
  assert.doesNotMatch(text, /ExecStopPost|--disable/);
  assert.throws(() => buildFeishuWorkboardService({ node: '/node\nExecStart=/bad' }), /absolute/);
});

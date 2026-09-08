#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createWeChatRequestFeedback } from '../connectors/wechat/request-feedback.mjs';
const calls = [];
let activity = [];
let failure = false;
const record = (requestId, peerUserId = 'peer') => ({ connector: 'wechat', requestId,
  target: { accountId: 'account', peerUserId, contextToken: 'old-context' } });
const feedback = createWeChatRequestFeedback({
  loadActivity: async () => { if (failure) throw new Error('transport offline'); return activity; },
  resolveContextToken: () => 'fresh-context',
  typing: {
    begin(summary) { calls.push(['begin', summary]); return { stop: async () => { calls.push(['stop', summary.peerUserId]); } }; },
    async close() { calls.push(['close']); },
  },
});
activity = [record('long-running'), record('queued-follow-up')];
await feedback.tick();
assert.equal(calls.filter(call => call[0] === 'begin').length, 1, 'one target lease, not one waiter per message');
assert.equal(calls[0][1].contextToken, 'fresh-context');
await feedback.tick();
assert.equal(calls.length, 1, 'unbounded task duration does not churn native typing');
activity = [record('queued-follow-up'), record('other-request', 'other-peer')];
await feedback.tick();
assert.equal(calls.filter(call => call[0] === 'stop').length, 0, 'one task completing cannot cancel its queued follow-up');
activity = [record('other-request', 'other-peer')];
await feedback.tick();
assert(calls.some(call => call[0] === 'stop' && call[1] === 'peer'));
failure = true;
await feedback.tick();
assert(calls.some(call => call[0] === 'stop' && call[1] === 'other-peer'));
failure = false;
await feedback.tick();
assert.equal(calls.filter(call => call[0] === 'begin' && call[1].peerUserId === 'other-peer').length, 2, 'reconnect reconstructs feedback from durable activity');
await feedback.stop();
const stoppedCalls = calls.length;
await feedback.tick();
assert.equal(calls.length, stoppedCalls);

let resolveLate;
let beganLate = false;
const late = createWeChatRequestFeedback({ loadActivity: () => new Promise(resolve => { resolveLate = resolve; }),
  typing: { begin() { beganLate = true; }, async close() {} } });
const poll = late.tick();
const stop = late.stop();
resolveLate([record('late')]);
await Promise.all([poll, stop]);
assert.equal(beganLate, false, 'a late scan cannot restart typing after shutdown');
console.log('WeChat native typing: durable activity projection, queued-peer sharing, fresh context, disconnect/reconnect and shutdown passed');

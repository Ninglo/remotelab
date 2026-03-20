#!/usr/bin/env node
import assert from 'assert/strict';

const { analyzeTurnRouting, buildTurnRoutingHint } = await import('../chat/session-routing.mjs');

const routed = analyzeTurnRouting(`现在手上都有哪些任务，我觉得需要关注两点：
1. 现在都积压了哪些任务，我们看下接下来做什么
2. 我们的 TODO 记录是标准流程吗，需不需要做一个定型？`);

assert.equal(routed.shouldSplit, true);
assert.equal(routed.reason, 'explicit_multi_agenda');
assert.deepEqual(routed.workstreams, [
  '现在都积压了哪些任务，我们看下接下来做什么',
  '我们的 TODO 记录是标准流程吗，需不需要做一个定型',
]);

const routedHint = buildTurnRoutingHint(`I think we should focus on two things:
1. audit the backlog and decide the next actions
2. decide whether the TODO process needs a stable SOP`);

assert.match(routedHint, /Routing principle for this turn/);
assert.match(routedHint, /Bounded work should prefer bounded context/);
assert.match(routedHint, /independently actionable goals/);
assert.match(routedHint, /clear no-split reason/);
assert.match(routedHint, /1\. audit the backlog and decide the next actions/);
assert.match(routedHint, /2\. decide whether the TODO process needs a stable SOP/);

const simple = analyzeTurnRouting('帮我看一下这个仓库的问题。');
assert.equal(simple.shouldSplit, false);
assert.deepEqual(simple.workstreams, []);
assert.equal(buildTurnRoutingHint('帮我看一下这个仓库的问题。'), '');

console.log('test-session-routing: ok');

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageInsights } from '../chat/usage-insights.mjs';
import { createUsageEventStore } from '../chat/usage-events.mjs';

let sequence = 0;
const event = (timestamp, name, fields = {}) => ({ eventId: 'event-' + (++sequence), timestamp, event: name,
  actorKind: 'human', sessionId: 's', personHash: 'alice', surface: 'web', ...fields });
const report = events => buildUsageInsights(events, { now: 10000 });
const input = (timestamp, fields) => event(timestamp, 'message_submitted', { kind: 'message', ...fields });

test('human adoption excludes tool noise, automation, question controls and identity duplicates', () => {
  const events = Array.from({ length: 1000 }, (_, n) => event(n, 'tool_started', { actorKind: 'agent' }));
  events.push(input(1001, { actorKind: 'automation' }), input(1002, { kind: 'question_answer' }),
    input(1003), input(1004), input(1005, { personHash: 'bob', sessionId: 'other' }));
  events.push({ ...events.at(-1) });
  const x = report(events);
  assert.equal(x.activity.people, 2); assert.equal(x.activity.sessions, 2); assert.equal(x.activity.inputs, 3);
  assert.deepEqual(x.activity.multiTurn, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(x.activity.daily[0].inputs, 4); assert.equal(x.activity.questionAnswers, 1);
});

test('answering in Web is meaningful continuation, while answer-only visits do not inflate multi-turn exchange', () => {
  const x = report([input(1, { surface: 'feishu', conversationKey: 'original' }),
    input(2, { kind: 'question_answer' }), input(3, { kind: 'question_answer', surface: 'feishu', conversationKey: 'original' }),
    input(4, { kind: 'question_answer', personHash: 'bob', sessionId: 'earlier-session' })]);
  assert.equal(x.activity.people, 2); assert.equal(x.activity.sessions, 2);
  assert.equal(x.activity.multiTurn.denominator, 1); assert.equal(x.activity.multiTurn.numerator, 0);
  assert.equal(x.journeys.continued.rate, 1); assert.equal(x.journeys.returned.rate, 1);
});

test('cross-surface fractions match the same person and thread, and keep question answers separate', () => {
  const events = [
    input(1, { surface: 'feishu', conversationKey: 'original' }),
    event(2, 'session_open'), input(3, { kind: 'question_answer' }), input(4),
    input(5, { surface: 'feishu', conversationKey: 'different' }),
    input(6, { surface: 'feishu', conversationKey: 'original' }),
    input(7, { surface: 'feishu', personHash: 'bob', conversationKey: 'bob-thread' }),
    input(8, { personHash: 'bob' }),
    event(9, 'session_open', { personHash: 'charlie' }),
    input(10, { surface: 'feishu', personHash: 'charlie', conversationKey: 'charlie-thread' }),
  ];
  const x = report(events.reverse()).journeys;
  assert.equal(x.started, 3);
  assert.deepEqual(x.opened, { numerator: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(x.continued, { numerator: 2, denominator: 3, rate: 2 / 3 }, 'Web input does not require an observed open');
  assert.deepEqual(x.returned, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(x.answeredInWeb, 1);
});

test('native follow-ups do not become extra executions, and only paired waits become durations', () => {
  const events = [
    input(10, { runId: 'r1', requestId: 'original' }),
    input(20, { runId: 'followup-placeholder', requestId: 'followup' }),
    event(30, 'request_state', { actorKind: 'system', requestId: 'followup', runId: 'r1', state: 'completed' }),
    event(40, 'run_state', { runId: 'r1', state: 'running' }),
    event(100, 'question_state', { runId: 'r1', questionId: 'q1', state: 'pending' }),
    input(1100, { kind: 'question_answer', runId: 'control-placeholder' }),
    event(1100, 'question_state', { runId: 'r1', questionId: 'q1', state: 'answered' }),
    event(1200, 'question_state', { runId: 'r1', questionId: 'q2', state: 'pending' }),
    event(1500, 'run_state', { runId: 'r1', state: 'completed' }),
    input(1600, { runId: 'r2', requestId: 'new' }),
    event(1700, 'run_state', { runId: 'r2', state: 'running' }),
    event(1800, 'question_state', { runId: 'r2', questionId: 'q3', state: 'pending' }),
    event(1900, 'question_state', { runId: 'r2', questionId: 'q4', state: 'answered' }),
    event(2000, 'question_state', { runId: 'r2', questionId: 'q5', state: 'pending' }),
    event(3000, 'question_state', { runId: 'r2', questionId: 'q5', state: 'timeout' }),
    event(4000, 'run_state', { actorKind: 'agent', runId: 'background', state: 'failed' }),
  ];
  const x = report(events).execution;
  assert.equal(x.observed, 2); assert.equal(x.completed, 1); assert.equal(x.active, 1); assert.equal(x.failed, 0);
  assert.equal(x.inputToEndMedianMs, 1490); assert.equal(x.durationSamples, 1);
  assert.equal(x.waiting.raised, 4); assert.equal(x.waiting.answered, 1);
  assert.equal(x.waiting.pending, 1); assert.equal(x.waiting.closed, 2); assert.equal(x.waiting.outsideWindow, 1);
  assert.equal(x.waiting.answerMedianMs, 1000); assert.equal(x.waiting.durationSamples, 1);
  assert.deepEqual(x.review[0].reasons, ['answer_not_observed']);
});

test('artifact cohorts join origin/assets, count logical websites, and exclude automatic loads and early clicks', () => {
  const events = [
    event(1, 'artifact_generated', { actorKind: 'agent', objectId: 'image-origin', kind: 'image' }),
    event(2, 'artifact_registered', { objectId: 'asset-a', originObjectId: 'image-origin' }),
    event(3, 'artifact_open', { objectId: 'asset-a' }),
    event(4, 'artifact_attached', { objectId: 'asset-a', kind: 'image' }),
    event(5, 'artifact_access_requested', { objectId: 'asset-a' }),
    event(6, 'artifact_open', { objectId: 'asset-a', actorKind: 'agent' }),
    event(7, 'artifact_open', { objectId: 'asset-a' }),
    event(8, 'artifact_registered', { objectId: 'asset-b', originObjectId: 'image-origin' }),
    event(9, 'artifact_attached', { objectId: 'asset-b', kind: 'image' }),
    event(10, 'web_published', { objectId: 'website', kind: 'web', operation: 'create' }),
    event(11, 'web_published', { objectId: 'website', kind: 'web', operation: 'update' }),
    event(12, 'web_published', { objectId: 'website', kind: 'web', operation: 'update' }),
    event(13, 'artifact_open', { objectId: 'website', kind: 'web' }),
    event(14, 'artifact_attached', { objectId: 'existing-document', kind: 'document' }),
    event(15, 'artifact_open', { objectId: 'older-output' }),
  ];
  const x = report(events).artifacts;
  assert.equal(x.provided, 3); assert.equal(x.opened.numerator, 2); assert.equal(x.opened.rate, 2 / 3);
  assert.equal(x.otherOpened, 1);
  assert.deepEqual(x.byKind.find(row => row.kind === 'image'), { kind: 'image', created: 1, updates: null, provided: 1, opened: 1 });
  assert.deepEqual(x.byKind.find(row => row.kind === 'web'), { kind: 'web', created: 1, updates: 2, provided: 1, opened: 1 });
  assert.equal(x.byKind.find(row => row.kind === 'document').created, null, 'an attachment is not new-generation evidence');
});

test('known gaps cut a continuous baseline; incomplete scans suppress fractions and timings', () => {
  const events = [input(2000, { runId: 'old' }), event(6000, 'run_state', { runId: 'old', state: 'completed' }),
    input(7000, { runId: 'new' }), input(7500, { runId: 'new' }), event(8000, 'run_state', { runId: 'new', state: 'completed' })];
  const options = { now: 10000, start: 1000, collectionStartedAt: new Date(1500).toISOString(), gaps: [{ start: 2500, end: 5000 }] };
  const x = buildUsageInsights(events, options);
  assert.equal(x.since, new Date(5000).toISOString()); assert.equal(x.quality.afterGap, true);
  assert.equal(x.activity.inputs, 2); assert.equal(x.execution.observed, 1); assert.equal(x.execution.inputToEndMedianMs, 1000);
  const incomplete = buildUsageInsights(events, { ...options, scanIncomplete: true });
  assert.equal(incomplete.activity.multiTurn.rate, null); assert.equal(incomplete.execution.inputToEndMedianMs, null);
  const empty = report([]);
  assert.equal(empty.activity.multiTurn.rate, null); assert.equal(empty.execution.waiting.answerMedianMs, null);
  assert.equal(empty.artifacts.opened.rate, null);
});

test('equal timestamps do not let an initial snapshot reopen a settled execution or question', () => {
  const x = report([input(1, { runId: 'r' }),
    event(2, 'run_state', { runId: 'r', state: 'completed' }),
    event(2, 'run_state', { runId: 'r', state: 'running' }),
    event(3, 'question_state', { questionId: 'q', state: 'answered' }),
    event(3, 'question_state', { questionId: 'q', state: 'pending' })]);
  assert.equal(x.execution.completed, 1); assert.equal(x.execution.active, 0);
  assert.equal(x.execution.waiting.answered, 1); assert.equal(x.execution.waiting.pending, 0);
});

test('API aggregation uses all observations even when only one recent event is requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-report-'));
  try {
    const store = createUsageEventStore({ directory });
    const events = Array.from({ length: 12 }, (_, n) => ({
      eventId: 'input-' + n, event: 'message_submitted', actorKind: 'human', surface: 'web', kind: 'message', sessionId: 's-' + n,
    }));
    await store.record(events, { personId: 'verified' });
    const result = await store.query({ limit: 1 });
    assert.equal(result.events.length, 1);
    assert.equal(result.report.activity.inputs, 12); assert.equal(result.report.activity.sessions, 12);
    assert.equal(result.report.activity.people, 1);
    assert.equal((await store.query({ maxScanned: 1 })).report.quality.reliable, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

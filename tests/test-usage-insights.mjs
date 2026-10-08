import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageInsights } from '../chat/usage-insights.mjs';
import { createUsageEventStore, usageKey } from '../chat/usage-events.mjs';
import { readUsageSessionOrigins, usageOriginFromRequest } from '../chat/usage-session-origins.mjs';

let sequence = 0;
const event = (timestamp, name, fields = {}) => ({ eventId: 'event-' + (++sequence), timestamp, event: name,
  actorKind: 'human', sessionId: 's', personHash: 'alice', surface: 'web', ...fields });
const origin = (sessionId = 's', surface = 'feishu', timestamp = 0, conversationKey = 'original') => ({ sessionId, surface, timestamp, conversationKey });
const report = (events, options = {}) => buildUsageInsights(events, { now: 10000, ...options });
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
    input(4, { kind: 'question_answer', personHash: 'bob', sessionId: 'earlier-session' })], { sessionOrigins: [origin()] });
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
  const x = report(events.reverse(), { sessionOrigins: [origin()] }).journeys;
  assert.equal(x.started, 3);
  assert.deepEqual(x.opened, { numerator: 2, denominator: 3, rate: 2 / 3 }, 'an active participant may open an old Feishu-origin conversation before their first input in this window');
  assert.deepEqual(x.continued, { numerator: 2, denominator: 3, rate: 2 / 3 }, 'Web input does not require an observed open');
  assert.deepEqual(x.returned, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(x.answeredInWeb, 1);
});

test('old conversation origins survive time-window and gap filtering without backfilling old activity', () => {
  const events = [input(1000, { surface: 'feishu' }), event(6000, 'session_open'), input(7000),
    input(8000, { surface: 'feishu', conversationKey: 'original' })];
  const options = { now: 10000, start: 2000, gaps: [{ start: 2500, end: 5000 }], sessionOrigins: [origin('s', 'feishu', 1000)] };
  const x = buildUsageInsights(events, options);
  assert.equal(x.activity.inputs, 2, 'the old Feishu input stays outside the count');
  assert.equal(x.journeys.started, 1);
  assert.equal(x.journeys.opened.rate, 1); assert.equal(x.journeys.continued.rate, 1); assert.equal(x.journeys.returned.rate, 1);
  const oldWeb = buildUsageInsights([input(6000, { surface: 'feishu' }), input(7000)], {
    ...options, sessionOrigins: [origin('s', 'web', 1000)] });
  assert.equal(oldWeb.journeys.started, 0, 'a first observed Feishu input cannot relabel a Web-origin conversation');
  const unknown = buildUsageInsights(events, { ...options, sessionOrigins: [] });
  assert.equal(unknown.journeys.unknownOrigins, 1); assert.equal(unknown.journeys.continued.rate, null);
  const unavailable = buildUsageInsights(events, { ...options, originLookupIncomplete: true });
  assert.equal(unavailable.journeys.continued.rate, null); assert.equal(unavailable.activity.inputs, 2);
});

test('answer-only continuation in an old Feishu conversation is included; an unknown original thread cannot yield a return rate', () => {
  const x = report([input(6000, { kind: 'question_answer' })], { sessionOrigins: [origin('s', 'feishu', 1000)] });
  assert.equal(x.activity.inputs, 0); assert.equal(x.journeys.started, 1); assert.equal(x.journeys.continued.rate, 1);
  const noThread = report([input(6000)], { sessionOrigins: [origin('s', 'feishu', 1000, '')] });
  assert.equal(noThread.journeys.unknownReturnTargets, 1); assert.equal(noThread.journeys.returned.rate, null);
});

test('original Request metadata verifies archived conversation origin without exposing text or inferring agent work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-origins-'));
  try {
    await mkdir(join(directory, 'archive')); await mkdir(join(directory, 'lookup', 'first-user-request'), { recursive: true });
    const key = '0123456789abcdef01234567', sessionId = 'old-session';
    const request = { schema: 1, key, sessionId, acceptedAt: '2026-09-01T12:00:00Z', text: 'private content',
      options: { viewPersonId: 'verified', initiatedByIdentityId: 'verified-identity',
        sourceContext: { connector: 'feishu', chatId: 'private-chat', rootId: 'private-thread', sender: { senderType: 'user' } } } };
    const address = createHash('sha256').update(JSON.stringify([sessionId, 'first'])).digest('hex').slice(0, 24);
    await writeFile(join(directory, 'lookup', 'first-user-request', address + '.json'), JSON.stringify({ key }));
    await writeFile(join(directory, 'archive', key + '.json'), JSON.stringify(request));
    const x = await readUsageSessionOrigins([sessionId, 'missing'], { requestsDirectory: directory, hash: usageKey });
    assert.equal(x.origins.length, 1); assert.equal(x.origins[0].surface, 'feishu');
    assert.equal(x.origins[0].timestamp, Date.parse(request.acceptedAt));
    assert.equal(x.origins[0].conversationKey, usageKey(JSON.stringify(['default', 'private-chat', 'private-thread'])));
    assert.ok(!JSON.stringify(x).includes('private')); assert.equal(x.errors, 0);
    assert.equal(usageOriginFromRequest({ ...request, options: { ...request.options, usageActorKind: 'agent' } }, usageKey), null);
    assert.equal(usageOriginFromRequest({ ...request, options: { ...request.options, scheduleId: 'automation' } }, usageKey), null);
    assert.equal(usageOriginFromRequest({ ...request, options: { ...request.options, sourceContext: {} } }, usageKey), null);
    assert.equal((await readUsageSessionOrigins([sessionId, 'missing'], { requestsDirectory: directory, hash: usageKey, maxSessions: 1 })).truncated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
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

#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.REMOTELAB_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'remotelab-recurring-schedules-'));

const {
  createRecurringSchedule,
  getNextCronOccurrence,
  listRecurringSchedules,
  materializeDueRecurringSchedulesNow,
  parseCronExpression,
  parseGateOutput,
  runScheduleGate,
  updateRecurringSchedule,
} = await import('../chat/recurring-schedules.mjs');

const parsed = parseCronExpression('*/15 9-17 * * 1-5');
assert.equal(parsed.minute.values.has(0), true);
assert.equal(parsed.minute.values.has(15), true);
assert.equal(parsed.hour.values.has(9), true);
assert.equal(parsed.dayOfWeek.values.has(1), true);
assert.throws(() => parseCronExpression('61 * * * *'), /minute/i);

assert.equal(
  getNextCronOccurrence('0 9 * * *', 'Asia/Shanghai', '2026-07-26T23:30:00.000Z'),
  '2026-07-27T01:00:00.000Z',
);
assert.equal(
  getNextCronOccurrence('0 9 * * 1-5', 'Asia/Shanghai', '2026-07-24T02:00:00.000Z'),
  '2026-07-27T01:00:00.000Z',
);

const createdTriggers = [];
const schedule = await createRecurringSchedule({
  sourceSessionId: 'sess-recurring',
  createdByIdentityId: 'identity_creator',
  sessionTemplate: { folder: '/tmp', tool: 'codex', name: 'Daily execution' },
  title: 'Daily date',
  text: 'Send the date',
  cron: '* * * * *',
  timezone: 'Asia/Shanghai',
  sourceDelivery: {
    connector: 'feishu',
    sourceRouteId: 'default',
    target: { chatId: 'oc_test', messageId: 'om_test' },
  },
}, { now: '2026-07-27T00:00:15.000Z' });

assert.match(schedule.id, /^sch_[a-f0-9]{24}$/);
assert.equal(schedule.nextRunAt, '2026-07-27T00:01:00.000Z');
assert.equal(schedule.misfirePolicy, 'latest_once');
assert.equal(schedule.overlapPolicy, 'latest_once');
assert.equal(schedule.createdByIdentityId, 'identity_creator');

const result = await materializeDueRecurringSchedulesNow({
  now: '2026-07-27T00:05:20.000Z',
  countOpenScheduleTriggers: async () => 0,
  createScheduledTrigger: async (input) => {
    createdTriggers.push(input);
    return { id: 'trg_000000000000000000000001', ...input };
  },
});

assert.equal(result.materialized, 1);
assert.equal(createdTriggers.length, 1);
assert.equal(createdTriggers[0].scheduledAt, '2026-07-27T00:05:00.000Z');
assert.equal(createdTriggers[0].scheduleId, schedule.id);
assert.equal(createdTriggers[0].sourceSessionId, 'sess-recurring');
assert.equal(createdTriggers[0].createdByIdentityId, 'identity_creator');
assert.equal(createdTriggers[0].sessionTemplate.conversation.target.chatId, 'oc_test');

const [advanced] = await listRecurringSchedules({ sessionId: 'sess-recurring' });
assert.equal(advanced.nextRunAt, '2026-07-27T00:06:00.000Z');
assert.equal(advanced.missedCount, 4);

const cancelled = await updateRecurringSchedule(schedule.id, { enabled: false });
assert.equal(cancelled.status, 'cancelled');
assert.equal(cancelled.enabled, false);

const isolatedSchedule = await createRecurringSchedule({
  sourceSessionId: 'sess-isolated',
  sessionTemplate: {
    folder: '/tmp',
    tool: 'codex',
    name: 'Isolated execution',
    internalRole: 'scheduled_execution',
  },
  title: 'Isolated daily task',
  text: 'Run in isolation',
  cron: '0 20 * * *',
  timezone: 'Asia/Shanghai',
}, { now: '2026-07-27T00:00:15.000Z' });
assert.equal(isolatedSchedule.sourceSessionId, 'sess-isolated');
assert.equal(isolatedSchedule.sessionTemplate.internalRole, 'scheduled_execution');

const badSchedule = await createRecurringSchedule({
  sourceSessionId: 'archived-session',
  sessionTemplate: { folder: '/tmp', tool: 'codex', name: 'Broken execution' },
  text: 'bad', cron: '* * * * *', timezone: 'Asia/Shanghai',
}, { now: '2026-07-27T00:10:15.000Z' });
const healthySchedule = await createRecurringSchedule({
  sourceSessionId: 'healthy-session',
  sessionTemplate: { folder: '/tmp', tool: 'codex', name: 'Healthy execution' },
  text: 'healthy', cron: '* * * * *', timezone: 'Asia/Shanghai',
}, { now: '2026-07-27T00:10:15.000Z' });
const isolated = await materializeDueRecurringSchedulesNow({
  now: '2026-07-27T00:11:20.000Z',
  countOpenScheduleTriggers: async () => 0,
  createScheduledTrigger: async (input) => {
    if (input.sourceSessionId === 'archived-session') throw new Error('Session is archived');
    return { id: 'trg_healthy', ...input };
  },
});
assert.equal(isolated.failed, 1, 'one broken schedule should be reported');
assert.equal(isolated.materialized, 1, 'one broken schedule must not block healthy schedules');
await updateRecurringSchedule(badSchedule.id, { enabled: false });
await updateRecurringSchedule(healthySchedule.id, { enabled: false });

assert.deepEqual(parseGateOutput('yes'), { trigger: true, reason: '', dedupeKey: '' });
assert.deepEqual(parseGateOutput('{"trigger":false,"reason":"unchanged"}'), {
  trigger: false, reason: 'unchanged', dedupeKey: '',
});
assert.throws(() => parseGateOutput('maybe'), /Gate output/);
await assert.rejects(() => createRecurringSchedule({
  sourceSessionId: 'invalid-interval',
  sessionTemplate: { folder: '/tmp', tool: 'codex' },
  text: 'invalid',
  everySeconds: 10.5,
}), /everySeconds/);
await assert.rejects(() => createRecurringSchedule({
  sourceSessionId: 'invalid-lifetime',
  sessionTemplate: { folder: '/tmp', tool: 'codex' },
  text: 'invalid',
  everySeconds: 10,
  lifetime: { mode: 'continuous', maxExecutions: 2 },
}), /continuous lifetime/);
assert.deepEqual(await runScheduleGate({
  id: 'sch_gate_runtime',
  sessionTemplate: { folder: '/tmp' },
  gate: { mode: 'script', runtime: 'bash', source: 'printf \'%s\\n\' \'{"trigger":true,"reason":"changed"}\'', timeoutSeconds: 2 },
}, '2026-07-27T00:00:00.000Z'), { trigger: true, reason: 'changed', dedupeKey: '' });
await assert.rejects(() => runScheduleGate({
  id: 'sch_bad_gate_runtime',
  sessionTemplate: { folder: '/tmp' },
  gate: { mode: 'script', runtime: 'bash', source: 'echo maybe', timeoutSeconds: 2 },
}, '2026-07-27T00:00:00.000Z'), /Gate output/);

const gatedTriggers = [];
const gated = await createRecurringSchedule({
  sourceSessionId: 'gated-session',
  sessionTemplate: { folder: '/tmp', tool: 'codex', name: 'Gated execution' },
  text: 'Inspect the change',
  everySeconds: 10,
  lifetime: { mode: 'bounded', maxExecutions: 2, maxChecks: 3 },
  gate: { mode: 'script', runtime: 'bash', source: 'echo yes', timeoutSeconds: 2 },
}, { now: '2026-07-27T01:00:00.000Z' });
assert.equal(gated.cadence.type, 'interval');
assert.equal(gated.cadence.everySeconds, 10);
assert.equal(gated.nextRunAt, '2026-07-27T01:00:10.000Z');
assert.equal(gated.gate.snapshotSha256.length, 64);
assert.equal(gated.lifetime.maxExecutions, 2);

const gatedResult = await materializeDueRecurringSchedulesNow({
  now: '2026-07-27T01:00:35.000Z',
  countOpenScheduleTriggers: async () => 0,
  getScheduleTriggerCounts: async () => ({ admittedExecutions: 0, pendingAdmissions: 0 }),
  runGate: async () => ({ trigger: true, reason: 'changed', dedupeKey: 'revision-1' }),
  createScheduledTrigger: async (input) => {
    gatedTriggers.push(input);
    return { id: 'trg_gated', ...input };
  },
});
assert.equal(gatedResult.materialized, 1);
assert.equal(gatedTriggers[0].scheduledAt, '2026-07-27T01:00:30.000Z');
assert.match(gatedTriggers[0].occurrenceId, new RegExp(`^${gated.id}:gate:`));
const gatedAfter = await listRecurringSchedules({ sessionId: 'gated-session' });
assert.equal(gatedAfter[0].missedCount, 2);
assert.equal(gatedAfter[0].checkCount, 1);
assert.equal(gatedAfter[0].matchCount, 1);

await materializeDueRecurringSchedulesNow({
  now: '2026-07-27T01:00:36.000Z',
  countOpenScheduleTriggers: async () => 0,
  getScheduleTriggerCounts: async (scheduleId) => scheduleId === gated.id
    ? { admittedExecutions: 2, pendingAdmissions: 0 }
    : { admittedExecutions: 0, pendingAdmissions: 0 },
  runGate: async () => { throw new Error('completed schedules must not run gates'); },
  createScheduledTrigger: async () => { throw new Error('completed schedules must not create triggers'); },
});
const completedGated = (await listRecurringSchedules({ sessionId: 'gated-session' }))[0];
assert.equal(completedGated.status, 'completed');
assert.equal(completedGated.enabled, false);
assert.equal(completedGated.nextRunAt, '');

const failingGate = await createRecurringSchedule({
  sourceSessionId: 'failing-gate-session',
  sessionTemplate: { folder: '/tmp', tool: 'codex', name: 'Failing gate' },
  text: 'Must not be admitted',
  everySeconds: 10,
  gate: { mode: 'script', runtime: 'bash', source: 'echo malformed', timeoutSeconds: 2 },
}, { now: '2026-07-27T02:00:00.000Z' });
let failClosedAdmissions = 0;
const failClosed = await materializeDueRecurringSchedulesNow({
  now: '2026-07-27T02:00:12.000Z',
  countOpenScheduleTriggers: async () => 0,
  getScheduleTriggerCounts: async () => ({ admittedExecutions: 0, pendingAdmissions: 0 }),
  createScheduledTrigger: async () => { failClosedAdmissions += 1; },
});
assert.equal(failClosed.failed, 1);
assert.equal(failClosedAdmissions, 0, 'a malformed gate result must fail closed');
const failedGateState = (await listRecurringSchedules({ sessionId: 'failing-gate-session' }))[0];
assert.equal(failedGateState.gateErrorCount, 1);
assert.equal(failedGateState.checkCount, 1);
assert.equal(failedGateState.nextRunAt, '2026-07-27T02:00:20.000Z', 'gate errors advance cadence instead of hot-looping');
await updateRecurringSchedule(failingGate.id, { enabled: false });

console.log('RecurringSchedule model tests passed.');

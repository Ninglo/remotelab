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
assert.equal(schedule.overlapPolicy, 'queue');

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
assert.equal(createdTriggers[0].sourceDelivery.target.chatId, 'oc_test');

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

console.log('RecurringSchedule model tests passed.');

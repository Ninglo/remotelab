#!/usr/bin/env node
import assert from 'assert/strict';

const { buildCalendarEventResource } = await import('../lib/connector-calendar.mjs');

const resourceWithReminder = buildCalendarEventResource({
  title: 'Watch reminder test',
  startTime: '2026-04-07T10:27:00+08:00',
  endTime: '2026-04-07T10:37:00+08:00',
  description: 'Verify real calendar reminders.',
  location: 'RemoteLab',
  timezone: 'Asia/Shanghai',
  reminderMinutesBefore: 2,
});

assert.equal(resourceWithReminder.summary, 'Watch reminder test');
assert.equal(resourceWithReminder.start.timeZone, 'Asia/Shanghai');
assert.equal(resourceWithReminder.end.timeZone, 'Asia/Shanghai');
assert.deepEqual(resourceWithReminder.reminders, {
  useDefault: false,
  overrides: [{ method: 'popup', minutes: 2 }],
});

const resourceWithoutReminder = buildCalendarEventResource({
  title: 'No reminder',
  startTime: '2026-04-07T10:27:00+08:00',
  endTime: '2026-04-07T10:37:00+08:00',
  reminderMinutesBefore: -1,
});

assert.equal(resourceWithoutReminder.reminders, undefined);

console.log('test-connector-calendar: ok');

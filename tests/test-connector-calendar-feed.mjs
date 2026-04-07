import { strict as assert } from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const testInstanceRoot = await mkdtemp(join(tmpdir(), 'remotelab-calendar-feed-'));
process.env.REMOTELAB_INSTANCE_ROOT = testInstanceRoot;

// We need to test the core logic without relying on config.mjs import order.
// Test the iCal generation function directly.

async function testIcsGeneration() {
  console.log('  [1] generateIcsContent produces valid iCal output');

  // Import the module — it will use the real config path, but we only test
  // the pure generateIcsContent function which takes a doc object.
  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test Calendar',
    events: [
      {
        uid: 'test-event-001@remotelab',
        summary: 'Team standup',
        description: 'Daily sync meeting',
        location: 'Conference Room A',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T11:00:00Z',
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
      {
        uid: 'test-event-002@remotelab',
        summary: 'Lunch with client',
        description: '',
        location: '',
        startTime: '2026-05-01T12:00:00Z',
        endTime: '2026-05-01T13:00:00Z',
        reminderMinutesBefore: 5,
        sequence: 1,
        createdAt: '2026-04-06T01:00:00Z',
        updatedAt: '2026-04-06T02:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);

  // Verify iCal structure
  assert.ok(ics.includes('BEGIN:VCALENDAR'), 'should have VCALENDAR begin');
  assert.ok(ics.includes('END:VCALENDAR'), 'should have VCALENDAR end');
  assert.ok(ics.includes('VERSION:2.0'), 'should have VERSION');
  assert.ok(ics.includes('PRODID:-//RemoteLab//Calendar Feed//EN'), 'should have PRODID');
  assert.ok(ics.includes('METHOD:PUBLISH'), 'should have METHOD:PUBLISH');
  assert.ok(ics.includes('X-WR-CALNAME:Test Calendar'), 'should have calendar name');
  assert.ok(ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT5M'), 'should have refresh interval');

  // Verify events
  assert.ok(ics.includes('BEGIN:VEVENT'), 'should have VEVENT');
  assert.ok(ics.includes('UID:test-event-001@remotelab'), 'should have first event UID');
  assert.ok(ics.includes('UID:test-event-002@remotelab'), 'should have second event UID');
  assert.ok(ics.includes('SUMMARY:Team standup'), 'should have first event summary');
  assert.ok(ics.includes('SUMMARY:Lunch with client'), 'should have second event summary');
  assert.ok(ics.includes('DESCRIPTION:Daily sync meeting'), 'should have description');
  assert.ok(ics.includes('LOCATION:Conference Room A'), 'should have location');

  // Verify UTC timestamps (DTSTART:20260501T100000Z)
  assert.ok(ics.includes('DTSTART:20260501T100000Z'), 'should have UTC start time');
  assert.ok(ics.includes('DTEND:20260501T110000Z'), 'should have UTC end time');

  // Verify SEQUENCE
  assert.ok(ics.includes('SEQUENCE:0'), 'should have sequence 0');
  assert.ok(ics.includes('SEQUENCE:1'), 'should have sequence 1');
  assert.ok(ics.includes('BEGIN:VALARM'), 'should emit VALARM when reminder is configured');
  assert.ok(ics.includes('TRIGGER:-PT5M'), 'should emit reminder trigger in minutes');
  assert.ok(ics.includes('ACTION:DISPLAY'), 'should emit display alarm action');

  // Verify CRLF line endings
  assert.ok(ics.includes('\r\n'), 'should use CRLF line endings');

  // Verify two VEVENT blocks
  const eventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(eventCount, 2, 'should have exactly 2 events');

  console.log('    PASS');
}

async function testIcsEmptyCalendar() {
  console.log('  [2] generateIcsContent handles empty calendar');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Empty Calendar',
    events: [],
  };

  const ics = generateIcsContent(doc);

  assert.ok(ics.includes('BEGIN:VCALENDAR'), 'should have VCALENDAR');
  assert.ok(ics.includes('END:VCALENDAR'), 'should have VCALENDAR end');
  assert.ok(!ics.includes('BEGIN:VEVENT'), 'should have no events');

  console.log('    PASS');
}

async function testIcsSpecialCharacters() {
  console.log('  [3] generateIcsContent escapes special characters');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test',
    events: [
      {
        uid: 'special@remotelab',
        summary: 'Meeting; with, semicolons\\and backslashes',
        description: 'Line one\nLine two',
        location: '',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T11:00:00Z',
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);

  // Semicolons, commas, and backslashes should be escaped
  assert.ok(ics.includes('\\;'), 'should escape semicolons');
  assert.ok(ics.includes('\\,'), 'should escape commas');
  assert.ok(ics.includes('\\\\'), 'should escape backslashes');
  assert.ok(ics.includes('\\n'), 'should escape newlines');

  console.log('    PASS');
}

async function testIcsInvalidDate() {
  console.log('  [4] generateIcsContent skips events with invalid dates');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test',
    events: [
      {
        uid: 'valid@remotelab',
        summary: 'Valid event',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T11:00:00Z',
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
      {
        uid: 'invalid@remotelab',
        summary: 'Invalid event',
        startTime: 'not-a-date',
        endTime: '',
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);

  const eventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(eventCount, 1, 'should only include valid event');
  assert.ok(ics.includes('UID:valid@remotelab'), 'should include valid event');
  assert.ok(!ics.includes('UID:invalid@remotelab'), 'should skip invalid event');

  console.log('    PASS');
}

async function testIcsInvalidReminder() {
  console.log('  [5] generateIcsContent ignores invalid reminders');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test',
    events: [
      {
        uid: 'no-reminder@remotelab',
        summary: 'No reminder event',
        startTime: '2026-05-01T12:00:00Z',
        endTime: '2026-05-01T13:00:00Z',
        reminderMinutesBefore: -1,
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);
  assert.ok(ics.includes('UID:no-reminder@remotelab'), 'event should still be present');
  assert.ok(!ics.includes('BEGIN:VALARM'), 'invalid reminder should not create an alarm');

  console.log('    PASS');
}

async function testBuildSubscriptionUrl() {
  console.log('  [6] buildSubscriptionUrl produces correct URL');

  const {
    buildSubscriptionUrl,
    buildCalendarSubscriptionChannels,
    filterCalendarSubscriptionChannelsForExposure,
  } = await import('../lib/connector-calendar-feed.mjs');

  const url = buildSubscriptionUrl('https://remotelab.jiujianian.dev', 'abc123');
  assert.equal(url, 'https://remotelab.jiujianian.dev/cal/abc123.ics');

  // Trailing slash handling
  const url2 = buildSubscriptionUrl('https://remotelab.jiujianian.dev/', 'abc123');
  assert.equal(url2, 'https://remotelab.jiujianian.dev/cal/abc123.ics');

  // Subpath handling for mainland bridge routes
  const mainlandUrl = buildSubscriptionUrl('https://jojotry.nat100.top/trial24', 'abc123');
  assert.equal(mainlandUrl, 'https://jojotry.nat100.top/trial24/cal/abc123.ics');

  // Localhost should never become a delivered subscription URL
  const localhostUrl = buildSubscriptionUrl('http://127.0.0.1:7690', 'abc123');
  assert.equal(localhostUrl, '', 'localhost feed URLs should be suppressed');

  const channels = buildCalendarSubscriptionChannels({
    feedToken: 'abc123',
    mainlandBaseUrl: 'https://jojotry.nat100.top/trial24',
    publicBaseUrl: 'https://trial24.jiujianian.dev',
    preferredBaseUrl: 'https://jojotry.nat100.top/trial24',
  });
  assert.equal(channels.preferredHttpsUrl, 'https://jojotry.nat100.top/trial24/cal/abc123.ics');
  assert.equal(channels.publicHttpsUrl, 'https://trial24.jiujianian.dev/cal/abc123.ics');
  assert.equal(channels.variants.length, 2, 'internal channel builder should preserve both mainland and public subscription variants');
  assert.equal(channels.variants[0].kind, 'mainland', 'mainland link should be preferred when requested');

  const exposedChannels = filterCalendarSubscriptionChannelsForExposure(channels);
  assert.equal(exposedChannels.variants.length, 1, 'exposed channel set should hide the public compatibility variant');
  assert.equal(exposedChannels.variants[0].kind, 'mainland', 'mainland link should be the only exposed variant when available');
  assert.equal(exposedChannels.publicHttpsUrl, '', 'public compatibility URL should not be exposed');

  console.log('    PASS');
}

async function testDispatchCalendarToFeed() {
  console.log('  [7] dispatchCalendarToFeed creates event and returns result');

  const { dispatchCalendarToFeed, listCalendarFeedEvents } = await import('../lib/connector-calendar-feed.mjs');

  const target = {
    id: 'target_1',
    title: 'Integration Test Meeting',
    description: 'Testing the feed dispatch',
    location: 'Virtual',
    startTime: '2026-06-15T14:00:00Z',
    endTime: '2026-06-15T15:00:00Z',
    timezone: 'Asia/Shanghai',
    reminderMinutesBefore: 10,
  };

  const result = await dispatchCalendarToFeed(target, {
    sessionId: 'sess_test',
    runId: 'run_test',
    baseUrl: 'https://remotelab.jiujianian.dev',
  });

  assert.equal(result.connectorId, 'calendar');
  assert.equal(result.capabilityState, 'ready');
  assert.equal(result.deliveryState, 'delivered');
  assert.ok(result.externalId, 'should have externalId (event UID)');
  assert.ok(result.message.includes('Integration Test Meeting'), 'message should include event title');
  assert.ok(result.message.includes('/cal/'), 'message should include subscription URL');

  // Verify event was persisted
  const events = await listCalendarFeedEvents();
  const created = events.find((e) => e.summary === 'Integration Test Meeting');
  assert.ok(created, 'event should be in the store');
  assert.equal(created.sessionId, 'sess_test');
  assert.equal(created.runId, 'run_test');
  assert.deepEqual(created.reminders, [10]);

  console.log('    PASS');
}

async function testDispatchMissingSummary() {
  console.log('  [8] dispatchCalendarToFeed fails gracefully without summary');

  const { dispatchCalendarToFeed } = await import('../lib/connector-calendar-feed.mjs');

  const result = await dispatchCalendarToFeed({
    id: 'target_empty',
    title: '',
    startTime: '2026-06-15T14:00:00Z',
    endTime: '2026-06-15T15:00:00Z',
  });

  assert.equal(result.deliveryState, 'delivery_failed');
  assert.ok(result.message.includes('title'), 'should mention missing title');

  console.log('    PASS');
}

async function testMultipleReminders() {
  console.log('  [9] generateIcsContent emits multiple VALARM blocks for reminders array');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test',
    events: [
      {
        uid: 'multi-alarm@remotelab',
        summary: 'Multi-alarm event',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T11:00:00Z',
        reminders: [1440, 30],
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);
  const alarmCount = (ics.match(/BEGIN:VALARM/g) || []).length;
  assert.equal(alarmCount, 2, 'should have two VALARM blocks');
  assert.ok(ics.includes('TRIGGER:-PT1440M'), 'should have 1-day reminder');
  assert.ok(ics.includes('TRIGGER:-PT30M'), 'should have 30-min reminder');

  console.log('    PASS');
}

async function testDefaultReminders() {
  console.log('  [10] addCalendarFeedEvent applies default reminders when none specified');

  const { addCalendarFeedEvent } = await import('../lib/connector-calendar-feed.mjs');

  const event = await addCalendarFeedEvent({
    summary: 'Default reminder test',
    startTime: '2026-07-01T09:00:00Z',
    endTime: '2026-07-01T10:00:00Z',
  });

  assert.ok(Array.isArray(event.reminders), 'reminders should be an array');
  assert.deepEqual(event.reminders, [1440, 30], 'should default to [1440, 30]');

  console.log('    PASS');
}

async function testLegacyReminderBackwardCompat() {
  console.log('  [11] generateIcsContent handles legacy reminderMinutesBefore field');

  const { generateIcsContent } = await import('../lib/connector-calendar-feed.mjs');

  const doc = {
    calendarName: 'Test',
    events: [
      {
        uid: 'legacy@remotelab',
        summary: 'Legacy event',
        startTime: '2026-05-01T14:00:00Z',
        endTime: '2026-05-01T15:00:00Z',
        reminderMinutesBefore: 15,
        // No reminders array — old event format
        sequence: 0,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
      },
    ],
  };

  const ics = generateIcsContent(doc);
  assert.ok(ics.includes('BEGIN:VALARM'), 'legacy event should still get VALARM');
  assert.ok(ics.includes('TRIGGER:-PT15M'), 'should use legacy reminderMinutesBefore value');

  console.log('    PASS');
}

// ---- Run all tests ----

console.log('\n=== connector-calendar-feed tests ===\n');

try {
  await testIcsGeneration();
  await testIcsEmptyCalendar();
  await testIcsSpecialCharacters();
  await testIcsInvalidDate();
  await testIcsInvalidReminder();
  await testBuildSubscriptionUrl();
  await testDispatchCalendarToFeed();
  await testDispatchMissingSummary();
  await testMultipleReminders();
  await testDefaultReminders();
  await testLegacyReminderBackwardCompat();
  console.log('\n  All 11 tests passed.\n');
} catch (err) {
  console.error('\n  FAIL:', err.message);
  console.error(err.stack);
  process.exit(1);
} finally {
  await rm(testInstanceRoot, { recursive: true, force: true });
}

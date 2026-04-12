import {
  addCalendarFeedEvent,
  buildCalendarSubscribeHelperPath,
  deleteCalendarFeedEvent,
  filterCalendarSubscriptionChannelsForExposure,
  getDefaultCalendarSubscriptionChannels,
  getFeedInfo,
  listCalendarFeedEvents,
  updateCalendarFeedEvent,
} from './connector-calendar-feed.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:
  remotelab agenda <command> [options]

Commands:
  add                      Add an event to the instance calendar feed
  list                     List feed events
  get <event-id>           Load one feed event
  update <event-id>        Update an existing feed event
  delete <event-id>        Delete an event from the feed
  subscribe                Show the subscription helper/direct URLs

Add / update options:
  --title <text>           Event title (required for add)
  --start <timestamp>      Event start time (ISO 8601)
  --end <timestamp>        Event end time (ISO 8601)
  --duration <minutes>     Duration in minutes (used with --start)
  --description <text>     Optional description
  --location <text>        Optional location
  --timezone <iana>        Optional timezone label (default: Asia/Shanghai)
  --reminder <minutes>     Reminder lead time in minutes; repeatable

General options:
  --json                   Print machine-readable JSON
  --help                   Show this help

Examples:
  remotelab agenda add --title "Doctor" --start 2026-04-21T09:00:00+08:00 --duration 30 --reminder 30
  remotelab agenda list --json
  remotelab agenda subscribe
`);
}

function parsePositiveMinutes(value, flag) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer number of minutes`);
  }
  return parsed;
}

function parseReminderMinutes(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('--reminder must be a non-negative integer number of minutes');
  }
  return parsed;
}

function normalizeTimestamp(value, flag) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a valid ISO 8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function buildEndTimeFromDuration(startTime, durationMinutes) {
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) {
    throw new Error('Cannot compute duration without a valid start time');
  }
  return new Date(startMs + (durationMinutes * 60 * 1000)).toISOString();
}

function ensureChronologicalRange(startTime, endTime) {
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('Event start and end must be valid timestamps');
  }
  if (endMs <= startMs) {
    throw new Error('Event end time must be after start time');
  }
}

function normalizeReminderList(reminders = []) {
  if (!Array.isArray(reminders) || reminders.length === 0) return undefined;
  return [...new Set(reminders)].sort((left, right) => right - left);
}

function parseArgs(argv = []) {
  const rawCommand = trimString(argv[0]).toLowerCase();
  const topLevelHelp = rawCommand === '--help' || rawCommand === '-h';
  const command = topLevelHelp ? '' : rawCommand;
  const idCommands = new Set(['get', 'update', 'delete']);
  const eventId = idCommands.has(command) ? trimString(argv[1]) : '';
  const startIndex = idCommands.has(command) ? 2 : 1;
  const options = {
    command,
    eventId,
    title: '',
    start: '',
    end: '',
    duration: '',
    description: '',
    location: '',
    timezone: 'Asia/Shanghai',
    reminders: [],
    json: false,
    help: topLevelHelp,
  };

  const valueFlags = new Set([
    '--title',
    '--start',
    '--end',
    '--duration',
    '--description',
    '--location',
    '--timezone',
    '--reminder',
  ]);

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--title':
        options.title = argv[index + 1] || '';
        index += 1;
        break;
      case '--start':
        options.start = argv[index + 1] || '';
        index += 1;
        break;
      case '--end':
        options.end = argv[index + 1] || '';
        index += 1;
        break;
      case '--duration':
        options.duration = argv[index + 1] || '';
        index += 1;
        break;
      case '--description':
        options.description = argv[index + 1] || '';
        index += 1;
        break;
      case '--location':
        options.location = argv[index + 1] || '';
        index += 1;
        break;
      case '--timezone':
        options.timezone = argv[index + 1] || '';
        index += 1;
        break;
      case '--reminder':
        options.reminders.push(parseReminderMinutes(argv[index + 1] || ''));
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (valueFlags.has(arg)) {
          throw new Error(`Missing value for ${arg}`);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.command = trimString(options.command).toLowerCase();
  options.eventId = trimString(options.eventId);
  options.title = trimString(options.title);
  options.start = trimString(options.start);
  options.end = trimString(options.end);
  options.duration = trimString(options.duration);
  options.description = trimString(options.description);
  options.location = trimString(options.location);
  options.timezone = trimString(options.timezone) || 'Asia/Shanghai';
  options.reminders = normalizeReminderList(options.reminders);
  return options;
}

function sortEvents(events = []) {
  return [...events].sort((left, right) => {
    const leftMs = Date.parse(left?.startTime || '') || 0;
    const rightMs = Date.parse(right?.startTime || '') || 0;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return trimString(left?.uid).localeCompare(trimString(right?.uid));
  });
}

async function buildSubscriptionSurface() {
  const feedInfo = await getFeedInfo();
  const channels = filterCalendarSubscriptionChannelsForExposure(
    getDefaultCalendarSubscriptionChannels(feedInfo.feedToken),
  );
  return {
    helperPath: buildCalendarSubscribeHelperPath(),
    manualHelperPath: buildCalendarSubscribeHelperPath({ format: 'https' }),
    subscriptionUrl: channels.preferredHttpsUrl,
    webcalUrl: channels.preferredWebcalUrl,
    calendarName: feedInfo.calendarName,
    eventCount: feedInfo.eventCount,
  };
}

function buildEventLines(event = {}) {
  const reminders = Array.isArray(event.reminders) ? event.reminders.join(', ') : '';
  return [
    `id: ${trimString(event.uid)}`,
    `title: ${trimString(event.summary)}`,
    `startTime: ${trimString(event.startTime)}`,
    trimString(event.endTime) ? `endTime: ${trimString(event.endTime)}` : '',
    trimString(event.description) ? `description: ${trimString(event.description)}` : '',
    trimString(event.location) ? `location: ${trimString(event.location)}` : '',
    trimString(event.timezone) ? `timezone: ${trimString(event.timezone)}` : '',
    reminders ? `reminders: ${reminders}` : '',
  ].filter(Boolean);
}

function writeOutput(payload, options = {}, stdout = process.stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (payload?.event) {
    const lines = buildEventLines(payload.event);
    if (payload.subscribe?.subscriptionUrl) {
      lines.push(`subscriptionUrl: ${payload.subscribe.subscriptionUrl}`);
    }
    lines.push(`subscribeHelper: ${payload.subscribe?.helperPath || buildCalendarSubscribeHelperPath()}`);
    stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (Array.isArray(payload?.events)) {
    const blocks = payload.events.map((event) => buildEventLines(event).join('\n'));
    stdout.write(`${blocks.join('\n\n')}\n`);
    return;
  }

  if (payload?.subscribe) {
    const lines = [
      `calendarName: ${trimString(payload.subscribe.calendarName)}`,
      `eventCount: ${payload.subscribe.eventCount ?? 0}`,
      `subscribeHelper: ${trimString(payload.subscribe.helperPath)}`,
      `manualSubscribeHelper: ${trimString(payload.subscribe.manualHelperPath)}`,
      trimString(payload.subscribe.subscriptionUrl) ? `subscriptionUrl: ${trimString(payload.subscribe.subscriptionUrl)}` : '',
      trimString(payload.subscribe.webcalUrl) ? `webcalUrl: ${trimString(payload.subscribe.webcalUrl)}` : '',
    ].filter(Boolean);
    stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (payload?.deleted) {
    stdout.write(`deleted: ${payload.deleted}\nid: ${trimString(payload.eventId)}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveAddTiming(options) {
  const startTime = normalizeTimestamp(options.start, '--start');
  if (!startTime) {
    throw new Error('--start is required');
  }
  const endTime = options.end
    ? normalizeTimestamp(options.end, '--end')
    : buildEndTimeFromDuration(startTime, parsePositiveMinutes(options.duration, '--duration'));
  ensureChronologicalRange(startTime, endTime);
  return { startTime, endTime };
}

function resolveUpdateTiming(options, existingEvent) {
  const hasStart = !!options.start;
  const hasEnd = !!options.end;
  const hasDuration = !!options.duration;
  if (!hasStart && !hasEnd && !hasDuration) return {};

  const updates = {};
  const currentStart = trimString(existingEvent?.startTime);
  const currentEnd = trimString(existingEvent?.endTime);
  const nextStart = hasStart ? normalizeTimestamp(options.start, '--start') : currentStart;

  if (hasDuration) {
    if (!nextStart) {
      throw new Error('Cannot apply --duration without a start time');
    }
    const nextEnd = buildEndTimeFromDuration(nextStart, parsePositiveMinutes(options.duration, '--duration'));
    ensureChronologicalRange(nextStart, nextEnd);
    if (hasStart) updates.startTime = nextStart;
    updates.endTime = nextEnd;
    return updates;
  }

  if (hasEnd) {
    const nextEnd = normalizeTimestamp(options.end, '--end');
    if (nextStart) {
      ensureChronologicalRange(nextStart, nextEnd);
    }
    if (hasStart) updates.startTime = nextStart;
    updates.endTime = nextEnd;
    return updates;
  }

  if (hasStart) {
    const currentStartMs = Date.parse(currentStart);
    const currentEndMs = Date.parse(currentEnd);
    updates.startTime = nextStart;
    if (Number.isFinite(currentStartMs) && Number.isFinite(currentEndMs) && currentEndMs > currentStartMs) {
      updates.endTime = new Date(Date.parse(nextStart) + (currentEndMs - currentStartMs)).toISOString();
    }
  }

  return updates;
}

export async function runAgendaCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp(stdout);
    return 0;
  }

  if (options.command === 'add') {
    if (!options.title) {
      throw new Error('--title is required');
    }
    const timing = resolveAddTiming(options);
    const event = await addCalendarFeedEvent({
      summary: options.title,
      description: options.description,
      location: options.location,
      startTime: timing.startTime,
      endTime: timing.endTime,
      timezone: options.timezone,
      reminders: options.reminders,
    });
    writeOutput({ event, subscribe: await buildSubscriptionSurface() }, options, stdout);
    return 0;
  }

  if (options.command === 'list') {
    const events = sortEvents(await listCalendarFeedEvents());
    writeOutput({ events }, options, stdout);
    return 0;
  }

  if (options.command === 'subscribe') {
    writeOutput({ subscribe: await buildSubscriptionSurface() }, options, stdout);
    return 0;
  }

  const eventId = trimString(options.eventId);
  if (!eventId) {
    throw new Error(`${options.command} requires an event id`);
  }

  const events = await listCalendarFeedEvents();
  const existingEvent = events.find((event) => trimString(event?.uid) === eventId);
  if (!existingEvent) {
    throw new Error(`Unknown agenda event: ${eventId}`);
  }

  if (options.command === 'get') {
    writeOutput({ event: existingEvent, subscribe: await buildSubscriptionSurface() }, options, stdout);
    return 0;
  }

  if (options.command === 'delete') {
    const deleted = await deleteCalendarFeedEvent(eventId);
    writeOutput({ deleted, eventId }, options, stdout);
    return deleted ? 0 : 1;
  }

  if (options.command === 'update') {
    const timingUpdates = resolveUpdateTiming(options, existingEvent);
    const event = await updateCalendarFeedEvent(eventId, {
      ...(options.title ? { summary: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.location ? { location: options.location } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
      ...(options.reminders ? { reminders: options.reminders } : {}),
      ...timingUpdates,
    });
    if (!event) {
      throw new Error(`Failed to update agenda event: ${eventId}`);
    }
    writeOutput({ event, subscribe: await buildSubscriptionSurface() }, options, stdout);
    return 0;
  }

  throw new Error(`Unknown agenda command: ${options.command}`);
}

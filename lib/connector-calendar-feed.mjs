import { randomBytes } from 'crypto';

import { createKeyedTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { CALENDAR_EVENTS_FILE } from './config.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const FEED_VERSION = 1;
const feedMutationQueue = createKeyedTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function generateUid() {
  return `${randomBytes(12).toString('hex')}@remotelab`;
}

function generateFeedToken() {
  return randomBytes(24).toString('hex');
}

async function loadFeedDocument() {
  const doc = await readJson(CALENDAR_EVENTS_FILE, null);
  if (!doc) {
    const fresh = {
      version: FEED_VERSION,
      feedToken: generateFeedToken(),
      calendarName: 'RemoteLab',
      events: [],
    };
    await writeJsonAtomic(CALENDAR_EVENTS_FILE, fresh);
    return fresh;
  }
  return {
    version: doc.version || FEED_VERSION,
    feedToken: trimString(doc.feedToken) || generateFeedToken(),
    calendarName: trimString(doc.calendarName) || 'RemoteLab',
    events: Array.isArray(doc.events) ? doc.events : [],
  };
}

async function saveFeedDocument(doc) {
  await writeJsonAtomic(CALENDAR_EVENTS_FILE, doc);
}

// ---- iCal formatting helpers ----

function toIcsUtcTimestamp(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  // 20260501T070000Z
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcsText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldIcsLine(line) {
  // RFC 5545: content lines should be max 75 octets, fold with CRLF + space
  const parts = [];
  let remaining = line;
  while (remaining.length > 75) {
    parts.push(remaining.slice(0, 75));
    remaining = ' ' + remaining.slice(75);
  }
  parts.push(remaining);
  return parts.join('\r\n');
}

// ---- Feed document queries ----

export async function getFeedInfo() {
  const doc = await loadFeedDocument();
  return {
    feedToken: doc.feedToken,
    calendarName: doc.calendarName,
    eventCount: doc.events.length,
  };
}

export async function getFeedToken() {
  const doc = await loadFeedDocument();
  return doc.feedToken;
}

export function buildSubscriptionUrl(baseUrl, feedToken) {
  const base = trimString(baseUrl).replace(/\/+$/, '');
  return `${base}/cal/${feedToken}.ics`;
}

export async function getSubscriptionUrl(baseUrl) {
  const token = await getFeedToken();
  return buildSubscriptionUrl(baseUrl, token);
}

// ---- Event CRUD ----

export async function addCalendarFeedEvent({ summary, description, location, startTime, endTime, timezone, sessionId, runId }) {
  return await feedMutationQueue(CALENDAR_EVENTS_FILE, async () => {
    const doc = await loadFeedDocument();
    const uid = generateUid();
    const now = nowIso();

    const event = {
      uid,
      summary: trimString(summary),
      description: trimString(description),
      location: trimString(location),
      startTime: trimString(startTime),
      endTime: trimString(endTime),
      timezone: trimString(timezone) || 'Asia/Shanghai',
      sessionId: trimString(sessionId),
      runId: trimString(runId),
      sequence: 0,
      createdAt: now,
      updatedAt: now,
    };

    doc.events.push(event);
    await saveFeedDocument(doc);
    return event;
  });
}

export async function updateCalendarFeedEvent(uid, updates) {
  return await feedMutationQueue(CALENDAR_EVENTS_FILE, async () => {
    const doc = await loadFeedDocument();
    const index = doc.events.findIndex((e) => e.uid === uid);
    if (index < 0) return null;

    const event = doc.events[index];
    if (updates.summary !== undefined) event.summary = trimString(updates.summary);
    if (updates.description !== undefined) event.description = trimString(updates.description);
    if (updates.location !== undefined) event.location = trimString(updates.location);
    if (updates.startTime !== undefined) event.startTime = trimString(updates.startTime);
    if (updates.endTime !== undefined) event.endTime = trimString(updates.endTime);
    event.sequence = (event.sequence || 0) + 1;
    event.updatedAt = nowIso();

    doc.events[index] = event;
    await saveFeedDocument(doc);
    return event;
  });
}

export async function deleteCalendarFeedEvent(uid) {
  return await feedMutationQueue(CALENDAR_EVENTS_FILE, async () => {
    const doc = await loadFeedDocument();
    const index = doc.events.findIndex((e) => e.uid === uid);
    if (index < 0) return false;
    doc.events.splice(index, 1);
    await saveFeedDocument(doc);
    return true;
  });
}

export async function listCalendarFeedEvents() {
  const doc = await loadFeedDocument();
  return doc.events;
}

// ---- iCal feed generation ----

export function generateIcsContent(doc) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RemoteLab//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(doc.calendarName || 'RemoteLab')}`),
    'REFRESH-INTERVAL;VALUE=DURATION:PT5M',
    'X-PUBLISHED-TTL:PT5M',
  ];

  for (const event of doc.events || []) {
    const dtstart = toIcsUtcTimestamp(event.startTime);
    if (!dtstart) continue;
    const dtend = toIcsUtcTimestamp(event.endTime);
    const dtstamp = toIcsUtcTimestamp(event.updatedAt || event.createdAt) || toIcsUtcTimestamp(nowIso());

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${dtstart}`);
    if (dtend) lines.push(`DTEND:${dtend}`);
    if (event.summary) lines.push(foldIcsLine(`SUMMARY:${escapeIcsText(event.summary)}`));
    if (event.description) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    if (event.location) lines.push(foldIcsLine(`LOCATION:${escapeIcsText(event.location)}`));
    lines.push(`SEQUENCE:${event.sequence || 0}`);
    lines.push(`CREATED:${toIcsUtcTimestamp(event.createdAt) || dtstamp}`);
    lines.push(`LAST-MODIFIED:${dtstamp}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export async function generateIcsFeed() {
  const doc = await loadFeedDocument();
  return generateIcsContent(doc);
}

// ---- Dispatcher integration ----

export async function dispatchCalendarToFeed(target, { sessionId, runId, baseUrl } = {}) {
  const summary = trimString(target?.title);
  if (!summary) {
    return createConnectorActionResult({
      actionId: trimString(target?.id),
      connectorId: 'calendar',
      capabilityState: 'ready',
      deliveryState: 'delivery_failed',
      message: 'Calendar event requires a title/summary.',
    });
  }

  const event = await addCalendarFeedEvent({
    summary,
    description: trimString(target?.description),
    location: trimString(target?.location),
    startTime: trimString(target?.startTime),
    endTime: trimString(target?.endTime),
    timezone: trimString(target?.timezone),
    sessionId,
    runId,
  });

  const feedToken = await getFeedToken();
  const subscriptionUrl = baseUrl ? buildSubscriptionUrl(baseUrl, feedToken) : '';

  return createConnectorActionResult({
    actionId: trimString(target?.id),
    connectorId: 'calendar',
    targetId: `event:${event.uid}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: event.uid,
    message: subscriptionUrl
      ? `Event "${summary}" added to calendar feed. Subscribe: ${subscriptionUrl}`
      : `Event "${summary}" added to calendar feed.`,
  });
}

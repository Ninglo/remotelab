import { randomBytes } from 'crypto';

import { createKeyedTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { CALENDAR_EVENTS_FILE, MAINLAND_PUBLIC_BASE_URL, PUBLIC_BASE_URL } from './config.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const FEED_VERSION = 1;
const feedMutationQueue = createKeyedTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSubscriptionBaseUrl(baseUrl) {
  const trimmed = trimString(baseUrl).replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return '';
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
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

const DEFAULT_REMINDERS = [1440, 30]; // 1 day before, 30 min before

function normalizeReminderMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Normalize reminders input into a sorted array of non-negative integers (minutes).
 * Accepts: array of numbers, a single number, or null/undefined.
 * Falls back to DEFAULT_REMINDERS when nothing valid is provided.
 */
function normalizeReminders(reminders, singleFallback) {
  let raw = reminders;
  if (!Array.isArray(raw)) {
    // Accept legacy single-value field
    const single = normalizeReminderMinutes(raw ?? singleFallback);
    raw = single !== null ? [single] : null;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const valid = raw
      .map((v) => normalizeReminderMinutes(v))
      .filter((v) => v !== null);
    if (valid.length > 0) {
      // Dedupe and sort descending (longest lead time first)
      return [...new Set(valid)].sort((a, b) => b - a);
    }
  }
  return [...DEFAULT_REMINDERS];
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
  const base = normalizeSubscriptionBaseUrl(baseUrl);
  if (!base || !trimString(feedToken)) return '';
  return `${base}/cal/${feedToken}.ics`;
}

export function buildWebcalSubscriptionUrl(baseUrl, feedToken) {
  const httpsUrl = buildSubscriptionUrl(baseUrl, feedToken);
  if (!httpsUrl) return '';
  return httpsUrl.replace(/^https?:\/\//, 'webcal://');
}

function addSubscriptionVariant(variants, seenUrls, {
  kind,
  label,
  baseUrl,
  feedToken,
  recommended = false,
} = {}) {
  const httpsUrl = buildSubscriptionUrl(baseUrl, feedToken);
  if (!httpsUrl || seenUrls.has(httpsUrl)) return;
  seenUrls.add(httpsUrl);
  variants.push({
    kind: trimString(kind),
    label: trimString(label),
    httpsUrl,
    webcalUrl: buildWebcalSubscriptionUrl(baseUrl, feedToken),
    recommended,
  });
}

export function buildCalendarSubscriptionChannels({
  feedToken = '',
  mainlandBaseUrl = '',
  publicBaseUrl = '',
  preferredBaseUrl = '',
} = {}) {
  const normalizedFeedToken = trimString(feedToken);
  if (!normalizedFeedToken) {
    return {
      preferredHttpsUrl: '',
      preferredWebcalUrl: '',
      mainlandHttpsUrl: '',
      mainlandWebcalUrl: '',
      publicHttpsUrl: '',
      publicWebcalUrl: '',
      variants: [],
    };
  }

  const resolvedPreferredBaseUrl = trimString(preferredBaseUrl)
    || trimString(mainlandBaseUrl)
    || trimString(publicBaseUrl);
  const variants = [];
  const seenUrls = new Set();

  addSubscriptionVariant(variants, seenUrls, {
    kind: trimString(mainlandBaseUrl) && resolvedPreferredBaseUrl === trimString(mainlandBaseUrl)
      ? 'mainland'
      : trimString(publicBaseUrl) && resolvedPreferredBaseUrl === trimString(publicBaseUrl)
        ? 'public'
        : 'preferred',
    label: trimString(mainlandBaseUrl) && resolvedPreferredBaseUrl === trimString(mainlandBaseUrl)
      ? 'China-recommended'
      : trimString(publicBaseUrl) && resolvedPreferredBaseUrl === trimString(publicBaseUrl)
        ? 'Global / overseas'
        : 'Preferred',
    baseUrl: resolvedPreferredBaseUrl,
    feedToken: normalizedFeedToken,
    recommended: true,
  });
  addSubscriptionVariant(variants, seenUrls, {
    kind: 'mainland',
    label: 'China-recommended',
    baseUrl: mainlandBaseUrl,
    feedToken: normalizedFeedToken,
    recommended: variants.length === 0,
  });
  addSubscriptionVariant(variants, seenUrls, {
    kind: 'public',
    label: 'Global / overseas',
    baseUrl: publicBaseUrl,
    feedToken: normalizedFeedToken,
    recommended: variants.length === 0,
  });

  return {
    preferredHttpsUrl: variants[0]?.httpsUrl || '',
    preferredWebcalUrl: variants[0]?.webcalUrl || '',
    mainlandHttpsUrl: buildSubscriptionUrl(mainlandBaseUrl, normalizedFeedToken),
    mainlandWebcalUrl: buildWebcalSubscriptionUrl(mainlandBaseUrl, normalizedFeedToken),
    publicHttpsUrl: buildSubscriptionUrl(publicBaseUrl, normalizedFeedToken),
    publicWebcalUrl: buildWebcalSubscriptionUrl(publicBaseUrl, normalizedFeedToken),
    variants,
  };
}

export function getDefaultCalendarSubscriptionChannels(feedToken = '') {
  return buildCalendarSubscriptionChannels({
    feedToken,
    mainlandBaseUrl: MAINLAND_PUBLIC_BASE_URL,
    publicBaseUrl: PUBLIC_BASE_URL,
    preferredBaseUrl: MAINLAND_PUBLIC_BASE_URL || PUBLIC_BASE_URL,
  });
}

export async function getSubscriptionUrl(baseUrl) {
  const token = await getFeedToken();
  return buildSubscriptionUrl(baseUrl, token);
}

// ---- Event CRUD ----

export async function addCalendarFeedEvent({
  summary,
  description,
  location,
  startTime,
  endTime,
  timezone,
  sessionId,
  runId,
  reminders,
  reminderMinutesBefore,
}) {
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
      reminders: normalizeReminders(reminders, reminderMinutesBefore),
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
    if (updates.reminders !== undefined || updates.reminderMinutesBefore !== undefined) {
      event.reminders = normalizeReminders(updates.reminders, updates.reminderMinutesBefore);
    }
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
    // Emit VALARM blocks — prefer reminders array, fall back to legacy single value
    const alarms = Array.isArray(event.reminders) && event.reminders.length > 0
      ? event.reminders
      : (Number.isInteger(event.reminderMinutesBefore) && event.reminderMinutesBefore >= 0)
        ? [event.reminderMinutesBefore]
        : [];
    for (const minutes of alarms) {
      if (!Number.isInteger(minutes) || minutes < 0) continue;
      lines.push('BEGIN:VALARM');
      lines.push(`TRIGGER:-PT${minutes}M`);
      lines.push('ACTION:DISPLAY');
      lines.push(
        foldIcsLine(`DESCRIPTION:${escapeIcsText(event.summary || event.description || 'Reminder')}`)
      );
      lines.push('END:VALARM');
    }
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
    reminders: target?.reminders,
    reminderMinutesBefore: target?.reminderMinutesBefore,
  });

  const feedToken = await getFeedToken();
  const channels = buildCalendarSubscriptionChannels({
    feedToken,
    mainlandBaseUrl: MAINLAND_PUBLIC_BASE_URL,
    publicBaseUrl: PUBLIC_BASE_URL,
    preferredBaseUrl: trimString(baseUrl) || MAINLAND_PUBLIC_BASE_URL || PUBLIC_BASE_URL,
  });
  const preferredVariant = channels.variants[0] || null;
  const subscriptionUrl = channels.preferredHttpsUrl;
  const alternateSubscriptionUrl = channels.variants.find((variant) => variant.httpsUrl !== subscriptionUrl)?.httpsUrl || '';

  return createConnectorActionResult({
    actionId: trimString(target?.id),
    connectorId: 'calendar',
    targetId: `event:${event.uid}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: event.uid,
    message: subscriptionUrl
      ? alternateSubscriptionUrl
        ? `Event "${summary}" added to calendar feed. Subscribe: ${subscriptionUrl}${preferredVariant?.label ? ` (${preferredVariant.label})` : ''}. Alternate: ${alternateSubscriptionUrl}`
        : `Event "${summary}" added to calendar feed. Subscribe: ${subscriptionUrl}`
      : `Event "${summary}" added to calendar feed.`,
  });
}

import { promises as fs } from 'fs';
import http from 'http';
import { dirname } from 'path';

import { resolveCalendarConnectorBinding, ensureCalendarConnectorBinding } from './connector-bindings.mjs';
import { createConnectorActionResult } from './connector-state.mjs';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_CALENDAR_ID = 'primary';
const AUTH_CALLBACK_PORT = 42814;
const AUTH_REDIRECT_URI = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReminderMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function readJson(pathname, fallback = null) {
  try {
    const raw = await fs.readFile(pathname, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(pathname, data) {
  await fs.mkdir(dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function buildCalendarEventResource({
  title,
  startTime,
  endTime,
  description,
  location,
  timezone,
  reminderMinutesBefore,
} = {}) {
  const tz = trimString(timezone) || DEFAULT_TIMEZONE;
  const normalizedReminder = normalizeReminderMinutes(reminderMinutesBefore);
  return {
    summary: trimString(title),
    description: trimString(description) || undefined,
    location: trimString(location) || undefined,
    start: { dateTime: new Date(startTime).toISOString(), timeZone: tz },
    end: { dateTime: new Date(endTime).toISOString(), timeZone: tz },
    reminders: normalizedReminder === null
      ? undefined
      : {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: normalizedReminder }],
        },
    extendedProperties: {
      private: { managedBy: 'remotelab-connector' },
    },
  };
}

async function loadGoogleApi() {
  const { google } = await import('googleapis');
  const { OAuth2Client } = await import('google-auth-library');
  return { google, OAuth2Client };
}

async function buildAuthenticatedClient(binding, credentialsPath) {
  const tokenPath = trimString(binding?.tokenPath);
  if (!tokenPath) {
    throw new Error('Calendar binding has no token path — authorization is required.');
  }

  const { google, OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing Google OAuth credentials file: ${credentialsPath}`);
  }

  const config = credentials.installed || credentials.web || credentials;
  const client = new OAuth2Client(
    config.client_id,
    config.client_secret,
    Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : config.redirect_uri,
  );

  const token = await readJson(tokenPath, null);
  if (!token) {
    throw new Error(`Missing token file: ${tokenPath}. Run the calendar authorization flow first.`);
  }
  client.setCredentials(token);

  return { calendar: google.calendar({ version: 'v3', auth: client }), client };
}

function resolveBindingError(binding) {
  if (!binding) {
    return createConnectorActionResult({
      connectorId: 'calendar',
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'binding_required') {
    return createConnectorActionResult({
      connectorId: 'calendar',
      bindingId: binding.id,
      capabilityState: 'binding_required',
      deliveryState: 'drafted',
    });
  }
  if (binding.capabilityState === 'authorization_required') {
    return createConnectorActionResult({
      connectorId: 'calendar',
      bindingId: binding.id,
      capabilityState: 'authorization_required',
      deliveryState: 'drafted',
    });
  }
  return null;
}

export async function generateCalendarAuthUrl({ credentialsPath, redirectUri, state }) {
  const { OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing OAuth credentials file: ${credentialsPath}`);
  }
  const config = credentials.installed || credentials.web || credentials;
  const effectiveRedirectUri = trimString(redirectUri) || AUTH_REDIRECT_URI;
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    ...(state ? { state } : {}),
  });
}

export async function handleCalendarAuthCallback({ credentialsPath, tokenPath, code, redirectUri }) {
  const { OAuth2Client } = await loadGoogleApi();
  const credentials = await readJson(credentialsPath, null);
  if (!credentials) {
    throw new Error(`Missing OAuth credentials file: ${credentialsPath}`);
  }
  const config = credentials.installed || credentials.web || credentials;
  const effectiveRedirectUri = trimString(redirectUri) || AUTH_REDIRECT_URI;
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  const { tokens } = await client.getToken(code);
  await writeJson(tokenPath, tokens);
  return tokens;
}

export async function startCalendarAuthServer({ credentialsPath, tokenPath, onAuthUrl }) {
  const authUrl = await generateCalendarAuthUrl({ credentialsPath });
  if (onAuthUrl) onAuthUrl(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${AUTH_CALLBACK_PORT}`);
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const authCode = url.searchParams.get('code');
      if (!authCode) {
        res.statusCode = 400;
        res.end('Missing code');
        return;
      }
      res.end('Calendar authorization received. You can close this tab.');
      server.close();
      resolve(authCode);
    });
    server.listen(AUTH_CALLBACK_PORT, '127.0.0.1');
    server.on('error', reject);
  });

  return await handleCalendarAuthCallback({ credentialsPath, tokenPath, code });
}

export async function listCalendarEvents({ bindingId, credentialsPath, timeMin, timeMax, calendarId, maxResults = 100 } = {}) {
  const binding = await resolveCalendarConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return { events: [], error: bindingError };

  const targetCalendarId = trimString(calendarId) || trimString(binding.calendarId) || DEFAULT_CALENDAR_ID;
  const { calendar } = await buildAuthenticatedClient(binding, credentialsPath);

  const now = new Date();
  const effectiveTimeMin = timeMin ? new Date(timeMin) : now;
  const effectiveTimeMax = timeMax ? new Date(timeMax) : new Date(now.getTime() + 30 * 86400000);

  const events = [];
  let pageToken;
  do {
    const response = await calendar.events.list({
      calendarId: targetCalendarId,
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: Math.min(maxResults - events.length, 250),
      pageToken,
      timeMin: effectiveTimeMin.toISOString(),
      timeMax: effectiveTimeMax.toISOString(),
    });
    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken && events.length < maxResults);

  return {
    events: events.map((event) => ({
      id: event.id,
      summary: trimString(event.summary),
      description: trimString(event.description),
      location: trimString(event.location),
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      status: trimString(event.status),
      htmlLink: trimString(event.htmlLink),
    })),
    calendarId: targetCalendarId,
    bindingId: binding.id,
  };
}

export async function createCalendarEvent({
  bindingId,
  credentialsPath,
  title,
  startTime,
  endTime,
  description,
  location,
  calendarId,
  timezone,
  reminderMinutesBefore,
} = {}) {
  const binding = await resolveCalendarConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return bindingError;

  const targetCalendarId = trimString(calendarId) || trimString(binding.calendarId) || DEFAULT_CALENDAR_ID;
  const { calendar } = await buildAuthenticatedClient(binding, credentialsPath);
  const resource = buildCalendarEventResource({
    title,
    startTime,
    endTime,
    description,
    location,
    timezone,
    reminderMinutesBefore,
  });

  const result = await calendar.events.insert({
    calendarId: targetCalendarId,
    requestBody: resource,
  });

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${result.data.id}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: result.data.id,
    message: `Created event "${trimString(title)}" on ${targetCalendarId}`,
  });
}

export async function updateCalendarEvent({
  bindingId,
  credentialsPath,
  eventId,
  title,
  startTime,
  endTime,
  description,
  location,
  calendarId,
  timezone,
  reminderMinutesBefore,
} = {}) {
  const binding = await resolveCalendarConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return bindingError;

  const targetCalendarId = trimString(calendarId) || trimString(binding.calendarId) || DEFAULT_CALENDAR_ID;
  const tz = trimString(timezone) || DEFAULT_TIMEZONE;
  const { calendar } = await buildAuthenticatedClient(binding, credentialsPath);

  const resource = {};
  if (title !== undefined) resource.summary = trimString(title);
  if (description !== undefined) resource.description = trimString(description);
  if (location !== undefined) resource.location = trimString(location);
  if (startTime !== undefined) resource.start = { dateTime: new Date(startTime).toISOString(), timeZone: tz };
  if (endTime !== undefined) resource.end = { dateTime: new Date(endTime).toISOString(), timeZone: tz };
  if (reminderMinutesBefore !== undefined) {
    const normalizedReminder = normalizeReminderMinutes(reminderMinutesBefore);
    resource.reminders = normalizedReminder === null
      ? { useDefault: true }
      : {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: normalizedReminder }],
        };
  }

  const result = await calendar.events.patch({
    calendarId: targetCalendarId,
    eventId,
    requestBody: resource,
  });

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${result.data.id}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: result.data.id,
    message: `Updated event "${trimString(result.data.summary)}"`,
  });
}

export async function deleteCalendarEvent({ bindingId, credentialsPath, eventId, calendarId } = {}) {
  const binding = await resolveCalendarConnectorBinding({ bindingId });
  const bindingError = resolveBindingError(binding);
  if (bindingError) return bindingError;

  const targetCalendarId = trimString(calendarId) || trimString(binding.calendarId) || DEFAULT_CALENDAR_ID;
  const { calendar } = await buildAuthenticatedClient(binding, credentialsPath);

  await calendar.events.delete({
    calendarId: targetCalendarId,
    eventId,
  });

  return createConnectorActionResult({
    connectorId: 'calendar',
    bindingId: binding.id,
    targetId: `event:${eventId}`,
    capabilityState: 'ready',
    deliveryState: 'delivered',
    externalId: eventId,
    message: `Deleted event ${eventId}`,
  });
}

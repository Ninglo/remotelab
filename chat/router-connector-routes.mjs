import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import {
  ensureCalendarConnectorBinding,
  getConnectorBinding,
  listConnectorBindings,
} from '../lib/connector-bindings.mjs';
import { CONFIG_DIR, MAINLAND_PUBLIC_BASE_URL, PUBLIC_BASE_URL } from '../lib/config.mjs';
import {
  generateCalendarAuthUrl,
  handleCalendarAuthCallback,
} from '../lib/connector-calendar.mjs';
import { resolveExternalRuntimeSelection } from '../lib/external-runtime-selection.mjs';
import { selectAssistantReplyEvent, stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { pathExists, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  buildCalendarSubscriptionChannels,
  filterCalendarSubscriptionChannelsForExposure,
  generateIcsFeed,
  getFeedInfo,
  getSubscriptionUrl,
  listCalendarFeedEvents,
} from '../lib/connector-calendar-feed.mjs';
import { readEventBody } from './history.mjs';
import {
  createSession,
  getRunState,
  getSession,
  getSessionEventsAfter,
  submitHttpMessage,
} from './session-manager.mjs';

const SHORTCUT_BODY_MAX_BYTES = 32 * 1024;
const SHORTCUT_DEFAULT_WAIT_MS = 0;
const SHORTCUT_MAX_WAIT_MS = 20_000;
const SHORTCUT_POLL_INTERVAL_MS = 300;
const CONNECTOR_REQUEST_BODY_MAX_BYTES = 64 * 1024;
const CALENDAR_CONNECTOR_DIR = join(CONFIG_DIR, 'calendar-connector');
const GOOGLE_CALENDAR_CREDENTIALS_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-oauth-client.json');
const GOOGLE_CALENDAR_TOKEN_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-calendar-token.json');
const GOOGLE_CALENDAR_AUTH_STATE_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-calendar-auth-state.json');
const DEFAULT_CALENDAR_BINDING_ID = 'binding_calendar_21d351117862';
const DEFAULT_CALENDAR_ACCOUNT_HINT = 'Google Calendar';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBaseUrl(req) {
  const host = trimString(req.headers?.host || req.headers?.['x-forwarded-host']);
  const proto = trimString(req.headers?.['x-forwarded-proto']) || 'https';
  const prefix = normalizeForwardedPrefix(req.headers?.['x-forwarded-prefix']);
  if (!host) return '';
  return `${proto}://${host}${prefix}`;
}

function normalizeForwardedPrefix(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function hasPathPrefix(baseUrl) {
  const normalizedBaseUrl = trimString(baseUrl);
  if (!normalizedBaseUrl) return false;
  try {
    const pathname = new URL(normalizedBaseUrl).pathname.replace(/\/+$/, '');
    return pathname.length > 0 && pathname !== '/';
  } catch {
    return false;
  }
}

function buildSessionUrl(req, sessionId) {
  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) return '';
  if (!sessionId) return `${baseUrl}/`;
  return `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
}

async function resolveShortcutRuntime(payload) {
  const explicitTool = trimString(payload?.tool);
  const explicitModel = trimString(payload?.model);
  const explicitEffort = trimString(payload?.effort);
  const explicitThinking = payload?.thinking === true;

  if (explicitTool) {
    return {
      tool: explicitTool,
      model: explicitModel,
      effort: explicitEffort,
      thinking: explicitThinking,
    };
  }

  const uiSelection = await loadUiRuntimeSelection();
  const resolved = resolveExternalRuntimeSelection({
    uiSelection,
    mode: 'ui',
    fallback: {
      tool: explicitTool,
      model: explicitModel,
      effort: explicitEffort,
      thinking: explicitThinking,
    },
    defaultTool: 'codex',
  });

  return {
    tool: resolved.tool,
    model: explicitModel || resolved.model,
    effort: explicitEffort || resolved.effort,
    thinking: explicitThinking || resolved.thinking,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeShortcutWaitMs(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return SHORTCUT_DEFAULT_WAIT_MS;
  }
  return Math.min(parsed, SHORTCUT_MAX_WAIT_MS);
}

function isTerminalRunState(state) {
  return ['completed', 'failed', 'cancelled'].includes(trimString(state).toLowerCase());
}

function buildShortcutRequestId() {
  return `shortcut:${Date.now().toString(36)}:${randomUUID()}`;
}

function buildShortcutSourceContext(payload = {}) {
  const base = payload?.sourceContext && typeof payload.sourceContext === 'object'
    ? { ...payload.sourceContext }
    : {};
  const shortcutName = trimString(payload?.shortcutName);
  const inputMode = trimString(payload?.inputMode);
  return {
    ...base,
    channel: 'shortcut',
    ...(shortcutName ? { shortcutName } : {}),
    ...(inputMode ? { inputMode } : {}),
  };
}

async function readShortcutPayload(req) {
  let body;
  try {
    body = await readBody(req, SHORTCUT_BODY_MAX_BYTES);
  } catch (error) {
    const wrapped = new Error(error?.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request');
    wrapped.statusCode = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
    throw wrapped;
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Invalid request body');
    error.statusCode = 400;
    throw error;
  }
}

async function readConnectorPayload(req) {
  let body;
  try {
    body = await readBody(req, CONNECTOR_REQUEST_BODY_MAX_BYTES);
  } catch (error) {
    const wrapped = new Error(error?.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request');
    wrapped.statusCode = error?.code === 'BODY_TOO_LARGE' ? 413 : 400;
    throw wrapped;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Invalid request body');
    error.statusCode = 400;
    throw error;
  }
}

function resolveCalendarAuthRedirectUri(req) {
  const baseUrl = PUBLIC_BASE_URL || resolveBaseUrl(req);
  if (!baseUrl) return '';
  return `${baseUrl}/api/connectors/calendar/google/callback`;
}

async function getCalendarAuthStatus(req) {
  const binding = await getConnectorBinding(DEFAULT_CALENDAR_BINDING_ID, { includeCompatibilityEmail: false });
  const credentialsPresent = await pathExists(GOOGLE_CALENDAR_CREDENTIALS_PATH);
  const tokenPresent = await pathExists(GOOGLE_CALENDAR_TOKEN_PATH);
  const redirectUri = resolveCalendarAuthRedirectUri(req);
  return {
    provider: 'google',
    redirectUri,
    credentialsPath: GOOGLE_CALENDAR_CREDENTIALS_PATH,
    tokenPath: GOOGLE_CALENDAR_TOKEN_PATH,
    credentialsPresent,
    tokenPresent,
    binding: binding?.connectorId === 'calendar'
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          capabilityState: trimString(binding.capabilityState),
        }
      : null,
  };
}

async function waitForRunResult(runId, timeoutMs) {
  let run = await getRunState(runId);
  if (!run || isTerminalRunState(run.state) || timeoutMs <= 0) {
    return run;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(SHORTCUT_POLL_INTERVAL_MS);
    run = await getRunState(runId) || run;
    if (!run || isTerminalRunState(run.state)) {
      return run;
    }
  }
  return run;
}

async function hydrateReplyEvent(sessionId, event) {
  if (!event?.bodyAvailable || event.bodyLoaded !== false || trimString(event.content)) {
    return event;
  }
  const body = await readEventBody(sessionId, event.seq);
  if (!body || typeof body.value !== 'string') {
    return event;
  }
  return {
    ...event,
    bodyLoaded: true,
    content: body.value,
  };
}

async function resolveRunReply(sessionId, run) {
  if (!sessionId || !run?.id) return '';
  const events = await getSessionEventsAfter(sessionId, 0);
  const selected = await selectAssistantReplyEvent(events, {
    match: (event) => {
      if (!event) return false;
      if (trimString(run.requestId) && trimString(event.requestId) === trimString(run.requestId)) {
        return true;
      }
      return trimString(event.runId) === trimString(run.id);
    },
    hydrate: (event) => hydrateReplyEvent(sessionId, event),
  });
  return selected ? stripHiddenBlocks(selected.content || '') : '';
}

// ---- Public: iCal feed (.ics) ----

export async function handleCalendarFeedRoute({ req, res, pathname }) {
  const match = pathname.match(/^\/cal\/([a-f0-9]+)\.ics$/);
  if (!match || req.method !== 'GET') return false;

  const requestedToken = match[1];
  const feedInfo = await getFeedInfo();

  if (requestedToken !== feedInfo.feedToken) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }

  const icsContent = await generateIcsFeed();
  const etag = `"${createHash('md5').update(icsContent).digest('hex')}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="remotelab.ics"',
    'ETag': etag,
    'Cache-Control': 'public, max-age=300',
    'Last-Modified': new Date().toUTCString(),
  });
  res.end(icsContent);
  return true;
}

// ---- Authenticated API routes ----

export async function handleConnectorApiRoutes({ req, res, pathname, authSession, writeJson }) {
  if (pathname === '/api/connectors/calendar/google/callback' && req.method === 'GET') {
    const code = trimString(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('code'));
    const state = trimString(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('state'));
    const redirectUri = resolveCalendarAuthRedirectUri(req);
    const authState = await readJson(GOOGLE_CALENDAR_AUTH_STATE_PATH, null);

    if (!code || !state || !redirectUri || !authState || trimString(authState.state) !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Calendar authorization callback is invalid or expired.');
      return true;
    }

    try {
      await handleCalendarAuthCallback({
        credentialsPath: trimString(authState.credentialsPath) || GOOGLE_CALENDAR_CREDENTIALS_PATH,
        tokenPath: trimString(authState.tokenPath) || GOOGLE_CALENDAR_TOKEN_PATH,
        code,
        redirectUri,
      });
      await ensureCalendarConnectorBinding({
        bindingId: trimString(authState.bindingId) || DEFAULT_CALENDAR_BINDING_ID,
        provider: 'google',
        accountHint: trimString(authState.accountHint) || DEFAULT_CALENDAR_ACCOUNT_HINT,
        tokenPath: trimString(authState.tokenPath) || GOOGLE_CALENDAR_TOKEN_PATH,
        title: trimString(authState.title) || 'Google Calendar',
      });
      await writeJsonAtomic(GOOGLE_CALENDAR_AUTH_STATE_PATH, {});
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Google Calendar authorization succeeded. You can return to RemoteLab and ask for a new reminder test.');
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Google Calendar authorization failed: ${error.message || 'unknown error'}`);
      return true;
    }
  }

  if (pathname === '/api/connectors' && req.method === 'GET') {
    const bindings = await listConnectorBindings();
    writeJson(res, 200, { bindings });
    return true;
  }

  if (pathname === '/api/connectors/calendar/feed' && req.method === 'GET') {
    const requestBaseUrl = resolveBaseUrl(req);
    const mainlandBaseUrl = MAINLAND_PUBLIC_BASE_URL || (hasPathPrefix(requestBaseUrl) ? requestBaseUrl : '');
    const publicBaseUrl = PUBLIC_BASE_URL || (!hasPathPrefix(requestBaseUrl) ? requestBaseUrl : '');
    const preferredBaseUrl = mainlandBaseUrl || publicBaseUrl || requestBaseUrl;
    if (!preferredBaseUrl) {
      writeJson(res, 500, { error: 'Cannot determine public base URL from request headers.' });
      return true;
    }
    const feedInfo = await getFeedInfo();
    const subscriptionChannels = buildCalendarSubscriptionChannels({
      feedToken: feedInfo.feedToken,
      mainlandBaseUrl,
      publicBaseUrl,
      preferredBaseUrl,
    });
    const exposedSubscriptionChannels = filterCalendarSubscriptionChannelsForExposure(subscriptionChannels);
    const subscriptionUrl = exposedSubscriptionChannels.preferredHttpsUrl || await getSubscriptionUrl(preferredBaseUrl);
    writeJson(res, 200, {
      subscriptionUrl,
      webcalUrl: exposedSubscriptionChannels.preferredWebcalUrl,
      subscriptionUrls: {
        preferred: exposedSubscriptionChannels.preferredHttpsUrl,
        preferredWebcal: exposedSubscriptionChannels.preferredWebcalUrl,
        ...(exposedSubscriptionChannels.mainlandHttpsUrl
          ? {
              mainland: exposedSubscriptionChannels.mainlandHttpsUrl,
              mainlandWebcal: exposedSubscriptionChannels.mainlandWebcalUrl,
            }
          : {}),
      },
      variants: exposedSubscriptionChannels.variants,
      calendarName: feedInfo.calendarName,
      eventCount: feedInfo.eventCount,
    });
    return true;
  }

  if (pathname === '/api/connectors/calendar/events' && req.method === 'GET') {
    const events = await listCalendarFeedEvents();
    writeJson(res, 200, { events });
    return true;
  }

  if (pathname === '/api/connectors/calendar/google/status' && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, await getCalendarAuthStatus(req));
    return true;
  }

  if (pathname === '/api/connectors/calendar/google/authorize' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }

    let payload;
    try {
      payload = await readConnectorPayload(req);
    } catch (error) {
      writeJson(res, error.statusCode || 400, { error: error.message || 'Bad request' });
      return true;
    }

    const redirectUri = resolveCalendarAuthRedirectUri(req);
    if (!redirectUri) {
      writeJson(res, 500, { error: 'Cannot determine public callback URL from request headers.' });
      return true;
    }

    if (!await pathExists(GOOGLE_CALENDAR_CREDENTIALS_PATH)) {
      writeJson(res, 409, {
        error: 'Missing Google OAuth client credentials.',
        redirectUri,
        credentialsPath: GOOGLE_CALENDAR_CREDENTIALS_PATH,
      });
      return true;
    }

    const binding = await ensureCalendarConnectorBinding({
      bindingId: DEFAULT_CALENDAR_BINDING_ID,
      provider: 'google',
      accountHint: trimString(payload?.accountHint) || DEFAULT_CALENDAR_ACCOUNT_HINT,
      tokenPath: '',
      title: trimString(payload?.title) || 'Google Calendar',
    });
    const state = randomUUID();
    await writeJsonAtomic(GOOGLE_CALENDAR_AUTH_STATE_PATH, {
      state,
      bindingId: binding.id,
      accountHint: binding.accountHint,
      title: binding.title,
      credentialsPath: GOOGLE_CALENDAR_CREDENTIALS_PATH,
      tokenPath: GOOGLE_CALENDAR_TOKEN_PATH,
      createdAt: new Date().toISOString(),
    });
    const authUrl = await generateCalendarAuthUrl({
      credentialsPath: GOOGLE_CALENDAR_CREDENTIALS_PATH,
      redirectUri,
      state,
    });
    writeJson(res, 200, {
      authUrl,
      redirectUri,
      bindingId: binding.id,
      credentialsPath: GOOGLE_CALENDAR_CREDENTIALS_PATH,
      tokenPath: GOOGLE_CALENDAR_TOKEN_PATH,
    });
    return true;
  }

  if (pathname === '/api/shortcut' && req.method === 'POST') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }

    let payload;
    try {
      payload = await readShortcutPayload(req);
    } catch (error) {
      writeJson(res, error.statusCode || 400, { error: error.message || 'Bad request' });
      return true;
    }

    if (!payload || typeof payload !== 'object') {
      writeJson(res, 400, { error: 'Invalid request body' });
      return true;
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const waitMs = normalizeShortcutWaitMs(payload.waitMs);
    const providedSessionId = trimString(payload.sessionId);
    const requestId = trimString(payload.requestId) || buildShortcutRequestId();
    const externalTriggerId = trimString(payload.externalTriggerId);
    const runtime = await resolveShortcutRuntime(payload);
    const sourceContext = buildShortcutSourceContext(payload);

    try {
      // When no text is provided, just return the app URL (quick-launch mode)
      if (!text) {
        const sessionUrl = buildSessionUrl(req, null);
        writeJson(res, 200, {
          status: 'launch',
          url: sessionUrl,
        });
        return true;
      }

      let session = null;
      if (providedSessionId) {
        session = await getSession(providedSessionId);
        if (!session) {
          writeJson(res, 404, { error: 'Session not found' });
          return true;
        }
      } else {
        session = await createSession(
          trimString(payload.folder) || homedir(),
          runtime.tool,
          trimString(payload.name),
          {
            sourceId: 'shortcut',
            sourceName: 'Shortcut',
            templateId: trimString(payload.templateId),
            templateName: trimString(payload.templateName),
            group: trimString(payload.group) || 'Shortcuts',
            description: trimString(payload.description) || 'Request created from the Shortcut connector.',
            externalTriggerId,
            sourceContext,
            ...(runtime.thinking ? { thinking: true } : {}),
            ...(runtime.model ? { model: runtime.model } : {}),
            ...(runtime.effort ? { effort: runtime.effort } : {}),
          },
        );
      }

      const outcome = await submitHttpMessage(session.id, text, [], {
        requestId,
        tool: runtime.tool,
        thinking: runtime.thinking,
        model: runtime.model || undefined,
        effort: runtime.effort || undefined,
        sourceContext,
      });

      const sessionUrl = buildSessionUrl(req, session.id);
      const activeRun = outcome.run?.id ? await waitForRunResult(outcome.run.id, waitMs) : null;
      if (activeRun && activeRun.state === 'completed') {
        const reply = await resolveRunReply(session.id, activeRun);
        writeJson(res, 200, {
          status: 'completed',
          sessionId: session.id,
          runId: activeRun.id,
          requestId,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          reply,
          speech: reply,
          url: sessionUrl,
        });
        return true;
      }

      if (activeRun && isTerminalRunState(activeRun.state)) {
        writeJson(res, 200, {
          status: activeRun.state,
          sessionId: session.id,
          runId: activeRun.id,
          requestId,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          reply: null,
          url: sessionUrl,
        });
        return true;
      }

      writeJson(res, 200, {
        status: 'pending',
        runState: activeRun?.state || null,
        sessionId: session.id,
        runId: activeRun?.id || outcome.run?.id || null,
        requestId,
        duplicate: outcome.duplicate,
        queued: outcome.queued,
        reply: null,
        url: sessionUrl,
      });
      return true;
    } catch (error) {
      const statusCode = error?.code === 'SESSION_ARCHIVED' ? 409 : 400;
      writeJson(res, statusCode, { error: error.message || 'Failed to process shortcut request' });
      return true;
    }
  }

  return false;
}

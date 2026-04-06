import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { listConnectorBindings } from '../lib/connector-bindings.mjs';
import { selectAssistantReplyEvent, stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { readBody } from '../lib/utils.mjs';
import {
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
const SHORTCUT_DEFAULT_WAIT_MS = 20_000;
const SHORTCUT_MAX_WAIT_MS = 20_000;
const SHORTCUT_POLL_INTERVAL_MS = 300;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBaseUrl(req) {
  const host = trimString(req.headers?.host || req.headers?.['x-forwarded-host']);
  const proto = trimString(req.headers?.['x-forwarded-proto']) || 'https';
  if (!host) return '';
  return `${proto}://${host}`;
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
  if (pathname === '/api/connectors' && req.method === 'GET') {
    const bindings = await listConnectorBindings();
    writeJson(res, 200, { bindings });
    return true;
  }

  if (pathname === '/api/connectors/calendar/feed' && req.method === 'GET') {
    const baseUrl = resolveBaseUrl(req);
    if (!baseUrl) {
      writeJson(res, 500, { error: 'Cannot determine public base URL from request headers.' });
      return true;
    }
    const feedInfo = await getFeedInfo();
    const subscriptionUrl = await getSubscriptionUrl(baseUrl);
    writeJson(res, 200, {
      subscriptionUrl,
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
    if (!text) {
      writeJson(res, 400, { error: 'text is required' });
      return true;
    }

    const waitMs = normalizeShortcutWaitMs(payload.waitMs);
    const providedSessionId = trimString(payload.sessionId);
    const requestId = trimString(payload.requestId) || buildShortcutRequestId();
    const externalTriggerId = trimString(payload.externalTriggerId);
    const tool = trimString(payload.tool) || 'codex';
    const sourceContext = buildShortcutSourceContext(payload);

    try {
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
          tool,
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
            ...(Object.prototype.hasOwnProperty.call(payload, 'thinking') ? { thinking: payload.thinking === true } : {}),
            ...(typeof payload.model === 'string' ? { model: trimString(payload.model) } : {}),
            ...(typeof payload.effort === 'string' ? { effort: trimString(payload.effort) } : {}),
          },
        );
      }

      const outcome = await submitHttpMessage(session.id, text, [], {
        requestId,
        tool: trimString(payload.tool) || undefined,
        thinking: payload.thinking === true,
        model: trimString(payload.model) || undefined,
        effort: trimString(payload.effort) || undefined,
        sourceContext,
      });

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

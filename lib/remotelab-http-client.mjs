import { readFile } from 'fs/promises';

import { AUTH_FILE, CHAT_PORT } from './config.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
} from './reply-selection.mjs';

export const DEFAULT_RUN_POLL_INTERVAL_MS = 1200;
export const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDefaultChatBaseUrl() {
  const host = trimString(process.env.CHAT_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const parsedPort = Number.parseInt(String(process.env.CHAT_PORT || ''), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : CHAT_PORT;
  return `http://${host}:${port}`;
}

export const DEFAULT_CHAT_BASE_URL = resolveDefaultChatBaseUrl();

export function normalizeBaseUrl(value) {
  const normalized = trimString(value || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '');
  return normalized || DEFAULT_CHAT_BASE_URL;
}

export function buildSessionUrl(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  params.set('tab', 'sessions');
  return `/?${params.toString()}`;
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function readResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
  }
  return { response, text, json };
}

export function createRemoteLabHttpClient(options = {}) {
  const runtime = {
    baseUrl: normalizeBaseUrl(options.baseUrl || process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    authToken: trimString(options.authToken),
    authCookie: trimString(options.authCookie),
  };

  async function ensureAuthCookie(forceRefresh = false) {
    if (!forceRefresh && runtime.authCookie) {
      return runtime.authCookie;
    }
    if (forceRefresh) {
      runtime.authCookie = '';
      runtime.authToken = '';
    }
    if (!runtime.authToken) {
      runtime.authToken = await readOwnerToken();
    }
    runtime.authCookie = await loginWithToken(runtime.baseUrl, runtime.authToken);
    return runtime.authCookie;
  }

  async function request(path, options = {}) {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath.startsWith('/')) {
      throw new Error(`RemoteLab API path must start with "/": ${path}`);
    }

    const method = String(options.method || 'GET').trim().toUpperCase() || 'GET';
    const headers = {
      Accept: 'application/json',
      ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
    };

    const rawBody = options.body;
    const body = rawBody === undefined
      ? undefined
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody);
    if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const execute = async (cookie) => {
      if (cookie) headers.Cookie = cookie;
      else delete headers.Cookie;
      const response = await fetch(`${runtime.baseUrl}${normalizedPath}`, {
        method,
        headers,
        body,
        redirect: 'manual',
      });
      return readResponse(response);
    };

    const cookie = await ensureAuthCookie(false);
    let result = await execute(cookie);
    if ([401, 403].includes(result.response.status)) {
      const refreshedCookie = await ensureAuthCookie(true);
      result = await execute(refreshedCookie);
    }
    return result;
  }

  async function waitForRun(runId, options = {}) {
    const intervalMs = parsePositiveInteger(options.intervalMs, DEFAULT_RUN_POLL_INTERVAL_MS);
    const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_RUN_POLL_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await request(`/api/runs/${encodeURIComponent(runId)}`);
      if (!result.response.ok || !result.json?.run) {
        throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`);
      }
      if (typeof options.onPoll === 'function') {
        options.onPoll(result.json.run);
      }
      if (['completed', 'failed', 'cancelled'].includes(result.json.run.state)) {
        return result.json.run;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for run ${runId}`);
  }

  return {
    baseUrl: runtime.baseUrl,
    request,
    waitForRun,
    ensureAuthCookie: () => ensureAuthCookie(false),
  };
}

export async function loadAssistantReply(client, sessionId, runId) {
  const eventsResult = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const selected = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => runId && event.runId === runId,
    hydrate: async (event) => {
      const bodyResult = await client.request(`/api/sessions/${encodeURIComponent(sessionId)}/events/${event.seq}/body`);
      if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
        return event;
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      };
    },
  });

  return trimString([
    selected?.content || '',
    buildAssistantReplyAttachmentFallbackText(selected),
  ].filter(Boolean).join('\n\n'));
}

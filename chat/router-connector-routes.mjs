import { createHash, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  ensureCalendarConnectorBinding,
  getConnectorBinding,
  listConnectorBindings,
} from '../lib/connector-bindings.mjs';
import { BRIDGE_PUBLIC_BASE_URL, CONFIG_DIR, PUBLIC_BASE_URL } from '../lib/config.mjs';
import {
  generateCalendarAuthUrl,
  handleCalendarAuthCallback,
} from '../lib/connector-calendar.mjs';
import { resolveExternalRuntimeSelection } from '../lib/external-runtime-selection.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { pathExists, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { readBody } from '../lib/utils.mjs';
import { getConnectorSurface, listConnectorSurfaces } from '../lib/connector-surface-registry.mjs';
import {
  getWeChatLoginQrUrl,
  getWeChatLoginSurface,
  WECHAT_LOGIN_PAGE_PATH,
  WECHAT_LOGIN_QR_PATH,
  WECHAT_LOGIN_STATUS_PATH,
} from '../lib/wechat-connector-login.mjs';
import {
  CALENDAR_SUBSCRIBE_HELPER_PATH,
  buildCalendarSubscriptionChannels,
  buildSubscriptionUrl,
  buildWebcalSubscriptionUrl,
  filterCalendarSubscriptionChannelsForExposure,
  generateIcsFeed,
  getFeedInfo,
  listCalendarFeedEvents,
} from '../lib/connector-calendar-feed.mjs';
import { readEventBody } from './history.mjs';
import {
  createSession,
  getRunState,
  getSessionReplyPublication,
  getSession,
  getSessionEventsAfter,
  submitHttpMessage,
} from './session-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORTCUT_BODY_MAX_BYTES = 32 * 1024;
const SHORTCUT_DEFAULT_WAIT_MS = 0;
const SHORTCUT_MAX_WAIT_MS = 20_000;
const SHORTCUT_POLL_INTERVAL_MS = 300;
const CONNECTOR_REQUEST_BODY_MAX_BYTES = 64 * 1024;
const CALENDAR_CONNECTOR_DIR = join(CONFIG_DIR, 'calendar-connector');
const GOOGLE_CALENDAR_CREDENTIALS_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-oauth-client.json');
const GOOGLE_CALENDAR_TOKEN_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-calendar-token.json');
const GOOGLE_CALENDAR_AUTH_STATE_PATH = join(CALENDAR_CONNECTOR_DIR, 'google-calendar-auth-state.json');
const WECHAT_CONNECTOR_LOGIN_TEMPLATE_PATH = join(__dirname, '..', 'templates', 'wechat-login.html');
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

function resolveRequestOrigin(req) {
  const host = trimString(req.headers?.host || req.headers?.['x-forwarded-host']);
  const proto = trimString(req.headers?.['x-forwarded-proto']) || 'https';
  if (!host) return '';
  return `${proto}://${host}`;
}

function normalizeForwardedPrefix(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function getRequestProductBasePath(req) {
  return normalizeForwardedPrefix(req?.headers?.['x-forwarded-prefix']);
}

function parseConnectorSurfaceProxyRoute(pathname) {
  const match = pathname.match(/^\/connectors\/([a-z0-9._:-]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    connectorId: trimString(match[1]).toLowerCase(),
    tailPath: trimString(match[2]) || '',
  };
}

function parseConnectorSurfaceInfoRoute(pathname) {
  const match = pathname.match(/^\/api\/connectors\/([a-z0-9._:-]+)\/surface$/i);
  if (!match) return null;
  return trimString(match[1]).toLowerCase();
}

function isConnectorSurfaceListRoute(pathname) {
  return pathname === '/api/connectors/surfaces';
}

function buildConnectorMountPath(connectorId, tailPath = '') {
  const normalizedTail = trimString(tailPath);
  return `/connectors/${encodeURIComponent(connectorId)}${normalizedTail || ''}`;
}

function buildProxyRequestHeaders(req, { mountPath = '', nonce = '' } = {}) {
  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(req.headers || {})) {
    const key = trimString(rawKey).toLowerCase();
    if (!key || ['host', 'cookie', 'content-length'].includes(key)) continue;
    if (rawValue === undefined) continue;
    headers[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  if (mountPath) {
    headers['x-forwarded-prefix'] = mountPath;
    headers['x-remotelab-connector-mount'] = mountPath;
  }
  if (nonce) {
    headers['x-remotelab-csp-nonce'] = nonce;
  }
  return headers;
}

function buildProxyResponseHeaders(response, { surface, mountPath }) {
  const headers = {};
  for (const [rawKey, rawValue] of response.headers.entries()) {
    const key = trimString(rawKey).toLowerCase();
    if (!key) continue;
    if ([
      'connection',
      'content-length',
      'content-security-policy',
      'keep-alive',
      'transfer-encoding',
      'x-frame-options',
    ].includes(key)) {
      continue;
    }
    if (key === 'location') {
      const value = trimString(rawValue);
      if (!value) continue;
      if (value.startsWith(surface.baseUrl)) {
        headers.Location = value.replace(surface.baseUrl, mountPath);
        continue;
      }
      if (value.startsWith('/')) {
        headers.Location = `${mountPath}${value}`;
        continue;
      }
    }
    headers[rawKey] = rawValue;
  }
  return headers;
}

async function fetchConnectorSurfaceDescription(surface, { mountPath = '', nonce = '' } = {}) {
  if (!surface?.baseUrl) return null;
  const headers = {};
  if (mountPath) {
    headers['x-forwarded-prefix'] = mountPath;
    headers['x-remotelab-connector-mount'] = mountPath;
  }
  if (nonce) {
    headers['x-remotelab-csp-nonce'] = nonce;
  }

  try {
    const response = await fetch(new URL('/surface', `${surface.baseUrl}/`), {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

function buildConnectorSurfaceInfoResponse(surface, description = null) {
  const payload = description && typeof description === 'object' ? description : {};
  const {
    connectorId: ignoredConnectorId,
    baseUrl: ignoredBaseUrl,
    title: describedTitle,
    entryPath: describedEntryPath,
    allowEmbed: describedAllowEmbed,
    updatedAt: describedUpdatedAt,
    ...rest
  } = payload;
  void ignoredConnectorId;
  void ignoredBaseUrl;

  return {
    connectorId: surface.connectorId,
    title: trimString(describedTitle) || surface.title,
    entryUrl: buildConnectorMountPath(surface.connectorId, describedEntryPath || surface.entryPath),
    allowEmbed: describedAllowEmbed !== false && surface.allowEmbed !== false,
    updatedAt: trimString(describedUpdatedAt) || surface.updatedAt,
    ...rest,
  };
}

async function getLegacyConnectorSurfaceInfo(connectorId) {
  if (trimString(connectorId).toLowerCase() !== 'wechat') return null;
  const surface = await getWeChatLoginSurface({
    autoStart: false,
    authPath: WECHAT_LOGIN_PAGE_PATH,
    qrPath: WECHAT_LOGIN_QR_PATH,
  });
  return {
    connectorId: 'wechat',
    title: 'WeChat',
    entryUrl: WECHAT_LOGIN_PAGE_PATH,
    allowEmbed: true,
    updatedAt: trimString(surface?.login?.updatedAt || surface?.account?.savedAt),
    surfaceType: 'login',
    description: 'Scan in WeChat to connect this workspace. The QR code refreshes behind one stable link.',
    embed: {
      mode: 'iframe',
      sameOrigin: true,
    },
    surface,
  };
}

async function listResolvedConnectorSurfaceInfo({ nonce = '' } = {}) {
  const results = [];
  const seen = new Set();

  for (const surface of await listConnectorSurfaces()) {
    seen.add(surface.connectorId);
    const mountPath = buildConnectorMountPath(surface.connectorId);
    const description = await fetchConnectorSurfaceDescription(surface, { mountPath, nonce });
    results.push(buildConnectorSurfaceInfoResponse(surface, description));
  }

  const legacyWeChat = await getLegacyConnectorSurfaceInfo('wechat');
  if (legacyWeChat && !seen.has(legacyWeChat.connectorId)) {
    results.push(legacyWeChat);
  }

  return results.sort((left, right) => String(left?.title || left?.connectorId || '').localeCompare(
    String(right?.title || right?.connectorId || ''),
  ));
}

function buildVisibleCalendarSubscriptionChannels(req, feedToken) {
  return filterCalendarSubscriptionChannelsForExposure(buildCalendarSubscriptionChannels({
    feedToken,
    primaryBaseUrl: resolveRequestOrigin(req),
    alternateBaseUrls: [PUBLIC_BASE_URL, BRIDGE_PUBLIC_BASE_URL].filter(Boolean),
  }));
}

function resolveCalendarSubscriptionRedirectTargets(req, feedToken) {
  const requestOrigin = resolveRequestOrigin(req);
  return {
    httpsUrl: buildSubscriptionUrl(requestOrigin, feedToken, { allowLocalhost: true })
      || buildSubscriptionUrl(PUBLIC_BASE_URL, feedToken)
      || buildSubscriptionUrl(BRIDGE_PUBLIC_BASE_URL, feedToken),
    webcalUrl: buildWebcalSubscriptionUrl(requestOrigin, feedToken, { allowLocalhost: true })
      || buildWebcalSubscriptionUrl(PUBLIC_BASE_URL, feedToken)
      || buildWebcalSubscriptionUrl(BRIDGE_PUBLIC_BASE_URL, feedToken),
  };
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

function isTerminalReplyPublicationState(state) {
  const normalized = trimString(state).toLowerCase();
  return normalized === 'ready' || normalized === 'failed' || normalized === 'cancelled';
}

async function waitForReplyPublicationResult(sessionId, responseId, timeoutMs) {
  if (!sessionId || !responseId) return null;
  let publication = await getSessionReplyPublication(sessionId, responseId);
  if ((publication && isTerminalReplyPublicationState(publication.state)) || timeoutMs <= 0) {
    return publication;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(SHORTCUT_POLL_INTERVAL_MS);
    publication = await getSessionReplyPublication(sessionId, responseId) || publication;
    if (publication && isTerminalReplyPublicationState(publication.state)) {
      return publication;
    }
  }
  return publication;
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
  if (!selected) return '';
  return stripHiddenBlocks([
    selected.content || '',
    buildAssistantReplyAttachmentFallbackText(selected),
  ].filter(Boolean).join('\n\n'));
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

export async function handleConnectorSurfaceRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  buildHeaders,
  nonce,
}) {
  if (isConnectorSurfaceListRoute(pathname)) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, {
      surfaces: await listResolvedConnectorSurfaceInfo({ nonce }),
    });
    return true;
  }

  const infoConnectorId = parseConnectorSurfaceInfoRoute(pathname);
  if (infoConnectorId) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const surface = await getConnectorSurface(infoConnectorId);
    if (!surface) {
      const fallbackSurface = await getLegacyConnectorSurfaceInfo(infoConnectorId);
      if (fallbackSurface) {
        writeJson(res, 200, fallbackSurface);
        return true;
      }
      writeJson(res, 404, { error: 'Connector surface not found' });
      return true;
    }
    const mountPath = buildConnectorMountPath(surface.connectorId);
    const description = await fetchConnectorSurfaceDescription(surface, { mountPath, nonce });
    writeJson(res, 200, buildConnectorSurfaceInfoResponse(surface, description));
    return true;
  }

  const route = parseConnectorSurfaceProxyRoute(pathname);
  if (!route) return false;
  if (authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  const surface = await getConnectorSurface(route.connectorId);
  if (!surface?.baseUrl) {
    return false;
  }

  const mountPath = buildConnectorMountPath(surface.connectorId);
  const url = new URL(req.url || pathname, 'http://127.0.0.1');
  const upstreamPath = route.tailPath || surface.entryPath || '/';
  const upstreamUrl = new URL(upstreamPath, `${surface.baseUrl}/`);
  upstreamUrl.search = url.search;

  let body;
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    try {
      const rawBody = await readBody(req, CONNECTOR_REQUEST_BODY_MAX_BYTES);
      body = rawBody ? Buffer.from(rawBody) : undefined;
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: error?.code === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Bad request',
      });
      return true;
    }
  }

  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: req.method || 'GET',
      headers: buildProxyRequestHeaders(req, { mountPath, nonce }),
      ...(body ? { body } : {}),
      redirect: 'manual',
    });
  } catch (error) {
    writeJson(res, 502, { error: `Connector surface unavailable: ${error?.message || 'unknown error'}` });
    return true;
  }

  const payload = Buffer.from(await response.arrayBuffer());
  const headers = buildProxyResponseHeaders(response, { surface, mountPath });
  headers['Content-Length'] = String(payload.length);
  res.writeHead(response.status, buildHeaders(headers));
  res.end(payload);
  return true;
}

// ---- Authenticated API routes ----

export async function handleConnectorApiRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  nonce,
  buildHeaders,
  getPageBuildInfo,
  renderPageTemplate,
  buildTemplateReplacements,
  serializeJsonForScript,
}) {
  if (pathname === WECHAT_LOGIN_PAGE_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }

    let template = '';
    try {
      template = await readFile(WECHAT_CONNECTOR_LOGIN_TEMPLATE_PATH, 'utf8');
    } catch {
      res.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('WeChat login template missing.');
      return true;
    }

    const pageBuildInfo = await getPageBuildInfo();
    const initialState = await getWeChatLoginSurface({ autoStart: true });
    const body = renderPageTemplate(template, nonce, {
      ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
      PAGE_TITLE: 'Connect WeChat',
      BODY_CLASS: 'wechat-login-page',
      BOOTSTRAP_JSON: serializeJsonForScript({
        wechatLogin: {
          initialState,
          statusEndpoint: WECHAT_LOGIN_STATUS_PATH,
          qrEndpoint: WECHAT_LOGIN_QR_PATH,
        },
      }),
    });
    res.writeHead(200, buildHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    }));
    res.end(body);
    return true;
  }

  if (pathname === WECHAT_LOGIN_STATUS_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    writeJson(res, 200, await getWeChatLoginSurface({ autoStart: true }));
    return true;
  }

  if (pathname === WECHAT_LOGIN_QR_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const { surface, qrcodeUrl } = await getWeChatLoginQrUrl({ autoStart: true });
    if (surface?.capabilityState === 'ready') {
      res.writeHead(409, buildHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end('WeChat is already connected.');
      return true;
    }
    if (!qrcodeUrl) {
      res.writeHead(503, buildHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end('WeChat QR code is not ready yet.');
      return true;
    }
    try {
      const response = await fetch(qrcodeUrl);
      if (!response.ok) {
        throw new Error(`QR upstream ${response.status}`);
      }
      const contentType = trimString(response.headers.get('content-type')) || 'image/png';
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(200, buildHeaders({
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      }));
      res.end(body);
      return true;
    } catch (error) {
      res.writeHead(502, buildHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end(`Failed to load WeChat QR image: ${error?.message || 'unknown error'}`);
      return true;
    }
  }

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

  if (pathname === CALENDAR_SUBSCRIBE_HELPER_PATH && req.method === 'GET') {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const format = trimString(url.searchParams.get('format')).toLowerCase();
    const feedInfo = await getFeedInfo();
    const targets = resolveCalendarSubscriptionRedirectTargets(req, feedInfo.feedToken);
    const location = format === 'https'
      ? targets.httpsUrl
      : targets.webcalUrl || targets.httpsUrl;

    if (!location) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Calendar subscription URL is unavailable for this request.');
      return true;
    }

    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  if (pathname === '/api/connectors/calendar/feed' && req.method === 'GET') {
    const feedInfo = await getFeedInfo();
    const exposedSubscriptionChannels = buildVisibleCalendarSubscriptionChannels(req, feedInfo.feedToken);

    if (!exposedSubscriptionChannels.preferredHttpsUrl && !exposedSubscriptionChannels.preferredWebcalUrl) {
      writeJson(res, 500, { error: 'Cannot determine public base URL from request headers.' });
      return true;
    }

    const subscriptionUrl = exposedSubscriptionChannels.preferredHttpsUrl;
    writeJson(res, 200, {
      subscriptionUrl,
      webcalUrl: exposedSubscriptionChannels.preferredWebcalUrl,
      subscriptionUrls: {
        preferred: exposedSubscriptionChannels.preferredHttpsUrl,
        preferredWebcal: exposedSubscriptionChannels.preferredWebcalUrl,
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
      const responseId = trimString(outcome.response?.id || requestId);
      const publication = responseId
        ? await waitForReplyPublicationResult(session.id, responseId, waitMs)
        : null;
      if (publication?.state === 'ready') {
        const reply = trimString(publication.payload?.text || '');
        writeJson(res, 200, {
          status: 'completed',
          sessionId: session.id,
          runId: publication.finalRunId || outcome.run?.id || null,
          requestId,
          responseId,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          reply,
          speech: reply,
          url: sessionUrl,
        });
        return true;
      }

      const activeRun = outcome.run?.id ? await waitForRunResult(outcome.run.id, 0) : null;
      if (publication && isTerminalReplyPublicationState(publication.state)) {
        writeJson(res, 200, {
          status: publication.state,
          sessionId: session.id,
          runId: publication.finalRunId || activeRun?.id || outcome.run?.id || null,
          requestId,
          responseId,
          duplicate: outcome.duplicate,
          queued: outcome.queued,
          reply: null,
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
          responseId,
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
        responseId,
        duplicate: outcome.duplicate,
        queued: outcome.queued,
        responseState: publication?.state || outcome.response?.state || null,
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

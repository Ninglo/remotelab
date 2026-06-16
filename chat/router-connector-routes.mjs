import { createHash, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { homedir, userInfo } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import {
  ensureCalendarConnectorBinding,
  ensureGmailConnectorBinding,
  getConnectorBinding,
  listConnectorBindings,
} from '../lib/connector-bindings.mjs';
import { BRIDGE_PUBLIC_BASE_URL, CONFIG_DIR, PUBLIC_BASE_URL } from '../lib/config.mjs';
import { CHAT_PORT, IS_GUEST_INSTANCE } from '../lib/config.mjs';
import {
  generateCalendarAuthUrl,
  handleCalendarAuthCallback,
} from '../lib/connector-calendar.mjs';
import {
  DEFAULT_GMAIL_BINDING_ID,
  GMAIL_OAUTH_SCOPES,
  GOOGLE_GMAIL_AUTH_STATE_PATH,
  GOOGLE_GMAIL_CREDENTIALS_PATH,
  GOOGLE_GMAIL_TOKEN_PATH,
  generateGmailAuthUrl,
  getGmailProfile,
  gmailCredentialsPresent,
  handleGmailAuthCallback,
  resolveGmailCredentialsPath,
} from '../lib/connector-gmail.mjs';
import { resolveExternalRuntimeSelection } from '../lib/external-runtime-selection.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';
import { createSerialTaskQueue, pathExists, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  getConnectorSurface,
  getReachableConnectorSurface,
  isConnectorSurfacePublicPath,
  listReachableConnectorSurfaces,
} from '../lib/connector-surface-registry.mjs';
import {
  getWeChatLoginQrUrl,
  getWeChatLoginSurface,
  verifyWeChatLoginOpenRequest,
  WECHAT_LOGIN_OPEN_PATH,
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
import { buildBridgeBaseUrl, loadInstanceAccessDefaults, normalizeBaseUrl } from '../lib/instance-access.mjs';
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
const GMAIL_CONNECTOR_PAGE_PATH = '/connectors/gmail';
const WHATSAPP_BUSINESS_CONNECTOR_ID = 'whatsapp-business';
const WHATSAPP_BUSINESS_CONNECTOR_PAGE_PATH = `/connectors/${WHATSAPP_BUSINESS_CONNECTOR_ID}`;
const GMAIL_STATUS_PATH = '/api/connectors/gmail/google/status';
const GMAIL_CREDENTIALS_PATH = '/api/connectors/gmail/google/credentials';
const GMAIL_AUTHORIZE_PATH = '/api/connectors/gmail/google/authorize';
const GMAIL_CALLBACK_PATH = '/api/connectors/gmail/google/callback';
const GMAIL_AUTH_STATE_TTL_MS = 30 * 60 * 1000;
const mutateGmailAuthState = createSerialTaskQueue();
const GMAIL_OAUTH_CALLBACK_BASE_URL_ENV = 'REMOTELAB_GMAIL_OAUTH_CALLBACK_BASE_URL';
const GOOGLE_OAUTH_CALLBACK_BASE_URL_ENV = 'REMOTELAB_GOOGLE_OAUTH_CALLBACK_BASE_URL';
const SHARED_CONFIG_DIR_ENV = 'REMOTELAB_SHARED_CONFIG_DIR';
const SYSTEM_HOME_ENV = 'REMOTELAB_SYSTEM_HOME';
const GMAIL_AUTH_RELAY_STATE_PATH = resolveSharedGmailRelayStatePath();
const mutateGmailRelayState = createSerialTaskQueue();
const WHATSAPP_BUSINESS_CONNECTOR_INSTANCE_SCRIPT_PATH = join(__dirname, '..', 'scripts', 'whatsapp-business-connector-instance.sh');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function resolveSystemHomeDir() {
  return firstNonEmpty(
    process.env[SYSTEM_HOME_ENV],
    userInfo().homedir,
    process.env.HOME,
  );
}

function resolvePathRelativeToHome(value, homeDir = '') {
  const trimmed = trimString(value);
  const normalizedHome = trimString(homeDir);
  if (!trimmed) return '';
  if (trimmed === '~') return normalizedHome;
  if (trimmed.startsWith('~/')) return join(normalizedHome, trimmed.slice(2));
  return trimmed;
}

function resolveSharedConfigDir() {
  const systemHome = resolveSystemHomeDir();
  return resolvePathRelativeToHome(process.env[SHARED_CONFIG_DIR_ENV], systemHome)
    || join(systemHome, '.config', 'remotelab');
}

function resolveSharedGmailRelayStatePath() {
  return join(resolveSharedConfigDir(), 'gmail-connector', 'google-gmail-auth-relay-state.json');
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

async function execFileAsync(file, args = []) {
  const { execFile } = await import('child_process');
  return await new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForConnectorSurface(connectorId, {
  timeoutMs = 8_000,
  intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const surface = await getConnectorSurface(connectorId);
    if (surface?.baseUrl) return surface;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function ensureWhatsAppBusinessConnectorSurfaceRunning() {
  const existing = await getConnectorSurface(WHATSAPP_BUSINESS_CONNECTOR_ID);
  if (existing?.baseUrl) return existing;
  await execFileAsync(WHATSAPP_BUSINESS_CONNECTOR_INSTANCE_SCRIPT_PATH, ['start']);
  return waitForConnectorSurface(WHATSAPP_BUSINESS_CONNECTOR_ID);
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

function prependProductBasePath(pathname, productBasePath = '') {
  const normalizedPath = trimString(pathname) || '/';
  const normalizedBase = normalizeForwardedPrefix(productBasePath);
  if (!normalizedBase) return normalizedPath;
  if (
    normalizedPath === normalizedBase
    || normalizedPath.startsWith(`${normalizedBase}/`)
    || normalizedPath.startsWith(`${normalizedBase}?`)
    || normalizedPath.startsWith(`${normalizedBase}#`)
  ) {
    return normalizedPath;
  }
  return normalizedPath === '/'
    ? normalizedBase
    : `${normalizedBase}${normalizedPath}`;
}

function buildPublicConnectorMountPath(req, connectorId, tailPath = '') {
  return prependProductBasePath(
    buildConnectorMountPath(connectorId, tailPath),
    getRequestProductBasePath(req),
  );
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

async function getLegacyConnectorSurfaceInfo(connectorId, { productBasePath = '' } = {}) {
  const normalizedConnectorId = trimString(connectorId).toLowerCase();
  if (normalizedConnectorId === 'gmail') {
    return {
      connectorId: 'gmail',
      title: 'Gmail',
      entryUrl: GMAIL_CONNECTOR_PAGE_PATH,
      allowEmbed: false,
      updatedAt: new Date().toISOString(),
      surfaceType: 'login',
      description: 'Connect one Gmail account so RemoteLab can search, read, label, archive, reply, and send on behalf of this workspace.',
      surface: await getGmailAuthStatus({
        headers: {},
      }),
    };
  }
  if (normalizedConnectorId === WHATSAPP_BUSINESS_CONNECTOR_ID) {
    return {
      connectorId: WHATSAPP_BUSINESS_CONNECTOR_ID,
      title: 'WhatsApp Business',
      entryUrl: WHATSAPP_BUSINESS_CONNECTOR_PAGE_PATH,
      allowEmbed: true,
      updatedAt: new Date().toISOString(),
      surfaceType: 'setup',
      description: 'Connect one WhatsApp Business Cloud API number so RemoteLab can receive webhook messages and send plain-text replies.',
      embed: {
        mode: 'iframe',
        sameOrigin: true,
      },
      surface: {
        capabilityState: 'authorization_required',
        status: 'authorization_required',
        message: 'Open the connector once to start the local runtime and finish setup.',
      },
    };
  }
  if (normalizedConnectorId !== 'wechat') return null;
  const authPath = prependProductBasePath(WECHAT_LOGIN_PAGE_PATH, productBasePath);
  const qrPath = prependProductBasePath(WECHAT_LOGIN_QR_PATH, productBasePath);
  const openPath = prependProductBasePath(WECHAT_LOGIN_OPEN_PATH, productBasePath);
  const surface = await getWeChatLoginSurface({
    autoStart: false,
    authPath,
    qrPath,
    openPath,
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

async function listResolvedConnectorSurfaceInfo({ nonce = '', productBasePath = '' } = {}) {
  const results = [];
  const seen = new Set();

  for (const surface of await listReachableConnectorSurfaces({ clearStale: true, timeoutMs: 500 })) {
    seen.add(surface.connectorId);
    const mountPath = prependProductBasePath(
      buildConnectorMountPath(surface.connectorId),
      productBasePath,
    );
    const description = await fetchConnectorSurfaceDescription(surface, { mountPath, nonce });
    results.push(buildConnectorSurfaceInfoResponse(surface, description));
  }

  for (const connectorId of ['gmail', WHATSAPP_BUSINESS_CONNECTOR_ID, 'wechat']) {
    const legacySurface = await getLegacyConnectorSurfaceInfo(connectorId, { productBasePath });
    if (legacySurface && !seen.has(legacySurface.connectorId)) {
      results.push(legacySurface);
    }
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

function buildAbsoluteRequestUrl(req, pathname) {
  const origin = resolveRequestOrigin(req);
  const normalizedPath = trimString(pathname);
  if (!origin || !normalizedPath) return normalizedPath;
  try {
    return new URL(normalizedPath, `${origin}/`).toString();
  } catch {
    return normalizedPath;
  }
}

async function handleWeChatLoginOpenRequest({
  req,
  res,
  pathname,
  authSession,
  buildHeaders,
  writeJson,
} = {}) {
  const requestUrl = new URL(req.url || pathname || WECHAT_LOGIN_OPEN_PATH, 'http://127.0.0.1');
  const publicPathname = prependProductBasePath(pathname, getRequestProductBasePath(req));
  const ownerAccess = authSession?.role === 'owner';
  const publicGrantAccess = ownerAccess || await verifyWeChatLoginOpenRequest({
    pathname: publicPathname,
    searchParams: requestUrl.searchParams,
  });

  if (!publicGrantAccess) {
    if (ownerAccess) {
      writeJson(res, 403, { error: 'Owner access required' });
    } else {
      res.writeHead(403, buildHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      }));
      res.end('WeChat login link is invalid or expired.');
    }
    return true;
  }

  const { surface, qrcodeUrl } = await getWeChatLoginQrUrl({ autoStart: ownerAccess });
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
    res.end('WeChat login link is not ready yet.');
    return true;
  }
  res.writeHead(302, buildHeaders({
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    Location: qrcodeUrl,
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  }));
  res.end();
  return true;
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

async function resolveSharedGmailAuthBaseUrl(req) {
  const explicitBaseUrl = normalizeBaseUrl(firstNonEmpty(
    process.env[GMAIL_OAUTH_CALLBACK_BASE_URL_ENV],
    process.env[GOOGLE_OAUTH_CALLBACK_BASE_URL_ENV],
  ));
  if (explicitBaseUrl) return explicitBaseUrl;
  if (!IS_GUEST_INSTANCE) {
    return PUBLIC_BASE_URL || resolveBaseUrl(req);
  }

  const defaultsFilePath = join(resolveSystemHomeDir(), '.config', 'remotelab', 'guest-instance-defaults.json');
  const defaults = await loadInstanceAccessDefaults({
    defaultsFilePath,
    env: {},
  });
  const ownerBaseUrl = buildBridgeBaseUrl('owner', defaults);
  return ownerBaseUrl || PUBLIC_BASE_URL || resolveBaseUrl(req);
}

async function resolveGmailAuthRedirectUri(req) {
  const baseUrl = await resolveSharedGmailAuthBaseUrl(req);
  if (!baseUrl) return '';
  return `${baseUrl}${GMAIL_CALLBACK_PATH}`;
}

function normalizeGmailRelayStateEntry(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const state = trimString(value.state);
  const createdAt = trimString(value.createdAt) || new Date().toISOString();
  if (!state) return null;
  const callbackUrl = trimString(value.callbackUrl);
  if (!callbackUrl) return null;
  return {
    state,
    callbackUrl,
    createdAt,
  };
}

function normalizeGmailRelayStateEntries(raw = null) {
  const normalized = {};
  const now = Date.now();
  if (!raw || typeof raw !== 'object') return normalized;
  const rawEntries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [state, value] of Object.entries(rawEntries)) {
    const entry = normalizeGmailRelayStateEntry({ state, ...(value || {}) });
    if (!entry) continue;
    const createdAtMs = Date.parse(trimString(entry.createdAt));
    if (Number.isFinite(createdAtMs) && createdAtMs < now - GMAIL_AUTH_STATE_TTL_MS) continue;
    normalized[entry.state] = entry;
  }
  return normalized;
}

async function loadGmailRelayStateEntries() {
  const raw = await readJson(GMAIL_AUTH_RELAY_STATE_PATH, null);
  return normalizeGmailRelayStateEntries(raw);
}

async function saveGmailRelayStateEntries(entries = {}) {
  await writeJsonAtomic(GMAIL_AUTH_RELAY_STATE_PATH, {
    version: 1,
    entries,
  });
}

async function putGmailRelayStateEntry(state, entry = {}) {
  const normalizedState = trimString(state);
  if (!normalizedState) return null;
  return await mutateGmailRelayState(async () => {
    const entries = await loadGmailRelayStateEntries();
    const normalizedEntry = normalizeGmailRelayStateEntry({
      ...entry,
      state: normalizedState,
      createdAt: trimString(entry.createdAt) || new Date().toISOString(),
    });
    if (!normalizedEntry) return null;
    entries[normalizedState] = normalizedEntry;
    await saveGmailRelayStateEntries(entries);
    return normalizedEntry;
  });
}

async function getGmailRelayStateEntry(state) {
  const normalizedState = trimString(state);
  if (!normalizedState) return null;
  return await mutateGmailRelayState(async () => {
    const entries = await loadGmailRelayStateEntries();
    return entries[normalizedState] || null;
  });
}

async function clearGmailRelayStateEntry(state) {
  const normalizedState = trimString(state);
  if (!normalizedState) return;
  await mutateGmailRelayState(async () => {
    const entries = await loadGmailRelayStateEntries();
    if (!Object.prototype.hasOwnProperty.call(entries, normalizedState)) return;
    delete entries[normalizedState];
    await saveGmailRelayStateEntries(entries);
  });
}

function buildLocalCallbackUrl() {
  return `http://127.0.0.1:${CHAT_PORT}${GMAIL_CALLBACK_PATH}`;
}

function buildAbsoluteProductUrl(req, pathname) {
  const baseUrl = resolveBaseUrl(req) || PUBLIC_BASE_URL || BRIDGE_PUBLIC_BASE_URL;
  const path = prependProductBasePath(pathname, getRequestProductBasePath(req));
  return baseUrl ? `${baseUrl}${path}` : path;
}

function normalizeGmailAuthStateEntry(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const state = trimString(value.state);
  const createdAt = trimString(value.createdAt) || new Date().toISOString();
  if (!state) return null;
  return {
    state,
    bindingId: trimString(value.bindingId),
    title: trimString(value.title),
    credentialsPath: trimString(value.credentialsPath),
    tokenPath: trimString(value.tokenPath),
    redirectUri: trimString(value.redirectUri),
    connectPath: trimString(value.connectPath),
    createdAt,
  };
}

function normalizeGmailAuthStateEntries(raw = null) {
  const normalized = {};
  const now = Date.now();
  const keepEntry = (entry) => {
    const createdAtMs = Date.parse(trimString(entry?.createdAt));
    if (Number.isFinite(createdAtMs) && createdAtMs < now - GMAIL_AUTH_STATE_TTL_MS) return;
    normalized[entry.state] = entry;
  };
  if (raw && typeof raw === 'object') {
    const legacyEntry = normalizeGmailAuthStateEntry(raw);
    if (legacyEntry) keepEntry(legacyEntry);
    const rawEntries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    for (const [state, value] of Object.entries(rawEntries)) {
      const entry = normalizeGmailAuthStateEntry({ state, ...(value || {}) });
      if (entry) keepEntry(entry);
    }
  }
  return normalized;
}

async function loadGmailAuthStateEntries() {
  const raw = await readJson(GOOGLE_GMAIL_AUTH_STATE_PATH, null);
  return normalizeGmailAuthStateEntries(raw);
}

async function saveGmailAuthStateEntries(entries = {}) {
  await writeJsonAtomic(GOOGLE_GMAIL_AUTH_STATE_PATH, {
    version: 1,
    entries,
  });
}

async function putGmailAuthStateEntry(state, entry = {}) {
  const normalizedState = trimString(state);
  if (!normalizedState) return null;
  return await mutateGmailAuthState(async () => {
    const entries = await loadGmailAuthStateEntries();
    const normalizedEntry = normalizeGmailAuthStateEntry({
      ...entry,
      state: normalizedState,
      createdAt: trimString(entry.createdAt) || new Date().toISOString(),
    });
    if (!normalizedEntry) return null;
    entries[normalizedState] = normalizedEntry;
    await saveGmailAuthStateEntries(entries);
    return normalizedEntry;
  });
}

async function getGmailAuthStateEntry(state) {
  const normalizedState = trimString(state);
  if (!normalizedState) return null;
  return await mutateGmailAuthState(async () => {
    const entries = await loadGmailAuthStateEntries();
    return entries[normalizedState] || null;
  });
}

async function clearGmailAuthStateEntry(state) {
  const normalizedState = trimString(state);
  if (!normalizedState) return;
  await mutateGmailAuthState(async () => {
    const entries = await loadGmailAuthStateEntries();
    if (!Object.prototype.hasOwnProperty.call(entries, normalizedState)) return;
    delete entries[normalizedState];
    await saveGmailAuthStateEntries(entries);
  });
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

async function getGmailAuthStatus(req) {
  const binding = await getConnectorBinding(DEFAULT_GMAIL_BINDING_ID, { includeCompatibilityEmail: false });
  let credentialsPath = '';
  let credentialsPresent = false;
  let setupError = '';
  try {
    credentialsPath = await resolveGmailCredentialsPath();
    credentialsPresent = await gmailCredentialsPresent(credentialsPath);
  } catch (error) {
    setupError = firstNonEmpty(error?.message, 'Google OAuth credentials are invalid.');
  }
  const tokenPresent = !!trimString(binding?.tokenPath) && await pathExists(trimString(binding.tokenPath));
  const redirectUri = await resolveGmailAuthRedirectUri(req);
  const bindingCapabilityState = trimString(binding?.capabilityState);
  let capabilityState = credentialsPresent ? 'authorization_required' : 'binding_required';
  let status = credentialsPresent ? 'authorization_required' : 'binding_required';
  let message = credentialsPresent
    ? 'Authorize Gmail once in a new page, then RemoteLab can use this mailbox for automation.'
    : 'Connect Gmail once to enable mailbox automation in this workspace.';
  if (setupError) {
    capabilityState = 'setup_required';
    status = 'setup_required';
    message = `This deployment has an invalid Gmail OAuth configuration: ${setupError}`;
  } else if (!credentialsPresent) {
    capabilityState = 'setup_required';
    status = 'setup_required';
    message = 'This deployment still needs Google OAuth configured before users can connect Gmail.';
  } else if (bindingCapabilityState === 'ready') {
    capabilityState = 'ready';
    status = 'ready';
    message = trimString(binding?.accountHint)
      ? `Connected as ${trimString(binding.accountHint)}.`
      : 'Gmail is connected.';
  } else if (bindingCapabilityState === 'authorization_required') {
    capabilityState = 'authorization_required';
    status = 'authorization_required';
    message = 'Authorize Gmail once in a new page, then RemoteLab can use this mailbox for automation.';
  }
  return {
    provider: 'google',
    capabilityState,
    status,
    message,
    setupError,
    redirectUri,
    credentialsPath,
    tokenPath: GOOGLE_GMAIL_TOKEN_PATH,
    credentialsPresent,
    tokenPresent,
    binding: binding?.connectorId === 'gmail'
      ? {
          id: trimString(binding.id),
          title: trimString(binding.title),
          provider: trimString(binding.provider),
          accountHint: trimString(binding.accountHint),
          capabilityState: trimString(binding.capabilityState),
          gmailScope: trimString(binding.gmailScope),
        }
      : null,
  };
}

function renderGmailConnectorPageHtml({
  nonce = '',
  statusPath = GMAIL_STATUS_PATH,
  authorizePath = GMAIL_AUTHORIZE_PATH,
} = {}) {
  const statusJson = JSON.stringify(statusPath);
  const authorizeJson = JSON.stringify(authorizePath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>RemoteLab - Connect Gmail</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --page: #f5f0e8;
      --card: rgba(255, 251, 246, 0.95);
      --border: rgba(80, 63, 44, 0.12);
      --text: #241c16;
      --muted: #786a59;
      --accent: #b3412d;
      --accent-soft: rgba(179, 65, 45, 0.12);
      --ok: #18714a;
      --ok-soft: rgba(24, 113, 74, 0.12);
      --shadow: 0 24px 60px rgba(34, 27, 22, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      padding: 20px;
      display: grid;
      place-items: center;
      font-family: "SF Pro Display", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(179, 65, 45, 0.08), transparent 28%),
        radial-gradient(circle at bottom right, rgba(39, 111, 74, 0.10), transparent 24%),
        var(--page);
      color: var(--text);
    }
    .shell {
      width: min(100%, 460px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 24px;
    }
    .eyebrow {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    h1 {
      margin: 14px 0 10px;
      font-size: 30px;
      line-height: 1.05;
      letter-spacing: -0.04em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: 14px;
    }
    .status {
      margin-top: 18px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.45);
    }
    .status strong {
      display: block;
      font-size: 15px;
      margin-bottom: 8px;
    }
    .status-line {
      font-size: 13px;
      color: var(--muted);
      margin-top: 6px;
      word-break: break-word;
    }
    .status-line.ok {
      color: var(--ok);
    }
    .button-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 18px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: var(--accent);
      color: white;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    button[disabled] {
      opacity: 0.6;
      cursor: wait;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="eyebrow">RemoteLab Gmail</div>
    <h1>Connect Gmail</h1>
    <p>Connect one Gmail account to this workspace. After that, RemoteLab can search, read, label, archive, reply, and send from the connected mailbox.</p>
    <p>This Google sign-in opens in a new page. If you are viewing RemoteLab inside an embedded page, keep this tab open and finish the Google consent flow in the newly opened page.</p>
    <div class="status" id="statusCard">
      <strong id="statusTitle">Checking Gmail status…</strong>
      <div class="status-line" id="statusDetail"></div>
      <div class="status-line" id="statusAccount"></div>
    </div>
    <div class="button-row">
      <button id="connectBtn" type="button">Connect Gmail</button>
      <button id="refreshBtn" class="secondary" type="button">Refresh</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const statusEndpoint = ${statusJson};
    const authorizeEndpoint = ${authorizeJson};
    const connectBtn = document.getElementById('connectBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const statusTitle = document.getElementById('statusTitle');
    const statusDetail = document.getElementById('statusDetail');
    const statusAccount = document.getElementById('statusAccount');

    let lastStatus = null;

    function renderStatus(payload) {
      lastStatus = payload || null;
      const binding = payload?.binding || null;
      const ready = payload?.capabilityState === 'ready' || binding?.capabilityState === 'ready';
      if (payload?.capabilityState === 'setup_required' || !payload?.credentialsPresent) {
        statusTitle.textContent = 'Gmail is not available yet';
      statusDetail.textContent = payload?.message || 'This deployment still needs Google OAuth configured by the operator. Once that is ready, this page will let you connect Gmail.';
        statusAccount.textContent = '';
        statusAccount.className = 'status-line';
        connectBtn.disabled = true;
        return;
      }
      connectBtn.disabled = false;
      if (ready) {
        statusTitle.textContent = 'Gmail is connected';
        statusDetail.textContent = 'This workspace can now use Gmail automation.';
        statusAccount.textContent = binding?.accountHint ? ('Connected as ' + binding.accountHint) : 'Connected';
        connectBtn.textContent = 'Reconnect Gmail';
        statusAccount.className = 'status-line ok';
        return;
      }
      statusTitle.textContent = binding?.capabilityState === 'authorization_required'
        ? 'Authorization required'
        : 'Gmail is not connected yet';
      statusDetail.textContent = 'Authorize Gmail in a new page, then RemoteLab can use this mailbox for automation.';
      statusAccount.textContent = binding?.accountHint ? ('Pending account: ' + binding.accountHint) : '';
      connectBtn.textContent = 'Connect Gmail';
      statusAccount.className = 'status-line';
    }

    async function refreshStatus() {
      const response = await fetch(statusEndpoint, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load Gmail status');
      }
      renderStatus(payload);
    }

    async function startAuthorization() {
      connectBtn.disabled = true;
      try {
        const response = await fetch(authorizeEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({}),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to start Gmail authorization');
        }
        const opened = window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        if (!opened) {
          if (window.top && window.top !== window) {
            window.top.location.href = payload.authUrl;
          } else {
            window.location.href = payload.authUrl;
          }
        }
      } catch (error) {
        connectBtn.disabled = false;
        statusTitle.textContent = 'Failed to start Gmail authorization';
        statusDetail.textContent = error?.message || 'Unknown error';
      }
    }

    connectBtn.addEventListener('click', () => void startAuthorization());
    refreshBtn.addEventListener('click', () => void refreshStatus());
    void refreshStatus().catch((error) => {
      statusTitle.textContent = 'Failed to load Gmail status';
      statusDetail.textContent = error?.message || 'Unknown error';
    });
  </script>
</body>
</html>`;
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
      surfaces: await listResolvedConnectorSurfaceInfo({
        nonce,
        productBasePath: getRequestProductBasePath(req),
      }),
    });
    return true;
  }

  const infoConnectorId = parseConnectorSurfaceInfoRoute(pathname);
  if (infoConnectorId) {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    const surface = await getReachableConnectorSurface(infoConnectorId, {
      clearStale: true,
      timeoutMs: 500,
    });
    if (!surface) {
      const fallbackSurface = await getLegacyConnectorSurfaceInfo(infoConnectorId, {
        productBasePath: getRequestProductBasePath(req),
      });
      if (fallbackSurface) {
        writeJson(res, 200, fallbackSurface);
        return true;
      }
      writeJson(res, 404, { error: 'Connector surface not found' });
      return true;
    }
    const mountPath = buildPublicConnectorMountPath(req, surface.connectorId);
    const description = await fetchConnectorSurfaceDescription(surface, { mountPath, nonce });
    writeJson(res, 200, buildConnectorSurfaceInfoResponse(surface, description));
    return true;
  }

  if (pathname === WECHAT_LOGIN_OPEN_PATH && req.method === 'GET') {
    return await handleWeChatLoginOpenRequest({
      req,
      res,
      pathname,
      authSession,
      buildHeaders,
      writeJson,
    });
  }

  const route = parseConnectorSurfaceProxyRoute(pathname);
  if (!route) return false;

  const surface = await getReachableConnectorSurface(route.connectorId, {
    clearStale: true,
    timeoutMs: 500,
  });
  if (!surface?.baseUrl) {
    return false;
  }

  const isPublicProxyPath = isConnectorSurfacePublicPath(surface, route.tailPath);
  if (authSession?.role !== 'owner' && !isPublicProxyPath) {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  const mountPath = buildPublicConnectorMountPath(req, surface.connectorId);
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
  if (pathname === WHATSAPP_BUSINESS_CONNECTOR_PAGE_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }

    try {
      const surface = await ensureWhatsAppBusinessConnectorSurfaceRunning();
      if (!surface?.baseUrl) {
        writeJson(res, 502, { error: 'WhatsApp Business connector failed to start.' });
        return true;
      }
    } catch (error) {
      writeJson(res, 502, {
        error: firstNonEmpty(
          trimString(error?.stderr),
          trimString(error?.stdout),
          trimString(error?.message),
          'WhatsApp Business connector failed to start.',
        ),
      });
      return true;
    }

    res.writeHead(302, buildHeaders({
      Location: prependProductBasePath(WHATSAPP_BUSINESS_CONNECTOR_PAGE_PATH, getRequestProductBasePath(req)),
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    }));
    res.end();
    return true;
  }

  if (pathname === GMAIL_CONNECTOR_PAGE_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.writeHead(200, buildHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    }));
    res.end(renderGmailConnectorPageHtml({
      nonce,
      statusPath: prependProductBasePath(GMAIL_STATUS_PATH, getRequestProductBasePath(req)),
      authorizePath: prependProductBasePath(GMAIL_AUTHORIZE_PATH, getRequestProductBasePath(req)),
    }));
    return true;
  }

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
    const productBasePath = getRequestProductBasePath(req);
    const authPath = prependProductBasePath(WECHAT_LOGIN_PAGE_PATH, productBasePath);
    const statusPath = prependProductBasePath(WECHAT_LOGIN_STATUS_PATH, productBasePath);
    const qrPath = prependProductBasePath(WECHAT_LOGIN_QR_PATH, productBasePath);
    const openPath = prependProductBasePath(WECHAT_LOGIN_OPEN_PATH, productBasePath);
    const initialState = await getWeChatLoginSurface({
      autoStart: true,
      authPath,
      qrPath,
      openPath,
    });
    const body = renderPageTemplate(template, nonce, {
      ...buildTemplateReplacements(pageBuildInfo, getRequestProductBasePath(req)),
      PAGE_TITLE: 'Connect WeChat',
      BODY_CLASS: 'wechat-login-page',
      BOOTSTRAP_JSON: serializeJsonForScript({
        wechatLogin: {
          initialState,
          statusEndpoint: statusPath,
          qrEndpoint: qrPath,
          openEndpoint: openPath,
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
    const productBasePath = getRequestProductBasePath(req);
    writeJson(res, 200, await getWeChatLoginSurface({
      autoStart: true,
      authPath: prependProductBasePath(WECHAT_LOGIN_PAGE_PATH, productBasePath),
      qrPath: prependProductBasePath(WECHAT_LOGIN_QR_PATH, productBasePath),
      openPath: prependProductBasePath(WECHAT_LOGIN_OPEN_PATH, productBasePath),
    }));
    return true;
  }

  if (pathname === GMAIL_STATUS_PATH && req.method === 'GET') {
    if (authSession?.role !== 'owner') {
      writeJson(res, 403, { error: 'Owner access required' });
      return true;
    }
    res.writeHead(200, buildHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    }));
    res.end(JSON.stringify(await getGmailAuthStatus(req)));
    return true;
  }

  if (pathname === GMAIL_CREDENTIALS_PATH && req.method === 'POST') {
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

    const credentialsText = firstNonEmpty(
      trimString(payload?.credentialsText),
      typeof payload?.credentials === 'string' ? trimString(payload.credentials) : '',
    );
    if (!credentialsText) {
      writeJson(res, 400, { error: 'Missing Gmail OAuth client JSON.' });
      return true;
    }

    let credentials;
    try {
      credentials = JSON.parse(credentialsText);
    } catch {
      writeJson(res, 400, { error: 'Gmail OAuth client JSON is invalid.' });
      return true;
    }

    const config = credentials?.installed || credentials?.web || credentials;
    if (!trimString(config?.client_id) || !trimString(config?.client_secret)) {
      writeJson(res, 400, { error: 'OAuth client JSON must include client_id and client_secret.' });
      return true;
    }
    if (!trimString(config?.redirect_uri) && !(Array.isArray(config?.redirect_uris) && config.redirect_uris.length > 0)) {
      writeJson(res, 400, { error: 'OAuth client JSON must include at least one redirect URI.' });
      return true;
    }

    await writeJsonAtomic(GOOGLE_GMAIL_CREDENTIALS_PATH, credentials);
    writeJson(res, 200, {
      saved: true,
      credentialsPath: GOOGLE_GMAIL_CREDENTIALS_PATH,
    });
    return true;
  }

  if (pathname === GMAIL_AUTHORIZE_PATH && req.method === 'POST') {
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

    const redirectUri = await resolveGmailAuthRedirectUri(req);
    if (!redirectUri) {
      writeJson(res, 500, { error: 'Cannot determine public callback URL from request headers.' });
      return true;
    }

    let credentialsPath = '';
    try {
      credentialsPath = await resolveGmailCredentialsPath();
    } catch (error) {
      writeJson(res, 409, {
        error: firstNonEmpty(error?.message, 'Invalid Google OAuth client credentials.'),
        redirectUri,
      });
      return true;
    }

    if (!await gmailCredentialsPresent(credentialsPath)) {
      writeJson(res, 409, {
        error: 'Missing Google OAuth client credentials.',
        redirectUri,
        credentialsPath,
      });
      return true;
    }

    const binding = await ensureGmailConnectorBinding({
      bindingId: DEFAULT_GMAIL_BINDING_ID,
      provider: 'google',
      title: trimString(payload?.title) || 'Gmail',
      tokenPath: '',
      gmailScope: GMAIL_OAUTH_SCOPES.join(' '),
    });
    const state = randomUUID();
    const localCallbackUrl = buildLocalCallbackUrl();
    const connectUrl = buildAbsoluteProductUrl(req, GMAIL_CONNECTOR_PAGE_PATH);
    await putGmailAuthStateEntry(state, {
      state,
      bindingId: binding.id,
      title: binding.title,
      credentialsPath,
      tokenPath: GOOGLE_GMAIL_TOKEN_PATH,
      redirectUri,
      connectPath: connectUrl,
      createdAt: new Date().toISOString(),
    });
    if (trimString(localCallbackUrl) && trimString(redirectUri) && trimString(localCallbackUrl) !== trimString(redirectUri)) {
      await putGmailRelayStateEntry(state, {
        state,
        callbackUrl: `${localCallbackUrl}?relay_target=1`,
        createdAt: new Date().toISOString(),
      });
    }
    const authUrl = await generateGmailAuthUrl({
      credentialsPath,
      redirectUri,
      state,
      scopes: GMAIL_OAUTH_SCOPES,
    });
    writeJson(res, 200, {
      authUrl,
      redirectUri,
      bindingId: binding.id,
      credentialsPath,
      tokenPath: GOOGLE_GMAIL_TOKEN_PATH,
    });
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
      const body = await QRCode.toBuffer(qrcodeUrl, {
        type: 'png',
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      res.writeHead(200, buildHeaders({
        'Content-Type': 'image/png',
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
      res.end(`Failed to generate WeChat QR image: ${error?.message || 'unknown error'}`);
      return true;
    }
  }

  if (pathname === WECHAT_LOGIN_OPEN_PATH && req.method === 'GET') {
    return await handleWeChatLoginOpenRequest({
      req,
      res,
      pathname,
      authSession,
      buildHeaders,
      writeJson,
    });
  }

  if (pathname === GMAIL_CALLBACK_PATH && req.method === 'GET') {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const code = trimString(requestUrl.searchParams.get('code'));
    const state = trimString(requestUrl.searchParams.get('state'));
    const relayTarget = trimString(requestUrl.searchParams.get('relay_target'));
    const isRelayTargetRequest = relayTarget === '1' || trimString(req.headers?.['x-remotelab-gmail-relay']) === '1';
    const relayState = !isRelayTargetRequest ? await getGmailRelayStateEntry(state) : null;
    if (!isRelayTargetRequest && code && state && relayState?.callbackUrl) {
      try {
        const relayUrl = new URL(trimString(relayState.callbackUrl));
        relayUrl.searchParams.set('code', code);
        relayUrl.searchParams.set('state', state);
        const relayResponse = await fetch(relayUrl, {
          headers: {
            'x-remotelab-gmail-relay': '1',
          },
        });
        const relayBody = await relayResponse.text();
        await clearGmailRelayStateEntry(state);
        res.writeHead(relayResponse.status, {
          'Content-Type': relayResponse.headers.get('content-type') || 'text/plain; charset=utf-8',
        });
        res.end(relayBody);
        return true;
      } catch (error) {
        await clearGmailRelayStateEntry(state);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Gmail authorization relay failed: ${error?.message || 'unknown error'}`);
        return true;
      }
    }
    const authState = await getGmailAuthStateEntry(state);
    const redirectUri = trimString(authState?.redirectUri) || await resolveGmailAuthRedirectUri(req);

    if (!code || !state || !redirectUri || !authState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Gmail authorization callback is invalid or expired.');
      return true;
    }

    try {
      await handleGmailAuthCallback({
        credentialsPath: trimString(authState.credentialsPath),
        tokenPath: trimString(authState.tokenPath) || GOOGLE_GMAIL_TOKEN_PATH,
        code,
        redirectUri,
      });
      await ensureGmailConnectorBinding({
        bindingId: trimString(authState.bindingId) || DEFAULT_GMAIL_BINDING_ID,
        provider: 'google',
        tokenPath: trimString(authState.tokenPath) || GOOGLE_GMAIL_TOKEN_PATH,
        title: trimString(authState.title) || 'Gmail',
        gmailScope: GMAIL_OAUTH_SCOPES.join(' '),
      });
      const profile = await getGmailProfile({
        bindingId: trimString(authState.bindingId) || DEFAULT_GMAIL_BINDING_ID,
        credentialsPath: trimString(authState.credentialsPath),
      });
      await ensureGmailConnectorBinding({
        bindingId: trimString(authState.bindingId) || DEFAULT_GMAIL_BINDING_ID,
        provider: 'google',
        accountHint: trimString(profile?.emailAddress),
        tokenPath: trimString(authState.tokenPath) || GOOGLE_GMAIL_TOKEN_PATH,
        title: trimString(profile?.emailAddress) || trimString(authState.title) || 'Gmail',
        gmailScope: GMAIL_OAUTH_SCOPES.join(' '),
      });
      await clearGmailAuthStateEntry(state);
      await clearGmailRelayStateEntry(state);
      const connectPath = trimString(authState.connectPath) || prependProductBasePath(GMAIL_CONNECTOR_PAGE_PATH, getRequestProductBasePath(req));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=${connectPath}"><title>Gmail Connected</title></head><body style="font-family: sans-serif; padding: 24px;">Gmail authorization succeeded. Returning to RemoteLab…</body></html>`);
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Gmail authorization failed: ${error.message || 'unknown error'}`);
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

export const __testing = {
  resolveGmailAuthRedirectUri,
  normalizeGmailAuthStateEntries,
  loadGmailAuthStateEntries,
  saveGmailAuthStateEntries,
  putGmailAuthStateEntry,
  getGmailAuthStateEntry,
  clearGmailAuthStateEntry,
};

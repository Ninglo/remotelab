#!/usr/bin/env node

import { createHmac } from 'crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { AUTH_FILE, CHAT_PORT, CONFIG_DIR, PUBLIC_BASE_URL } from '../lib/config.mjs';
import {
  normalizeExternalRuntimeSelectionMode,
  resolveExternalRuntimeSelection,
} from '../lib/external-runtime-selection.mjs';
import {
  buildConnectorFailureReply,
  classifyConnectorFailureReason,
  decideConnectorUserVisibleReply,
} from '../lib/connector-user-visible-reply.mjs';
import {
  assertConnectorPublicationReady,
  createConnectorSession,
  loadConnectorAssistantReply,
  normalizeConnectorPublicationText,
  submitConnectorMessage,
  waitForConnectorPublication,
} from '../lib/connector-turn-flow.mjs';
import { startConnectorSurfaceServer } from '../lib/connector-sdk/surface.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';

const CONNECTOR_ID = 'whatsapp-business';
const REMOTELAB_SESSION_APP_ID = 'whatsapp';
const DEFAULT_STORAGE_DIR = join(CONFIG_DIR, CONNECTOR_ID);
const DEFAULT_CONFIG_PATH = process.env.REMOTELAB_WHATSAPP_BUSINESS_CONFIG_PATH
  ? resolve(process.env.REMOTELAB_WHATSAPP_BUSINESS_CONFIG_PATH)
  : join(DEFAULT_STORAGE_DIR, 'config.json');
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = trimString(process.env.REMOTELAB_WHATSAPP_GRAPH_VERSION) || 'v23.0';
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_RUNTIME_SELECTION_MODE = 'ui';
const DEFAULT_SOURCE_NAME = 'WhatsApp';
const DEFAULT_GROUP = 'WhatsApp';
const DEFAULT_SURFACE_HOST = '127.0.0.1';
const DEFAULT_SURFACE_TITLE = 'WhatsApp Business';
const DEFAULT_SURFACE_ENTRY_PATH = '/';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RUN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WEBHOOK_BODY_LIMIT_BYTES = 512 * 1024;
const PUBLIC_WEBHOOK_PATH = '/webhook';
const STATUS_PATH = '/status';
const CONFIG_PATH = '/config';
const SUBSCRIBE_PATH = '/subscribe';
const HANDLED_MESSAGES_FILENAME = 'handled-messages.json';
const EVENTS_LOG_FILENAME = 'events.jsonl';
const DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are interacting through a WhatsApp Business connector on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by RemoteLab backend prompt logic.',
].join('\n');

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

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolvePath(value, fallback = '') {
  const trimmed = trimString(value);
  if (!trimmed) return fallback;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function normalizeBaseUrl(value, fallback = '') {
  const normalized = trimString(value || fallback).replace(/\/+$/, '');
  return normalized;
}

function sanitizeIdPart(value, fallback = 'unknown') {
  const normalized = trimString(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function maskSecret(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}***`;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSurfaceBaseUrl(req, mountPrefix = '') {
  const forwardedHost = trimString(req?.headers?.['x-forwarded-host']);
  const forwardedProto = trimString(req?.headers?.['x-forwarded-proto']) || 'https';
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}${trimString(mountPrefix)}`;
  }
  return normalizeBaseUrl(PUBLIC_BASE_URL)
    ? `${normalizeBaseUrl(PUBLIC_BASE_URL)}${trimString(mountPrefix)}`
    : trimString(mountPrefix);
}

function buildWebhookUrl(req, mountPrefix = '') {
  const base = resolveSurfaceBaseUrl(req, mountPrefix);
  if (!base) return PUBLIC_WEBHOOK_PATH;
  return `${base}${PUBLIC_WEBHOOK_PATH}`;
}

async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

async function readJson(pathname, fallback) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(pathname, value) {
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
  await ensureDir(dirname(pathname));
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, pathname);
}

async function appendJsonl(pathname, value) {
  await ensureDir(dirname(pathname));
  await appendFile(pathname, `${JSON.stringify(value)}\n`, 'utf8');
}

function buildPersistedConfig(config = {}) {
  return {
    storageDir: config.storageDir,
    chatBaseUrl: config.chatBaseUrl,
    graphApiBaseUrl: config.graphApiBaseUrl,
    graphVersion: config.graphVersion,
    accessToken: trimString(config.accessToken),
    appSecret: trimString(config.appSecret),
    verifyToken: trimString(config.verifyToken),
    phoneNumberId: trimString(config.phoneNumberId),
    wabaId: trimString(config.wabaId),
    sessionFolder: config.sessionFolder,
    sessionTool: config.sessionTool,
    runtimeSelectionMode: config.runtimeSelectionMode,
    sourceName: config.sourceName,
    group: config.group,
    silentConfirmationText: trimString(config.silentConfirmationText),
    ...(config.model ? { model: trimString(config.model) } : {}),
    ...(config.effort ? { effort: trimString(config.effort) } : {}),
    ...(config.thinking === true ? { thinking: true } : {}),
    requestTimeoutMs: config.requestTimeoutMs,
    runPollTimeoutMs: config.runPollTimeoutMs,
    runPollIntervalMs: config.runPollIntervalMs,
    surface: {
      enabled: config.surface?.enabled !== false,
      host: trimString(config.surface?.host) || DEFAULT_SURFACE_HOST,
      port: Number.isInteger(config.surface?.port) ? config.surface.port : 0,
      entryPath: trimString(config.surface?.entryPath) || DEFAULT_SURFACE_ENTRY_PATH,
    },
  };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedConfigPath = resolve(configPath);
  const existing = await readJson(resolvedConfigPath, null);
  const defaultStorageDir = dirname(resolvedConfigPath);
  const storageDir = resolvePath(existing?.storageDir, defaultStorageDir) || defaultStorageDir;
  const config = {
    configPath: resolvedConfigPath,
    storageDir,
    chatBaseUrl: normalizeBaseUrl(existing?.chatBaseUrl, DEFAULT_CHAT_BASE_URL),
    graphApiBaseUrl: normalizeBaseUrl(existing?.graphApiBaseUrl, DEFAULT_GRAPH_API_BASE_URL),
    graphVersion: trimString(existing?.graphVersion) || DEFAULT_GRAPH_VERSION,
    accessToken: trimString(existing?.accessToken),
    appSecret: trimString(existing?.appSecret),
    verifyToken: trimString(existing?.verifyToken),
    phoneNumberId: trimString(existing?.phoneNumberId),
    wabaId: trimString(existing?.wabaId),
    sessionFolder: resolvePath(existing?.sessionFolder, homedir()) || homedir(),
    sessionTool: trimString(existing?.sessionTool) || DEFAULT_SESSION_TOOL,
    runtimeSelectionMode: normalizeExternalRuntimeSelectionMode(existing?.runtimeSelectionMode, DEFAULT_RUNTIME_SELECTION_MODE),
    sourceName: trimString(existing?.sourceName) || DEFAULT_SOURCE_NAME,
    group: trimString(existing?.group) || DEFAULT_GROUP,
    silentConfirmationText: trimString(existing?.silentConfirmationText),
    model: trimString(existing?.model),
    effort: trimString(existing?.effort),
    thinking: existing?.thinking === true,
    requestTimeoutMs: Number.isInteger(existing?.requestTimeoutMs) && existing.requestTimeoutMs > 0
      ? existing.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS,
    runPollTimeoutMs: Number.isInteger(existing?.runPollTimeoutMs) && existing.runPollTimeoutMs > 0
      ? existing.runPollTimeoutMs
      : DEFAULT_RUN_POLL_TIMEOUT_MS,
    runPollIntervalMs: Number.isInteger(existing?.runPollIntervalMs) && existing.runPollIntervalMs > 0
      ? existing.runPollIntervalMs
      : DEFAULT_RUN_POLL_INTERVAL_MS,
    surface: {
      enabled: existing?.surface?.enabled !== false,
      host: trimString(existing?.surface?.host) || DEFAULT_SURFACE_HOST,
      port: Number.isInteger(existing?.surface?.port) && existing.surface.port >= 0
        ? existing.surface.port
        : 0,
      entryPath: trimString(existing?.surface?.entryPath) || DEFAULT_SURFACE_ENTRY_PATH,
    },
  };

  if (!existing) {
    await writeJsonAtomic(resolvedConfigPath, buildPersistedConfig(config));
  }

  return config;
}

async function saveConfigPatch(configPath, patch = {}) {
  const current = await loadConfig(configPath);
  const next = {
    ...current,
    ...patch,
    surface: {
      ...current.surface,
      ...(patch.surface && typeof patch.surface === 'object' ? patch.surface : {}),
    },
  };
  await writeJsonAtomic(current.configPath, buildPersistedConfig(next));
  return loadConfig(current.configPath);
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

async function requestJson(baseUrl, path, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { response, json, text };
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (runtime.authCookie && !forceRefresh) return runtime.authCookie;
  if (!runtime.authToken || forceRefresh) {
    runtime.authToken = await runtime.readOwnerToken();
  }
  runtime.authCookie = await loginWithToken(runtime.config.chatBaseUrl, runtime.authToken);
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const cookie = await ensureAuthCookie(runtime, false);
  const headers = {
    Accept: 'application/json',
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
    Cookie: cookie,
  };
  let result = await requestJson(runtime.config.chatBaseUrl, path, {
    ...options,
    headers,
    timeoutMs: runtime.config.requestTimeoutMs,
  });
  if (result.response?.status === 401) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await requestJson(runtime.config.chatBaseUrl, path, {
      ...options,
      headers: {
        ...headers,
        Cookie: refreshedCookie,
      },
      timeoutMs: runtime.config.requestTimeoutMs,
    });
  }
  return result;
}

function buildGraphUrl(runtime, path) {
  const baseUrl = normalizeBaseUrl(runtime?.config?.graphApiBaseUrl, DEFAULT_GRAPH_API_BASE_URL);
  const version = trimString(runtime?.config?.graphVersion);
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
  return version
    ? `${baseUrl}/${version}${normalizedPath}`
    : `${baseUrl}${normalizedPath}`;
}

async function requestGraph(runtime, path, { method = 'GET', body = undefined } = {}) {
  const accessToken = trimString(runtime?.config?.accessToken);
  if (!accessToken) {
    throw new Error('WhatsApp access token is not configured');
  }
  const response = await fetch(buildGraphUrl(runtime, path), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(runtime.config.requestTimeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    throw new Error(
      firstNonEmpty(
        trimString(json?.error?.message),
        trimString(json?.message),
        trimString(text),
        `WhatsApp Graph API request failed (${response.status})`,
      ),
    );
  }
  return { response, json, text };
}

function buildStoragePaths(config) {
  return {
    handledMessagesPath: join(config.storageDir, HANDLED_MESSAGES_FILENAME),
    eventsLogPath: join(config.storageDir, EVENTS_LOG_FILENAME),
  };
}

async function loadHandledMessagesDocument(pathname) {
  const loaded = await readJson(pathname, null);
  if (loaded && typeof loaded === 'object' && loaded.messages && typeof loaded.messages === 'object') {
    return loaded;
  }
  return { messages: {} };
}

async function saveHandledMessagesDocument(pathname, document) {
  await writeJsonAtomic(pathname, document);
}

export async function createRuntimeContext(config) {
  await ensureDir(config.storageDir);
  return {
    config,
    storagePaths: buildStoragePaths(config),
    authToken: '',
    authCookie: '',
    readOwnerToken,
    processingMessageIds: new Set(),
    conversationQueues: new Map(),
    handledMessagesDoc: await loadHandledMessagesDocument(join(config.storageDir, HANDLED_MESSAGES_FILENAME)),
    lastError: '',
    stats: {
      webhookCalls: 0,
      inboundMessages: 0,
      outboundMessages: 0,
      startedAt: nowIso(),
    },
  };
}

function runtimeMissingSetup(runtime) {
  const missing = [];
  if (!trimString(runtime?.config?.verifyToken)) missing.push('verify token');
  if (!trimString(runtime?.config?.accessToken)) missing.push('access token');
  if (!trimString(runtime?.config?.phoneNumberId)) missing.push('phone number ID');
  return missing;
}

function buildSurfaceStatus(runtime, { req = null, mountPrefix = '' } = {}) {
  const missing = runtimeMissingSetup(runtime);
  const appSecretConfigured = !!trimString(runtime?.config?.appSecret);
  const ready = missing.length === 0;
  let message = '';
  if (!ready) {
    message = `Add ${missing.join(', ')} to finish connecting WhatsApp Business.`;
  } else if (!appSecretConfigured) {
    message = 'Ready to receive and reply to WhatsApp messages. App secret is still missing, so webhook signatures are not verified.';
  } else {
    message = 'Ready to receive and reply to WhatsApp messages.';
  }
  return {
    capabilityState: ready ? 'ready' : 'authorization_required',
    status: ready ? 'ready' : 'authorization_required',
    message,
    webhookUrl: buildWebhookUrl(req, mountPrefix),
    config: {
      verifyTokenConfigured: !!trimString(runtime?.config?.verifyToken),
      accessTokenConfigured: !!trimString(runtime?.config?.accessToken),
      appSecretConfigured,
      phoneNumberId: trimString(runtime?.config?.phoneNumberId),
      wabaId: trimString(runtime?.config?.wabaId),
      graphVersion: trimString(runtime?.config?.graphVersion),
      sourceName: trimString(runtime?.config?.sourceName),
      group: trimString(runtime?.config?.group),
      sessionFolder: trimString(runtime?.config?.sessionFolder),
      sessionTool: trimString(runtime?.config?.sessionTool),
      runtimeSelectionMode: trimString(runtime?.config?.runtimeSelectionMode),
      maskedAccessToken: maskSecret(runtime?.config?.accessToken),
      maskedAppSecret: maskSecret(runtime?.config?.appSecret),
    },
    stats: {
      ...runtime.stats,
      queuedConversations: runtime.conversationQueues.size,
      lastError: trimString(runtime.lastError),
    },
    updatedAt: nowIso(),
  };
}

function normalizeWebhookMessageText(message = {}) {
  const type = trimString(message?.type).toLowerCase();
  if (type === 'text') {
    return trimString(message?.text?.body);
  }
  if (type === 'button') {
    return trimString(message?.button?.text);
  }
  if (type === 'interactive') {
    const interactiveType = trimString(message?.interactive?.type).toLowerCase();
    if (interactiveType === 'button_reply') {
      return firstNonEmpty(
        trimString(message?.interactive?.button_reply?.title),
        trimString(message?.interactive?.button_reply?.id),
      );
    }
    if (interactiveType === 'list_reply') {
      return firstNonEmpty(
        trimString(message?.interactive?.list_reply?.title),
        trimString(message?.interactive?.list_reply?.description),
        trimString(message?.interactive?.list_reply?.id),
      );
    }
  }
  return '';
}

function summarizeMessageType(message = {}) {
  const type = trimString(message?.type).toLowerCase();
  if (type === 'image') return 'image message';
  if (type === 'audio') return 'audio message';
  if (type === 'video') return 'video message';
  if (type === 'document') return 'document message';
  if (type === 'location') return 'location message';
  if (type === 'contacts') return 'contact card';
  if (type === 'sticker') return 'sticker';
  if (type === 'reaction') return 'reaction';
  return type || 'message';
}

export function summarizeWebhookMessage(message = {}, contact = {}, metadata = {}, envelope = {}) {
  const normalizedText = normalizeWebhookMessageText(message);
  const fromWaId = trimString(message?.from) || trimString(contact?.wa_id);
  const profileName = trimString(contact?.profile?.name);
  return {
    connector: CONNECTOR_ID,
    sourceId: REMOTELAB_SESSION_APP_ID,
    wabaId: trimString(envelope?.wabaId),
    phoneNumberId: trimString(metadata?.phone_number_id),
    displayPhoneNumber: trimString(metadata?.display_phone_number),
    fromWaId,
    profileName,
    messageId: trimString(message?.id),
    replyToMessageId: trimString(message?.context?.id),
    timestamp: trimString(message?.timestamp),
    messageType: trimString(message?.type).toLowerCase() || 'unknown',
    normalizedText,
    textPreview: normalizedText,
    contentSummary: normalizedText || summarizeMessageType(message),
    rawMessage: message,
  };
}

export function collectWebhookMessages(payload = {}) {
  if (trimString(payload?.object) !== 'whatsapp_business_account') return [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const summaries = [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (trimString(change?.field) !== 'messages') continue;
      const value = change?.value && typeof change.value === 'object' ? change.value : {};
      const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactByWaId = new Map();
      for (const contact of contacts) {
        const waId = trimString(contact?.wa_id);
        if (waId) contactByWaId.set(waId, contact);
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        const fromWaId = trimString(message?.from);
        const contact = contactByWaId.get(fromWaId) || {};
        const summary = summarizeWebhookMessage(message, contact, metadata, {
          wabaId: entry?.id,
        });
        if (!summary.messageId || !summary.fromWaId) continue;
        summaries.push(summary);
      }
    }
  }
  return summaries;
}

export function verifyWebhookSignature(rawBody, signatureHeader = '', appSecret = '') {
  const normalizedSecret = trimString(appSecret);
  if (!normalizedSecret) return true;
  const normalizedHeader = trimString(signatureHeader);
  if (!normalizedHeader.startsWith('sha256=')) return false;
  const provided = normalizedHeader.slice('sha256='.length).trim().toLowerCase();
  const expected = createHmac('sha256', normalizedSecret).update(rawBody).digest('hex').toLowerCase();
  return provided === expected;
}

function buildExternalTriggerId(summary) {
  return `${REMOTELAB_SESSION_APP_ID}:${sanitizeIdPart(summary.phoneNumberId, 'phone')}:${sanitizeIdPart(summary.fromWaId, 'user')}`;
}

function buildRequestId(summary) {
  return `${REMOTELAB_SESSION_APP_ID}:${sanitizeIdPart(summary.phoneNumberId, 'phone')}:${sanitizeIdPart(summary.messageId, 'message')}`;
}

function buildSessionName(summary) {
  return firstNonEmpty(summary.profileName, summary.fromWaId, summary.displayPhoneNumber, 'WhatsApp chat');
}

function buildSessionDescription(summary) {
  const parts = ['Inbound WhatsApp direct chat'];
  const displayPhoneNumber = trimString(summary?.displayPhoneNumber);
  if (displayPhoneNumber) parts.push(displayPhoneNumber);
  return parts.join(' · ');
}

function buildRemoteLabMessage(summary) {
  return trimString(summary?.normalizedText || summary?.textPreview || summary?.contentSummary);
}

function buildSessionSourceContext(summary) {
  return {
    connector: CONNECTOR_ID,
    chatType: 'direct',
    wabaId: trimString(summary?.wabaId),
    phoneNumberId: trimString(summary?.phoneNumberId),
    displayPhoneNumber: trimString(summary?.displayPhoneNumber),
    waId: trimString(summary?.fromWaId),
    profileName: trimString(summary?.profileName),
  };
}

function buildMessageSourceContext(summary) {
  return {
    connector: CONNECTOR_ID,
    chatType: 'direct',
    wabaId: trimString(summary?.wabaId),
    phoneNumberId: trimString(summary?.phoneNumberId),
    waId: trimString(summary?.fromWaId),
    profileName: trimString(summary?.profileName),
    messageId: trimString(summary?.messageId),
    replyToMessageId: trimString(summary?.replyToMessageId),
    messageType: trimString(summary?.messageType),
    contentSummary: trimString(summary?.contentSummary),
  };
}

async function resolveWhatsAppRuntimeSelection(runtime) {
  const uiSelection = await loadUiRuntimeSelection();
  return resolveExternalRuntimeSelection({
    uiSelection,
    mode: runtime?.config?.runtimeSelectionMode || DEFAULT_RUNTIME_SELECTION_MODE,
    fallback: {
      tool: runtime?.config?.sessionTool || DEFAULT_SESSION_TOOL,
      model: runtime?.config?.model || '',
      effort: runtime?.config?.effort || '',
      thinking: runtime?.config?.thinking === true,
    },
    defaultTool: DEFAULT_SESSION_TOOL,
  });
}

export async function generateRemoteLabReply(runtime, summary) {
  const runtimeSelection = await resolveWhatsAppRuntimeSelection(runtime);
  const requester = (path, options = {}) => requestRemoteLab(runtime, path, options);
  const session = await createConnectorSession(requester, {
    folder: runtime.config.sessionFolder,
    tool: runtimeSelection.tool,
    name: buildSessionName(summary),
    sourceId: REMOTELAB_SESSION_APP_ID,
    sourceName: runtime.config.sourceName,
    group: runtime.config.group,
    description: buildSessionDescription(summary),
    systemPrompt: DEFAULT_SESSION_SYSTEM_PROMPT,
    externalTriggerId: buildExternalTriggerId(summary),
    sourceContext: buildSessionSourceContext(summary),
  });
  const submission = await submitConnectorMessage(requester, session.id, {
    requestId: buildRequestId(summary),
    text: buildRemoteLabMessage(summary),
    tool: runtimeSelection.tool,
    sourceContext: buildMessageSourceContext(summary),
    ...(runtimeSelection.thinking ? { thinking: true } : {}),
    ...(runtimeSelection.model ? { model: runtimeSelection.model } : {}),
    ...(runtimeSelection.effort ? { effort: runtimeSelection.effort } : {}),
  });

  if (!submission.runId && submission.duplicate) {
    return {
      sessionId: session.id,
      runId: '',
      requestId: submission.requestId,
      responseId: submission.responseId,
      duplicate: true,
      queued: submission.queued,
      replyText: '',
      silent: true,
    };
  }

  const publication = await waitForConnectorPublication(requester, session.id, submission.responseId, {
    timeoutMs: runtime.config.runPollTimeoutMs,
    intervalMs: runtime.config.runPollIntervalMs,
  });
  assertConnectorPublicationReady(publication);

  const finalizedRunId = trimString(publication?.finalRunId) || trimString(submission.runId);
  let replyText = trimString(normalizeConnectorPublicationText(publication));
  if (!replyText) {
    const replyEvent = await loadConnectorAssistantReply(requester, session.id, {
      runId: finalizedRunId,
      requestId: submission.requestId,
    });
    replyText = trimString(replyEvent?.normalizedContent || replyEvent?.content || '');
  }

  return {
    sessionId: session.id,
    runId: finalizedRunId,
    requestId: submission.requestId,
    responseId: submission.responseId,
    duplicate: submission.duplicate,
    queued: submission.queued,
    replyText,
    silent: !replyText,
  };
}

export async function sendWhatsAppText(runtime, summary, text) {
  const bodyText = trimString(text);
  if (!bodyText) {
    throw new Error('WhatsApp text body is empty');
  }
  const phoneNumberId = firstNonEmpty(
    trimString(summary?.phoneNumberId),
    trimString(runtime?.config?.phoneNumberId),
  );
  const to = firstNonEmpty(
    trimString(summary?.fromWaId),
    trimString(summary?.waId),
    trimString(summary?.to),
  );
  if (!phoneNumberId) {
    throw new Error('WhatsApp phone number ID is not configured');
  }
  if (!to) {
    throw new Error('WhatsApp recipient is missing');
  }
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      body: bodyText,
    },
  };
  const replyToMessageId = trimString(summary?.messageId || summary?.replyToMessageId);
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }

  const result = await requestGraph(runtime, `/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    body: payload,
  });
  runtime.stats.outboundMessages += 1;
  return result.json || {};
}

export async function subscribeAppToWaba(runtime) {
  const wabaId = trimString(runtime?.config?.wabaId);
  if (!wabaId) {
    throw new Error('WABA ID is not configured');
  }
  const result = await requestGraph(runtime, `/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'POST',
  });
  return result.json || {};
}

async function wasMessageHandled(runtime, messageId) {
  return !!runtime?.handledMessagesDoc?.messages?.[messageId];
}

async function markMessageHandled(runtime, messageId, metadata = {}) {
  runtime.handledMessagesDoc.messages[messageId] = {
    handledAt: nowIso(),
    ...metadata,
  };
  await saveHandledMessagesDocument(runtime.storagePaths.handledMessagesPath, runtime.handledMessagesDoc);
}

function buildConversationKey(summary) {
  return `${sanitizeIdPart(summary.phoneNumberId, 'phone')}:${sanitizeIdPart(summary.fromWaId, 'user')}`;
}

function isProcessableMessage(summary) {
  if (!summary?.messageId || !summary?.fromWaId || !summary?.phoneNumberId) return false;
  return !!buildRemoteLabMessage(summary);
}

async function recordInboundEvent(runtime, summary, rawPayload) {
  await appendJsonl(runtime.storagePaths.eventsLogPath, {
    loggedAt: nowIso(),
    type: 'inbound_webhook',
    summary: {
      messageId: summary.messageId,
      fromWaId: summary.fromWaId,
      profileName: summary.profileName,
      phoneNumberId: summary.phoneNumberId,
      displayPhoneNumber: summary.displayPhoneNumber,
      messageType: summary.messageType,
      contentSummary: summary.contentSummary,
    },
    rawPayload,
  });
}

async function handleWhatsAppMessage(runtime, summary) {
  if (runtime.processingMessageIds.has(summary.messageId)) return;
  if (await wasMessageHandled(runtime, summary.messageId)) return;

  runtime.processingMessageIds.add(summary.messageId);
  try {
    if (!isProcessableMessage(summary)) {
      await markMessageHandled(runtime, summary.messageId, {
        status: 'silent_no_reply',
        reason: 'unsupported_message_type',
        messageType: summary.messageType,
        contentSummary: summary.contentSummary,
      });
      return;
    }

    const generated = await generateRemoteLabReply(runtime, summary);
    const finalReply = decideConnectorUserVisibleReply({
      replyText: generated.replyText,
      duplicate: generated.duplicate,
      silentConfirmationText: runtime.config.silentConfirmationText,
    });

    if (finalReply.action === 'silent') {
      await markMessageHandled(runtime, summary.messageId, {
        status: finalReply.status,
        reason: finalReply.reason,
        sessionId: generated.sessionId,
        runId: generated.runId,
        requestId: generated.requestId,
        responseId: generated.responseId,
        duplicate: generated.duplicate === true,
      });
      return;
    }

    const response = await sendWhatsAppText(runtime, summary, finalReply.text);
    await markMessageHandled(runtime, summary.messageId, {
      status: finalReply.status,
      reason: finalReply.reason,
      sessionId: generated.sessionId,
      runId: generated.runId,
      requestId: generated.requestId,
      responseId: generated.responseId,
      duplicate: generated.duplicate === true,
      responseMessageId: trimString(response?.messages?.[0]?.id),
      repliedAt: nowIso(),
    });
  } catch (error) {
    runtime.lastError = trimString(error?.message || String(error));
    try {
      const failureCategory = classifyConnectorFailureReason(runtime.lastError);
      const fallbackText = buildConnectorFailureReply(summary, runtime.lastError);
      const response = await sendWhatsAppText(runtime, summary, fallbackText);
      await markMessageHandled(runtime, summary.messageId, {
        status: 'failed_with_notice',
        error: runtime.lastError,
        failureCategory,
        responseMessageId: trimString(response?.messages?.[0]?.id),
        repliedAt: nowIso(),
      });
    } catch (sendError) {
      runtime.lastError = trimString(sendError?.message || runtime.lastError);
    }
  } finally {
    runtime.processingMessageIds.delete(summary.messageId);
  }
}

function enqueueConversationWork(runtime, summary) {
  const key = buildConversationKey(summary);
  const previous = runtime.conversationQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await handleWhatsAppMessage(runtime, summary);
    });
  runtime.conversationQueues.set(key, next);
  next.finally(() => {
    if (runtime.conversationQueues.get(key) === next) {
      runtime.conversationQueues.delete(key);
    }
  }).catch(() => {});
  return next;
}

export async function handleWebhookPayload(runtime, payload) {
  const summaries = collectWebhookMessages(payload);
  for (const summary of summaries) {
    runtime.stats.inboundMessages += 1;
    await recordInboundEvent(runtime, summary, payload);
    enqueueConversationWork(runtime, summary);
  }
  return summaries;
}

async function readRequestBody(req, limitBytes = DEFAULT_WEBHOOK_BODY_LIMIT_BYTES) {
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        const error = new Error('Request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  return Buffer.concat(chunks);
}

function renderConnectorPageHtml({
  nonce = '',
  statusPath = STATUS_PATH,
  configPath = CONFIG_PATH,
} = {}) {
  const statusPathJson = JSON.stringify(statusPath);
  const configPathJson = JSON.stringify(configPath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>RemoteLab - WhatsApp Business</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --page: #f3efe7;
      --card: rgba(255,255,255,0.92);
      --line: rgba(38, 41, 49, 0.10);
      --text: #1f2a23;
      --muted: #65746c;
      --accent: #117a45;
      --accent-soft: rgba(17, 122, 69, 0.10);
      --warn: #9c5b12;
      --warn-soft: rgba(156, 91, 18, 0.12);
      --shadow: 0 20px 50px rgba(22, 25, 31, 0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      padding: 18px;
      background:
        radial-gradient(circle at top right, rgba(17, 122, 69, 0.11), transparent 24%),
        radial-gradient(circle at bottom left, rgba(8, 98, 116, 0.10), transparent 28%),
        var(--page);
      color: var(--text);
      font-family: "SF Pro Text", "Segoe UI", sans-serif;
    }
    .shell {
      width: min(100%, 760px);
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .eyebrow {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    h1 {
      margin: 12px 0 8px;
      font-size: 32px;
      line-height: 1.04;
      letter-spacing: -0.04em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      background: var(--warn-soft);
      color: var(--warn);
    }
    .status-pill.ready {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 16px;
    }
    .meta {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px;
      background: rgba(255,255,255,0.45);
    }
    .meta label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .meta code {
      display: block;
      word-break: break-all;
      white-space: pre-wrap;
      font-size: 13px;
    }
    .quick-links {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .quick-links a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 9px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      background: rgba(255,255,255,0.6);
    }
    .callout {
      display: grid;
      gap: 8px;
      margin-top: 16px;
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.52);
    }
    form {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .field {
      display: grid;
      gap: 6px;
    }
    .field-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .field label {
      font-size: 13px;
      color: var(--muted);
    }
    .tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .tag.required {
      background: rgba(162, 39, 39, 0.10);
      color: #8a2525;
    }
    .tag.recommended {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .tag.optional {
      background: rgba(8, 98, 116, 0.10);
      color: #0a6274;
    }
    .tag.advanced {
      background: rgba(31, 42, 35, 0.08);
      color: var(--text);
    }
    .field input, .field select, .field textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 11px 12px;
      font: inherit;
      color: var(--text);
      background: rgba(255,255,255,0.72);
    }
    .field textarea {
      min-height: 84px;
      resize: vertical;
    }
    .field-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 2px;
    }
    .inline-button {
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 700;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: var(--accent);
      color: white;
    }
    button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--line);
    }
    button[disabled] {
      opacity: 0.65;
      cursor: wait;
    }
    .hint {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
    }
    .flash {
      min-height: 20px;
      font-size: 13px;
      color: var(--muted);
    }
    .flash.error {
      color: #a22727;
    }
    .notice {
      display: grid;
      gap: 8px;
      margin-top: 8px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255,255,255,0.5);
    }
    .notice strong {
      font-size: 13px;
    }
    .notice ul {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="card">
      <div class="eyebrow">Internal Bind</div>
      <h1>WhatsApp Business</h1>
      <p>This page is only for the internal platform-side bind. Keep the heavy Meta setup here, and keep later user-facing onboarding minimal.</p>
      <div id="statusPill" class="status-pill">Loading status...</div>
      <div class="grid">
        <div class="meta">
          <label>Webhook URL</label>
          <code id="webhookUrl">Loading...</code>
        </div>
        <div class="meta">
          <label>Phone Number ID</label>
          <code id="phoneNumberState">Not configured</code>
        </div>
        <div class="meta">
          <label>Security</label>
          <code id="securityState">Waiting for access token and app secret</code>
        </div>
      </div>
      <div class="quick-links">
        <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Open Meta App Dashboard</a>
        <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noreferrer">Open WhatsApp Manager</a>
      </div>
      <div class="callout">
        <strong>Prepare only these values</strong>
        <p><code>access token</code>, <code>phone number ID</code>, <code>verify token</code>, and ideally <code>app secret</code>. <code>WABA ID</code> stays optional.</p>
        <p><code>access token</code> and <code>phone number ID</code> come from <code>Meta App Dashboard &gt; WhatsApp &gt; Quickstart / API Setup</code>. <code>app secret</code> comes from <code>Settings &gt; Basic</code>. <code>verify token</code> is a random string you choose here and paste back into Meta webhook verification.</p>
      </div>
    </section>

    <section class="card">
      <div class="eyebrow">Minimal Mode</div>
      <h2>Internal binding form</h2>
      <p>This page only keeps the small set of fields needed to connect one WhatsApp Business number. Advanced runtime settings stay on backend defaults.</p>
      <div class="notice">
        <strong>Required now</strong>
        <ul>
          <li><code>verify token</code>, <code>phone number ID</code>, and <code>access token</code> are required.</li>
          <li><code>app secret</code> is recommended so webhook POST signatures can be verified.</li>
          <li><code>WABA ID</code> is optional and can stay blank in the first pass.</li>
        </ul>
      </div>
      <form id="configForm">
        <div class="form-grid">
          <div class="field">
            <div class="field-head">
              <label for="verifyToken">Verify token</label>
              <span class="tag required">Required</span>
            </div>
            <input id="verifyToken" name="verifyToken" autocomplete="off" />
            <div class="field-actions">
              <button id="generateVerifyTokenBtn" type="button" class="secondary inline-button">Generate token</button>
            </div>
            <div class="hint">You choose this value yourself. Meta does not issue it. Paste the exact same string into the Meta webhook verification form.</div>
          </div>
          <div class="field">
            <div class="field-head">
              <label for="phoneNumberId">Phone number ID</label>
              <span class="tag required">Required</span>
            </div>
            <input id="phoneNumberId" name="phoneNumberId" autocomplete="off" />
            <div class="hint">Get this from <code>Meta App Dashboard &gt; WhatsApp &gt; Quickstart or API Setup</code>, or from the phone number details in WhatsApp Manager.</div>
          </div>
          <div class="field">
            <div class="field-head">
              <label for="accessToken">Access token</label>
              <span class="tag required">Required</span>
            </div>
            <textarea id="accessToken" name="accessToken" placeholder="Leave blank to keep the current token"></textarea>
            <div class="hint">For testing, copy the temporary token from <code>Meta App Dashboard &gt; WhatsApp &gt; Quickstart or API Setup</code>. For production, use a system-user token with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.</div>
          </div>
          <div class="field">
            <div class="field-head">
              <label for="appSecret">App secret</label>
              <span class="tag recommended">Recommended</span>
            </div>
            <textarea id="appSecret" name="appSecret" placeholder="Leave blank to keep the current app secret"></textarea>
            <div class="hint">Find this in <code>Meta App Dashboard &gt; Settings &gt; Basic</code>. It lets RemoteLab verify the <code>X-Hub-Signature-256</code> header on webhook POSTs.</div>
          </div>
          <div class="field">
            <div class="field-head">
              <label for="wabaId">WABA ID</label>
              <span class="tag optional">Optional</span>
            </div>
            <input id="wabaId" name="wabaId" autocomplete="off" />
            <div class="hint">You can find it in WhatsApp account details in the App Dashboard or WhatsApp Manager. Leave it blank for the first pass if you want.</div>
          </div>
        </div>
        <div class="hint">Blank secret fields keep the currently saved value. This page does not provide secret-clearing controls.</div>
        <div class="actions">
          <button id="saveBtn" type="submit">Save configuration</button>
          <button id="refreshBtn" type="button" class="secondary">Refresh status</button>
        </div>
        <div id="flash" class="flash"></div>
      </form>
    </section>
  </div>

  <script nonce="${nonce}">
    const endpoints = {
      status: ${statusPathJson},
      config: ${configPathJson},
    };

    const els = {
      statusPill: document.getElementById('statusPill'),
      webhookUrl: document.getElementById('webhookUrl'),
      phoneNumberState: document.getElementById('phoneNumberState'),
      securityState: document.getElementById('securityState'),
      flash: document.getElementById('flash'),
      form: document.getElementById('configForm'),
      saveBtn: document.getElementById('saveBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      verifyToken: document.getElementById('verifyToken'),
      phoneNumberId: document.getElementById('phoneNumberId'),
      wabaId: document.getElementById('wabaId'),
      accessToken: document.getElementById('accessToken'),
      appSecret: document.getElementById('appSecret'),
      generateVerifyTokenBtn: document.getElementById('generateVerifyTokenBtn'),
    };

    function generateVerifyToken() {
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }

    function setFlash(message, isError = false) {
      els.flash.textContent = message || '';
      els.flash.className = isError ? 'flash error' : 'flash';
    }

    async function fetchJson(path, options = {}) {
      const response = await fetch(path, {
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        ...options,
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (!response.ok) {
        throw new Error((json && (json.error || json.message)) || text || 'Request failed');
      }
      return json || {};
    }

    function applyStatus(status) {
      const ready = status?.capabilityState === 'ready';
      els.statusPill.textContent = status?.message || (ready ? 'Ready' : 'Needs action');
      els.statusPill.classList.toggle('ready', ready);
      els.webhookUrl.textContent = status?.webhookUrl || 'Unavailable';
      els.phoneNumberState.textContent = status?.config?.phoneNumberId || 'Not configured';
      els.securityState.textContent = status?.config?.accessTokenConfigured
        ? (status?.config?.appSecretConfigured
          ? 'Access token and app secret are configured'
          : 'Access token configured; app secret still missing')
        : 'Waiting for access token and app secret';

      els.phoneNumberId.value = status?.config?.phoneNumberId || '';
      els.wabaId.value = status?.config?.wabaId || '';
    }

    async function refreshStatus() {
      const status = await fetchJson(endpoints.status);
      applyStatus(status);
      return status;
    }

    els.generateVerifyTokenBtn.addEventListener('click', () => {
      els.verifyToken.value = generateVerifyToken();
      setFlash('Generated a verify token. Save it here, then paste the same value into Meta webhook verification.');
    });

    els.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      els.saveBtn.disabled = true;
      setFlash('Saving…');
      try {
        const payload = {
          verifyToken: els.verifyToken.value.trim(),
          phoneNumberId: els.phoneNumberId.value.trim(),
          wabaId: els.wabaId.value.trim(),
        };
        if (els.accessToken.value.trim()) payload.accessToken = els.accessToken.value.trim();
        if (els.appSecret.value.trim()) payload.appSecret = els.appSecret.value.trim();
        await fetchJson(endpoints.config, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        els.verifyToken.value = '';
        els.accessToken.value = '';
        els.appSecret.value = '';
        setFlash('Configuration saved.');
        await refreshStatus();
      } catch (error) {
        setFlash(error.message || 'Failed to save configuration.', true);
      } finally {
        els.saveBtn.disabled = false;
      }
    });

    els.refreshBtn.addEventListener('click', async () => {
      els.refreshBtn.disabled = true;
      setFlash('Refreshing…');
      try {
        await refreshStatus();
        setFlash('Status refreshed.');
      } catch (error) {
        setFlash(error.message || 'Failed to refresh status.', true);
      } finally {
        els.refreshBtn.disabled = false;
      }
    });

    refreshStatus().catch((error) => {
      setFlash(error.message || 'Failed to load connector status.', true);
    });
  </script>
</body>
</html>`;
}

export async function startWhatsAppBusinessSurfaceServer(runtime) {
  if (runtime?.config?.surface?.enabled === false) return null;
  return startConnectorSurfaceServer({
    connectorId: CONNECTOR_ID,
    title: DEFAULT_SURFACE_TITLE,
    host: runtime.config.surface.host,
    port: runtime.config.surface.port,
    entryPath: runtime.config.surface.entryPath,
    allowEmbed: true,
    publicPaths: [PUBLIC_WEBHOOK_PATH],
    describeSurface: async ({ req, mountPrefix }) => ({
      surfaceType: 'setup',
      description: 'Connect one WhatsApp Business Cloud API number so RemoteLab can receive webhook messages and send plain-text replies.',
      publicPaths: [PUBLIC_WEBHOOK_PATH],
      surface: buildSurfaceStatus(runtime, { req, mountPrefix }),
    }),
    handleRequest: async ({ req, res, url, mountPrefix, nonce, sendJson }) => {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        });
        res.end(renderConnectorPageHtml({
          nonce,
          statusPath: `${mountPrefix}${STATUS_PATH}`,
          configPath: `${mountPrefix}${CONFIG_PATH}`,
          subscribePath: `${mountPrefix}${SUBSCRIBE_PATH}`,
        }));
        return true;
      }

      if (req.method === 'GET' && url.pathname === STATUS_PATH) {
        sendJson(res, 200, buildSurfaceStatus(runtime, { req, mountPrefix }));
        return true;
      }

      if (req.method === 'POST' && url.pathname === CONFIG_PATH) {
        let payload = {};
        try {
          const rawBody = await readRequestBody(req, 256 * 1024);
          payload = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
        } catch (error) {
          sendJson(res, 400, { error: error?.message || 'Invalid request body' });
          return true;
        }
        runtime.config = await saveConfigPatch(runtime.config.configPath, {
          ...(Object.prototype.hasOwnProperty.call(payload, 'verifyToken') ? { verifyToken: trimString(payload.verifyToken) || runtime.config.verifyToken } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'phoneNumberId') ? { phoneNumberId: trimString(payload.phoneNumberId) } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'wabaId') ? { wabaId: trimString(payload.wabaId) } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'graphVersion') ? { graphVersion: trimString(payload.graphVersion) || DEFAULT_GRAPH_VERSION } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'accessToken') && trimString(payload.accessToken) ? { accessToken: trimString(payload.accessToken) } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'appSecret') && trimString(payload.appSecret) ? { appSecret: trimString(payload.appSecret) } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'sessionFolder') ? { sessionFolder: resolvePath(payload.sessionFolder, homedir()) } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'sessionTool') ? { sessionTool: trimString(payload.sessionTool) || DEFAULT_SESSION_TOOL } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'runtimeSelectionMode')
            ? { runtimeSelectionMode: normalizeExternalRuntimeSelectionMode(payload.runtimeSelectionMode, DEFAULT_RUNTIME_SELECTION_MODE) }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'sourceName') ? { sourceName: trimString(payload.sourceName) || DEFAULT_SOURCE_NAME } : {}),
          ...(Object.prototype.hasOwnProperty.call(payload, 'group') ? { group: trimString(payload.group) || DEFAULT_GROUP } : {}),
        });
        sendJson(res, 200, {
          saved: true,
          status: buildSurfaceStatus(runtime, { req, mountPrefix }),
        });
        return true;
      }

      if (req.method === 'POST' && url.pathname === SUBSCRIBE_PATH) {
        try {
          const result = await subscribeAppToWaba(runtime);
          sendJson(res, 200, {
            subscribed: true,
            result,
          });
        } catch (error) {
          sendJson(res, 400, { error: error?.message || 'Failed to subscribe the app to the WABA' });
        }
        return true;
      }

      if (req.method === 'GET' && url.pathname === PUBLIC_WEBHOOK_PATH) {
        const mode = trimString(url.searchParams.get('hub.mode'));
        const challenge = trimString(url.searchParams.get('hub.challenge'));
        const verifyToken = trimString(url.searchParams.get('hub.verify_token'));
        if (mode === 'subscribe' && challenge && verifyToken && verifyToken === trimString(runtime.config.verifyToken)) {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(challenge);
          return true;
        }
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Webhook verification failed' }));
        return true;
      }

      if (req.method === 'POST' && url.pathname === PUBLIC_WEBHOOK_PATH) {
        runtime.stats.webhookCalls += 1;
        const missing = runtimeMissingSetup(runtime).filter((item) => item !== 'verify token');
        if (missing.length > 0) {
          sendJson(res, 503, { error: `Connector is not ready: missing ${missing.join(', ')}` });
          return true;
        }

        let rawBody;
        try {
          rawBody = await readRequestBody(req);
        } catch (error) {
          sendJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
            error: error?.message || 'Invalid request body',
          });
          return true;
        }

        const signature = firstNonEmpty(
          req.headers?.['x-hub-signature-256'],
          Array.isArray(req.headers?.['x-hub-signature-256']) ? req.headers['x-hub-signature-256'][0] : '',
        );
        if (!verifyWebhookSignature(rawBody, signature, runtime.config.appSecret)) {
          sendJson(res, 401, { error: 'Webhook signature verification failed' });
          return true;
        }

        let payload;
        try {
          payload = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { error: 'Invalid webhook JSON payload' });
          return true;
        }

        const summaries = await handleWebhookPayload(runtime, payload);
        sendJson(res, 200, {
          received: true,
          queued: summaries.length,
        });
        return true;
      }

      return false;
    },
  });
}

function parseArgs(argv) {
  const options = {
    action: 'run',
    configPath: DEFAULT_CONFIG_PATH,
    to: '',
    text: '',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'status') {
      options.action = 'status';
      continue;
    }
    if (arg === 'send') {
      options.action = 'send';
      continue;
    }
    if (arg === '--config') {
      options.configPath = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--to') {
      options.to = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--text') {
      options.text = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0);
    }
    printUsage(1);
  }

  return options;
}

function printUsage(exitCode = 0) {
  const message = `Usage:
  node scripts/whatsapp-business-connector.mjs [--config <path>]
  node scripts/whatsapp-business-connector.mjs status [--config <path>] [--json]
  node scripts/whatsapp-business-connector.mjs send --to <wa_id> --text <text> [--config <path>] [--json]
`;
  if (exitCode === 0) {
    console.log(message.trim());
  } else {
    console.error(message.trim());
  }
  process.exit(exitCode);
}

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1] || '').href;
}

async function runStatus(options) {
  const config = await loadConfig(options.configPath);
  const runtime = await createRuntimeContext(config);
  const status = buildSurfaceStatus(runtime);
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`connector: ${CONNECTOR_ID}`);
  console.log(`status: ${status.status}`);
  console.log(`message: ${status.message}`);
  console.log(`webhook: ${status.webhookUrl}`);
  console.log(`access token: ${status.config.accessTokenConfigured ? status.config.maskedAccessToken || 'configured' : 'missing'}`);
  console.log(`app secret: ${status.config.appSecretConfigured ? status.config.maskedAppSecret || 'configured' : 'missing'}`);
  console.log(`phone number id: ${status.config.phoneNumberId || '(missing)'}`);
  console.log(`waba id: ${status.config.wabaId || '(optional)'}`);
}

async function runSend(options) {
  const config = await loadConfig(options.configPath);
  const runtime = await createRuntimeContext(config);
  const response = await sendWhatsAppText(runtime, {
    phoneNumberId: config.phoneNumberId,
    to: options.to,
  }, options.text);
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  console.log(`sent to ${options.to}`);
  console.log(`message id: ${trimString(response?.messages?.[0]?.id) || '(unknown)'}`);
}

async function runConnector(options) {
  const config = await loadConfig(options.configPath);
  const runtime = await createRuntimeContext(config);
  const surfaceServer = await startWhatsAppBusinessSurfaceServer(runtime);
  if (!surfaceServer?.baseUrl) {
    throw new Error('WhatsApp Business surface is disabled');
  }
  console.log(`[whatsapp-business-connector] surface ready at ${surfaceServer.baseUrl}${runtime.config.surface.entryPath}`);
  if (normalizeBaseUrl(PUBLIC_BASE_URL)) {
    console.log(`[whatsapp-business-connector] public webhook ${normalizeBaseUrl(PUBLIC_BASE_URL)}/connectors/${CONNECTOR_ID}${PUBLIC_WEBHOOK_PATH}`);
  }

  const shutdown = async (signal) => {
    console.log(`[whatsapp-business-connector] stopping (${signal})`);
    await surfaceServer.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'status') {
    await runStatus(options);
    return;
  }
  if (options.action === 'send') {
    if (!trimString(options.to) || !trimString(options.text)) {
      throw new Error('send requires --to and --text');
    }
    await runSend(options);
    return;
  }
  await runConnector(options);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[whatsapp-business-connector] fatal error:', error?.stack || error);
    process.exitCode = 1;
  });
}

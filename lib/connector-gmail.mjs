import { userInfo } from 'os';
import { join } from 'path';

import { CONFIG_DIR } from './config.mjs';
import { resolveGmailConnectorBinding } from './connector-bindings.mjs';
import { pathExists, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const GMAIL_CONNECTOR_DIR = join(CONFIG_DIR, 'gmail-connector');
export const GOOGLE_GMAIL_CREDENTIALS_PATH = join(GMAIL_CONNECTOR_DIR, 'google-oauth-client.json');
export const GOOGLE_GMAIL_TOKEN_PATH = join(GMAIL_CONNECTOR_DIR, 'google-gmail-token.json');
export const GOOGLE_GMAIL_AUTH_STATE_PATH = join(GMAIL_CONNECTOR_DIR, 'google-gmail-auth-state.json');
export const GMAIL_OAUTH_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
export const DEFAULT_GMAIL_BINDING_ID = 'binding_gmail_default';
const GOOGLE_CALENDAR_FALLBACK_CREDENTIALS_PATH = join(CONFIG_DIR, 'calendar-connector', 'google-oauth-client.json');
const GMAIL_API_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ENV_GMAIL_OAUTH_CLIENT_PATH = 'REMOTELAB_GMAIL_OAUTH_CLIENT_PATH';
const ENV_GOOGLE_OAUTH_CLIENT_PATH = 'REMOTELAB_GOOGLE_OAUTH_CLIENT_PATH';
const ENV_GMAIL_OAUTH_CLIENT_JSON = 'REMOTELAB_GMAIL_OAUTH_CLIENT_JSON';
const ENV_GOOGLE_OAUTH_CLIENT_JSON = 'REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON';
const ENV_SHARED_CONFIG_DIR = 'REMOTELAB_SHARED_CONFIG_DIR';
const ENV_OWNER_INSTANCE_ROOT = 'REMOTELAB_OWNER_INSTANCE_ROOT';
const ENV_SYSTEM_HOME = 'REMOTELAB_SYSTEM_HOME';

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

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => trimString(value)).filter(Boolean))];
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => trimString(entry)).filter(Boolean);
  }
  const single = trimString(value);
  return single ? [single] : [];
}

function normalizeLabelInput(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => trimString(value)).filter(Boolean))];
}

function resolveHomeRelativePathForHome(value, homeDir = '') {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalizedHome = trimString(homeDir);
  if (trimmed === '~') return normalizedHome;
  if (trimmed.startsWith('~/')) return join(normalizedHome, trimmed.slice(2));
  return trimmed;
}

function resolveHomeRelativePath(value) {
  return resolveHomeRelativePathForHome(value, trimString(process.env.HOME));
}

function resolveSystemHomeDir() {
  return firstNonEmpty(
    process.env[ENV_SYSTEM_HOME],
    userInfo().homedir,
    process.env.HOME,
  );
}

function resolveSharedConfigDir() {
  const systemHome = resolveSystemHomeDir();
  return resolveHomeRelativePathForHome(process.env[ENV_SHARED_CONFIG_DIR], systemHome)
    || join(systemHome, '.config', 'remotelab');
}

function resolveOwnerInstanceRoot() {
  const systemHome = resolveSystemHomeDir();
  return resolveHomeRelativePathForHome(process.env[ENV_OWNER_INSTANCE_ROOT], systemHome)
    || join(systemHome, '.remotelab', 'instances', 'owner');
}

async function loadGoogleAuthLibrary() {
  const { OAuth2Client } = await import('google-auth-library');
  return { OAuth2Client };
}

async function readRequiredJson(pathname, label) {
  const value = await readJson(pathname, null);
  if (!value) {
    throw new Error(`Missing ${label}: ${pathname}`);
  }
  return value;
}

async function persistMergedToken(tokenPath, nextCredentials = {}, incomingTokens = {}) {
  const existing = await readJson(tokenPath, {});
  const merged = {
    ...(existing || {}),
    ...(nextCredentials || {}),
    ...(incomingTokens || {}),
  };
  if (Object.keys(merged).length === 0) return;
  await writeJsonAtomic(tokenPath, merged);
}

function parseGoogleOAuthConfig(credentials = {}) {
  const config = credentials.installed || credentials.web || credentials;
  if (!trimString(config?.client_id) || !trimString(config?.client_secret)) {
    throw new Error('OAuth client credentials are missing client_id or client_secret.');
  }
  return config;
}

export async function resolveGmailCredentialsPath(preferredPath = '') {
  const explicit = trimString(preferredPath);
  if (explicit) return explicit;
  const sharedConfigDir = resolveSharedConfigDir();
  const sharedCredentialsPath = join(sharedConfigDir, 'gmail-connector', 'google-oauth-client.json');
  const sharedCalendarFallbackCredentialsPath = join(sharedConfigDir, 'calendar-connector', 'google-oauth-client.json');
  const ownerInstanceRoot = resolveOwnerInstanceRoot();
  const ownerInstanceCredentialsPath = join(ownerInstanceRoot, 'config', 'gmail-connector', 'google-oauth-client.json');
  const ownerInstanceCalendarFallbackCredentialsPath = join(ownerInstanceRoot, 'config', 'calendar-connector', 'google-oauth-client.json');
  const configuredPath = resolveHomeRelativePath(firstNonEmpty(
    process.env[ENV_GMAIL_OAUTH_CLIENT_PATH],
    process.env[ENV_GOOGLE_OAUTH_CLIENT_PATH],
  ));
  if (configuredPath) {
    if (await pathExists(configuredPath)) return configuredPath;
    return configuredPath;
  }
  const configuredJson = firstNonEmpty(
    process.env[ENV_GMAIL_OAUTH_CLIENT_JSON],
    process.env[ENV_GOOGLE_OAUTH_CLIENT_JSON],
  );
  if (configuredJson) {
    const parsed = JSON.parse(configuredJson);
    parseGoogleOAuthConfig(parsed);
    await writeJsonAtomic(sharedCredentialsPath, parsed);
    return sharedCredentialsPath;
  }
  if (await pathExists(sharedCredentialsPath)) return sharedCredentialsPath;
  if (await pathExists(ownerInstanceCredentialsPath)) return ownerInstanceCredentialsPath;
  if (await pathExists(GOOGLE_GMAIL_CREDENTIALS_PATH)) return GOOGLE_GMAIL_CREDENTIALS_PATH;
  if (await pathExists(sharedCalendarFallbackCredentialsPath)) return sharedCalendarFallbackCredentialsPath;
  if (await pathExists(ownerInstanceCalendarFallbackCredentialsPath)) return ownerInstanceCalendarFallbackCredentialsPath;
  if (await pathExists(GOOGLE_CALENDAR_FALLBACK_CREDENTIALS_PATH)) return GOOGLE_CALENDAR_FALLBACK_CREDENTIALS_PATH;
  return sharedCredentialsPath;
}

export async function gmailCredentialsPresent(preferredPath = '') {
  return await pathExists(await resolveGmailCredentialsPath(preferredPath));
}

async function buildAuthenticatedClient(binding, credentialsPath = '') {
  const tokenPath = trimString(binding?.tokenPath);
  if (!tokenPath) {
    throw new Error('Gmail binding has no token path. Authorization is required.');
  }

  const resolvedCredentialsPath = await resolveGmailCredentialsPath(credentialsPath);
  const credentials = await readRequiredJson(resolvedCredentialsPath, 'Google OAuth client credentials');
  const token = await readRequiredJson(tokenPath, 'Gmail token file');
  const config = parseGoogleOAuthConfig(credentials);
  const redirectUri = Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : config.redirect_uri;
  const { OAuth2Client } = await loadGoogleAuthLibrary();
  const client = new OAuth2Client(config.client_id, config.client_secret, redirectUri);
  client.setCredentials(token);
  client.on('tokens', (tokens) => {
    void persistMergedToken(tokenPath, client.credentials, tokens);
  });
  await client.getAccessToken();
  await persistMergedToken(tokenPath, client.credentials, {});
  return client;
}

function buildApiUrl(pathname, params = {}) {
  const url = new URL(`${GMAIL_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === undefined || entry === null || entry === '') continue;
        url.searchParams.append(key, String(entry));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function parseJsonMaybe(text) {
  const trimmed = trimString(text);
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractAccessToken(value) {
  if (typeof value === 'string') return trimString(value);
  if (value && typeof value === 'object') {
    return trimString(value.token || value.access_token || '');
  }
  return '';
}

async function resolveAuthorizedRequestHeaders(client, requestUrl = '') {
  const rawHeaders = await client.getRequestHeaders(trimString(requestUrl) || undefined);
  const requestHeaders = {
    Accept: 'application/json',
    ...(rawHeaders || {}),
  };
  if (!trimString(requestHeaders.Authorization || requestHeaders.authorization)) {
    const accessToken = extractAccessToken(await client.getAccessToken());
    if (accessToken) {
      requestHeaders.Authorization = `Bearer ${accessToken}`;
    }
  }
  return requestHeaders;
}

async function gmailApiRequest(client, pathname, { method = 'GET', body = null, params = null } = {}) {
  const requestUrl = buildApiUrl(pathname, params).toString();
  const requestHeaders = await resolveAuthorizedRequestHeaders(client, requestUrl);
  let requestBody = undefined;
  if (body !== null && body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(requestUrl, {
    method,
    headers: requestHeaders,
    ...(requestBody ? { body: requestBody } : {}),
  });
  const rawText = await response.text();
  const parsed = parseJsonMaybe(rawText);
  if (!response.ok) {
    const message = firstNonEmpty(parsed?.error?.message, parsed?.error_description, rawText, 'Unknown Gmail API error');
    const error = new Error(`Gmail API ${method} ${pathname} failed (${response.status}): ${message}`);
    error.statusCode = response.status;
    error.response = parsed || rawText;
    throw error;
  }
  return parsed || {};
}

function decodeBase64Url(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function stripHtml(value) {
  return trimString(
    String(value || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n'),
  );
}

function headerValue(headers = [], name) {
  const normalizedName = trimString(name).toLowerCase();
  if (!normalizedName) return '';
  const matched = (headers || []).find((header) => trimString(header?.name).toLowerCase() === normalizedName);
  return trimString(matched?.value);
}

function normalizeAttachment(part = {}) {
  const filename = trimString(part?.filename);
  const attachmentId = trimString(part?.body?.attachmentId);
  if (!filename && !attachmentId) return null;
  return {
    filename,
    mimeType: trimString(part?.mimeType) || 'application/octet-stream',
    attachmentId,
    size: Number.isFinite(part?.body?.size) ? Number(part.body.size) : 0,
  };
}

function collectPayloadBodies(part, state) {
  if (!part || typeof part !== 'object') return;
  const mimeType = trimString(part.mimeType).toLowerCase();
  const bodyData = trimString(part?.body?.data);
  const attachment = normalizeAttachment(part);
  if (attachment) state.attachments.push(attachment);
  if (bodyData) {
    const decoded = decodeBase64Url(bodyData);
    if (mimeType === 'text/plain') {
      state.textParts.push(decoded);
    } else if (mimeType === 'text/html') {
      state.htmlParts.push(decoded);
    }
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    collectPayloadBodies(child, state);
  }
}

function normalizeGmailMessageResource(message = {}) {
  const state = {
    textParts: [],
    htmlParts: [],
    attachments: [],
  };
  collectPayloadBodies(message.payload, state);
  const html = state.htmlParts.join('\n').trim();
  const text = firstNonEmpty(state.textParts.join('\n').trim(), stripHtml(html));
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  return {
    id: trimString(message.id),
    threadId: trimString(message.threadId),
    historyId: trimString(message.historyId),
    internalDate: trimString(message.internalDate),
    snippet: trimString(message.snippet),
    labelIds: normalizeStringArray(message.labelIds || []),
    subject: headerValue(headers, 'Subject'),
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    bcc: headerValue(headers, 'Bcc'),
    replyTo: headerValue(headers, 'Reply-To'),
    date: headerValue(headers, 'Date'),
    messageIdHeader: headerValue(headers, 'Message-ID'),
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References'),
    text,
    html,
    attachments: state.attachments,
    headers,
  };
}

function normalizeGmailThreadResource(thread = {}) {
  const messages = Array.isArray(thread.messages)
    ? thread.messages.map((message) => normalizeGmailMessageResource(message))
    : [];
  const latestMessage = messages[messages.length - 1] || null;
  return {
    id: trimString(thread.id),
    historyId: trimString(thread.historyId),
    snippet: trimString(thread.snippet),
    messages,
    latestMessage,
    subject: latestMessage?.subject || '',
    from: latestMessage?.from || '',
    date: latestMessage?.date || '',
  };
}

function normalizeIdCandidates(rawId = '') {
  const raw = trimString(rawId).replace(/^#+/, '');
  if (!raw) return [];
  const candidates = [raw.toLowerCase()];
  if (/^\d+$/.test(raw)) {
    try {
      candidates.push(BigInt(raw).toString(16));
    } catch {}
  }
  return [...new Set(candidates.map((value) => trimString(value).toLowerCase()).filter(Boolean))];
}

function extractUrlReferenceToken(value) {
  const decoded = decodeURIComponent(trimString(value));
  const normalized = decoded.replace(/^#+/, '');
  const match = normalized.match(/(?:^|[#/?&])(thread-f|msg-f):([0-9a-z]+)/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() === 'thread-f' ? 'thread' : 'message',
    rawId: trimString(match[2]).toLowerCase(),
    candidates: normalizeIdCandidates(match[2]),
  };
}

export function parseGmailWebUrl(urlValue = '') {
  const rawUrl = trimString(urlValue);
  if (!rawUrl) {
    throw new Error('Gmail URL is required.');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid Gmail URL.');
  }
  if (!/^mail\.google\.com$/i.test(url.hostname)) {
    throw new Error('Only mail.google.com URLs are supported.');
  }
  const candidates = [
    url.searchParams.get('permmsgid'),
    url.searchParams.get('th'),
    url.hash,
  ].map((value) => extractUrlReferenceToken(value)).filter(Boolean);
  if (candidates.length === 0) {
    throw new Error('This Gmail URL format is not supported yet.');
  }
  return candidates[0];
}

async function getReadyGmailBinding({ bindingId = '', credentialsPath = '' } = {}) {
  const binding = await resolveGmailConnectorBinding({ bindingId });
  if (!binding) {
    throw new Error('Gmail is not connected for this workspace yet.');
  }
  if (binding.capabilityState !== 'ready') {
    if (binding.capabilityState === 'authorization_required') {
      throw new Error('Gmail is configured but still needs authorization.');
    }
    throw new Error('Gmail is not ready for use in this workspace yet.');
  }
  const resolvedCredentialsPath = await resolveGmailCredentialsPath(credentialsPath);
  return {
    binding,
    credentialsPath: resolvedCredentialsPath,
  };
}

async function tryMessageCandidates(client, candidates = []) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const message = await gmailApiRequest(client, `/messages/${encodeURIComponent(candidate)}`, {
        params: { format: 'full' },
      });
      return normalizeGmailMessageResource(message);
    } catch (error) {
      lastError = error;
      if (error?.statusCode !== 404) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('Gmail message was not found.');
}

async function tryThreadCandidates(client, candidates = []) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const thread = await gmailApiRequest(client, `/threads/${encodeURIComponent(candidate)}`, {
        params: { format: 'full' },
      });
      return normalizeGmailThreadResource(thread);
    } catch (error) {
      lastError = error;
      if (error?.statusCode !== 404) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error('Gmail thread was not found.');
}

async function getThreadForResource(client, { threadId = '', messageId = '', url = '' } = {}) {
  if (trimString(threadId)) {
    return await tryThreadCandidates(client, normalizeIdCandidates(threadId));
  }
  if (trimString(messageId)) {
    const message = await tryMessageCandidates(client, normalizeIdCandidates(messageId));
    return await tryThreadCandidates(client, normalizeIdCandidates(message.threadId));
  }
  if (trimString(url)) {
    const reference = parseGmailWebUrl(url);
    if (reference.kind === 'thread') {
      return await tryThreadCandidates(client, reference.candidates);
    }
    const message = await tryMessageCandidates(client, reference.candidates);
    return await tryThreadCandidates(client, normalizeIdCandidates(message.threadId));
  }
  throw new Error('Thread, message, or Gmail URL is required.');
}

async function getMessageForResource(client, { messageId = '', threadId = '', url = '' } = {}) {
  if (trimString(messageId)) {
    return await tryMessageCandidates(client, normalizeIdCandidates(messageId));
  }
  if (trimString(url)) {
    const reference = parseGmailWebUrl(url);
    if (reference.kind === 'message') {
      return await tryMessageCandidates(client, reference.candidates);
    }
    const thread = await tryThreadCandidates(client, reference.candidates);
    return thread.latestMessage || null;
  }
  if (trimString(threadId)) {
    const thread = await tryThreadCandidates(client, normalizeIdCandidates(threadId));
    return thread.latestMessage || null;
  }
  throw new Error('Message, thread, or Gmail URL is required.');
}

function buildMimeMessage({
  from = '',
  to = [],
  cc = [],
  bcc = [],
  subject = '',
  text = '',
  inReplyTo = '',
  references = '',
} = {}) {
  const headers = [
    `From: ${trimString(from)}`,
    `To: ${normalizeRecipients(to).join(', ')}`,
    normalizeRecipients(cc).length ? `Cc: ${normalizeRecipients(cc).join(', ')}` : '',
    normalizeRecipients(bcc).length ? `Bcc: ${normalizeRecipients(bcc).join(', ')}` : '',
    `Subject: ${trimString(subject)}`,
    trimString(inReplyTo) ? `In-Reply-To: ${trimString(inReplyTo)}` : '',
    trimString(references) ? `References: ${trimString(references)}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  const body = String(text || '').replace(/\r\n/g, '\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function replySubject(subject = '') {
  const normalized = trimString(subject);
  if (!normalized) return 'Re:';
  if (/^re\s*:/i.test(normalized)) return normalized;
  return `Re: ${normalized}`;
}

function replyReferences(message = {}) {
  const values = [
    trimString(message.references),
    trimString(message.messageIdHeader),
  ].filter(Boolean);
  return values.join(' ').trim();
}

async function resolveLabelIds(client, labels = []) {
  const requested = normalizeLabelInput(labels);
  if (requested.length === 0) return [];
  const labelResponse = await gmailApiRequest(client, '/labels');
  const entries = Array.isArray(labelResponse.labels) ? labelResponse.labels : [];
  const byName = new Map();
  for (const label of entries) {
    const name = trimString(label?.name);
    const id = trimString(label?.id);
    if (!name || !id) continue;
    byName.set(name.toLowerCase(), id);
    byName.set(id.toLowerCase(), id);
  }
  return requested.map((label) => {
    const normalized = label.toLowerCase();
    if (byName.has(normalized)) return byName.get(normalized);
    throw new Error(`Unknown Gmail label: ${label}`);
  });
}

async function sendRawMessage(client, { raw, threadId = '', draft = false } = {}) {
  if (draft) {
    return await gmailApiRequest(client, '/drafts', {
      method: 'POST',
      body: {
        message: {
          raw,
          ...(trimString(threadId) ? { threadId: trimString(threadId) } : {}),
        },
      },
    });
  }
  return await gmailApiRequest(client, '/messages/send', {
    method: 'POST',
    body: {
      raw,
      ...(trimString(threadId) ? { threadId: trimString(threadId) } : {}),
    },
  });
}

export async function generateGmailAuthUrl({ credentialsPath = '', redirectUri = '', state = '', scopes = GMAIL_OAUTH_SCOPES } = {}) {
  const resolvedCredentialsPath = await resolveGmailCredentialsPath(credentialsPath);
  const credentials = await readRequiredJson(resolvedCredentialsPath, 'Google OAuth client credentials');
  const config = parseGoogleOAuthConfig(credentials);
  const { OAuth2Client } = await loadGoogleAuthLibrary();
  const effectiveRedirectUri = trimString(redirectUri) || firstNonEmpty(
    Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : '',
    config.redirect_uri,
  );
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: normalizeStringArray(scopes.length ? scopes : GMAIL_OAUTH_SCOPES),
    ...(trimString(state) ? { state: trimString(state) } : {}),
  });
}

export async function handleGmailAuthCallback({ credentialsPath = '', tokenPath = '', code = '', redirectUri = '' } = {}) {
  const resolvedCredentialsPath = await resolveGmailCredentialsPath(credentialsPath);
  const credentials = await readRequiredJson(resolvedCredentialsPath, 'Google OAuth client credentials');
  const config = parseGoogleOAuthConfig(credentials);
  const { OAuth2Client } = await loadGoogleAuthLibrary();
  const effectiveRedirectUri = trimString(redirectUri) || firstNonEmpty(
    Array.isArray(config.redirect_uris) ? config.redirect_uris[0] : '',
    config.redirect_uri,
  );
  const client = new OAuth2Client(config.client_id, config.client_secret, effectiveRedirectUri);
  const { tokens } = await client.getToken(trimString(code));
  await writeJsonAtomic(trimString(tokenPath), tokens || {});
  return tokens || {};
}

export async function getGmailProfile({ bindingId = '', credentialsPath = '' } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  return await gmailApiRequest(client, '/profile');
}

export async function readGmailResource({ bindingId = '', credentialsPath = '', threadId = '', messageId = '', url = '' } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);

  if (trimString(threadId) || (trimString(url) && parseGmailWebUrl(url).kind === 'thread')) {
    const thread = await getThreadForResource(client, { threadId, messageId, url });
    return {
      bindingId: binding.id,
      accountHint: trimString(binding.accountHint),
      kind: 'thread',
      thread,
    };
  }

  const message = await getMessageForResource(client, { threadId, messageId, url });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    kind: 'message',
    message,
  };
}

export async function searchGmailThreads({ bindingId = '', credentialsPath = '', query = '', maxResults = 10 } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const list = await gmailApiRequest(client, '/threads', {
    params: {
      q: trimString(query),
      maxResults: Math.max(1, Math.min(Number.parseInt(String(maxResults || ''), 10) || 10, 25)),
    },
  });
  const threads = Array.isArray(list.threads) ? list.threads : [];
  const items = [];
  for (const thread of threads) {
    const fullThread = await tryThreadCandidates(client, normalizeIdCandidates(thread.id));
    items.push({
      id: fullThread.id,
      snippet: fullThread.snippet,
      subject: fullThread.subject,
      from: fullThread.from,
      date: fullThread.date,
      messageCount: fullThread.messages.length,
    });
  }
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    query: trimString(query),
    items,
  };
}

export const __testing = {
  buildMimeMessage,
  resolveAuthorizedRequestHeaders,
};

export async function archiveGmailThread({ bindingId = '', credentialsPath = '', threadId = '', messageId = '', url = '' } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const thread = await getThreadForResource(client, { threadId, messageId, url });
  await gmailApiRequest(client, `/threads/${encodeURIComponent(thread.id)}/modify`, {
    method: 'POST',
    body: {
      removeLabelIds: ['INBOX'],
    },
  });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    threadId: thread.id,
    archived: true,
  };
}

export async function markGmailThreadRead({ bindingId = '', credentialsPath = '', threadId = '', messageId = '', url = '', unread = false } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const thread = await getThreadForResource(client, { threadId, messageId, url });
  await gmailApiRequest(client, `/threads/${encodeURIComponent(thread.id)}/modify`, {
    method: 'POST',
    body: unread
      ? { addLabelIds: ['UNREAD'] }
      : { removeLabelIds: ['UNREAD'] },
  });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    threadId: thread.id,
    unread: unread === true,
  };
}

export async function labelGmailThread({ bindingId = '', credentialsPath = '', threadId = '', messageId = '', url = '', addLabels = [], removeLabels = [] } = {}) {
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const thread = await getThreadForResource(client, { threadId, messageId, url });
  const [addLabelIds, removeLabelIds] = await Promise.all([
    resolveLabelIds(client, addLabels),
    resolveLabelIds(client, removeLabels),
  ]);
  await gmailApiRequest(client, `/threads/${encodeURIComponent(thread.id)}/modify`, {
    method: 'POST',
    body: {
      addLabelIds,
      removeLabelIds,
    },
  });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    threadId: thread.id,
    addLabelIds,
    removeLabelIds,
  };
}

export async function sendGmailMessage({
  bindingId = '',
  credentialsPath = '',
  to = [],
  cc = [],
  bcc = [],
  subject = '',
  text = '',
  draft = false,
} = {}) {
  const normalizedTo = normalizeRecipients(to);
  if (normalizedTo.length === 0) {
    throw new Error('At least one recipient is required.');
  }
  if (!trimString(subject)) {
    throw new Error('A subject is required.');
  }
  if (!trimString(text)) {
    throw new Error('A text body is required.');
  }
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const profile = await gmailApiRequest(client, '/profile');
  const raw = encodeBase64Url(buildMimeMessage({
    from: trimString(profile.emailAddress),
    to: normalizedTo,
    cc,
    bcc,
    subject,
    text,
  }));
  const result = await sendRawMessage(client, { raw, draft });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    draft: draft === true,
    id: trimString(result?.id || result?.message?.id),
    threadId: trimString(result?.threadId || result?.message?.threadId),
  };
}

export async function replyToGmailThread({
  bindingId = '',
  credentialsPath = '',
  threadId = '',
  messageId = '',
  url = '',
  text = '',
  draft = false,
} = {}) {
  if (!trimString(text)) {
    throw new Error('A reply body is required.');
  }
  const { binding, credentialsPath: resolvedCredentialsPath } = await getReadyGmailBinding({ bindingId, credentialsPath });
  const client = await buildAuthenticatedClient(binding, resolvedCredentialsPath);
  const profile = await gmailApiRequest(client, '/profile');
  const thread = await getThreadForResource(client, { threadId, messageId, url });
  const latest = thread.latestMessage;
  if (!latest) {
    throw new Error('The target Gmail thread has no readable messages.');
  }
  const raw = encodeBase64Url(buildMimeMessage({
    from: trimString(profile.emailAddress),
    to: [firstNonEmpty(latest.replyTo, latest.from)],
    subject: replySubject(latest.subject),
    text,
    inReplyTo: latest.messageIdHeader,
    references: replyReferences(latest),
  }));
  const result = await sendRawMessage(client, {
    raw,
    threadId: thread.id,
    draft,
  });
  return {
    bindingId: binding.id,
    accountHint: trimString(binding.accountHint),
    draft: draft === true,
    threadId: trimString(result?.threadId || result?.message?.threadId || thread.id),
    id: trimString(result?.id || result?.message?.id),
  };
}

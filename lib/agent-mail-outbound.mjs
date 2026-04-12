import { execFile } from 'child_process';
import { promisify } from 'util';
import { userShellEnv } from './user-shell-env.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_CLOUDFLARE_WORKER_BASE_URL = '';
const DEFAULT_RESEND_API_BASE_URL = 'https://api.resend.com';
const CURL_HTTP_STATUS_MARKER = '__REMOTELAB_CURL_STATUS__';
const FETCH_PROXY_RETRY_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value, fallbackValue = 'resend_api') {
  const normalized = trimString(value).toLowerCase();
  return normalized || fallbackValue;
}

function normalizeWorkerBaseUrl(value) {
  const trimmed = trimString(value);
  if (!trimmed) return DEFAULT_CLOUDFLARE_WORKER_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function normalizeApiBaseUrl(value, fallbackValue = '') {
  const trimmed = trimString(value);
  const resolved = trimmed || fallbackValue;
  return resolved ? resolved.replace(/\/+$/, '') : '';
}

function resolveSecret(config, directKey, envKey) {
  const directValue = trimString(config?.[directKey]);
  if (directValue) return directValue;
  const envName = trimString(config?.[envKey]);
  if (!envName) return '';
  return trimString(process.env[envName]);
}

function configuredAuthMode(config = {}) {
  const provider = normalizeProvider(config.provider);
  if (provider === 'apple_mail') {
    return 'mail_app';
  }
  if (provider === 'cloudflare_worker') {
    return resolveSecret(config, 'workerToken', 'workerTokenEnv') ? 'bearer_token' : 'unconfigured';
  }
  if (provider === 'resend_api') {
    return resolveSecret(config, 'apiKey', 'apiKeyEnv') ? 'api_key' : 'unconfigured';
  }
  return 'unconfigured';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => trimString(entry)).filter(Boolean);
  }
  const single = trimString(value);
  return single ? [single] : [];
}

function parseJsonMaybe(text) {
  if (!trimString(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseMessage(body, fallbackText) {
  if (!body || typeof body !== 'object') return trimString(fallbackText);
  return firstNonEmpty(body.message, body.error, body.detail, fallbackText);
}

function summarizedResponse(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    id: firstNonEmpty(body.id, body.messageId, body.message_id),
    message: firstNonEmpty(body.message, body.status),
  };
}

function normalizeFallbackConfig(config = {}) {
  const fallback = config?.fallback;
  if (!fallback || typeof fallback !== 'object') return null;
  const provider = normalizeProvider(fallback.provider, '');
  if (!provider) return null;
  return {
    provider,
    workerBaseUrl: normalizeWorkerBaseUrl(fallback.workerBaseUrl),
    account: trimString(fallback.account),
    from: trimString(fallback.from),
    workerToken: trimString(fallback.workerToken),
    workerTokenEnv: trimString(fallback.workerTokenEnv),
    apiKey: trimString(fallback.apiKey),
    apiKeyEnv: trimString(fallback.apiKeyEnv),
    apiBaseUrl: normalizeApiBaseUrl(fallback.apiBaseUrl, provider === 'resend_api' ? DEFAULT_RESEND_API_BASE_URL : ''),
    replyTo: trimString(fallback.replyTo),
  };
}

function errorTextCandidates(body, rawText = '') {
  return [
    trimString(rawText),
    trimString(body?.message),
    trimString(body?.error),
    trimString(body?.detail),
    trimString(body?.details?.name),
    trimString(body?.details?.message),
  ].filter(Boolean);
}

function isCloudflareVerifiedDestinationRestriction(statusCode, body, rawText = '') {
  if (!Number.isInteger(statusCode) || statusCode < 400) {
    return false;
  }
  const haystack = errorTextCandidates(body, rawText).join('\n').toLowerCase();
  if (!haystack) {
    return false;
  }
  return haystack.includes('destination address is not a verified address')
    || (haystack.includes('destination address') && haystack.includes('verified address'))
    || (haystack.includes('email routing') && haystack.includes('verified'));
}

function createOutboundError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function normalizeOutboundAttachmentEntry(attachment) {
  if (!(attachment && typeof attachment === 'object')) return null;
  const filename = trimString(attachment.filename);
  const contentBase64 = trimString(attachment.contentBase64);
  if (!filename || !contentBase64) return null;
  return {
    filename,
    contentType: trimString(attachment.contentType) || 'application/octet-stream',
    contentBase64,
    sourcePath: trimString(attachment.sourcePath),
  };
}

function normalizeOutboundAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((attachment) => normalizeOutboundAttachmentEntry(attachment))
    .filter(Boolean);
}

function providerConfigurationState(config = {}) {
  const provider = normalizeProvider(config.provider);

  if (provider === 'apple_mail') {
    return {
      provider,
      configured: true,
      missing: [],
    };
  }

  if (provider === 'resend_api') {
    const apiKeyEnv = trimString(config.apiKeyEnv) || 'RESEND_API_KEY';
    const apiKey = resolveSecret(config, 'apiKey', 'apiKeyEnv');
    const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl, DEFAULT_RESEND_API_BASE_URL);
    const missing = [];
    if (!apiKey) {
      missing.push(`API key (${apiKeyEnv})`);
    }
    if (!apiBaseUrl) {
      missing.push('API base URL');
    }
    return {
      provider,
      configured: missing.length === 0,
      missing,
      apiKeyEnv,
    };
  }

  if (provider === 'cloudflare_worker') {
    const workerTokenEnv = trimString(config.workerTokenEnv) || 'REMOTELAB_CLOUDFLARE_EMAIL_WORKER_TOKEN';
    const workerToken = resolveSecret(config, 'workerToken', 'workerTokenEnv');
    const workerBaseUrl = normalizeWorkerBaseUrl(config.workerBaseUrl);
    const missing = [];
    if (!workerToken) {
      missing.push(`worker token (${workerTokenEnv})`);
    }
    if (!workerBaseUrl) {
      missing.push('worker base URL');
    }
    return {
      provider,
      configured: missing.length === 0,
      missing,
      workerTokenEnv,
    };
  }

  return {
    provider,
    configured: false,
    missing: ['supported provider'],
  };
}

function providerSetupHint(config = {}, state = providerConfigurationState(config)) {
  if (state.provider === 'resend_api') {
    return `Set ${state.apiKeyEnv || 'RESEND_API_KEY'}, or run: remotelab mail outbound configure-resend-api --from <sender> --api-key-env ${state.apiKeyEnv || 'RESEND_API_KEY'}`;
  }
  if (state.provider === 'cloudflare_worker') {
    return `Set ${state.workerTokenEnv || 'REMOTELAB_CLOUDFLARE_EMAIL_WORKER_TOKEN'}, or run: remotelab mail outbound configure-cloudflare-worker --from <sender> --worker-base-url <url>`;
  }
  return '';
}

function providerConfigurationError(config = {}) {
  const state = providerConfigurationState(config);
  if (state.configured) {
    return null;
  }
  const missingText = state.missing.length ? `Missing ${state.missing.join(' and ')}. ` : '';
  const setupHint = providerSetupHint(config, state);

  if (state.provider === 'resend_api') {
    return createOutboundError(`Resend outbound email is not configured. ${missingText}${setupHint}`.trim(), {
      provider: state.provider,
      configurationError: true,
      missing: state.missing,
      setupHint,
    });
  }

  if (state.provider === 'cloudflare_worker') {
    return createOutboundError(`Cloudflare worker outbound email is not configured. ${missingText}${setupHint}`.trim(), {
      provider: state.provider,
      configurationError: true,
      missing: state.missing,
      setupHint,
    });
  }

  return null;
}

function configuredProxyUrl(env = process.env) {
  const effectiveEnv = { ...userShellEnv, ...env };
  return firstNonEmpty(
    effectiveEnv.https_proxy,
    effectiveEnv.HTTPS_PROXY,
    effectiveEnv.http_proxy,
    effectiveEnv.HTTP_PROXY,
    effectiveEnv.all_proxy,
    effectiveEnv.ALL_PROXY,
  );
}

function parseNoProxyMatchers(env = process.env) {
  const effectiveEnv = { ...userShellEnv, ...env };
  return firstNonEmpty(effectiveEnv.no_proxy, effectiveEnv.NO_PROXY)
    .split(',')
    .map((entry) => trimString(entry).toLowerCase())
    .filter(Boolean);
}

function hostMatchesNoProxy(hostname, matchers = []) {
  const normalizedHost = trimString(hostname).toLowerCase();
  if (!normalizedHost) return false;
  for (const matcher of matchers) {
    if (matcher === '*') return true;
    const matcherWithoutPort = matcher.replace(/:\d+$/, '');
    if (!matcherWithoutPort) continue;
    if (matcherWithoutPort.startsWith('.')) {
      const suffix = matcherWithoutPort.slice(1);
      if (normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }
    if (normalizedHost === matcherWithoutPort || normalizedHost.endsWith(`.${matcherWithoutPort}`)) {
      return true;
    }
  }
  return false;
}

function requestShouldBypassProxy(urlValue, env = process.env) {
  try {
    const url = new URL(urlValue);
    const hostname = trimString(url.hostname).toLowerCase();
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }
    return hostMatchesNoProxy(hostname, parseNoProxyMatchers(env));
  } catch {
    return false;
  }
}

function shouldPreferCurlTransport(urlValue, options = {}) {
  if (options.forceFetchTransport) return false;
  if (options.forceCurlTransport) return true;
  if (!configuredProxyUrl()) return false;
  return !requestShouldBypassProxy(urlValue);
}

function shouldRetryViaCurl(error, urlValue, options = {}) {
  if (options.forceFetchTransport) return false;
  const code = firstNonEmpty(error?.cause?.code, error?.code);
  if (code && FETCH_PROXY_RETRY_ERROR_CODES.has(code)) {
    return true;
  }
  return trimString(error?.message).toLowerCase() === 'fetch failed';
}

function buildCloudflareWorkerRequest(urlValue, prepared) {
  const attachments = Array.isArray(prepared.attachments) ? prepared.attachments : [];
  return {
    url: urlValue,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${prepared.workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: prepared.to,
      from: prepared.from,
      subject: prepared.subject,
      text: prepared.text,
      inReplyTo: prepared.inReplyTo,
      references: prepared.references,
      ...(attachments.length > 0 ? {
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentBase64: attachment.contentBase64,
        })),
      } : {}),
    }),
  };
}

function parseCurlResponse(stdout = '') {
  const marker = `\n${CURL_HTTP_STATUS_MARKER}:`;
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error('curl response did not include an HTTP status code');
  }
  const rawText = stdout.slice(0, markerIndex);
  const statusText = stdout.slice(markerIndex + marker.length).trim();
  const statusCode = Number.parseInt(statusText, 10);
  if (!Number.isInteger(statusCode)) {
    throw new Error('curl response reported an invalid HTTP status code');
  }
  return {
    rawText,
    statusCode,
    parsedBody: parseJsonMaybe(rawText),
  };
}

function finalizeCloudflareWorkerResponse(prepared, statusCode, rawText) {
  const parsedBody = parseJsonMaybe(rawText);
  if (statusCode < 200 || statusCode >= 300) {
    throw createOutboundError(
      `Outbound email failed (${statusCode}): ${responseMessage(parsedBody, rawText) || 'Unknown error'}`,
      {
        provider: prepared.provider,
        statusCode,
        response: parsedBody || rawText,
        summary: summarizedResponse(parsedBody),
        cloudflareVerifiedDestinationRestriction: isCloudflareVerifiedDestinationRestriction(statusCode, parsedBody, rawText),
      },
    );
  }

  return {
    provider: prepared.provider,
    authMode: 'bearer_token',
    statusCode,
    response: parsedBody || rawText,
    summary: summarizedResponse(parsedBody),
  };
}

async function sendCloudflareWorkerMessageViaCurl(request, prepared, options = {}) {
  if (typeof options.sendCloudflareWorkerViaCurlImpl === 'function') {
    return await options.sendCloudflareWorkerViaCurlImpl(request, prepared);
  }

  let result;
  try {
    result = await execFileAsync('curl', [
      '--silent',
      '--show-error',
      '--location',
      '--connect-timeout',
      '15',
      '--max-time',
      '30',
      '--request',
      'POST',
      request.url,
      '--header',
      `Accept: ${request.headers.Accept}`,
      '--header',
      `Authorization: ${request.headers.Authorization}`,
      '--header',
      `Content-Type: ${request.headers['Content-Type']}`,
      '--data-binary',
      '@-',
      '--write-out',
      `\n${CURL_HTTP_STATUS_MARKER}:%{http_code}`,
    ], {
      input: request.body,
      encoding: 'utf8',
      env: process.env,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const status = error?.code ?? error?.signal ?? 'unknown';
    throw new Error(trimString(stderr) || `curl transport failed (${status})`);
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const parsed = parseCurlResponse(stdout);
  return finalizeCloudflareWorkerResponse(prepared, parsed.statusCode, parsed.rawText);
}

function summarizeSingleOutboundConfig(config = {}) {
  const provider = normalizeProvider(config.provider);
  const authMode = configuredAuthMode(config);
  const configuration = providerConfigurationState(config);
  return {
    provider,
    workerBaseUrl: normalizeWorkerBaseUrl(config.workerBaseUrl),
    apiBaseUrl: normalizeApiBaseUrl(config.apiBaseUrl, provider === 'resend_api' ? DEFAULT_RESEND_API_BASE_URL : ''),
    account: trimString(config.account),
    from: trimString(config.from),
    workerTokenEnv: trimString(config.workerTokenEnv),
    apiKeyEnv: trimString(config.apiKeyEnv),
    replyTo: trimString(config.replyTo),
    authMode,
    configured: configuration.configured,
    missing: configuration.missing,
    setupHint: configuration.configured ? '' : providerSetupHint(config, configuration),
  };
}

export function summarizeOutboundConfig(config = {}) {
  const summary = summarizeSingleOutboundConfig(config);
  const fallback = normalizeFallbackConfig(config);
  return {
    ...summary,
    fallback: fallback ? summarizeSingleOutboundConfig(fallback) : null,
  };
}

function prepareCloudflareWorkerConfig(config = {}, message = {}) {
  const to = normalizeRecipients(message.to);
  const subject = trimString(message.subject);
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const attachments = normalizeOutboundAttachments(message.attachments);
  const from = firstNonEmpty(message.from, config.from);
  const workerToken = resolveSecret(config, 'workerToken', 'workerTokenEnv');
  const workerBaseUrl = normalizeWorkerBaseUrl(config.workerBaseUrl);
  const inReplyTo = trimString(message.inReplyTo);
  const references = trimString(message.references);
  const allowEmptySubject = Boolean(inReplyTo || references);

  if (to.length === 0) {
    throw new Error('Outbound email requires at least one recipient');
  }
  if (!subject && !allowEmptySubject) {
    throw new Error('Outbound email requires a subject');
  }
  if (!text) {
    throw new Error('Outbound email requires a text body');
  }
  if (!from) {
    throw new Error('Outbound email requires a sender address');
  }
  if (!workerToken) {
    throw new Error('Cloudflare worker outbound email is not configured. Set a worker token first.');
  }
  if (!workerBaseUrl) {
    throw new Error('Cloudflare worker outbound email requires a worker base URL. Set workerBaseUrl first.');
  }

  return {
    provider: 'cloudflare_worker',
    workerBaseUrl,
    workerToken,
    from,
    to,
    subject,
    text,
    inReplyTo,
    references,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function buildResendApiRequest(urlValue, prepared) {
  const attachments = Array.isArray(prepared.attachments) ? prepared.attachments : [];
  const headers = {};
  if (prepared.inReplyTo) {
    headers['In-Reply-To'] = prepared.inReplyTo;
  }
  if (prepared.references) {
    headers.References = prepared.references;
  }

  return {
    url: urlValue,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${prepared.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: prepared.from,
      to: prepared.to.length === 1 ? prepared.to[0] : prepared.to,
      subject: prepared.subject,
      text: prepared.text,
      ...(prepared.replyTo ? { reply_to: prepared.replyTo } : {}),
      ...(attachments.length > 0 ? {
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.contentBase64,
        })),
      } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }),
  };
}

function finalizeResendApiResponse(prepared, statusCode, rawText) {
  const parsedBody = parseJsonMaybe(rawText);
  if (statusCode < 200 || statusCode >= 300) {
    throw createOutboundError(
      `Outbound email failed (${statusCode}): ${responseMessage(parsedBody, rawText) || 'Unknown error'}`,
      {
        provider: prepared.provider,
        statusCode,
        response: parsedBody || rawText,
        summary: summarizedResponse(parsedBody),
      },
    );
  }

  return {
    provider: prepared.provider,
    authMode: 'api_key',
    statusCode,
    response: parsedBody || rawText,
    summary: {
      id: firstNonEmpty(parsedBody?.id, parsedBody?.messageId, parsedBody?.message_id),
      message: firstNonEmpty(parsedBody?.message, parsedBody?.status, 'sent'),
    },
  };
}

function prepareResendApiConfig(config = {}, message = {}) {
  const to = normalizeRecipients(message.to);
  const subject = trimString(message.subject);
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const attachments = normalizeOutboundAttachments(message.attachments);
  const from = firstNonEmpty(message.from, config.from);
  const replyTo = trimString(config.replyTo);
  const apiKey = resolveSecret(config, 'apiKey', 'apiKeyEnv');
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl, DEFAULT_RESEND_API_BASE_URL);
  const inReplyTo = trimString(message.inReplyTo);
  const references = trimString(message.references) || inReplyTo;
  const allowEmptySubject = Boolean(inReplyTo || references);

  if (to.length === 0) {
    throw new Error('Outbound email requires at least one recipient');
  }
  if (!subject && !allowEmptySubject) {
    throw new Error('Outbound email requires a subject');
  }
  if (!text) {
    throw new Error('Outbound email requires a text body');
  }
  if (!from) {
    throw new Error('Outbound email requires a sender address');
  }
  if (!apiKey) {
    throw new Error('Resend outbound email is not configured. Set an API key first.');
  }
  if (!apiBaseUrl) {
    throw new Error('Resend outbound email requires an API base URL. Set apiBaseUrl first.');
  }

  return {
    provider: 'resend_api',
    apiBaseUrl,
    apiKey,
    from,
    replyTo,
    to,
    subject,
    text,
    inReplyTo,
    references,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function prepareAppleMailConfig(config = {}, message = {}) {
  const to = normalizeRecipients(message.to);
  const subject = trimString(message.subject);
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const attachments = normalizeOutboundAttachments(message.attachments);
  const allowEmptySubject = Boolean(trimString(message.inReplyTo) || trimString(message.references));

  if (to.length === 0) {
    throw new Error('Outbound email requires at least one recipient');
  }
  if (!subject && !allowEmptySubject) {
    throw new Error('Outbound email requires a subject');
  }
  if (!text) {
    throw new Error('Outbound email requires a text body');
  }

  return {
    provider: 'apple_mail',
    account: trimString(config.account),
    from: '',
    to,
    subject,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

async function sendAppleMailMessage(prepared, options = {}) {
  if (typeof options.sendAppleMailMessageImpl === 'function') {
    return await options.sendAppleMailMessageImpl(prepared);
  }

  const attachments = Array.isArray(prepared.attachments) ? prepared.attachments : [];
  const script = [
    'set recipientText to system attribute "REMOTELAB_MAIL_TO"',
    'set subjectText to system attribute "REMOTELAB_MAIL_SUBJECT"',
    'set bodyText to system attribute "REMOTELAB_MAIL_TEXT"',
    'set attachmentText to system attribute "REMOTELAB_MAIL_ATTACHMENTS"',
    'set desiredAccount to system attribute "REMOTELAB_MAIL_ACCOUNT"',
    'set desiredSender to system attribute "REMOTELAB_MAIL_SENDER"',
    'set recipientList to paragraphs of recipientText',
    'set attachmentList to paragraphs of attachmentText',
    'tell application "Mail"',
    '  set availableAccounts to every account',
    '  if (count of availableAccounts) is 0 then error "No Mail accounts are configured"',
    '  set selectedAccount to item 1 of availableAccounts',
    '  if desiredAccount is not "" then',
    '    set accountFound to false',
    '    repeat with currentAccount in availableAccounts',
    '      if ((name of currentAccount as text) is desiredAccount) or ((user name of currentAccount as text) is desiredAccount) then',
    '        set selectedAccount to currentAccount',
    '        set accountFound to true',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if accountFound is false then error "Mail account not found: " & desiredAccount',
    '  end if',
    '  set resolvedSender to desiredSender',
    '  if resolvedSender is "" then',
    '    try',
    '      set accountAddresses to email addresses of selectedAccount',
    '      if (count of accountAddresses) > 0 then set resolvedSender to item 1 of accountAddresses',
    '    end try',
    '  end if',
    '  if resolvedSender is "" then set resolvedSender to user name of selectedAccount',
    '  set outgoingMessage to make new outgoing message with properties {subject:subjectText, content:bodyText & return & return, visible:false}',
    '  tell outgoingMessage',
    '    repeat with recipientAddress in recipientList',
    '      if (recipientAddress as text) is not "" then',
    '        make new to recipient at end of to recipients with properties {address:recipientAddress as text}',
    '      end if',
    '    end repeat',
    '    repeat with attachmentPath in attachmentList',
    '      if (attachmentPath as text) is not "" then',
    '        tell content',
    '          make new attachment with properties {file name:(POSIX file (attachmentPath as text)) as alias} at after last paragraph',
    '        end tell',
    '      end if',
    '    end repeat',
    '    if resolvedSender is not "" then set sender to resolvedSender',
    '    send',
    '  end tell',
    '  return resolvedSender',
    'end tell',
  ].join('\n');

  let result;
  try {
    result = await execFileAsync('osascript', ['-'], {
      input: script,
      encoding: 'utf8',
      env: {
        ...process.env,
        REMOTELAB_MAIL_TO: prepared.to.join('\n'),
        REMOTELAB_MAIL_SUBJECT: prepared.subject,
        REMOTELAB_MAIL_TEXT: prepared.text,
        REMOTELAB_MAIL_ATTACHMENTS: attachments
          .map((attachment) => trimString(attachment.sourcePath))
          .filter(Boolean)
          .join('\n'),
        REMOTELAB_MAIL_ACCOUNT: prepared.account,
        REMOTELAB_MAIL_SENDER: prepared.from,
      },
    });
  } catch (error) {
    const stderr = trimString(error?.stderr);
    const stdout = trimString(error?.stdout);
    const status = error?.code ?? error?.signal ?? 'unknown';
    throw new Error(stderr || stdout || `Mail.app send failed (${status})`);
  }

  return {
    sender: trimString(result.stdout),
  };
}

function attachFallbackMetadata(result, provider, error, fallbackReason = 'cloudflare_verified_destination_only') {
  return {
    ...result,
    requestedProvider: firstNonEmpty(result?.requestedProvider, provider),
    fallbackFromProvider: firstNonEmpty(result?.fallbackFromProvider, provider),
    fallbackReason: firstNonEmpty(result?.fallbackReason, fallbackReason),
    initialError: firstNonEmpty(result?.initialError, trimString(error?.message)),
  };
}

async function sendOutboundEmailWithFallback(message, config = {}, options = {}, visitedProviders = new Set()) {
  const provider = normalizeProvider(config.provider);
  if (visitedProviders.has(provider)) {
    throw new Error(`Outbound email fallback cycle detected for provider: ${provider}`);
  }
  const nextVisitedProviders = new Set(visitedProviders);
  nextVisitedProviders.add(provider);

  const configurationError = providerConfigurationError(config);
  if (configurationError) {
    const fallbackConfig = normalizeFallbackConfig(config);
    const fallbackProvider = normalizeProvider(fallbackConfig?.provider, '');
    if (fallbackConfig
      && fallbackProvider
      && !nextVisitedProviders.has(fallbackProvider)
      && !providerConfigurationError(fallbackConfig)) {
      const fallbackResult = await sendOutboundEmailWithFallback(message, fallbackConfig, options, nextVisitedProviders);
      return attachFallbackMetadata(fallbackResult, provider, configurationError, 'provider_unconfigured');
    }
    throw configurationError;
  }

  if (provider === 'apple_mail') {
    const prepared = prepareAppleMailConfig(config, message);
    const response = await sendAppleMailMessage(prepared, options);
    return {
      provider: 'apple_mail',
      statusCode: 202,
      response: {
        message: 'queued in Mail.app',
        sender: trimString(response?.sender),
      },
      summary: {
        message: trimString(response?.sender)
          ? `queued in Mail.app via ${trimString(response.sender)}`
          : 'queued in Mail.app',
      },
    };
  }

  if (provider === 'resend_api') {
    const prepared = prepareResendApiConfig(config, message);
    const requestUrl = `${prepared.apiBaseUrl}/emails`;
    const request = buildResendApiRequest(requestUrl, prepared);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global fetch is unavailable in this Node runtime');
    }

    const response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    const rawText = await response.text();
    return finalizeResendApiResponse(prepared, response.status, rawText);
  }

  if (provider === 'cloudflare_worker') {
    const prepared = prepareCloudflareWorkerConfig(config, message);
    const requestUrl = `${prepared.workerBaseUrl}/api/send-email`;
    try {
      const request = buildCloudflareWorkerRequest(requestUrl, prepared);
      if (shouldPreferCurlTransport(requestUrl, options)) {
        return await sendCloudflareWorkerMessageViaCurl(request, prepared, options);
      }

      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new Error('Global fetch is unavailable in this Node runtime');
      }

      let response;
      try {
        response = await fetchImpl(requestUrl, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        });
      } catch (error) {
        if (!shouldRetryViaCurl(error, requestUrl, options)) {
          throw error;
        }
        return await sendCloudflareWorkerMessageViaCurl(request, prepared, options);
      }

      const rawText = await response.text();
      return finalizeCloudflareWorkerResponse(prepared, response.status, rawText);
    } catch (error) {
      const fallbackConfig = normalizeFallbackConfig(config);
      const fallbackProvider = normalizeProvider(fallbackConfig?.provider, '');
      if (fallbackConfig
        && fallbackProvider
        && !nextVisitedProviders.has(fallbackProvider)
        && error?.cloudflareVerifiedDestinationRestriction) {
        const fallbackResult = await sendOutboundEmailWithFallback(message, fallbackConfig, options, nextVisitedProviders);
        return attachFallbackMetadata(fallbackResult, provider, error);
      }
      throw error;
    }
  }

  throw new Error(`Unsupported outbound email provider: ${provider}`);
}

export async function sendOutboundEmail(message, config = {}, options = {}) {
  return sendOutboundEmailWithFallback(message, config, options);
}

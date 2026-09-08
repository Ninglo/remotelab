#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { AUTH_FILE } from '../lib/config.mjs';
import { buildEmailSourceRouteId, buildEmailSourceDelivery, buildEmailSourceDeliveryTarget } from '../lib/agent-mail-source-delivery.mjs';
import { processEmailSourceDeliveryOnce } from '../lib/agent-mail-source-delivery-sender.mjs';
import { findMailboxRuntimeByName, loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_ROOT_DIR,
  DEFAULT_AUTOMATION_SETTINGS,
  buildEmailThreadExternalTriggerId,
  decodeMaybeEncodedMailboxText,
  extractNormalizedMailboxContent,
  extractRawMessageAttachments,
  loadMailboxAutomation,
  listQueue,
  updateQueueItem,
} from '../lib/agent-mailbox.mjs';
import { resolveExternalRuntimeSelection } from '../lib/external-runtime-selection.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';

const DEFAULT_OWNER_CONFIG_DIR = join(homedir(), '.config', 'remotelab');
const DEFAULT_GUEST_REGISTRY_FILE = join(DEFAULT_OWNER_CONFIG_DIR, 'guest-instances.json');

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) {
      index += 1;
    }
    options[key] = value;
  }

  return { positional, options };
}

function optionValue(options, key, fallbackValue = undefined) {
  const value = options[key];
  return value === undefined ? fallbackValue : value;
}

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeliveryMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'session_only' || normalized === 'session-only' || normalized === 'session') {
    return 'session_only';
  }
  return 'reply_email';
}

function expandHomePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function normalizeAuthFile(value) {
  return expandHomePath(value);
}

async function readJsonFile(filePath, fallbackValue) {
  const normalizedPath = normalizeAuthFile(filePath);
  if (!normalizedPath) return fallbackValue;
  try {
    return JSON.parse(await readFile(normalizedPath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/agent-mail-worker.mjs [--root <dir>] [--chat-base-url <url>] [--auth-file <path>] [--interval-ms <ms>] [--once]

Examples:
  node scripts/agent-mail-worker.mjs --once
  node scripts/agent-mail-worker.mjs --interval-ms 5000`);
}

async function readOwnerToken(authFile = AUTH_FILE) {
  const resolvedAuthFile = normalizeAuthFile(authFile) || AUTH_FILE;
  const auth = JSON.parse(await readFile(resolvedAuthFile, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${resolvedAuthFile}`);
  }
  return token;
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error('chat base URL is required');
  }
  return normalized.replace(/\/+$/, '');
}

function normalizeBaseUrlMatch(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return '';
  }
}

function sameBaseUrl(leftValue, rightValue) {
  const left = normalizeBaseUrlMatch(leftValue);
  const right = normalizeBaseUrlMatch(rightValue);
  return !!left && left === right;
}

async function loadGuestRegistry() {
  return (await loadMailboxRuntimeRegistry({
    registryFile: process.env.REMOTELAB_GUEST_REGISTRY_FILE || DEFAULT_GUEST_REGISTRY_FILE,
  })).map((record) => ({
    ...record,
    authFile: normalizeAuthFile(record?.authFile),
    localBaseUrl: trimString(record?.localBaseUrl),
    publicBaseUrl: trimString(record?.publicBaseUrl),
  }));
}

function findGuestInstanceByName(name, registry = []) {
  return findMailboxRuntimeByName(name, registry);
}

function findGuestInstanceByBaseUrl(baseUrl, registry = []) {
  const normalizedBaseUrl = normalizeBaseUrlMatch(baseUrl);
  if (!normalizedBaseUrl) return null;
  return registry.find((record) => sameBaseUrl(record.localBaseUrl, normalizedBaseUrl) || sameBaseUrl(record.publicBaseUrl, normalizedBaseUrl)) || null;
}

async function resolveRuntimeTarget(item, automation, fallbackBaseUrl = '') {
  const registry = await loadGuestRegistry();
  const routedInstance = trimString(item?.routing?.instanceName).toLowerCase();
  if (routedInstance) {
    const guest = findGuestInstanceByName(routedInstance, registry);
    if (!guest) {
      throw new Error(`Mailbox recipient targeted guest instance "${routedInstance}" but no matching guest instance was found`);
    }
    const guestBaseUrl = trimString(guest.localBaseUrl) || trimString(guest.publicBaseUrl);
    if (!guestBaseUrl) {
      throw new Error(`Guest instance "${routedInstance}" does not have a usable base URL`);
    }
    return {
      baseUrl: guestBaseUrl,
      authFile: guest.authFile,
      guestInstance: guest.name,
      configDir: trimString(guest.configDir),
      mailboxRoot: trimString(guest.mailboxRoot),
      source: 'recipient_subaddress',
    };
  }

  const configuredBaseUrl = trimString(fallbackBaseUrl) || trimString(automation?.chatBaseUrl);
  if (!configuredBaseUrl) {
    throw new Error('chat base URL is required');
  }
  const matchingGuest = findGuestInstanceByBaseUrl(configuredBaseUrl, registry);
  return {
    baseUrl: configuredBaseUrl,
    authFile: normalizeAuthFile(automation?.authFile) || trimString(matchingGuest?.authFile),
    guestInstance: trimString(matchingGuest?.name),
    configDir: trimString(matchingGuest?.configDir),
    mailboxRoot: trimString(matchingGuest?.mailboxRoot),
    source: matchingGuest ? 'configured_guest_instance' : 'automation_chat_base_url',
  };
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to chat server at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function createRemoteLabRuntime(baseUrl, { authFile = '' } = {}) {
  const normalizedAuthFile = normalizeAuthFile(authFile);
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    authFile: normalizedAuthFile,
    authToken: '',
    authCookie: '',
    readOwnerToken: async () => readOwnerToken(normalizedAuthFile || AUTH_FILE),
  };
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie;
  }
  if (forceRefresh) {
    runtime.authCookie = '';
    runtime.authToken = '';
  }
  if (!runtime.authToken) {
    runtime.authToken = typeof runtime.readOwnerToken === 'function'
      ? await runtime.readOwnerToken()
      : await readOwnerToken();
  }
  const login = typeof runtime.loginWithToken === 'function' ? runtime.loginWithToken : loginWithToken;
  runtime.authCookie = await login(runtime.baseUrl, runtime.authToken);
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const request = typeof runtime.requestJson === 'function' ? runtime.requestJson : requestJson;
  const cookie = await ensureAuthCookie(runtime, false);
  let result = await request(runtime.baseUrl, path, { ...options, cookie });
  if ([401, 403].includes(result.response?.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await request(runtime.baseUrl, path, { ...options, cookie: refreshedCookie });
  }
  return result;
}

function runtimeMatchesTarget(runtime, target) {
  if (!runtime || !target) return false;
  return sameBaseUrl(runtime.baseUrl, target.baseUrl)
    && normalizeAuthFile(runtime.authFile) === normalizeAuthFile(target.authFile);
}

function buildSessionName(item) {
  return trimString(item?.message?.subject);
}

function buildSessionDescription(item, fallbackDescription) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const fallback = trimString(fallbackDescription);
  return trimString(`Inbound email${sender ? ` from ${sender}` : ''}${subject ? ` about ${subject}` : ''}`) || fallback;
}

async function extractReadableBodyFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return '';
  }

  try {
    const normalized = extractNormalizedMailboxContent({
      rawMessage: await readFile(rawPath, 'utf8'),
    });
    return trimString(normalized.messageText) || trimString(normalized.previewText);
  } catch (error) {
    console.error(`[agent-mail-worker] extractReadableBodyFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return '';
  }
}

async function extractAttachmentsFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return [];
  }

  try {
    return extractRawMessageAttachments(await readFile(rawPath, 'utf8'), { includeData: true })
      .filter((attachment) => typeof attachment?.data === 'string' && attachment.data);
  } catch (error) {
    console.error(`[agent-mail-worker] extractAttachmentsFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return [];
  }
}

async function buildReplyPrompt(item) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const date = trimString(item?.message?.date);
  const messageId = trimString(item?.message?.messageId);
  const rawDerivedBody = await extractReadableBodyFromRaw(item);
  const bodySource = trimString(item?.content?.extractedText) || trimString(item?.content?.preview);
  const decodedStoredBody = decodeMaybeEncodedMailboxText(bodySource, {
    contentType: trimString(item?.message?.headers?.['content-type']) || 'text/plain; charset=UTF-8',
    transferEncoding: trimString(item?.message?.headers?.['content-transfer-encoding']),
  });
  const body = rawDerivedBody || decodedStoredBody;

  return [
    'Inbound email.',
    `- From: ${sender || '(unknown sender)'}`,
    `- Subject: ${subject || '(no subject)'}`,
    `- Date: ${date || '(no date)'}`,
    `- Message-ID: ${messageId || '(no message id)'}`,
    '',
    'User message:',
    body || '(empty body)',
  ].join('\n');
}

function hasExplicitPinnedRuntime(automation) {
  const session = automation?.session || {};
  return trimString(session.tool) && trimString(session.tool) !== DEFAULT_AUTOMATION_SETTINGS.session.tool
    || !!trimString(session.model)
    || !!trimString(session.effort)
    || session.thinking === true;
}

function resolveReplyRuntimeSelection(automation, uiSelection) {
  const session = automation?.session || {};
  const pinned = hasExplicitPinnedRuntime(automation);
  const defaultTool = trimString(DEFAULT_AUTOMATION_SETTINGS.session.tool) || 'codex';
  return resolveExternalRuntimeSelection({
    uiSelection,
    mode: pinned ? 'pinned' : 'ui',
    fallback: {
      tool: trimString(session.tool) || defaultTool,
      model: trimString(session.model),
      effort: trimString(session.effort),
      thinking: session.thinking === true,
    },
    defaultTool,
  });
}

function requestIdPrefixForMode(deliveryMode) {
  return deliveryMode === 'session_only' ? 'mailbox_session_' : 'mailbox_reply_';
}

function submittedStatusForMode(deliveryMode) {
  return deliveryMode === 'session_only' ? 'submitted_to_session' : 'processing_for_reply';
}

function failureStatusForMode(deliveryMode) {
  return deliveryMode === 'session_only' ? 'session_submission_failed' : 'reply_failed';
}

function shouldProcessItem(item) {
  const status = trimString(item?.status);
  const automationStatus = trimString(item?.automation?.status);
  if (!trimString(item?.message?.fromAddress)) return false;
  if (status === 'reply_sent' || automationStatus === 'reply_sent') return false;
  if (status === 'processing_for_reply' || automationStatus === 'processing_for_reply') return false;
  if (status === 'reply_failed' || automationStatus === 'reply_failed') return false;
  if (status === 'submitted_to_session' || automationStatus === 'submitted_to_session') return false;
  if (status === 'session_submission_failed' || automationStatus === 'session_submission_failed') return false;
  // Items with a preparedSessionId are mid-submission (session created but
  // message not yet submitted).  Allow them through so the sweep can resume.
  if (trimString(item?.automation?.preparedSessionId)) return true;
  return true;
}

/**
 * Tag an error as permanent (4xx HTTP rejection) so the sweep can distinguish
 * transient network failures from definite server-side rejections.
 */
function tagPermanentIfHttpError(error, httpStatus) {
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    error.permanent = true;
  }
  return error;
}

async function submitApprovedItem(item, rootDir, automation, runtime) {
  const prepared = item?.automation?.preparedSubmission;
  const deliveryMode = normalizeDeliveryMode(prepared?.deliveryMode || automation.deliveryMode);
  const requestId = trimString(prepared?.payload?.requestId || item?.automation?.requestId) || `${requestIdPrefixForMode(deliveryMode)}${item.id}`;
  const externalTriggerId = trimString(item?.message?.externalTriggerId)
    || buildEmailThreadExternalTriggerId({
      messageId: trimString(item?.message?.messageId),
      inReplyTo: trimString(item?.message?.inReplyTo),
      references: trimString(item?.message?.references),
    })
    || `mailbox:${item.id}`;
  const runtimeTarget = prepared?.runtimeTarget || item?.automation?.preparedRuntimeTarget
    || await resolveRuntimeTarget(item, automation, runtime?.baseUrl || automation.chatBaseUrl);
  const effectiveRuntime = runtimeMatchesTarget(runtime, runtimeTarget)
    ? runtime
    : createRemoteLabRuntime(runtimeTarget.baseUrl, { authFile: runtimeTarget.authFile });
  const targetSelectionFile = runtimeTarget.configDir
    ? join(runtimeTarget.configDir, 'ui-runtime-selection.json')
    : undefined;
  const uiSelection = await loadUiRuntimeSelection(targetSelectionFile);
  const runtimeSelection = resolveReplyRuntimeSelection(automation, uiSelection);

  // ─── PHASE 1: create or reuse session (durable) ───────────────────────────
  // If a previous sweep crashed after creating the session but before finishing
  // message submission, item.automation.preparedSessionId is already set.
  // Reuse it so we never create duplicate sessions for the same email.
  let preparedSessionId = trimString(prepared?.sessionId || item?.automation?.preparedSessionId);

  if (!preparedSessionId) {
    const sessionPayload = {
      folder: automation.session.folder,
      tool: runtimeSelection.tool,
      sourceId: 'email',
      sourceName: 'Email',
      group: automation.session.group,
      description: buildSessionDescription(item, automation.session.description),
      systemPrompt: automation.session.systemPrompt,
      externalTriggerId,
    };
    const sessionName = buildSessionName(item);
    if (sessionName) sessionPayload.name = sessionName;
    // Legacy explicit completion targets supplied via external configuration.
    if (automation.session?.completionTargets?.length > 0) {
      sessionPayload.completionTargets = automation.session.completionTargets;
    }

    const createResult = await requestRemoteLab(effectiveRuntime, '/api/sessions', {
      method: 'POST',
      body: sessionPayload,
    });
    if (!createResult.response.ok || !createResult.json?.session?.id) {
      const status = createResult.response?.status;
      throw tagPermanentIfHttpError(
        new Error(createResult.json?.error || createResult.text || `Failed to create session (${status})`),
        status,
      );
    }

    preparedSessionId = createResult.json.session.id;

    // Persist the session ID before submitting the message.  If the process
    // crashes here, the next sweep will reuse this session instead of creating
    // a duplicate.  requestId deduplication makes the message submit idempotent.
    await updateQueueItem(item.id, rootDir, (draft) => {
      draft.automation = {
        ...(draft.automation || {}),
        preparedSessionId,
        preparedRuntimeTarget: runtimeTarget,
        requestId,
        externalTriggerId,
        targetBaseUrl: runtimeTarget.baseUrl,
        targetInstance: runtimeTarget.guestInstance || null,
        targetMailboxRoot: runtimeTarget.mailboxRoot || null,
        updatedAt: nowIso(),
      };
      return draft;
    });
  }

  // Freeze the exact payload before POST, including runtime selection and
  // attachments. A retry must not re-render changed config or source files.
  let messagePayload = prepared?.payload;
  if (!messagePayload) {
  messagePayload = {
    requestId,
    text: await buildReplyPrompt(item),
    tool: runtimeSelection.tool,
  };

  // Pass sourceDelivery in the message for reply_email mode so the outbox
  // records the reply target durably alongside the request.
  if (deliveryMode === 'reply_email') {
    const emailTarget = buildEmailSourceDeliveryTarget(item);
    const sourceRouteId = buildEmailSourceRouteId(rootDir);
    messagePayload.sourceDelivery = buildEmailSourceDelivery(sourceRouteId, emailTarget);
  }
  const rawAttachmentCount = Number(item?.content?.attachmentCount) || 0;
  const attachments = (await extractAttachmentsFromRaw(item)).map((attachment) => ({
    data: attachment.data,
    mimeType: attachment.mimeType,
    originalName: attachment.originalName,
  }));
  if (attachments.length > 0) messagePayload.attachments = attachments;
  if (rawAttachmentCount > 0 && attachments.length === 0) {
    messagePayload.text += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but they could not be extracted. The raw email is stored at: ${trimString(item?.storage?.rawPath)}`;
    console.error(`[agent-mail-worker] attachment extraction yielded 0 results for item ${item?.id} (expected ${rawAttachmentCount})`);
  } else if (rawAttachmentCount > 0 && attachments.length < rawAttachmentCount) {
    messagePayload.text += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but only ${attachments.length} could be extracted.`;
    console.warn(`[agent-mail-worker] partial attachment extraction for item ${item?.id}: ${attachments.length}/${rawAttachmentCount}`);
  }
  if (runtimeSelection.thinking) messagePayload.thinking = true;
  if (runtimeSelection.model) messagePayload.model = runtimeSelection.model;
  if (runtimeSelection.effort) messagePayload.effort = runtimeSelection.effort;

  await updateQueueItem(item.id, rootDir, draft => {
    draft.automation = { ...(draft.automation || {}), preparedSubmission: {
      sessionId: preparedSessionId, payload: messagePayload, runtimeTarget, deliveryMode, externalTriggerId,
    } };
    return draft;
  });
  }

  // One bounded recovery lookup, not an AI completion wait. If admission's
  // HTTP response was lost, don't re-upload inline attachments to a request
  // already accepted with stable saved attachment references.
  let submitResult;
  if (prepared) {
    const observed = await requestRemoteLab(effectiveRuntime, `/api/sessions/${preparedSessionId}/responses/${encodeURIComponent(requestId)}`);
    const publication = observed.json?.replyPublication;
    if (observed.response.ok && publication?.rootRunId) {
      submitResult = { response: { status: 200, ok: true }, json: {
        duplicate: true, queued: publication.state === 'queued', run: { id: publication.rootRunId },
      } };
    } else if (observed.response.status !== 404) {
      throw tagPermanentIfHttpError(new Error(observed.json?.error || 'Cannot reconcile email admission'), observed.response.status);
    }
  }
  submitResult ||= await requestRemoteLab(effectiveRuntime, `/api/sessions/${preparedSessionId}/messages`, {
    method: 'POST', body: messagePayload,
  });
  const isQueued = submitResult.json?.queued === true;
  if (![200, 202].includes(submitResult.response.status) || (!submitResult.json?.run?.id && !isQueued)) {
    const status = submitResult.response?.status;
    throw tagPermanentIfHttpError(
      new Error(submitResult.json?.error || submitResult.text || `Failed to submit session message (${status})`),
      status,
    );
  }

  const run = submitResult.json.run;
  const submittedStatus = submittedStatusForMode(deliveryMode);
  await updateQueueItem(item.id, rootDir, (draft) => {
    const status = draft.status === 'reply_sent' || draft.automation?.status === 'reply_sent' ? 'reply_sent' : submittedStatus;
    draft.status = status;
    draft.automation = {
      ...(draft.automation || {}),
      status,
      deliveryMode,
      sessionId: preparedSessionId,
      runId: run?.id || null,
      requestId,
      externalTriggerId,
      targetBaseUrl: runtimeTarget.baseUrl,
      targetInstance: runtimeTarget.guestInstance || null,
      targetMailboxRoot: runtimeTarget.mailboxRoot || null,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: submitResult.json?.duplicate === true,
      queued: isQueued,
      // Clear the prepared flag now that submission is complete.
      preparedSessionId: null,
      preparedSubmission: null,
      preparedRuntimeTarget: null,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: preparedSessionId,
    runId: run?.id || null,
    queued: isQueued,
    duplicate: submitResult.json?.duplicate === true,
    deliveryMode,
    targetBaseUrl: runtimeTarget.baseUrl,
    targetInstance: runtimeTarget.guestInstance || null,
  };
}

/**
 * Drain email source-deliveries from one RemoteLab instance endpoint.
 *
 * sourceRouteId is always buildEmailSourceRouteId(rootDir) because the
 * sourceDelivery written by submitApprovedItem uses the root mailbox's binding
 * ID regardless of which instance runs the AI session.  Outbound email always
 * uses the root mailbox's credentials.
 */
async function drainEmailDeliveriesFromInstance({ requestFn, sourceRouteId, mailboxRoot, baseUrl, authorizeDelivery }) {
  const deliveries = [];
  const deliveryErrors = [];
  const MAX_PER_SWEEP = 20;
  for (let i = 0; i < MAX_PER_SWEEP; i++) {
    try {
      const result = await processEmailSourceDeliveryOnce({
        requestRemoteLab: requestFn,
        sourceRouteId,
        mailboxRoot,
        authorizeDelivery,
        // A receipt belongs to one control plane; never acknowledge a guest's
        // receipt against the root instance (or block every route on its 404).
        receiptsDir: join(mailboxRoot, 'email-delivery-receipts', createHash('sha256').update(normalizeBaseUrl(baseUrl)).digest('hex').slice(0, 24)),
      });
      if (!result) break;
      deliveries.push(result);
    } catch (error) {
      deliveryErrors.push({ error: error.message });
      break;
    }
  }
  return { deliveries, deliveryErrors };
}

async function runEmailSourceDeliverySweep({ rootDir, runtime }) {
  const sourceRouteId = buildEmailSourceRouteId(rootDir);
  const allDeliveries = [];
  const allErrors = [];

  // ── sweep root instance ────────────────────────────────────────────
  const rootResult = await drainEmailDeliveriesFromInstance({
    requestFn: (path, options = {}) => requestRemoteLab(runtime, path, options),
    sourceRouteId,
    mailboxRoot: rootDir,
    baseUrl: runtime.baseUrl,
  });
  allDeliveries.push(...rootResult.deliveries);
  allErrors.push(...rootResult.deliveryErrors);

  // ── sweep known guest instances (explicit supported targets only) ───────
  // When submitApprovedItem routes an email to a guest instance, the AI
  // session runs there and the delivery record ends up in that instance's
  // outbox.  The root worker must also claim from each guest's outbox so
  // replies are not silently stranded.
  //
  // Safety constraint: only instances that appear in the explicit guest
  // registry are swept (no blind discovery).  The sourceRouteId and outbound
  // email credentials always come from the root mailbox.
  let registry = [];
  try {
    registry = await loadGuestRegistry();
  } catch {
    // Registry unavailable is not a fatal error for this sweep.
  }

  for (const guest of registry) {
    const guestBaseUrl = trimString(guest.localBaseUrl) || trimString(guest.publicBaseUrl);
    if (!guestBaseUrl || sameBaseUrl(guestBaseUrl, runtime.baseUrl)) continue;
    // Skip guests that don't expose a base URL we can reach
    // (e.g. disabled or not yet started).
    if (!trimString(guest.authFile)) {
      allErrors.push({ error: 'Guest mailbox route has no bound authentication file', guestBaseUrl });
      continue;
    }
    // Never send the root instance's owner token to another guest.
    const guestRuntime = createRemoteLabRuntime(guestBaseUrl, { authFile: guest.authFile });
    const guestResult = await drainEmailDeliveriesFromInstance({
      requestFn: (path, opts = {}) => requestRemoteLab(guestRuntime, path, opts),
      sourceRouteId,   // same route ID — matches what submitApprovedItem wrote
      mailboxRoot: rootDir, // outbound email config is always from root mailbox
      baseUrl: guestBaseUrl,
      // Registry membership alone must not grant an arbitrary guest an email
      // relay using the root mailbox. Only replies to admitted intake qualify.
      authorizeDelivery: async delivery => (await listQueue(APPROVED_QUEUE, rootDir)).some(item => {
        const saved = item.automation || {};
        const targetBaseUrl = saved.targetBaseUrl || saved.preparedSubmission?.runtimeTarget?.baseUrl;
        const sessionId = saved.sessionId || saved.preparedSessionId || saved.preparedSubmission?.sessionId;
        return sameBaseUrl(targetBaseUrl, guestBaseUrl) && sessionId === delivery.sessionId
          && saved.requestId === delivery.responseId
          && trimString(item.message?.fromAddress).toLowerCase() === trimString(delivery.target?.to).toLowerCase()
          && (!delivery.target?.inReplyTo || delivery.target.inReplyTo === item.message?.messageId);
      }),
    }).catch((error) => {
      console.error(`[agent-mail-worker] guest email delivery sweep failed for ${guestBaseUrl}: ${error?.message}`);
      return { deliveries: [], deliveryErrors: [{ error: error.message, guestBaseUrl }] };
    });
    allDeliveries.push(...guestResult.deliveries);
    allErrors.push(...guestResult.deliveryErrors);
  }

  return { deliveries: allDeliveries, deliveryErrors: allErrors };
}

async function runSweep({ rootDir, baseUrl, runtime = createRemoteLabRuntime(baseUrl), deliver = true }) {
  const automation = await loadMailboxAutomation(rootDir);
  const deliveryMode = normalizeDeliveryMode(automation.deliveryMode);
  if (automation.enabled === false) {
    return {
      processed: 0,
      skipped: 0,
      failures: [],
      reason: 'automation_disabled',
    };
  }

  const allApprovedItems = await listQueue(APPROVED_QUEUE, rootDir);
  const approvedItems = allApprovedItems.filter(shouldProcessItem);
  const successes = [];
  const failures = [];

  for (const item of approvedItems) {
    try {
      successes.push(await submitApprovedItem(item, rootDir, automation, runtime));
    } catch (error) {
      if (error.permanent) {
        // Definite server rejection (4xx): mark permanently failed.
        await updateQueueItem(item.id, rootDir, (draft) => {
          draft.status = failureStatusForMode(deliveryMode);
          draft.automation = {
            ...(draft.automation || {}),
            status: failureStatusForMode(deliveryMode),
            deliveryMode,
            requestId: trimString(draft.automation?.requestId) || `${requestIdPrefixForMode(deliveryMode)}${item.id}`,
            lastError: error.message,
            updatedAt: nowIso(),
          };
          return draft;
        });
      } else {
        // Transient failure (network error, 5xx, timeout): leave the item
        // retriable.  preparedSessionId (if any) is already persisted so the
        // next sweep resumes from the correct session without creating a
        // duplicate.
        await updateQueueItem(item.id, rootDir, (draft) => {
          draft.automation = {
            ...(draft.automation || {}),
            lastError: error.message,
            updatedAt: nowIso(),
          };
          return draft;
        }).catch(() => {}); // best-effort; do not mask the original error
      }
      failures.push({ itemId: item.id, error: error.message, permanent: error.permanent === true });
    }
  }

  // Notify connected UI clients about failures so they are visible in the chat interface
  if (failures.length > 0) {
    const failureSummary = failures.map((f) => f.itemId).join(', ');
    const notificationMessage = `邮件处理失败 (${failures.length} 封): ${failures[0].error.slice(0, 200)}`;
    try {
      await requestRemoteLab(runtime, '/api/notifications', {
        method: 'POST',
        body: { message: notificationMessage, level: 'error' },
      });
    } catch {
      console.error(`[agent-mail-worker] failed to send UI notification for failures: ${failureSummary}`);
    }
  }

  // --once performs a bounded outbox sweep as well. The resident worker uses
  // its own independent sender timer, never held behind admission work.
  const emailDelivery = deliver ? await runEmailSourceDeliverySweep({ rootDir, runtime }).catch((error) => {
    console.error(`[agent-mail-worker] email delivery sweep error: ${error?.message || error}`);
    return { deliveries: [], deliveryErrors: [{ error: error.message }] };
  }) : { deliveries: [], deliveryErrors: [] };

  return {
    processed: successes.length,
    skipped: allApprovedItems.length - approvedItems.length,
    successes,
    failures,
    emailDeliveries: emailDelivery.deliveries.length,
    emailDeliveryErrors: emailDelivery.deliveryErrors,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional[0] === 'help' || options.help || options.h) {
    printUsage();
    return;
  }

  const rootDir = optionValue(options, 'root', DEFAULT_ROOT_DIR);
  const automation = await loadMailboxAutomation(rootDir);
  const baseUrl = optionValue(options, 'chat-base-url', automation.chatBaseUrl);
  const authFile = optionValue(options, 'auth-file', automation.authFile);
  const intervalMs = Math.max(1000, parseInt(optionValue(options, 'interval-ms', '5000'), 10) || 5000);
  const once = optionValue(options, 'once', false) === true;
  const runtime = createRemoteLabRuntime(baseUrl, { authFile });

  if (once) {
    console.log(JSON.stringify(await runSweep({ rootDir, baseUrl, runtime }), null, 2));
    return;
  }

  let running = false;
  let stopping = false;
  let deliveryPending = null;
  const pumpDeliveries = () => {
    if (stopping || deliveryPending) return;
    deliveryPending = runEmailSourceDeliverySweep({ rootDir, runtime })
      .catch(error => console.error(`[agent-mail-worker] delivery: ${error.message}`))
      .finally(() => { deliveryPending = null; });
  };
  const loop = async () => {
    if (stopping || running) return;
    running = true;
    try {
      const summary = await runSweep({ rootDir, baseUrl, runtime, deliver: false });
      if (summary.processed > 0 || summary.failures.length > 0) {
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch (error) {
      console.error(`[agent-mail-worker] ${error.message}`);
    } finally {
      running = false;
    }
  };

  const admissionTimer = setInterval(loop, intervalMs);
  const deliveryTimer = setInterval(pumpDeliveries, 1000);
  const stop = () => {
    stopping = true;
    clearInterval(admissionTimer);
    clearInterval(deliveryTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  pumpDeliveries();
  await loop();
}

export {
  createRemoteLabRuntime,
  ensureAuthCookie,
  requestRemoteLab,
  runEmailSourceDeliverySweep,
  runSweep,
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

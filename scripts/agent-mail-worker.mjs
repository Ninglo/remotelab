#!/usr/bin/env node

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { AUTH_FILE } from '../lib/config.mjs';
import { findMailboxRuntimeByName, loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_ROOT_DIR,
  DEFAULT_AUTOMATION_SETTINGS,
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
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

function readJsonFile(filePath, fallbackValue) {
  const normalizedPath = normalizeAuthFile(filePath);
  if (!normalizedPath) return fallbackValue;
  try {
    return JSON.parse(readFileSync(normalizedPath, 'utf8'));
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

function readOwnerToken(authFile = AUTH_FILE) {
  const resolvedAuthFile = normalizeAuthFile(authFile) || AUTH_FILE;
  const auth = JSON.parse(readFileSync(resolvedAuthFile, 'utf8'));
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

function normalizeEmailAddress(value) {
  return trimString(value).toLowerCase();
}

function splitEmailAddressParts(value) {
  const normalized = normalizeEmailAddress(value);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) {
    return {
      localPart: normalized,
      domain: '',
    };
  }
  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function resolveReplyFromAddress(item) {
  const replyFrom = normalizeEmailAddress(item?.message?.effectiveToAddress)
    || normalizeEmailAddress(item?.message?.envelopeToAddress)
    || normalizeEmailAddress(item?.message?.toAddress);
  const identityAddress = normalizeEmailAddress(item?.identity?.address);
  if (!replyFrom || !identityAddress) return '';

  const replyFromParts = splitEmailAddressParts(replyFrom);
  const identityParts = splitEmailAddressParts(identityAddress);
  if (!replyFromParts.localPart || !replyFromParts.domain) return '';
  if (!identityParts.domain || replyFromParts.domain !== identityParts.domain) return '';
  return replyFrom;
}

function sameBaseUrl(leftValue, rightValue) {
  const left = normalizeBaseUrlMatch(leftValue);
  const right = normalizeBaseUrlMatch(rightValue);
  return !!left && left === right;
}

function loadGuestRegistry() {
  return loadMailboxRuntimeRegistry({
    registryFile: process.env.REMOTELAB_GUEST_REGISTRY_FILE || DEFAULT_GUEST_REGISTRY_FILE,
  }).map((record) => ({
    ...record,
    authFile: normalizeAuthFile(record?.authFile),
    localBaseUrl: trimString(record?.localBaseUrl),
    publicBaseUrl: trimString(record?.publicBaseUrl),
  }));
}

function findGuestInstanceByName(name, registry = loadGuestRegistry()) {
  return findMailboxRuntimeByName(name, registry);
}

function findGuestInstanceByBaseUrl(baseUrl, registry = loadGuestRegistry()) {
  const normalizedBaseUrl = normalizeBaseUrlMatch(baseUrl);
  if (!normalizedBaseUrl) return null;
  return registry.find((record) => sameBaseUrl(record.localBaseUrl, normalizedBaseUrl) || sameBaseUrl(record.publicBaseUrl, normalizedBaseUrl)) || null;
}

function resolveRuntimeTarget(item, automation, fallbackBaseUrl = '') {
  const registry = loadGuestRegistry();
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
      : readOwnerToken();
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

function buildReplySubject(subject) {
  const trimmed = trimString(subject);
  if (!trimmed) return '';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
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

function extractReadableBodyFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return '';
  }

  try {
    const normalized = extractNormalizedMailboxContent({
      rawMessage: readFileSync(rawPath, 'utf8'),
    });
    return trimString(normalized.messageText) || trimString(normalized.previewText);
  } catch (error) {
    console.error(`[agent-mail-worker] extractReadableBodyFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return '';
  }
}

function extractAttachmentsFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return [];
  }

  try {
    return extractRawMessageAttachments(readFileSync(rawPath, 'utf8'), { includeData: true })
      .filter((attachment) => typeof attachment?.data === 'string' && attachment.data);
  } catch (error) {
    console.error(`[agent-mail-worker] extractAttachmentsFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return [];
  }
}

function buildReplyPrompt(item) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const date = trimString(item?.message?.date);
  const messageId = trimString(item?.message?.messageId);
  const rawDerivedBody = extractReadableBodyFromRaw(item);
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

function buildCompletionTarget(item, rootDir, requestId) {
  const messageId = trimString(item?.message?.messageId);
  const inReplyTo = trimString(item?.message?.inReplyTo);
  const references = trimString(item?.message?.replyReferences)
    || buildThreadReferencesHeader({
      messageId,
      inReplyTo,
      references: trimString(item?.message?.references),
    });
  return {
    id: `mailbox_email_${item.id}`,
    type: 'email',
    requestId,
    to: trimString(item?.message?.fromAddress),
    from: resolveReplyFromAddress(item),
    subject: buildReplySubject(item?.message?.subject),
    inReplyTo: messageId,
    references,
    mailboxRoot: rootDir,
    mailboxItemId: item.id,
  };
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
  return true;
}

async function submitApprovedItem(item, rootDir, automation, runtime) {
  const deliveryMode = normalizeDeliveryMode(automation.deliveryMode);
  const requestId = trimString(item?.automation?.requestId) || `${requestIdPrefixForMode(deliveryMode)}${item.id}`;
  const externalTriggerId = trimString(item?.message?.externalTriggerId)
    || buildEmailThreadExternalTriggerId({
      messageId: trimString(item?.message?.messageId),
      inReplyTo: trimString(item?.message?.inReplyTo),
      references: trimString(item?.message?.references),
    })
    || `mailbox:${item.id}`;
  const runtimeTarget = resolveRuntimeTarget(item, automation, runtime?.baseUrl || automation.chatBaseUrl);
  const effectiveRuntime = runtimeMatchesTarget(runtime, runtimeTarget)
    ? runtime
    : createRemoteLabRuntime(runtimeTarget.baseUrl, { authFile: runtimeTarget.authFile });
  const targetSelectionFile = runtimeTarget.configDir
    ? join(runtimeTarget.configDir, 'ui-runtime-selection.json')
    : undefined;
  const uiSelection = await loadUiRuntimeSelection(targetSelectionFile);
  const runtimeSelection = resolveReplyRuntimeSelection(automation, uiSelection);
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
  if (sessionName) {
    sessionPayload.name = sessionName;
  }
  if (deliveryMode === 'reply_email') {
    sessionPayload.completionTargets = [buildCompletionTarget(item, rootDir, requestId)];
  }

  const createResult = await requestRemoteLab(effectiveRuntime, '/api/sessions', {
    method: 'POST',
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const session = createResult.json.session;
  const messagePayload = {
    requestId,
    text: buildReplyPrompt(item),
    tool: runtimeSelection.tool,
  };
  const rawAttachmentCount = Number(item?.content?.attachmentCount) || 0;
  const attachments = extractAttachmentsFromRaw(item).map((attachment) => ({
    data: attachment.data,
    mimeType: attachment.mimeType,
    originalName: attachment.originalName,
  }));
  if (attachments.length > 0) {
    messagePayload.attachments = attachments;
  }
  if (rawAttachmentCount > 0 && attachments.length === 0) {
    messagePayload.text += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but they could not be extracted. The raw email is stored at: ${trimString(item?.storage?.rawPath)}`;
    console.error(`[agent-mail-worker] attachment extraction yielded 0 results for item ${item?.id} (expected ${rawAttachmentCount})`);
  } else if (rawAttachmentCount > 0 && attachments.length < rawAttachmentCount) {
    messagePayload.text += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but only ${attachments.length} could be extracted.`;
    console.warn(`[agent-mail-worker] partial attachment extraction for item ${item?.id}: ${attachments.length}/${rawAttachmentCount}`);
  }
  if (runtimeSelection.thinking) {
    messagePayload.thinking = true;
  }
  if (runtimeSelection.model) {
    messagePayload.model = runtimeSelection.model;
  }
  if (runtimeSelection.effort) {
    messagePayload.effort = runtimeSelection.effort;
  }

  const submitResult = await requestRemoteLab(effectiveRuntime, `/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: messagePayload,
  });
  const isQueued = submitResult.json?.queued === true;
  if (![200, 202].includes(submitResult.response.status) || (!submitResult.json?.run?.id && !isQueued)) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit session message (${submitResult.response.status})`);
  }

  const run = submitResult.json.run;
  const submittedStatus = submittedStatusForMode(deliveryMode);
  updateQueueItem(item.id, rootDir, (draft) => {
    draft.status = submittedStatus;
    draft.automation = {
      ...(draft.automation || {}),
      status: submittedStatus,
      deliveryMode,
      sessionId: session.id,
      runId: run?.id || null,
      requestId,
      externalTriggerId,
      targetBaseUrl: runtimeTarget.baseUrl,
      targetInstance: runtimeTarget.guestInstance || null,
      targetMailboxRoot: runtimeTarget.mailboxRoot || null,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: submitResult.json?.duplicate === true,
      queued: isQueued,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: session.id,
    runId: run?.id || null,
    queued: isQueued,
    duplicate: submitResult.json?.duplicate === true,
    deliveryMode,
    targetBaseUrl: runtimeTarget.baseUrl,
    targetInstance: runtimeTarget.guestInstance || null,
  };
}

async function runSweep({ rootDir, baseUrl, runtime = createRemoteLabRuntime(baseUrl) }) {
  const automation = loadMailboxAutomation(rootDir);
  const deliveryMode = normalizeDeliveryMode(automation.deliveryMode);
  if (automation.enabled === false) {
    return {
      processed: 0,
      skipped: 0,
      failures: [],
      reason: 'automation_disabled',
    };
  }

  const approvedItems = listQueue(APPROVED_QUEUE, rootDir).filter(shouldProcessItem);
  const successes = [];
  const failures = [];

  for (const item of approvedItems) {
    try {
      successes.push(await submitApprovedItem(item, rootDir, automation, runtime));
    } catch (error) {
      updateQueueItem(item.id, rootDir, (draft) => {
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
      failures.push({ itemId: item.id, error: error.message });
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

  return {
    processed: successes.length,
    skipped: listQueue(APPROVED_QUEUE, rootDir).length - approvedItems.length,
    successes,
    failures,
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
  const automation = loadMailboxAutomation(rootDir);
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
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runSweep({ rootDir, baseUrl, runtime });
      if (summary.processed > 0 || summary.failures.length > 0) {
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch (error) {
      console.error(`[agent-mail-worker] ${error.message}`);
    } finally {
      running = false;
    }
  };

  await loop();
  setInterval(loop, intervalMs);
}

export {
  createRemoteLabRuntime,
  ensureAuthCookie,
  requestRemoteLab,
  runSweep,
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

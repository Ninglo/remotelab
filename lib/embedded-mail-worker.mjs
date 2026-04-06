/**
 * Embedded mail worker — runs inside the chat server process.
 *
 * Instead of polling a remote chat server via HTTP, it calls
 * createSession / submitHttpMessage directly.  Each instance
 * processes only its own mailbox; no cross-instance awareness needed.
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';

import { CONFIG_DIR } from './config.mjs';
import { ensureEmailConnectorBinding } from './connector-bindings.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_AUTOMATION_SETTINGS,
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  decodeMaybeEncodedMailboxText,
  extractNormalizedMailboxContent,
  extractRawMessageAttachments,
  loadMailboxAutomation,
  loadIdentity,
  listQueue,
  updateQueueItem,
} from './agent-mailbox.mjs';
import { resolveExternalRuntimeSelection } from './external-runtime-selection.mjs';
import { loadUiRuntimeSelection } from './runtime-selection.mjs';

const MAILBOX_ROOT = join(CONFIG_DIR, 'agent-mailbox');
const DEFAULT_POLL_INTERVAL_MS = 5000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDeliveryMode(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'session_only' || normalized === 'session-only' || normalized === 'session') {
    return 'session_only';
  }
  return 'reply_email';
}

function normalizeEmailAddress(value) {
  return trimString(value).toLowerCase();
}

function splitEmailAddressParts(address) {
  const normalized = normalizeEmailAddress(address);
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === normalized.length - 1) {
    return { localPart: '', domain: '' };
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

function buildSessionName(item) {
  const subject = trimString(item?.message?.subject);
  const sender = trimString(item?.message?.fromAddress);
  return subject || sender || '';
}

function buildSessionDescription(item, fallbackDescription) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const fallback = trimString(fallbackDescription);
  return trimString(`Inbound email${sender ? ` from ${sender}` : ''}${subject ? ` about ${subject}` : ''}`) || fallback;
}

async function extractBodiesFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) return { body: '', htmlBody: '', hasNativePlainText: false };
  try {
    const normalized = extractNormalizedMailboxContent({
      rawMessage: await readFile(rawPath, 'utf8'),
    });
    // Use the full extracted text (including forwarded/quoted content) for AI consumption.
    // Reply segmentation strips forwarded message content which the user often needs the AI to process.
    const body = trimString(normalized.fullExtractedText) || trimString(normalized.messageText) || trimString(normalized.previewText);
    const htmlBody = trimString(normalized.rawHtmlBody);
    return { body, htmlBody, hasNativePlainText: normalized.hasNativePlainText };
  } catch (error) {
    console.error(`[embedded-mail-worker] extractBodiesFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return { body: '', htmlBody: '', hasNativePlainText: false };
  }
}

async function extractAttachmentsFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) return [];
  try {
    return extractRawMessageAttachments(await readFile(rawPath, 'utf8'), { includeData: true })
      .filter((a) => typeof a?.data === 'string' && a.data);
  } catch (error) {
    console.error(`[embedded-mail-worker] extractAttachmentsFromRaw failed for ${item?.id || 'unknown'}: ${error.message}`);
    return [];
  }
}

async function buildReplyPrompt(item) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const date = trimString(item?.message?.date);
  const messageId = trimString(item?.message?.messageId);
  const { body: rawDerivedBody, htmlBody, hasNativePlainText } = await extractBodiesFromRaw(item);
  const bodySource = trimString(item?.content?.extractedText) || trimString(item?.content?.preview);
  const decodedStoredBody = decodeMaybeEncodedMailboxText(bodySource, {
    contentType: trimString(item?.message?.headers?.['content-type']) || 'text/plain; charset=UTF-8',
    transferEncoding: trimString(item?.message?.headers?.['content-transfer-encoding']),
  });
  const body = rawDerivedBody || decodedStoredBody;

  const parts = [
    'Inbound email.',
    `- From: ${sender || '(unknown sender)'}`,
    `- Subject: ${subject || '(no subject)'}`,
    `- Date: ${date || '(no date)'}`,
    `- Message-ID: ${messageId || '(no message id)'}`,
    '',
    'Email body:',
    body || '(empty body)',
  ];

  // Include raw HTML only when it is the sole/primary representation (HTML-only emails,
  // styled tables, formatted forwarded messages).  When a native text/plain MIME part
  // exists, the plain text and HTML are alternative representations of the same content
  // (multipart/alternative), so including both would be redundant.
  if (htmlBody && !hasNativePlainText) {
    parts.push('', '<email-html>', htmlBody, '</email-html>');
  }

  return parts.join('\n');
}

function buildReplySubject(subject) {
  const trimmed = trimString(subject);
  if (!trimmed) return '';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

async function buildCompletionTarget(item, rootDir, requestId) {
  const messageId = trimString(item?.message?.messageId);
  const inReplyTo = trimString(item?.message?.inReplyTo);
  const references = trimString(item?.message?.replyReferences)
    || buildThreadReferencesHeader({
      messageId,
      inReplyTo,
      references: trimString(item?.message?.references),
    });
  const binding = await ensureEmailConnectorBinding({ rootDir });
  return {
    id: `mailbox_email_${item.id}`,
    type: 'email',
    requestId,
    bindingId: binding.id,
    to: trimString(item?.message?.fromAddress),
    from: resolveReplyFromAddress(item),
    subject: buildReplySubject(item?.message?.subject),
    inReplyTo: messageId,
    references,
    mailboxRoot: rootDir,
    mailboxItemId: item.id,
  };
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
  return true;
}

function expandHomePath(value) {
  const trimmed = trimString(value);
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/**
 * Submit an approved mailbox item by creating a session and sending a message.
 * Uses direct in-process calls instead of HTTP.
 *
 * @param {object} item - the queue item
 * @param {string} rootDir - mailbox root directory
 * @param {object} automation - mailbox automation config
 * @param {Function} createSession - session-manager.createSession
 * @param {Function} submitHttpMessage - session-manager.submitHttpMessage
 */
async function submitApprovedItem(item, rootDir, automation, createSession, submitHttpMessage, saveAttachments) {
  const deliveryMode = normalizeDeliveryMode(automation.deliveryMode);
  const requestId = trimString(item?.automation?.requestId) || `${requestIdPrefixForMode(deliveryMode)}${item.id}`;
  const externalTriggerId = trimString(item?.message?.externalTriggerId)
    || buildEmailThreadExternalTriggerId({
      messageId: trimString(item?.message?.messageId),
      inReplyTo: trimString(item?.message?.inReplyTo),
      references: trimString(item?.message?.references),
    })
    || `mailbox:${item.id}`;

  // Read this instance's own UI selection — no cross-instance awareness needed
  const uiSelection = await loadUiRuntimeSelection();
  const runtimeSelection = resolveReplyRuntimeSelection(automation, uiSelection);

  const folder = expandHomePath(automation.session.folder) || homedir();
  const completionTargets = deliveryMode === 'reply_email'
    ? [await buildCompletionTarget(item, rootDir, requestId)]
    : [];

  const session = await createSession(folder, runtimeSelection.tool, buildSessionName(item), {
    sourceId: 'email',
    sourceName: 'Email',
    group: automation.session.group,
    description: buildSessionDescription(item, automation.session.description),
    systemPrompt: automation.session.systemPrompt,
    externalTriggerId,
    completionTargets,
  });

  let messageText = await buildReplyPrompt(item);
  const rawAttachmentCount = Number(item?.content?.attachmentCount) || 0;
  const rawAttachments = await extractAttachmentsFromRaw(item);
  if (rawAttachmentCount > 0 && rawAttachments.length === 0) {
    messageText += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but they could not be extracted. The raw email is stored at: ${trimString(item?.storage?.rawPath)}`;
    console.error(`[embedded-mail-worker] attachment extraction yielded 0 results for item ${item?.id} (expected ${rawAttachmentCount})`);
  } else if (rawAttachmentCount > 0 && rawAttachments.length < rawAttachmentCount) {
    messageText += `\n\n⚠️ Warning: This email originally contained ${rawAttachmentCount} attachment(s) but only ${rawAttachments.length} could be extracted.`;
    console.warn(`[embedded-mail-worker] partial attachment extraction for item ${item?.id}: ${rawAttachments.length}/${rawAttachmentCount}`);
  }

  // Save attachments to disk via session-manager, then pass as preSavedAttachments
  const savedAttachments = rawAttachments.length > 0 && typeof saveAttachments === 'function'
    ? await saveAttachments(rawAttachments.map((a) => ({
        data: a.data,
        mimeType: a.mimeType,
        originalName: a.originalName,
      })))
    : [];

  const messageOptions = {
    requestId,
    tool: runtimeSelection.tool,
    thinking: runtimeSelection.thinking === true,
    model: runtimeSelection.model || undefined,
    effort: runtimeSelection.effort || undefined,
    ...(savedAttachments.length > 0 ? { preSavedAttachments: savedAttachments } : {}),
  };

  const outcome = await submitHttpMessage(session.id, messageText.trim(), [], messageOptions);

  const submittedStatus = submittedStatusForMode(deliveryMode);
  await updateQueueItem(item.id, rootDir, (draft) => {
    draft.status = submittedStatus;
    draft.automation = {
      ...(draft.automation || {}),
      status: submittedStatus,
      deliveryMode,
      sessionId: session.id,
      runId: outcome?.runId || null,
      requestId,
      externalTriggerId,
      targetBaseUrl: null,
      targetInstance: null,
      targetMailboxRoot: null,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: outcome?.duplicate === true,
      queued: outcome?.queued === true,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: session.id,
    runId: outcome?.runId || null,
    queued: outcome?.queued === true,
    duplicate: outcome?.duplicate === true,
    deliveryMode,
  };
}

async function runSweep(rootDir, createSession, submitHttpMessage, saveAttachments) {
  const automation = await loadMailboxAutomation(rootDir);
  const deliveryMode = normalizeDeliveryMode(automation.deliveryMode);
  if (automation.enabled === false) {
    return { processed: 0, skipped: 0, failures: [], reason: 'automation_disabled' };
  }

  const allApprovedItems = await listQueue(APPROVED_QUEUE, rootDir);
  const approvedItems = allApprovedItems.filter(shouldProcessItem);
  const successes = [];
  const failures = [];

  for (const item of approvedItems) {
    try {
      successes.push(await submitApprovedItem(item, rootDir, automation, createSession, submitHttpMessage, saveAttachments));
    } catch (error) {
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
      failures.push({ itemId: item.id, error: error.message });
    }
  }

  return {
    processed: successes.length,
    skipped: allApprovedItems.length - approvedItems.length,
    successes,
    failures,
  };
}

/**
 * Start the embedded mail worker polling loop.
 *
 * @param {object} deps - injected dependencies
 * @param {Function} deps.createSession - session-manager.createSession
 * @param {Function} deps.submitHttpMessage - session-manager.submitHttpMessage
 * @param {Function} [deps.saveAttachments] - session-manager.saveAttachments
 * @param {number}  [deps.intervalMs] - polling interval (default 5000)
 * @returns {{ stop: Function }} - call stop() to halt the loop
 */
export async function startEmbeddedMailWorker({ createSession, submitHttpMessage, saveAttachments, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const identity = await loadIdentity(MAILBOX_ROOT);
  if (!identity) {
    return null;
  }

  const automation = await loadMailboxAutomation(MAILBOX_ROOT);
  if (automation.enabled === false) {
    console.log('[embedded-mail-worker] mailbox automation is disabled, skipping');
    return null;
  }

  console.log(`[embedded-mail-worker] starting — mailbox ${trimString(identity.address)}, polling every ${intervalMs}ms`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runSweep(MAILBOX_ROOT, createSession, submitHttpMessage, saveAttachments);
      if (summary.processed > 0 || summary.failures.length > 0) {
        console.log(`[embedded-mail-worker] sweep: ${summary.processed} processed, ${summary.failures.length} failed`);
      }
    } catch (error) {
      console.error(`[embedded-mail-worker] sweep error: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Run the first sweep immediately
  void tick();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

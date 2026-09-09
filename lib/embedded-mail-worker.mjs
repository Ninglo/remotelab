/**
 * Embedded mail worker — runs inside the chat server process.
 *
 * Instead of polling a remote chat server via HTTP, it calls
 * createSession / submitHttpMessage directly.  Each instance
 * processes only its own mailbox; no cross-instance awareness needed.
 */

import { buildEmailSourceContext } from './email-source-context.mjs';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';

import { CONFIG_DIR } from './config.mjs';
import {
  buildEmailSourceDelivery,
  buildEmailSourceDeliveryTarget,
  buildEmailSourceRouteId,
} from './agent-mail-source-delivery.mjs';
import {
  processEmailSourceDeliveryInProcess,
  startEmailSourceDeliveryInProcessPoller,
} from './agent-mail-source-delivery-sender.mjs';
import { ensureEmailConnectorBinding } from './connector-bindings.mjs';
import {
  claimSourceDelivery,
  completeSourceDelivery,
  failSourceDelivery,
} from '../chat/source-deliveries.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_AUTOMATION_SETTINGS,
  buildEmailThreadExternalTriggerId,
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

function envFlagEnabled(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off'].includes(normalized);
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
  const { body: rawDerivedBody, htmlBody, hasNativePlainText } = await extractBodiesFromRaw(item);
  const bodySource = trimString(item?.content?.extractedText) || trimString(item?.content?.preview);
  const decodedStoredBody = decodeMaybeEncodedMailboxText(bodySource, {
    contentType: trimString(item?.message?.headers?.['content-type']) || 'text/plain; charset=UTF-8',
    transferEncoding: trimString(item?.message?.headers?.['content-transfer-encoding']),
  });
  const body = rawDerivedBody || decodedStoredBody;

  const parts = [body || '(empty body)'];

  // Include raw HTML only when it is the sole/primary representation (HTML-only emails,
  // styled tables, formatted forwarded messages).  When a native text/plain MIME part
  // exists, the plain text and HTML are alternative representations of the same content
  // (multipart/alternative), so including both would be redundant.
  if (htmlBody && !hasNativePlainText) {
    parts.push('', '<email-html>', htmlBody, '</email-html>');
  }

  return parts.join('\n');
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
  // Items with a persisted preparedSessionId are mid-submission (session
  // created, message not yet submitted).  Allow them through for retry.
  if (trimString(item?.automation?.preparedSessionId)) return true;
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
  const prepared = item?.automation?.preparedSubmission;
  const deliveryMode = normalizeDeliveryMode(prepared?.deliveryMode || automation.deliveryMode);
  const requestId = trimString(prepared?.options?.requestId || item?.automation?.requestId) || `${requestIdPrefixForMode(deliveryMode)}${item.id}`;
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

  // ─── PHASE 1: create or reuse session (durable) ───────────────────────────
  // If a previous sweep created the session but the process crashed before
  // submitHttpMessage completed, reuse the persisted session ID.
  let preparedSessionId = trimString(prepared?.sessionId || item?.automation?.preparedSessionId);

  if (!preparedSessionId) {
    // Legacy explicit completion targets from automation config are forwarded;
    // the worker itself no longer adds email completionTargets for new requests.
    const explicitCompletionTargets = Array.isArray(automation.session?.completionTargets)
      ? automation.session.completionTargets
      : [];

    const session = await createSession(folder, runtimeSelection.tool, buildSessionName(item), {
      sourceId: 'email',
      sourceName: 'Email',
      group: automation.session.group,
      description: buildSessionDescription(item, automation.session.description),
      systemPrompt: automation.session.systemPrompt,
      externalTriggerId,
      ...(explicitCompletionTargets.length > 0 ? { completionTargets: explicitCompletionTargets } : {}),
    });

    preparedSessionId = session.id;

    // Persist the session ID before submitting the message.  If the process
    // crashes here the next sweep will reuse this session rather than creating
    // a duplicate.  requestId deduplication makes message submission idempotent.
    await updateQueueItem(item.id, rootDir, (draft) => {
      draft.automation = {
        ...(draft.automation || {}),
        preparedSessionId,
        requestId,
        externalTriggerId,
        updatedAt: nowIso(),
      };
      return draft;
    });
  }

  // Persist exact text, saved attachment references and runtime options
  // before admission. Session id alone cannot prevent a changed-body conflict.
  let messageText = prepared?.text;
  let messageOptions = prepared?.options;
  if (!messageOptions) {
  messageText = await buildReplyPrompt(item);
  const rawAttachmentCount = Number(item?.content?.attachmentCount) || 0;
  const rawAttachments = await extractAttachmentsFromRaw(item);
  if (rawAttachmentCount > 0 && rawAttachments.length === 0) {
    console.error(`[embedded-mail-worker] attachment extraction yielded 0 results for item ${item?.id} (expected ${rawAttachmentCount})`);
  } else if (rawAttachmentCount > 0 && rawAttachments.length < rawAttachmentCount) {
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

  // For reply_email mode, pass a sourceDelivery plan so the request's outbox
  // records the reply target durably.  The in-process email sender claims and
  // sends these; we no longer use completionTargets for worker submissions.
  const emailSourceDelivery = deliveryMode === 'reply_email'
    ? buildEmailSourceDelivery(
        buildEmailSourceRouteId(rootDir),
        buildEmailSourceDeliveryTarget(item),
      )
    : undefined;

  messageOptions = {
    sourceContext: buildEmailSourceContext(item, rootDir, rawAttachments.length),
    requestId,
    tool: runtimeSelection.tool,
    thinking: runtimeSelection.thinking === true,
    model: runtimeSelection.model || undefined,
    effort: runtimeSelection.effort || undefined,
    ...(savedAttachments.length > 0 ? { preSavedAttachments: savedAttachments } : {}),
    ...(emailSourceDelivery ? { sourceDelivery: emailSourceDelivery } : {}),
  };

  await updateQueueItem(item.id, rootDir, draft => {
    draft.automation = { ...(draft.automation || {}), preparedSubmission: {
      sessionId: preparedSessionId, text: messageText.trim(), options: messageOptions, deliveryMode,
    } };
    return draft;
  });
  }
  const outcome = await submitHttpMessage(preparedSessionId, messageText.trim(), [], messageOptions);

  const submittedStatus = submittedStatusForMode(deliveryMode);
  await updateQueueItem(item.id, rootDir, (draft) => {
    const status = draft.status === 'reply_sent' || draft.automation?.status === 'reply_sent' ? 'reply_sent' : submittedStatus;
    draft.status = status;
    draft.automation = {
      ...(draft.automation || {}),
      status,
      deliveryMode,
      sessionId: preparedSessionId,
      runId: outcome?.run?.id || outcome?.runId || null,
      requestId,
      externalTriggerId,
      targetBaseUrl: null,
      targetInstance: null,
      targetMailboxRoot: null,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: outcome?.duplicate === true,
      queued: outcome?.queued === true,
      // Clear the prepared flag now that submission is complete.
      preparedSessionId: null,
      preparedSubmission: null,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: preparedSessionId,
    runId: outcome?.run?.id || outcome?.runId || null,
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
      if (error.permanent) {
        // Definite failure (e.g. bad session state): mark permanently failed.
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
        // Transient failure: leave retriable; preparedSessionId (if set) lets
        // the next sweep reuse the session without creating a duplicate.
        await updateQueueItem(item.id, rootDir, (draft) => {
          draft.automation = {
            ...(draft.automation || {}),
            lastError: error.message,
            updatedAt: nowIso(),
          };
          return draft;
        }).catch(() => {});
      }
      failures.push({ itemId: item.id, error: error.message, permanent: error.permanent === true });
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
  if (envFlagEnabled(process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER)) {
    console.log('[embedded-mail-worker] disabled by REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER');
    return null;
  }

  const identity = await loadIdentity(MAILBOX_ROOT);
  if (!identity) {
    return null;
  }
  await ensureEmailConnectorBinding({ rootDir: MAILBOX_ROOT });

  const automation = await loadMailboxAutomation(MAILBOX_ROOT);
  if (automation.enabled === false) {
    console.log('[embedded-mail-worker] mailbox automation is disabled, skipping');
    return null;
  }

  console.log(`[embedded-mail-worker] starting — mailbox ${trimString(identity.address)}, polling every ${intervalMs}ms`);

  // ── admission sweep: ingest approved items into RemoteLab sessions ────────
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
  void tick(); // first sweep immediately

  // ── delivery sender: claim outbox records and send outbound email ────────
  // The admission sweep creates sourceDelivery records in the request outbox
  // when reply_email mode is active.  This in-process sender claims them,
  // sends the outbound email, and updates the mailbox item to reply_sent.
  // It runs in the same process so no external standalone worker is needed.
  const sourceRouteId = buildEmailSourceRouteId(MAILBOX_ROOT);
  const deliverySenderPoller = startEmailSourceDeliveryInProcessPoller({
    claimFn: claimSourceDelivery,
    completeFn: completeSourceDelivery,
    failFn: failSourceDelivery,
    sourceRouteId,
    mailboxRoot: MAILBOX_ROOT,
    // pollMs slightly faster than admission so replies go out quickly
    pollMs: Math.max(250, Math.floor(intervalMs / 2)),
  });

  return {
    stop() {
      clearInterval(timer);
      deliverySenderPoller.stop();
    },
  };
}

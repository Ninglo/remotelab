import { selectAssistantReplyEvent, stripHiddenBlocks } from './reply-selection.mjs';
import { loadHistory } from '../chat/history.mjs';
import { getRun, updateRun } from '../chat/runs.mjs';
import { sendOutboundEmail } from './agent-mail-outbound.mjs';
import { loadIdentity, loadOutboundConfig, updateQueueItem } from './agent-mailbox.mjs';

const TARGET_STALE_MS = 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

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

function normalizeSubject(value) {
  return trimString(value);
}

function targetStateIsStale(state) {
  const startedAt = Date.parse(state?.startedAt || '');
  if (!Number.isFinite(startedAt)) return true;
  return (Date.now() - startedAt) > TARGET_STALE_MS;
}

function summarizeDeliveryResult(result) {
  return {
    provider: trimString(result?.provider),
    statusCode: Number.isInteger(result?.statusCode) ? result.statusCode : null,
    responseId: firstNonEmpty(result?.summary?.id, result?.response?.id, result?.response?.messageId),
    responseMessage: firstNonEmpty(result?.summary?.message, result?.response?.message),
  };
}

function sanitizeEmailTarget(target, index) {
  const to = trimString(target?.to);
  if (!to) return null;
  const id = firstNonEmpty(target?.id, `email_target_${index + 1}`);
  return {
    id,
    type: 'email',
    enabled: target?.enabled !== false,
    requestId: trimString(target?.requestId),
    to,
    from: trimString(target?.from),
    subject: normalizeSubject(target?.subject),
    inReplyTo: trimString(target?.inReplyTo),
    references: trimString(target?.references),
    mailboxRoot: trimString(target?.mailboxRoot),
    mailboxItemId: trimString(target?.mailboxItemId),
  };
}

export function sanitizeEmailCompletionTargets(targets = []) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target, index) => {
      const type = trimString(target?.type || target?.kind).toLowerCase();
      if (type !== 'email') return null;
      return sanitizeEmailTarget(target, index);
    })
    .filter(Boolean);
}

async function resolveAssistantReply(sessionId, run) {
  const events = await loadHistory(sessionId, { includeBodies: true });
  const assistantMessage = await selectAssistantReplyEvent(events, {
    match: (event) => {
      if (run?.id && event.runId === run.id) return true;
      if (run?.requestId && event.requestId === run.requestId) return true;
      return false;
    },
  });

  const content = stripHiddenBlocks(assistantMessage?.content || '');
  if (!content) {
    throw new Error('No assistant reply content was found for this run');
  }

  return {
    assistantMessage,
    content,
  };
}

function updateMailboxDelivery(target, session, run, state, extra = {}) {
  if (!target.mailboxRoot || !target.mailboxItemId) return;
  updateQueueItem(target.mailboxItemId, target.mailboxRoot, (item) => {
    item.status = state === 'sent'
      ? 'reply_sent'
      : state === 'failed'
        ? 'reply_failed'
        : 'processing_for_reply';
    item.automation = {
      ...(item.automation || {}),
      status: item.status,
      sessionId: session?.id || item.automation?.sessionId || null,
      runId: run?.id || item.automation?.runId || null,
      requestId: run?.requestId || item.automation?.requestId || null,
      updatedAt: nowIso(),
      ...(state === 'sent'
        ? {
            repliedAt: nowIso(),
            delivery: {
              ...(item.automation?.delivery || {}),
              ...extra,
            },
          }
        : state === 'failed'
          ? { lastError: trimString(extra.error) }
          : {}),
    };
    return item;
  });
}

async function deliverEmailTarget(target, session, run, options = {}) {
  const { content } = await resolveAssistantReply(session.id, run);
  const mailboxRoot = target.mailboxRoot || undefined;
  const outboundConfig = loadOutboundConfig(mailboxRoot);
  const identity = loadIdentity(mailboxRoot);
  const result = await sendOutboundEmail({
    to: target.to,
    from: firstNonEmpty(target.from, outboundConfig.from, identity?.address),
    subject: target.subject,
    text: content,
    inReplyTo: target.inReplyTo,
    references: target.references,
  }, outboundConfig, options);

  const summary = summarizeDeliveryResult(result);
  updateMailboxDelivery(target, session, run, 'sent', summary);
  return summary;
}

function shouldDispatchTarget(target, run, currentState) {
  if (!target?.enabled) return false;
  if (target.requestId && trimString(run?.requestId) !== target.requestId) return false;
  if (currentState?.state === 'sent') return false;
  if (currentState?.state === 'sending' && !targetStateIsStale(currentState)) return false;
  return true;
}

export async function dispatchSessionEmailCompletionTargets(session, run, options = {}) {
  const targets = sanitizeEmailCompletionTargets(session?.completionTargets || []);
  if (!session?.id || !run?.id || targets.length === 0) {
    return [];
  }

  const results = [];
  for (const target of targets) {
    const currentRun = await getRun(run.id) || run;
    const currentState = currentRun.completionTargets?.[target.id] || null;
    if (!shouldDispatchTarget(target, currentRun, currentState)) {
      continue;
    }

    const startedAt = nowIso();
    await updateRun(run.id, (existing) => ({
      ...existing,
      completionTargets: {
        ...(existing.completionTargets || {}),
        [target.id]: {
          ...(existing.completionTargets?.[target.id] || {}),
          state: 'sending',
          startedAt,
          attempts: (existing.completionTargets?.[target.id]?.attempts || 0) + 1,
          lastError: null,
        },
      },
    }));
    updateMailboxDelivery(target, session, currentRun, 'sending');

    try {
      const summary = await deliverEmailTarget(target, session, currentRun, options);
      const deliveredAt = nowIso();
      await updateRun(run.id, (existing) => ({
        ...existing,
        completionTargets: {
          ...(existing.completionTargets || {}),
          [target.id]: {
            ...(existing.completionTargets?.[target.id] || {}),
            state: 'sent',
            deliveredAt,
            delivery: summary,
            lastError: null,
          },
        },
      }));
      results.push({ id: target.id, state: 'sent', delivery: summary });
    } catch (error) {
      const failedAt = nowIso();
      await updateRun(run.id, (existing) => ({
        ...existing,
        completionTargets: {
          ...(existing.completionTargets || {}),
          [target.id]: {
            ...(existing.completionTargets?.[target.id] || {}),
            state: 'failed',
            failedAt,
            lastError: error.message,
          },
        },
      }));
      updateMailboxDelivery(target, session, currentRun, 'failed', { error: error.message });
      results.push({ id: target.id, state: 'failed', error: error.message });
    }
  }

  return results;
}

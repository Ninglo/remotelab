/**
 * Email / Agent Mailbox source-delivery contract helpers.
 *
 * Builds the sourceDelivery plan that is passed in the message payload when an
 * approved mailbox item is submitted to RemoteLab.  The plan is persisted as
 * part of the request record so the independent email sender can claim and
 * dispatch it durably, even across process restarts or HTTP response loss.
 *
 * Contract with chat/source-deliveries.mjs:
 *   connector:     'email'
 *   sourceRouteId: stable binding ID for this mailbox (buildEmailBindingId(rootDir))
 *   target: {
 *     to:         string   – reply-to address
 *     subject:    string   – Re: …
 *     inReplyTo:  string   – Message-ID of the triggering message
 *     references: string[] – ordered list of thread Message-IDs (ARRAY)
 *     messageId:  string   – Message-ID of the triggering message (same as inReplyTo)
 *     threadId:   string   – earliest known thread root Message-ID (for ordering)
 *   }
 *
 * buildReplyDeliveries for 'email' returns ONE entry with both text and
 * attachments (not split), matching the shared request-outbox contract.
 */

import { buildEmailBindingId } from './connector-bindings.mjs';
import { buildThreadReferencesHeader } from './agent-mailbox-mime.mjs';

export const EMAIL_CONNECTOR_ID = 'email';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse an RFC 2822 References / In-Reply-To header value into an ordered,
 * deduplicated array of angle-bracketed Message-IDs.
 */
export function parseReferencesArray(value) {
  if (!value || typeof value !== 'string') return [];
  const matches = value.match(/<[^>\r\n]+>/g) || [];
  return [...new Set(matches)];
}

/**
 * Build the reply subject from the original subject, adding "Re: " if absent.
 */
export function buildEmailReplySubject(subject) {
  const trimmed = trimString(subject);
  if (!trimmed) return '';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Resolve the outbound From address for a reply.
 *
 * Uses the effective/envelope To address when it shares the same domain as the
 * configured mailbox identity, so alias sub-addresses (e.g. rowan+guest@…) are
 * preserved in the reply From.
 */
export function resolveEmailReplyFromAddress(item) {
  const normalizeAddress = (v) => trimString(v).toLowerCase();
  const replyFrom = normalizeAddress(item?.message?.effectiveToAddress)
    || normalizeAddress(item?.message?.envelopeToAddress)
    || normalizeAddress(item?.message?.toAddress);
  const identityAddress = normalizeAddress(item?.identity?.address);
  if (!replyFrom || !identityAddress) return '';
  const atIndex = replyFrom.lastIndexOf('@');
  if (atIndex === -1) return '';
  const domain = replyFrom.slice(atIndex + 1);
  const identityAtIndex = identityAddress.lastIndexOf('@');
  if (identityAtIndex === -1) return '';
  const identityDomain = identityAddress.slice(identityAtIndex + 1);
  if (!domain || domain !== identityDomain) return '';
  return replyFrom;
}

/**
 * Build the email target object from an approved mailbox queue item.
 *
 * Returns the email-connector target shape expected by source-deliveries.mjs:
 *   { to, from, subject, inReplyTo, references: string[], messageId, threadId }
 */
export function buildEmailSourceDeliveryTarget(item) {
  const messageId = trimString(item?.message?.messageId);
  const inReplyTo = trimString(item?.message?.inReplyTo);
  const rawReferences = trimString(item?.message?.references);
  // replyReferences may already be the pre-built References header string.
  const replyReferences = trimString(item?.message?.replyReferences);

  const referencesStr = replyReferences || buildThreadReferencesHeader({
    messageId,
    inReplyTo,
    references: rawReferences,
  });
  const references = parseReferencesArray(referencesStr);

  // threadId is the earliest message-ID in the thread for stable ordering.
  const threadId = references[0] || messageId;

  const target = {
    to: trimString(item?.message?.fromAddress),
    subject: buildEmailReplySubject(item?.message?.subject),
    inReplyTo: messageId,
    references,
    messageId,
    threadId,
  };

  const from = resolveEmailReplyFromAddress(item);
  if (from) target.from = from;

  return target;
}

/**
 * Build the full sourceDelivery plan for an email queue item.
 *
 * @param {string} sourceRouteId  – stable binding ID (buildEmailBindingId(rootDir))
 * @param {object} target         – result of buildEmailSourceDeliveryTarget(item)
 */
export function buildEmailSourceDelivery(sourceRouteId, target) {
  return {
    connector: EMAIL_CONNECTOR_ID,
    sourceRouteId: trimString(sourceRouteId) || 'default',
    target,
  };
}

/**
 * Derive the sourceRouteId for a given mailbox root.
 * Uses the deterministic binding ID so the sender and the worker agree.
 */
export function buildEmailSourceRouteId(rootDir) {
  return buildEmailBindingId(rootDir);
}

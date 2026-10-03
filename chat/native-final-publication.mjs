import { isFinalAssistantMessage } from '../lib/assistant-message-phase.mjs';
import { assistantSurfaceMessageId, collectAssistantSurfaceMessages, parseProgressMessage } from '../lib/assistant-surface-messages.mjs';
import { getAssistantReplyAttachments } from '../lib/reply-selection.mjs';
import { appendDeliveries } from './requests.mjs';
import { buildReplyDeliveries } from '../lib/reply-deliveries.mjs';
import { buildReplyPublicationPayload } from './reply-publication.mjs';
import { resolveAmbientFeishuReplyPlan } from './ambient-feishu-reply.mjs';
import {
  extractAssistantArtifactBlockReferences, extractAssistantLocalMarkdownImageReferences,
  collectGeneratedResultFilesFromRun, collectAssistantLocalMarkdownImageRewrites,
  normalizePublishedResultAssetAttachments,
  rewriteAssistantLocalMarkdownImageTargets,
} from './session-result-files.mjs';
import { publishLocalFileAssetFromPath } from './file-assets.mjs';
import { projectWorkboards } from '../lib/workboard-state.mjs';
import { appendSessionEntryFooter, buildSessionEntry } from '../lib/session-navigation.mjs';
import { normalizeConversation } from '../lib/conversation-target.mjs';

export async function prepareNativeFinalFiles(record, event, { run, manifest, publishAsset = publishLocalFileAssetFromPath } = {}) {
  const references = [...extractAssistantArtifactBlockReferences(event.content), ...extractAssistantLocalMarkdownImageReferences(event.content)];
  if (!references.length) return event;
  const files = await collectGeneratedResultFilesFromRun(run, manifest, [event]);
  // A missing file is still unready: leave this answer for terminal publication.
  if (files.length < new Set(references.map(ref => ref.candidate)).size) return null;
  const assets = await Promise.all(files.map(async file => {
    const asset = await publishAsset({ ...file, sessionId: record.sessionId, createdBy: 'assistant' });
    return { ...file, assetId: asset.id, originalName: asset.originalName || file.originalName,
      mimeType: asset.mimeType || file.mimeType, sizeBytes: asset.sizeBytes };
  }));
  const next = { ...event, seq: event.seq || 1, attachments: [
    ...(event.attachments || []), ...normalizePublishedResultAssetAttachments(assets),
  ] };
  next.localMarkdownImageRewrites = await collectAssistantLocalMarkdownImageRewrites(manifest, [next], assets);
  next.content = rewriteAssistantLocalMarkdownImageTargets(next.content,
    new Map(next.localMarkdownImageRewrites.map(rewrite => [rewrite.candidate, rewrite.url])));
  return next;
}

// Admitted Feishu progress uses its durable route worker, with or without an
// acceptance list. Openings, questions and finals retain the normal outbox.
export async function publishLiveAssistantReplies(record, events, { store, plan, session, fullHistory = events, running = true, prepareFinal = async event => event } = {}) {
  if (!record || record.result || record.options?.suppressSourceDelivery || record.options?.internalOperation
      || !plan) return;
  const cardProgressSeqs = session?.workboardPilot === true
    ? new Set(projectWorkboards(fullHistory).flatMap(task => task.progressHistory.map(progress => progress.seq))) : new Set();
  const groupedProgress = plan.connector === 'feishu' && session?.workboardPilot === true
    && fullHistory.some(event => event.type === 'message' && event.role === 'user' && event.runId === record.runId
      && event.workboardAdmission?.personId && event.workboardAdmission?.identityId
      && event.workboardAdmission.sourceRouteId === session.conversation?.sourceRouteId
      && event.sourceContext?.connector === 'feishu'
      && event.sourceContext?.sourceRouteId === session.conversation?.sourceRouteId
      && event.sourceContext?.chatType === session.conversation?.target?.chatType
      && event.sourceContext?.chatId === session.conversation?.target?.chatId
      && plan.target?.chatId === session.conversation?.target?.chatId
      && (!session.conversation?.target?.tenantKey || event.sourceContext?.tenantKey === session.conversation.target.tenantKey)
      && event.workboardAdmission.senderOpenId === event.sourceContext?.sender?.openId);
  for (const [event, surface] of collectAssistantSurfaceMessages(events || [])) {
    // The same history drives the card publisher. A card update is never also
    // queued as a separate chat message; openings, questions and finals remain.
    if (cardProgressSeqs.has(event.seq)) continue;
    if (groupedProgress && surface.surfaceKind === 'progress') continue;
    // Without a phase, a direct answer is indistinguishable from an opening.
    // Wait for terminal publication unless the Harness explicitly marks progress.
    if (plan.connector === 'feishu' && !event.phase && surface.surfaceKind === 'opening'
        && !parseProgressMessage(event.content).progress) continue;
    const messageId = assistantSurfaceMessageId(event);
    if (!messageId) continue;
    const stored = await store.get(record.key);
    if (stored?.streamedSurfaceMessageIds?.includes(messageId)
        || stored?.streamedFinalReplyIds?.includes(messageId)) continue;
    const final = isFinalAssistantMessage(event);
    // An early final is not a stopped execution. Feishu sends the result once
    // execution stops, rather than announcing delivery while work continues.
    if (plan.connector === 'feishu' && final && running) continue;
    // Cold recovery of a stopped execution publishes its result, not stale
    // openings or intermediate updates labeled as separate deliveries.
    if (plan.connector === 'feishu' && !final && !running) continue;
    let prepared;
    try { prepared = await prepareFinal(surface); }
    catch (error) {
      // Asset transport failure must not freeze Run observation or other final
      // messages. The terminal asset path still owns this deferred answer.
      console.error(`[live-reply-publication] deferred ${messageId}: ${error.message}`);
      continue;
    }
    if (!prepared) continue;
    const includeEntry = plan.connector === 'feishu' && Boolean(session?.id)
      && ['opening', 'final'].includes(surface.surfaceKind)
      && fullHistory.filter(item => item.type === 'message' && item.role === 'user').length === 1
      && !stored?.deliveries?.some(item => item.kind === 'session_entry' || item.sessionEntryIncluded);
    const entry = includeEntry ? buildSessionEntry(session) : null;
    const payload = final ? buildReplyPublicationPayload([prepared], {
      id: record.runId, responseId: record.responseId,
    }, { session, includeSessionEntry: Boolean(entry) }) : {
      text: appendSessionEntryFooter(prepared.content, entry), attachments: getAssistantReplyAttachments(prepared),
    };
    const parts = buildReplyDeliveries(resolveAmbientFeishuReplyPlan(record, plan, [event]), payload, {
      running,
      surfaceKind: surface.surfaceKind,
      requireFeishuOutcome: final && record.options?.sourceContext?.feishuOutcomeRequired === true,
    });
    if (!parts.length) continue;
    await store.mutate(record.key, current => {
      if (!current || current.result
          || current.streamedSurfaceMessageIds?.includes(messageId)
          || current.streamedFinalReplyIds?.includes(messageId)) return current;
      return {
        ...current,
        streamedSurfaceMessageIds: [...(current.streamedSurfaceMessageIds || []), messageId],
        ...(final ? { streamedFinalReplyIds: [...(current.streamedFinalReplyIds || []), messageId] } : {}),
        deliveries: appendDeliveries(current, parts.map(part => ({
          ...part, providerMessageId: messageId, surfaceKind: surface.surfaceKind,
          ...(entry && part.kind === 'content' ? { sessionEntryIncluded: true } : {}),
          providerPartCount: parts.filter(part => ['content', 'attachment'].includes(part.kind)).length,
          triggerId: current.options?.triggerId || '',
          scheduleId: current.options?.scheduleId || '',
          occurrenceId: current.options?.occurrenceId || '',
        }))),
      };
    });
  }
}

// Compatibility for existing callers and already persisted final receipts.
export const publishNativeFinalReplies = publishLiveAssistantReplies;

// Terminal settlement can publish a final before the live observer sees it.
// Preserve the same answer identity and multipart count on that fallback path.
// Ambiguous bundles cannot borrow one answer's receipt for another task.
export function annotateTerminalReplyDeliveries(parts, payload) {
  const finals = (payload?.displayEvents || []).filter(isFinalAssistantMessage);
  const ids = new Set(finals.map(assistantSurfaceMessageId).filter(Boolean));
  if (ids.size !== 1) return parts;
  const providerMessageId = [...ids][0];
  const providerPartCount = parts.filter(part => ['content', 'attachment'].includes(part.kind)).length;
  return parts.map(part => ['content', 'attachment'].includes(part.kind)
    ? { ...part, providerMessageId, providerPartCount, surfaceKind: 'final' } : part);
}

// Recover old terminal receipts only from an exact retained payload match.
// This associates evidence; it neither sends nor changes a delivery outcome.
export function recoverTerminalReplyReceipt(record, delivery) {
  if (delivery.providerMessageId || delivery.workboardTaskId || delivery.surfaceKind
      || record.result?.state !== 'completed' || !record.result.payload
      || !['content', 'attachment'].includes(delivery.kind)) return null;
  const plan = normalizeConversation(record.deliveryPlan || record.options?.sourceDelivery);
  const parts = annotateTerminalReplyDeliveries(buildReplyDeliveries(plan, record.result.payload, { running: false }), record.result.payload);
  const matches = part => part.kind === delivery.kind && part.text === delivery.text
    && part.connector === delivery.connector && part.sourceRouteId === delivery.sourceRouteId
    && part.target?.chatId === delivery.target?.chatId
    && part.target?.commentId === delivery.target?.commentId
    && part.target?.to === delivery.target?.to
    && part.target?.peerUserId === delivery.target?.peerUserId
    && JSON.stringify(part.attachment) === JSON.stringify(delivery.attachment);
  const candidates = parts.filter(matches);
  if (candidates.length !== 1 || !candidates[0].providerMessageId
      || record.deliveries.filter(matches).length !== 1) return null;
  const { providerMessageId, providerPartCount } = candidates[0];
  return { providerMessageId, providerPartCount, receiptRecovered: true };
}

export function excludePublishedFinalReplies(history, publishedIds = []) {
  if (!publishedIds.length) return history;
  const published = new Set(publishedIds);
  // Terminal asset collection may append a phase-less fallback for files
  // already attached to a streamed final. Keep the original final-only
  // behavior in that case, while retaining legacy finals after progress.
  const finalPublished = history.some(event => isFinalAssistantMessage(event)
    && published.has(assistantSurfaceMessageId(event)));
  return history.filter(event => event?.type !== 'message' || event.role !== 'assistant'
    || (!published.has(assistantSurfaceMessageId(event)) && (!finalPublished || isFinalAssistantMessage(event))));
}

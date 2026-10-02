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

// Openings, explicit progress, and completed finals enter the same durable
// outbox. Selection and receipt keys survive observer replay and restarts.
export async function publishLiveAssistantReplies(record, events, { store, plan, session, running = true, prepareFinal = async event => event } = {}) {
  if (!record || record.result || record.options?.suppressSourceDelivery || record.options?.internalOperation
      || !plan) return;
  for (const [event, surface] of collectAssistantSurfaceMessages(events || [])) {
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
    try { prepared = await prepareFinal(final ? event : surface); }
    catch (error) {
      // Asset transport failure must not freeze Run observation or other final
      // messages. The terminal asset path still owns this deferred answer.
      console.error(`[live-reply-publication] deferred ${messageId}: ${error.message}`);
      continue;
    }
    if (!prepared) continue;
    const payload = final ? buildReplyPublicationPayload([prepared], {
      id: record.runId, responseId: record.responseId,
    }, { session, includeSessionEntry: false }) : {
      text: prepared.content, attachments: getAssistantReplyAttachments(prepared),
    };
    const parts = buildReplyDeliveries(resolveAmbientFeishuReplyPlan(record, plan, [event]), payload, {
      running,
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

import { isFinalAssistantMessage } from '../lib/assistant-message-phase.mjs';
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

// A completed final message is a delivery boundary even when native steering
// keeps the same Run alive. Commit its receipt key and outbox parts together.
export async function publishNativeFinalReplies(record, events, { store, plan, session, prepareFinal = async event => event } = {}) {
  if (!record || record.result || record.options?.suppressSourceDelivery || record.options?.internalOperation
      || plan?.connector !== 'feishu') return;
  for (const event of events || []) {
    if (!isFinalAssistantMessage(event) || !event.providerMessageId) continue;
    if ((await store.get(record.key))?.streamedFinalReplyIds?.includes(event.providerMessageId)) continue;
    let prepared;
    try { prepared = await prepareFinal(event); }
    catch (error) {
      // Asset transport failure must not freeze Run observation or other final
      // messages. The terminal asset path still owns this deferred answer.
      console.error(`[native-final-publication] deferred ${event.providerMessageId}: ${error.message}`);
      continue;
    }
    if (!prepared) continue;
    const payload = buildReplyPublicationPayload([prepared], {
      id: record.runId, responseId: record.responseId,
    }, { session, includeSessionEntry: false });
    const parts = buildReplyDeliveries(resolveAmbientFeishuReplyPlan(record, plan, [event]), payload, {
      requireFeishuOutcome: record.options?.sourceContext?.feishuOutcomeRequired === true,
    });
    if (!parts.length) continue;
    await store.mutate(record.key, current => {
      if (!current || current.result
          || current.streamedFinalReplyIds?.includes(event.providerMessageId)) return current;
      return {
        ...current,
        streamedFinalReplyIds: [...(current.streamedFinalReplyIds || []), event.providerMessageId],
        deliveries: appendDeliveries(current, parts.map(part => ({
          ...part, providerMessageId: event.providerMessageId,
          providerPartCount: parts.filter(part => ['content', 'attachment'].includes(part.kind)).length,
          triggerId: current.options?.triggerId || '',
          scheduleId: current.options?.scheduleId || '',
          occurrenceId: current.options?.occurrenceId || '',
        }))),
      };
    });
  }
}

export function excludePublishedFinalReplies(history, publishedIds = []) {
  if (!publishedIds.length) return history;
  const published = new Set(publishedIds);
  return history.filter(event => event?.type !== 'message' || event.role !== 'assistant'
    || (isFinalAssistantMessage(event) && !published.has(event.providerMessageId)));
}

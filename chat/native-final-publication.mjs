import { isFinalAssistantMessage } from '../lib/assistant-message-phase.mjs';
import { assistantSurfaceMessageId, collectAssistantSurfaceMessages, parseProgressMessage } from '../lib/assistant-surface-messages.mjs';
import { getAssistantReplyAttachments } from '../lib/reply-selection.mjs';
import { appendDeliveries } from './requests.mjs';
import { buildReplyDeliveries, isFeishuMainlineReply } from '../lib/reply-deliveries.mjs';
import { buildReplyPublicationPayload, collectReplyPublicationHistory, isFirstUserTurnPublication } from './reply-publication.mjs';
import { resolveAmbientFeishuReplyPlan, rememberAmbientFeishuReplyPlan } from './ambient-feishu-reply.mjs';
import {
  extractAssistantArtifactBlockReferences, extractAssistantLocalMarkdownImageReferences,
  collectGeneratedResultFilesFromRun, collectAssistantLocalMarkdownImageRewrites,
  normalizePublishedResultAssetAttachments,
  rewriteAssistantLocalMarkdownImageTargets,
} from './session-result-files.mjs';
import { publishLocalFileAssetFromPath } from './file-assets.mjs';
import { appendSessionEntryFooter, buildSessionEntry } from '../lib/session-navigation.mjs';
import { normalizeConversation } from '../lib/conversation-target.mjs';
import { shouldPublishSessionProgress, usesOctober7GroupMessaging } from '../lib/session-progress-policy.mjs';
import { withSessionProgressPolicy } from './session-progress-policy.mjs';
import { findSessionMeta } from './session-meta-store.mjs';

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

// A native execution retains its root identity, but each accepted ordinary
// input is a new opening boundary with its own frozen policy and destination.
// Question answers and reference-only inputs do not start another reply.
export async function publishLiveRunReplies(record, fullHistory, { store, run, ...options } = {}) {
  const rootEvents = collectReplyPublicationHistory(fullHistory, run);
  if (options.plan?.connector !== 'feishu') {
    return publishLiveAssistantReplies(record, rootEvents, { ...options, store, fullHistory });
  }
  const rootSet = new Set(rootEvents);
  const firstSeq = rootEvents.find(event => event.type === 'message' && event.role === 'user')?.seq || 0;
  const inputs = new Map();
  for (const event of fullHistory) {
    if (event.type !== 'message' || event.role !== 'user' || !event.requestId
        || event.seq < firstSeq || event.requestId === record.requestId || inputs.has(event.requestId)) continue;
    const input = await store.byRequest(record.sessionId, event.requestId);
    // Pre-upgrade suppressed text remains historical evidence, not a replay.
    if (input?.nativeDispatchRunId !== record.runId || input.liveReplyPublicationVersion !== 1
        || input.result || input.options?.nativeQuestionId || input.options?.internalOperation || input.options?.workReference) continue;
    inputs.set(event.requestId, input);
  }
  const events = fullHistory.filter(event => rootSet.has(event)
    || event.type === 'message' && event.role === 'user' && inputs.has(event.requestId));
  // A queued spool item may be projected after the new user event. Its
  // original emission time keeps old output on the previous input's route.
  if (events.every(event => Number.isFinite(event.timestamp))) {
    events.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  }
  await publishLiveAssistantReplies(record, events, { ...options, store, fullHistory, inputRecords: inputs });
}

// Publication rules are per accepted input; ordinary progress still follows
// the existing card/message choice. The root owns durable delivery identities
// and the terminal result for the shared execution.
export async function publishLiveAssistantReplies(record, events, { store, plan, session, fullHistory = events, running = true, prepareFinal = async event => event, inputRecords = new Map() } = {}) {
  if (!record || record.result || record.options?.suppressSourceDelivery || record.options?.internalOperation
      || !plan) return;
  // Admission remains per turn even when the Session has cards enabled.
  // Ordinary unlisted progress remains in Web/history rather than a new post.
  const forThisTurn = policy => record.options?.workboardEnabled === false
    ? { ...policy, workboardPilot: false } : policy;
  const progressPolicy = plan.connector === 'feishu'
    ? forThisTurn(await findSessionMeta(record.sessionId || session?.id) || session) : null;
  const publicationRun = { id: record.runId, responseId: record.responseId,
    ...(record.runtimeSelection || record.options) };
  const firstUserTurn = isFirstUserTurnPublication(events, publicationRun, fullHistory);
  const scopes = new Map();
  let input = record;
  for (const event of events) {
    if (event.type === 'message' && event.role === 'user') input = inputRecords.get(event.requestId) || record;
    scopes.set(event, input);
  }
  const suppressOpening = (surface, current, owner, messageReplyPolicy) => {
    if (plan.connector !== 'feishu' || surface.surfaceKind !== 'opening') return false;
    const alreadyPublished = current?.deliveries?.some(item => item.surfaceKind === 'opening'
      && (item.publicationRequestId || record.requestId) === owner.requestId);
    if (messageReplyPolicy) return !messageReplyPolicy.opening || alreadyPublished;
    if (usesOctober7GroupMessaging(progressPolicy)) return alreadyPublished;
    return !firstUserTurn || current?.deliveries?.some(item => item.surfaceKind === 'opening'
      || item.kind === 'session_entry' || item.sessionEntryIncluded);
  };
  for (const [event, surface] of collectAssistantSurfaceMessages(events || [], { independentOpening: Boolean(record.options?.messageReplyPolicy) })) {
    if (event.runId && event.runId !== record.runId) continue;
    const final = isFinalAssistantMessage(event);
    const owner = final || surface.surfaceKind === 'question' ? record : scopes.get(event) || record;
    if (owner !== record && !owner.nativeReceipt?.accepted) continue;
    if (owner.options?.suppressSourceDelivery || owner.routingHandoff) continue;
    const messageReplyPolicy = owner.options?.messageReplyPolicy;
    const ownerPlan = owner === record ? plan : normalizeConversation(owner.deliveryPlan || owner.options?.sourceDelivery);
    if (!ownerPlan) continue;
    // Without a phase, a direct answer is indistinguishable from an opening.
    // Wait for terminal publication unless the Harness explicitly marks progress.
    if (plan.connector === 'feishu' && !event.phase && surface.surfaceKind === 'opening'
        && !parseProgressMessage(event.content).progress) continue;
    const messageId = assistantSurfaceMessageId(event);
    if (!messageId) continue;
    let stored = await store.get(record.key);
    if (stored?.options?.suppressSourceDelivery || stored?.routingHandoff) return;
    if (owner === record) stored = await rememberAmbientFeishuReplyPlan(stored || record, plan, [event], store);
    const replyRecord = current => owner === record ? current : owner;
    const replyPlan = resolveAmbientFeishuReplyPlan(replyRecord(stored || record), ownerPlan, [event]);
    if (isFeishuMainlineReply(replyPlan) && messageReplyPolicy?.version !== 3
        && ['opening', 'progress'].includes(surface.surfaceKind)) continue;
    if (suppressOpening(surface, stored || record, owner, messageReplyPolicy)) continue;
    // A rollout can fence progress previously suppressed by card grouping.
    // This is not a delivery receipt; old card text must not be announced again.
    if ((surface.surfaceKind === 'progress' || surface.surfaceKind === 'opening'
        && !messageReplyPolicy && usesOctober7GroupMessaging(progressPolicy))
        && event.seq <= (stored?.progressMessageAfterSeq || 0)) continue;
    if (plan.connector === 'feishu' && surface.surfaceKind === 'progress'
        && !shouldPublishSessionProgress(progressPolicy, event.seq, record.runId, messageReplyPolicy)) continue;
    if (stored?.streamedSurfaceMessageIds?.includes(messageId)
        || stored?.streamedFinalReplyIds?.includes(messageId)) continue;
    // An early final is not a stopped execution. Feishu sends the result once
    // execution stops, rather than announcing delivery while work continues.
    if (plan.connector === 'feishu' && final && running) continue;
    // Cold recovery of a stopped execution publishes its result, not stale
    // openings or intermediate updates labeled as separate deliveries.
    if (plan.connector === 'feishu' && !final && !running
        && !(event.nativeQuestion && event.questionState !== 'pending')) continue;
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
      && !isFeishuMainlineReply(replyPlan)
      && ['opening', 'final'].includes(surface.surfaceKind)
      && firstUserTurn
      && !stored?.deliveries?.some(item => item.kind === 'session_entry' || item.sessionEntryIncluded);
    const entry = includeEntry ? buildSessionEntry(session, { runtimeSelection: publicationRun }) : null;
    const payload = final ? buildReplyPublicationPayload([prepared], publicationRun,
      { session, fullHistory, includeSessionEntry: Boolean(entry) }) : {
      text: appendSessionEntryFooter(prepared.content, entry), attachments: getAssistantReplyAttachments(prepared),
    };
    const buildParts = current => buildReplyDeliveries(resolveAmbientFeishuReplyPlan(replyRecord(current), ownerPlan, [event]), payload, {
      running,
      surfaceKind: surface.surfaceKind,
      messageReplyPolicy,
      automationTitle: record.options?.automationTitle,
      requireFeishuOutcome: final && record.options?.sourceContext?.feishuOutcomeRequired === true,
    });
    const parts = buildParts(stored || record);
    if (!parts.length) continue;
    const admit = () => store.mutate(record.key, current => {
      if (!current || current.result || current.options?.suppressSourceDelivery || current.routingHandoff
          || suppressOpening(surface, current, owner, messageReplyPolicy)
          || current.streamedSurfaceMessageIds?.includes(messageId)
          || current.streamedFinalReplyIds?.includes(messageId)) return current;
      const parts = buildParts(current);
      if (!parts.length) return current;
      return {
        ...current,
        streamedSurfaceMessageIds: [...(current.streamedSurfaceMessageIds || []), messageId],
        ...(final ? { streamedFinalReplyIds: [...(current.streamedFinalReplyIds || []), messageId] } : {}),
        deliveries: appendDeliveries(current, parts.map(part => ({
          ...part, providerMessageId: messageId, surfaceKind: surface.surfaceKind,
          publicationRequestId: owner.requestId,
          ...(event.nativeQuestion && part.kind === 'content' ? { nativeQuestion: {
            id: event.questionId, state: event.questionState, question: event.nativeQuestion,
            deadline: event.questionDeadline, answers: event.questionAnswers || [],
            origin: event.answerOrigin || '', statusText: event.content,
          } } : {}),
          ...(entry && part.kind === 'content' ? { sessionEntryIncluded: true } : {}),
          providerPartCount: parts.filter(part => ['content', 'attachment'].includes(part.kind)).length,
          triggerId: current.options?.triggerId || '',
          scheduleId: current.options?.scheduleId || '',
          occurrenceId: current.options?.occurrenceId || '',
        }))),
      };
    });
    if (plan.connector === 'feishu' && surface.surfaceKind === 'progress') {
      await withSessionProgressPolicy(record.sessionId || session?.id, async () => {
        const latest = forThisTurn(await findSessionMeta(record.sessionId || session?.id) || session);
        if (shouldPublishSessionProgress(latest, event.seq, record.runId, messageReplyPolicy)) await admit();
      });
    } else await admit();
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
  const parts = annotateTerminalReplyDeliveries(buildReplyDeliveries(plan, record.result.payload, {
    running: false, automationTitle: record.options?.automationTitle,
  }), record.result.payload);
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

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FEISHU_SOCIAL_REACTION_CRITERIA } from '../lib/feishu-reaction-catalog.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createRecordStore } from '../lib/durable-records.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { appendEvent, getHistoryHeadSeq, loadHistory, readEventsAfter } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { buildMessageAttachmentRefs } from './session-attachments.mjs';
import { requests } from './requests.mjs';

const store = createRecordStore(join(CONFIG_DIR, 'session-observations'));
const serialize = createKeyedTaskQueue();
const MAX_RECENT_EVENTS = 120;
const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_AGE_MS = 4 * 60 * 60 * 1000;

const trim = value => typeof value === 'string' ? value.trim() : '';
const boundedProbability = value => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const keyFor = (sessionId, sourceMessageId) => createHash('sha256')
  .update(JSON.stringify([sessionId, sourceMessageId])).digest('hex').slice(0, 24);

export async function hasObservedSessionInput(sessionId, sourceMessageId, requestId) {
  if (!sourceMessageId || !requestId) return false;
  const record = await store.get(keyFor(sessionId, sourceMessageId));
  if (!record?.eventSeq) return false;
  const events = await loadHistory(sessionId, { fromSeq: record.eventSeq, toSeq: record.eventSeq, includeBodies: false });
  return events.some(event => event.seq === record.eventSeq && event.type === 'message'
    && event.role === 'user' && event.requestId === requestId && event.sourceMessageId === sourceMessageId);
}

async function ensureDecisionEvent(sessionId, sourceMessageId, key, record) {
  if (!record.decision || record.decisionEventSeq) return record;
  const after = await readEventsAfter(sessionId, record.eventSeq || record.baseSeq || 0);
  const prior = after.find(event => event.type === 'reaction_decision'
    && event.sourceMessageId === sourceMessageId);
  const decisionEventSeq = prior?.seq || (await appendEvent(sessionId, {
    type: 'reaction_decision', role: 'system', timestamp: Date.now(),
    sourceMessageId,
    ...(record.decision.purpose ? { purpose: record.decision.purpose } : { participation: record.decision.participation }),
    emojiType: record.decision.emojiType,
    ...(record.decision.workMode ? { workMode: record.decision.workMode } : {}),
    ...(record.decision.contextSources ? { contextSources: record.decision.contextSources } : {}),
  })).seq;
  return store.mutate(key, current => ({ ...current, decisionEventSeq }));
}

async function recentMessages(sessionId, latestSeq, exclude = null) {
  const events = await loadHistory(sessionId, {
    fromSeq: Math.max(1, latestSeq - MAX_RECENT_EVENTS + 1), toSeq: latestSeq, includeBodies: true,
  });
  const cutoff = Date.now() - MAX_RECENT_AGE_MS;
  return events.filter(event => event.seq <= latestSeq
      && event.type === 'message' && ['user', 'assistant'].includes(event.role)
      && (!exclude || (event.requestId !== exclude.requestId
        && event.sourceMessageId !== exclude.sourceMessageId
        && event.sourceContext?.messageId !== exclude.sourceMessageId))
      && (!exclude || Number(event.timestamp) <= exclude.acceptedAt)
      && Number(event.timestamp) >= cutoff)
    .slice(-MAX_RECENT_MESSAGES)
    .map(event => ({
      seq: event.seq,
      time: event.timestamp,
      sender: trim(event.sourceContext?.sender?.name)
        || (event.role === 'assistant' ? 'assistant' : '群成员'),
      text: trim(event.content).slice(0, 1200),
    }));
}

// Optional feedback projects an already accepted Request. It cannot append a
// second human input or resolve/revalidate the current Session binding. A
// queued Request is sufficient; feedback never waits for Harness execution.
export async function observeAcceptedSessionMessage(sessionId, requestId) {
  const request = await requests.byRequest(sessionId, trim(requestId));
  const source = request?.options?.sourceContext;
  if (!request?.options?.feishuConnectorAuthenticated || source?.connector !== 'feishu'
      || !source.messageId || ['p2p', 'private'].includes(source.chatType)
      || source.conversationKind === 'document_comment') {
    throw new Error('An accepted Feishu group request is required');
  }
  const sourceMessageId = source.messageId;
  const key = keyFor(sessionId, sourceMessageId);
  return serialize(key, async () => {
    let record = await store.get(key);
    const duplicate = Boolean(record);
    if (!record) {
      const baseSeq = await getHistoryHeadSeq(sessionId);
      record = await store.mutate(key, () => ({
        sessionId, sourceMessageId, acceptedRequestId: request.requestId,
        baseSeq, eventSeq: 0, decision: null, decisionEventSeq: 0,
      }));
    }
    record = await ensureDecisionEvent(sessionId, sourceMessageId, key, record);
    const recent = await recentMessages(sessionId, record.baseSeq || record.eventSeq, {
      requestId: request.requestId, sourceMessageId, acceptedAt: Date.parse(request.acceptedAt),
    });
    recent.push({
      time: Date.parse(request.acceptedAt),
      sender: trim(source.sender?.name) || '群成员',
      text: trim(request.text).slice(-1200),
    });
    return { accepted: true, duplicate, decision: record.decision || null,
      recent: recent.slice(-MAX_RECENT_MESSAGES) };
  });
}

export async function observeSessionMessage(sessionId, input = {}) {
  const sourceMessageId = trim(input.sourceMessageId);
  const text = trim(input.text);
  if (!sessionId || !sourceMessageId || !text) throw new Error('Session, source message ID and text are required');
  const key = keyFor(sessionId, sourceMessageId);
  return serialize(key, async () => {
    let record = await store.get(key);
    let duplicate = Boolean(record?.eventSeq);
    if (!record) {
      const baseSeq = await getHistoryHeadSeq(sessionId);
      record = await store.mutate(key, () => ({
        sessionId, sourceMessageId, baseSeq, eventSeq: 0,
        decision: null, decisionEventSeq: 0,
      }));
    }
    let eventSeq = record.eventSeq;
    if (!eventSeq) {
      // The event may have committed before a crash. Search from the durable
      // pre-append watermark before attempting another append.
      const after = await readEventsAfter(sessionId, record.baseSeq);
      const prior = after.find(event => event.type === 'message' && event.role === 'user'
        && event.sourceMessageId === sourceMessageId);
      if (prior) duplicate = true;
      eventSeq = prior?.seq || (await appendEvent(sessionId, messageEvent('user', text, buildMessageAttachmentRefs(input.attachments), {
        requestId: trim(input.requestId),
        sourceMessageId,
        source: 'feishu_observation',
        sourceContext: input.sourceContext || null,
        ...(trim(input.initiatedByIdentityId) ? { initiatedByIdentityId: trim(input.initiatedByIdentityId) } : {}),
      }))).seq;
      record = await store.mutate(key, current => ({ ...current, eventSeq }));
    }
    record = await ensureDecisionEvent(sessionId, sourceMessageId, key, record);
    return { eventSeq, duplicate,
      decision: record.decision || null,
      recent: await recentMessages(sessionId, eventSeq) };
  });
}

export async function recordSessionObservationDecision(sessionId, sourceMessageId, proposed) {
  const key = keyFor(sessionId, trim(sourceMessageId));
  return serialize(key, async () => {
    let record = await store.get(key);
    if (!record?.eventSeq && !record?.acceptedRequestId) throw new Error('Source message has not entered the Session');
    const participation = proposed?.participation;
    const emojiType = trim(proposed?.emojiType);
    const workMode = trim(proposed?.workMode);
    if (!record.decision) {
      const reactionOnly = proposed?.purpose === 'reaction';
      if (reactionOnly && (participation !== undefined || workMode || (emojiType && !Object.hasOwn(FEISHU_SOCIAL_REACTION_CRITERIA, emojiType)))) {
        throw new Error('Invalid social reaction decision');
      }
      if (!reactionOnly && (!['reply', 'silent'].includes(participation)
          || (participation === 'reply' && !(
            (['short', 'complex'].includes(workMode) && emojiType === 'OnIt')
            || (workMode === 'reaction' && ['Yes', 'No'].includes(emojiType))))
          || (participation === 'silent' && workMode !== '')
          || (participation === 'silent' && emojiType !== ''
            && !['WOW', 'TOASTED'].includes(emojiType)))) {
        throw new Error('Invalid Jev reaction decision');
      }
      const decision = {
        ...(reactionOnly ? { purpose: 'reaction' } : { participation, workMode: workMode || null }),
        emojiType: emojiType || null,
        ...(proposed.groupRoutingPilot === true ? { groupRoutingPilot: true } : {}),
        ...(reactionOnly && proposed?.diagnostics ? { diagnostics: {
          choice: trim(proposed.diagnostics.choice).slice(0, 64),
          choiceProbability: boundedProbability(proposed.diagnostics.choiceProbability),
          reactionNeeded: ['yes', 'no'].includes(proposed.diagnostics.reactionNeeded)
            ? proposed.diagnostics.reactionNeeded : '',
          reactProbability: boundedProbability(proposed.diagnostics.reactProbability),
          model: trim(proposed.diagnostics.model).slice(0, 100),
          latencyMs: Number.isFinite(proposed.diagnostics.latencyMs) && proposed.diagnostics.latencyMs >= 0
            ? Math.round(proposed.diagnostics.latencyMs) : null,
        } } : {}),
        reason: trim(proposed?.reason),
        decidedAt: new Date().toISOString(),
        ...(Array.isArray(proposed.contextSources) ? { contextSources: proposed.contextSources
          .filter(source => source?.kind === 'daily_report' && /^\d{4}-\d{2}-\d{2}$/.test(source.date)
            && /^[a-f0-9]{64}$/.test(source.sha256)).slice(0, 3).map(source => ({
            kind: 'daily_report', date: source.date, sha256: source.sha256,
            url: trim(source.url).slice(0, 1000), updatedAt: trim(source.updatedAt).slice(0, 40),
          })) } : {}),
      };
      record = await store.mutate(key, current => ({ ...current, decision }));
    }
    const decision = record.decision;
    await ensureDecisionEvent(sessionId, trim(sourceMessageId), key, record);
    return decision;
  });
}

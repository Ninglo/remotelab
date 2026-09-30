import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createRecordStore } from '../lib/durable-records.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { appendEvent, getHistoryHeadSeq, readEventsAfter } from './history.mjs';
import { messageEvent } from './normalizer.mjs';

const store = createRecordStore(join(CONFIG_DIR, 'session-observations'));
const serialize = createKeyedTaskQueue();
const MAX_RECENT_EVENTS = 120;
const MAX_RECENT_MESSAGES = 20;
const MAX_RECENT_AGE_MS = 4 * 60 * 60 * 1000;

const trim = value => typeof value === 'string' ? value.trim() : '';
const keyFor = (sessionId, sourceMessageId) => createHash('sha256')
  .update(JSON.stringify([sessionId, sourceMessageId])).digest('hex').slice(0, 24);

async function ensureDecisionEvent(sessionId, sourceMessageId, key, record) {
  if (!record.decision || record.decisionEventSeq) return record;
  const after = await readEventsAfter(sessionId, record.eventSeq);
  const prior = after.find(event => event.type === 'reaction_decision'
    && event.sourceMessageId === sourceMessageId);
  const decisionEventSeq = prior?.seq || (await appendEvent(sessionId, {
    type: 'reaction_decision', role: 'system', timestamp: Date.now(),
    sourceMessageId,
    participation: record.decision.participation, emojiType: record.decision.emojiType,
    ...(record.decision.workMode ? { workMode: record.decision.workMode } : {}),
    ...(record.decision.contextSources ? { contextSources: record.decision.contextSources } : {}),
  })).seq;
  return store.mutate(key, current => ({ ...current, decisionEventSeq }));
}

async function recentMessages(sessionId, latestSeq) {
  const events = await readEventsAfter(sessionId, Math.max(0, latestSeq - MAX_RECENT_EVENTS), { includeBodies: true });
  const cutoff = Date.now() - MAX_RECENT_AGE_MS;
  return events.filter(event => event.seq <= latestSeq
      && event.type === 'message' && ['user', 'assistant'].includes(event.role)
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
      eventSeq = prior?.seq || (await appendEvent(sessionId, messageEvent('user', text, [], {
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
    if (!record?.eventSeq) throw new Error('Source message has not entered the Session');
    const participation = proposed?.participation;
    const emojiType = trim(proposed?.emojiType);
    const workMode = trim(proposed?.workMode);
    if (!record.decision) {
      if (!['reply', 'silent'].includes(participation)
          || (participation === 'reply' && !(
            (['short', 'complex'].includes(workMode) && emojiType === 'OnIt')
            || (workMode === 'reaction' && ['Yes', 'No'].includes(emojiType))))
          || (participation === 'silent' && workMode !== '')
          || (participation === 'silent' && emojiType !== ''
            && !['WOW', 'TOASTED'].includes(emojiType))) {
        throw new Error('Invalid Jev reaction decision');
      }
      const decision = {
        participation, emojiType: emojiType || null, workMode: workMode || null,
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

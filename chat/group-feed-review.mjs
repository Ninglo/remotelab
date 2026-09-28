import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { getHistorySnapshot, loadHistory } from './history.mjs';
import { listSessions } from './session-manager.mjs';

const REVIEW_DIR = join(CONFIG_DIR, 'group-feed-reviews');
const REVIEW_HOUR_UTC = 15; // 23:30 Asia/Shanghai
const REVIEW_MINUTE_UTC = 30;
const MAX_RECENT_MESSAGES = 120;

function clipped(value, limit = 1200) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function buildGroupFeedReview(session, previous, events, latestSeq, now = new Date()) {
  const recent = Array.isArray(previous?.recentMessages) ? previous.recentMessages : [];
  const additions = events.filter((event) => event?.type === 'message' && event.role === 'user')
    .map((event) => ({
      seq: event.seq,
      at: event.timestamp || event.createdAt || '',
      messageId: event.sourceContext?.messageId || '',
      sender: clipped(event.sourceContext?.sender?.name || event.sourceContext?.sender?.displayName, 80),
      text: clipped(event.content),
    }));
  return {
    version: 1,
    sessionId: session.id,
    chatId: session.conversation?.target?.chatId || '',
    name: session.name,
    throughSeq: latestSeq,
    scannedAt: now.toISOString(),
    scannedMessageCount: (previous?.scannedMessageCount || 0) + additions.length,
    newMessageCount: additions.length,
    projectState: session.workSummary || null,
    recentMessages: [...recent, ...additions].slice(-MAX_RECENT_MESSAGES),
  };
}

export async function scanGroupFeedReviews({ now = new Date() } = {}) {
  const sessions = (await listSessions({ includeArchived: false }))
    .filter((session) => session.groupFeed === true && session.conversation?.target?.conversationKind === 'main');
  const reviewed = [];
  for (const session of sessions) {
    const path = join(REVIEW_DIR, `${session.id}.json`);
    const previous = await readRecord(path);
    const snapshot = await getHistorySnapshot(session.id);
    const throughSeq = Number.isInteger(previous?.throughSeq) ? previous.throughSeq : 0;
    if (snapshot.latestSeq <= throughSeq) continue;
    const events = await loadHistory(session.id, {
      fromSeq: throughSeq + 1,
      toSeq: snapshot.latestSeq,
      includeBodies: true,
    });
    const review = buildGroupFeedReview(session, previous, events, snapshot.latestSeq, now);
    await writeDurableJson(path, review);
    reviewed.push({ sessionId: session.id, throughSeq: review.throughSeq, newMessageCount: review.newMessageCount });
  }
  return reviewed;
}

export function nextGroupFeedReviewAt(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(REVIEW_HOUR_UTC, REVIEW_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

let reviewTimer = null;
export function startGroupFeedReview() {
  if (reviewTimer) return;
  const scheduleNext = () => {
    const waitMs = nextGroupFeedReviewAt().getTime() - Date.now();
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      void scanGroupFeedReviews().catch((error) => {
        console.error(`[group-feed-review] ${error.message}`);
      }).finally(scheduleNext);
    }, waitMs);
    reviewTimer.unref?.();
  };
  scheduleNext();
  void scanGroupFeedReviews().catch((error) => {
    console.error(`[group-feed-review] Startup scan failed: ${error.message}`);
  });
}

export function stopGroupFeedReview() {
  if (reviewTimer) clearTimeout(reviewTimer);
  reviewTimer = null;
}

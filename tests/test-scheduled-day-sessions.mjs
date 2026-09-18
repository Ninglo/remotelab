import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.REMOTELAB_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'scheduled-day-'));
const { createTrigger, ensureExecutionSession } = await import('../chat/triggers.mjs');
const { updateSessionConversation } = await import('../chat/session-conversations.mjs');
const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'chat' } };
const template = { folder: '/tmp', tool: 'codex', conversation };
const make = (scheduledAt, reuse = true) => createTrigger({ text: 'review', scheduleId: 'daily', scheduledAt,
  sessionTemplate: { ...template, ...(reuse ? { reuse: 'calendar_day', reuseTimezone: 'Asia/Shanghai' } : {}) } });
// Adopt the morning occurrence created before this feature was enabled.
const morning = await ensureExecutionSession(await make('2026-09-17T20:00:00Z', false));
await updateSessionConversation(morning.session.id, { ...conversation, target: { chatId: 'chat', threadId: 'topic-first-day' } });
const evening = await ensureExecutionSession(await make('2026-09-18T10:00:00Z'));
assert.equal(evening.session.id, morning.session.id);
assert.equal(evening.session.conversation.target.threadId, 'topic-first-day');
const nextMorning = await ensureExecutionSession(await make('2026-09-18T20:00:00Z'));
assert.notEqual(nextMorning.session.id, morning.session.id);
await updateSessionConversation(nextMorning.session.id, { ...conversation, target: { chatId: 'chat', threadId: 'topic-next-day' } });
const nextEvening = await ensureExecutionSession(await make('2026-09-19T10:00:00Z'));
assert.equal(nextEvening.session.id, nextMorning.session.id);
const retry = await ensureExecutionSession(nextEvening.trigger);
assert.equal(retry.session.id, nextMorning.session.id);
console.log('scheduled day sessions: legacy adoption, same-day topic reuse, next-day isolation and restart retry passed');

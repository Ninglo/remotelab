import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = await mkdtemp(join(tmpdir(), 'scheduled-runtime-'));
process.env.REMOTELAB_CONFIG_DIR = config;
await writeFile(join(config, 'tools.json'), JSON.stringify([
  {
    id: 'codex', name: 'Codex', command: process.execPath, runtimeFamily: 'codex-json',
    models: [{ id: 'auto' }], reasoning: { kind: 'none' },
  },
  ...['first', 'second'].map(id => ({
    id, name: id, command: process.execPath, runtimeFamily: 'codex-json',
    models: [{ id: `${id}-model` }], reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' },
  })),
]));
const { scheduledRuntimeIntent, patchScheduledRuntime } = await import('../lib/scheduled-runtime-policy.mjs');
const { createTrigger, ensureExecutionSession, getTrigger } = await import('../chat/triggers.mjs');
const { createRecurringSchedule, getRecurringSchedule, updateRecurringSchedule } = await import('../chat/recurring-schedules.mjs');
const { updateSessionConversation } = await import('../chat/session-conversations.mjs');
const make = (scheduledAt, extra = {}) => createTrigger({ text: 'review', scheduledAt, scheduleId: 'daily',
  sessionTemplate: { folder: config, tool: 'first', reuse: 'calendar_day', reuseTimezone: 'Asia/Shanghai' }, ...extra });

assert.equal(scheduledRuntimeIntent({ model: 'explicit-model' }).runtimePolicy, 'fixed');
assert.equal(scheduledRuntimeIntent({ model: '', tool: '', effort: '' }).runtimePolicy, 'auto');
assert.equal(scheduledRuntimeIntent({ runtimePolicy: 'follow_default' }).runtimePolicy, 'auto');
assert.throws(() => scheduledRuntimeIntent({ runtimePolicy: 'invalid' }));
assert.equal(patchScheduledRuntime({ runtimePolicy: 'auto' }, { model: 'explicit' }).runtimePolicy, 'fixed');

const pending = await make('2026-09-17T20:00:00Z');
const morning = await ensureExecutionSession(pending);
assert.equal(morning.session.tool, 'codex');
assert.equal(morning.session.model, 'auto');
assert.equal(morning.session.effort, undefined);
assert.equal((await getTrigger(pending.id)).executionRuntime.model, 'auto');
const retried = await ensureExecutionSession(await getTrigger(pending.id));
assert.equal(retried.session.id, morning.session.id);
assert.equal(retried.trigger.executionRuntime.model, 'auto');
const evening = await ensureExecutionSession(await make('2026-09-18T10:00:00Z'));
assert.equal(evening.session.id, morning.session.id);
assert.equal(evening.trigger.executionRuntime.model, 'auto');
const tomorrow = await ensureExecutionSession(await make('2026-09-18T20:00:00Z'));
assert.notEqual(tomorrow.session.id, morning.session.id);
assert.equal(tomorrow.session.model, 'auto');
const pinned = await ensureExecutionSession(await make('2026-09-19T20:00:00Z', {
  runtimePolicy: 'fixed', tool: 'second', model: 'second-model', effort: 'high',
}));
assert.equal(pinned.session.model, 'second-model');
const fixedSession = await ensureExecutionSession(await make('2026-09-20T20:00:00Z', {
  runtimePolicy: 'auto', sessionTemplate: { folder: config, tool: 'second', reuse: 'fixed_session', sessionId: morning.session.id },
}));
assert.equal(fixedSession.trigger.executionRuntime.model, 'auto');
const conversation = { connector: 'feishu', sourceRouteId: 'test', target: { chatId: 'chat', threadId: 'topic' } };
await updateSessionConversation(morning.session.id, conversation);
const continuedTopic = await ensureExecutionSession(await make('2026-09-21T20:00:00Z', {
  sessionTemplate: { folder: config, tool: 'first', conversation },
}));
assert.equal(continuedTopic.session.id, morning.session.id);
assert.equal(continuedTopic.trigger.executionRuntime.model, 'auto');

const schedule = await createRecurringSchedule({ sourceSessionId: morning.session.id,
  sessionTemplate: { folder: config, tool: 'first' }, text: 'review', cron: '0 9 * * *',
  runtimePolicy: 'auto', model: 'stale-snapshot', tool: 'first' });
assert.equal((await getRecurringSchedule(schedule.id)).model, '');
const updated = await updateRecurringSchedule(schedule.id, { model: 'second-model', tool: 'second' });
assert.equal(updated.runtimePolicy, 'fixed');
assert.equal((await updateRecurringSchedule(schedule.id, { runtimePolicy: 'auto' })).model, '');
console.log('Scheduled runtime: immutable Auto, fixed overrides, daily reuse, durable retry, and legacy policy passed');

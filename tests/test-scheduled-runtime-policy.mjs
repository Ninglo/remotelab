import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduledRuntimeIntent, patchScheduledRuntime } from '../lib/scheduled-runtime-policy.mjs';

const config = await mkdtemp(join(tmpdir(), 'scheduled-runtime-'));
process.env.REMOTELAB_CONFIG_DIR = config;
await writeFile(join(config, 'tools.json'), JSON.stringify(['first', 'second'].map(id => ({
  id, name: id, command: process.execPath, runtimeFamily: 'codex-json',
  models: [{ id: `${id}-model` }], reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' },
}))));
const { saveUiRuntimeSelection } = await import('../lib/runtime-selection.mjs');
const { createTrigger, ensureExecutionSession, getTrigger } = await import('../chat/triggers.mjs');
const { createRecurringSchedule, getRecurringSchedule, updateRecurringSchedule } = await import('../chat/recurring-schedules.mjs');
const { updateSessionConversation } = await import('../chat/session-conversations.mjs');
const select = (tool, effort) => saveUiRuntimeSelection({ selectedTool: tool, selectedModel: `${tool}-model`, selectedEffort: effort, reasoningKind: 'enum' });
const make = (scheduledAt, extra = {}) => createTrigger({ text: 'review', scheduledAt, scheduleId: 'daily',
  sessionTemplate: { folder: config, tool: 'first', reuse: 'calendar_day', reuseTimezone: 'Asia/Shanghai' }, ...extra });

assert.equal(scheduledRuntimeIntent({ model: 'explicit-model' }).runtimePolicy, 'fixed');
assert.equal(scheduledRuntimeIntent({ model: '', tool: '', effort: '' }).runtimePolicy, 'follow_default');
assert.throws(() => scheduledRuntimeIntent({ runtimePolicy: 'invalid' }));
assert.equal(patchScheduledRuntime({ runtimePolicy: 'follow_default' }, { model: 'explicit' }).runtimePolicy, 'fixed');

await select('first', 'low');
const pending = await make('2026-09-17T20:00:00Z');
await select('second', 'high');
const morning = await ensureExecutionSession(pending);
assert.equal(morning.session.tool, 'second');
assert.equal(morning.session.model, 'second-model');
assert.equal(morning.session.effort, 'high');
assert.equal((await getTrigger(pending.id)).executionRuntime.model, 'second-model');
await select('first', 'low');
const retried = await ensureExecutionSession(await getTrigger(pending.id));
assert.equal(retried.session.id, morning.session.id);
assert.equal(retried.trigger.executionRuntime.model, 'second-model');
const evening = await ensureExecutionSession(await make('2026-09-18T10:00:00Z'));
assert.equal(evening.session.id, morning.session.id);
assert.equal(evening.trigger.executionRuntime.model, 'second-model');
const tomorrow = await ensureExecutionSession(await make('2026-09-18T20:00:00Z'));
assert.notEqual(tomorrow.session.id, morning.session.id);
assert.equal(tomorrow.session.model, 'first-model');
const pinned = await ensureExecutionSession(await make('2026-09-19T20:00:00Z', {
  runtimePolicy: 'fixed', tool: 'second', model: 'second-model', effort: 'high',
}));
assert.equal(pinned.session.model, 'second-model');
const fixedSession = await ensureExecutionSession(await make('2026-09-20T20:00:00Z', {
  runtimePolicy: 'follow_default', sessionTemplate: { folder: config, tool: 'second', reuse: 'fixed_session', sessionId: morning.session.id },
}));
assert.equal(fixedSession.trigger.executionRuntime.model, 'second-model');
const conversation = { connector: 'feishu', sourceRouteId: 'test', target: { chatId: 'chat', threadId: 'topic' } };
await updateSessionConversation(morning.session.id, conversation);
const continuedTopic = await ensureExecutionSession(await make('2026-09-21T20:00:00Z', {
  sessionTemplate: { folder: config, tool: 'first', conversation },
}));
assert.equal(continuedTopic.session.id, morning.session.id);
assert.equal(continuedTopic.trigger.executionRuntime.model, 'second-model');

const schedule = await createRecurringSchedule({ sourceSessionId: morning.session.id,
  sessionTemplate: { folder: config, tool: 'first' }, text: 'review', cron: '0 9 * * *',
  runtimePolicy: 'follow_default', model: 'stale-snapshot', tool: 'first' });
assert.equal((await getRecurringSchedule(schedule.id)).model, '');
const updated = await updateRecurringSchedule(schedule.id, { model: 'second-model', tool: 'second' });
assert.equal(updated.runtimePolicy, 'fixed');
assert.equal((await updateRecurringSchedule(schedule.id, { runtimePolicy: 'follow_default' })).model, '');
console.log('Scheduled runtime: live Default, atomic Harness profile, fixed selection, daily reuse, durable retry, and legacy policy passed');

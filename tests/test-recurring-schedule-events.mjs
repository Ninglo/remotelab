import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-schedule-events-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;
const { createRecurringSchedule, getRecurringSchedule, updateRecurringSchedule, materializeDueRecurringSchedulesNow,
  startRecurringScheduleScheduler, stopRecurringScheduleScheduler, runScheduleGate } = await import('../chat/recurring-schedules.mjs');
const { notifyAutomationWake } = await import('../lib/automation-events.mjs');
const now = '2026-10-06T00:00:00.000Z';
const base = { sourceSessionId: 'fixture', sessionTemplate: { folder: tmpdir(), tool: 'codex' },
  text: 'fixture only', everySeconds: 3600, gate: { mode: 'script', runtime: 'bash', source: 'echo no' },
  wakeOn: ['foreground_idle'], lifetime: { mode: 'bounded', maxExecutions: 1, maxChecks: 10 } };
const create = input => createRecurringSchedule({ ...base, ...input }, { now });
const created = []; let admissions = 0;
const options = { now: '2026-10-06T00:00:30.000Z', wakeReason: 'foreground_idle',
  runGate: async () => ({ trigger: true, reason: 'eligible', dedupeKey: 'same-material' }),
  getScheduleTriggerCounts: async () => ({ admittedExecutions: admissions, pendingAdmissions: created.length }),
  createScheduledTrigger: async input => { created.push(input); return { id: 'fixture-trigger', ...input }; } };
try {
  await assert.rejects(create({ wakeOn: ['cpu_idle'] }), /foreground_idle/);
  await assert.rejects(create({ gate: { mode: 'direct' } }), /script gate/);
  const eventSchedule = await create();
  const direct = await create({ wakeOn: [], gate: { mode: 'direct' } });
  const noOptIn = await create({ wakeOn: [] });
  assert.deepEqual((await materializeDueRecurringSchedulesNow(options)).materialized, 1);
  const checked = await getRecurringSchedule(eventSchedule.id);
  assert.equal(checked.nextRunAt, eventSchedule.nextRunAt, 'events must not shift the hourly fallback');
  assert.equal(checked.lastCheckCause, 'foreground_idle'); assert.equal(checked.checkCount, 1);
  assert.equal((await getRecurringSchedule(direct.id)).checkCount, 0);
  assert.equal((await getRecurringSchedule(noOptIn.id)).checkCount, 0);
  await materializeDueRecurringSchedulesNow(options); assert.equal(created.length, 1, 'pending admissions reserve the execution budget');
  admissions = 1; await materializeDueRecurringSchedulesNow(options);
  assert.equal((await getRecurringSchedule(eventSchedule.id)).status, 'completed');
  await assert.rejects(updateRecurringSchedule(eventSchedule.id, { status: 'active' }), /cannot be resumed/);
  const extended = await updateRecurringSchedule(eventSchedule.id, { status: 'active', lifetime: { ...eventSchedule.lifetime, maxExecutions: 3 } });
  assert.equal(extended.lifetime.maxExecutions, 3); assert.equal(extended.status, 'active');
  await updateRecurringSchedule(eventSchedule.id, { enabled: false });
  await updateRecurringSchedule(direct.id, { enabled: false }); await updateRecurringSchedule(noOptIn.id, { enabled: false });
  created.length = 0; admissions = 0;

  const delayed = await create({ automationPolicy: { minIdleSeconds: 300, beforeLaunch: { mode: 'script', runtime: 'bash', source: 'echo no' } } });
  let gateCalls = 0;
  const stabilityOptions = { ...options, now: '2026-10-06T00:06:00Z', runGate: async () => { gateCalls++; return { trigger: true }; },
    getResourceSnapshot: async () => ({ status: 'ready', sessions: [], idleSince: '2026-10-06T00:01:01Z' }) };
  await materializeDueRecurringSchedulesNow(stabilityOptions); assert.equal(gateCalls, 0, 'do not even invoke a gate before stable idle');
  await materializeDueRecurringSchedulesNow({ ...stabilityOptions, now: '2026-10-06T00:06:01Z' });
  assert.equal(gateCalls, 1); assert.equal(created[0].automationPolicy.minIdleSeconds, 300);
  assert.equal(created[0].automationPolicy.beforeLaunch.source, 'echo no', 'freeze the guard with the occurrence');
  const due = (await getRecurringSchedule(delayed.id)).nextRunAt;
  const beforeFallbackCalls = gateCalls;
  await materializeDueRecurringSchedulesNow({ ...stabilityOptions, now: due, wakeReason: undefined,
    getResourceSnapshot: async () => ({ status: 'ready', sessions: [{ id: 'busy' }], idleSince: '' }) });
  assert.ok(Date.parse((await getRecurringSchedule(delayed.id)).nextRunAt) > Date.parse(due), 'a skipped hourly fallback advances, without minute/second rechecks');
  assert.equal(gateCalls, beforeFallbackCalls);
  await updateRecurringSchedule(delayed.id, { enabled: false }); created.length = 0;

  const concurrent = await create();
  let entered, release;
  const entering = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const runGate = async () => { entered(); await waiting; return { trigger: true }; };
  const eventCheck = materializeDueRecurringSchedulesNow({ ...options, now: concurrent.nextRunAt, runGate });
  await entering;
  const cadenceCheck = materializeDueRecurringSchedulesNow({ ...options, now: concurrent.nextRunAt, wakeReason: undefined });
  await cadenceCheck; release(); await eventCheck;
  assert.equal(created.length, 1, 'concurrent cadence and event results cannot double-admit');
  await updateRecurringSchedule(concurrent.id, { enabled: false }); created.length = 0;

  const cancelled = await create();
  const cancellationCheck = materializeDueRecurringSchedulesNow({ ...options, runGate: async () => {
    await updateRecurringSchedule(cancelled.id, { enabled: false }); return { trigger: true };
  } });
  await cancellationCheck; assert.equal(created.length, 0, 'cancellation during a gate prevents admission');

  const expired = await create({ lifetime: { mode: 'bounded', endsAt: '2026-10-06T00:00:10.000Z' } });
  await materializeDueRecurringSchedulesNow(options);
  assert.equal((await getRecurringSchedule(expired.id)).status, 'completed'); assert.equal(created.length, 0);
  const actualGate = await create({ gate: { mode: 'script', runtime: 'bash', source: 'printf \'{"trigger":false,"reason":"%s"}\' "$REMOTELAB_TASK_CHECK_CAUSE"' } });
  assert.equal((await runScheduleGate(actualGate, now, { checkCause: 'resource_recovery' })).reason, 'resource_recovery');
  await updateRecurringSchedule(actualGate.id, { enabled: false });

  const errored = await create({ gate: { mode: 'script', runtime: 'bash', source: 'echo invalid' } });
  await materializeDueRecurringSchedulesNow({ ...options, runGate: runScheduleGate });
  assert.equal((await getRecurringSchedule(errored.id)).gateErrorCount, 1);
  assert.equal(created.length, 0, 'event gate failures must not launch a run');
  await updateRecurringSchedule(errored.id, { enabled: false });
  const limited = await create({ lifetime: { mode: 'bounded', maxChecks: 1 } });
  await materializeDueRecurringSchedulesNow({ ...options, runGate: async () => ({ trigger: false }) });
  assert.equal((await getRecurringSchedule(limited.id)).status, 'completed', 'event checks consume the same check budget');
  const deduped = await create({ lifetime: { mode: 'bounded', maxChecks: 3 } });
  const keys = new Set();
  const dedupeOptions = { ...options, createScheduledTrigger: async input => {
    const duplicate = keys.has(input.occurrenceId); keys.add(input.occurrenceId);
    return { id: 'fixture-deduped', deduplicated: duplicate };
  } };
  await materializeDueRecurringSchedulesNow(dedupeOptions);
  await materializeDueRecurringSchedulesNow({ ...dedupeOptions, now: '2026-10-06T00:00:31.000Z' });
  assert.equal(keys.size, 1, 'material dedupe identity is stable across idle events');
  assert.equal((await getRecurringSchedule(deduped.id)).deduplicatedCount, 1);
  await updateRecurringSchedule(deduped.id, { enabled: false });

  // The scheduler keeps an event that arrives during a cadence check, rather than losing it.
  const serial = await create();
  let firstGate, unblockGate, finished, released, calls = 0, resourceStarts = 0;
  const first = new Promise(resolve => { firstGate = resolve; });
  const block = new Promise(resolve => { unblockGate = resolve; });
  const done = new Promise(resolve => { finished = resolve; });
  const releaseDone = new Promise(resolve => { released = resolve; });
  startRecurringScheduleScheduler({ ...options, wakeReason: undefined, now: serial.nextRunAt,
    runGate: async () => {
      calls++;
      if (calls === 1) { firstGate(); await block; return { trigger: false }; }
      return { trigger: true };
    },
    onMaterialized: () => finished(),
    ensureEventResources: () => { resourceStarts++; },
    releaseEventResources: () => released(),
  });
  await first;
  notifyAutomationWake('foreground_idle', 'resource_recovery');
  unblockGate(); await done;
  assert.equal(calls, 2, 'an event arriving during a check is retained and serialized');
  assert.equal(created.length, 1);
  const serialResult = await getRecurringSchedule(serial.id);
  assert.equal(serialResult.checkCount, 2); assert.equal(serialResult.lastCheckCause, 'resource_recovery');
  assert.equal(resourceStarts, 1, 'ordinary scheduler checks must not rearm the observer');
  admissions = 1; notifyAutomationWake('foreground_idle'); await releaseDone;
  assert.equal((await getRecurringSchedule(serial.id)).status, 'completed');
  stopRecurringScheduleScheduler();
  await updateRecurringSchedule(serial.id, { enabled: false });
} finally {
  stopRecurringScheduleScheduler();
  await rm(configDir, { recursive: true, force: true });
}
console.log('schedule events: opt-in, hourly fallback, bounds, concurrent checks, cancellation and recovery passed');

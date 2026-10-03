import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'remotelab-task-history-'));
setIsolatedTestHome(fixture);
const { createRecurringSchedule } = await import('../chat/recurring-schedules.mjs');
const { createTrigger } = await import('../chat/triggers.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { getAutomationTask, listAutomationTasks, listAutomationTaskExecutions } = await import('../chat/automation-tasks.mjs');
const { CHAT_TRIGGERS_FILE, CONFIG_DIR } = await import('../lib/config.mjs');
const { ensureRequestSchema } = await import('../lib/request-schema.mjs');
await ensureRequestSchema(CONFIG_DIR);
const template = { folder: fixture, tool: 'codex', name: 'History fixture' };
const now = Date.now();
try {
  const task = await createRecurringSchedule({ sourceSessionId: 'history-source', sessionTemplate: template,
    title: 'Task with older failures', text: 'Fixture only', cron: '0 0 1 1 *', timezone: 'UTC' });
  const ids = [], fixtureTriggers = [];
  for (let index = 0; index < 38; index += 1) {
    const scheduledAt = new Date(now - (index + 1) * 3600000).toISOString();
    const failed = index === 31 || index === 36;
    const run = await createRun({ status: { sessionId: 'history-execution', state: failed ? 'failed' : 'completed',
      completedAt: scheduledAt, failureReason: failed ? 'Fixture allowance exhausted\nRecorded failure details' : null }, manifest: {} });
    const trigger = await createTrigger({ sourceSessionId: 'history-source', sessionTemplate: template,
      scheduleId: task.id, text: 'Fixture only', scheduledAt, enabled: false });
    fixtureTriggers.push({ ...trigger, status: 'delivered', runId: run.id, executionSessionId: 'history-execution' });
    ids.push(trigger.id);
  }
  await writeFile(CHAT_TRIGGERS_FILE, JSON.stringify(fixtureTriggers));
  const summary = await getAutomationTask(task.id);
  assert.equal(summary.recentExecutions.length, 5);
  assert.equal(summary.lastExecution.state, 'completed');
  assert.equal(summary.health.failedExecutions, 2, 'summary must not hide failures older than the last five triggers');
  assert.equal(summary.health.needsAttention, false, 'a successful latest run is distinct from historical failures');
  const first = await listAutomationTaskExecutions(task.id, { limit: 25 });
  assert.deepEqual(first.executions.map(item => item.id), ids.slice(0, 25));
  assert.equal(first.totalOccurrences, 38);
  assert.ok(first.nextCursor);
  const second = await listAutomationTaskExecutions(task.id, { cursor: first.nextCursor });
  assert.deepEqual(second.executions.map(item => item.id), ids.slice(25));
  assert.equal(second.nextCursor, '');
  const failed = await listAutomationTaskExecutions(task.id, { status: 'failed', limit: 1 });
  assert.equal(failed.executions[0].id, ids[31], 'failure filtering must look beyond a page of successes');
  assert.match(failed.executions[0].error, /allowance exhausted/);
  assert.equal(failed.executions[0].sessionId, 'history-execution');
  const nextFailure = await listAutomationTaskExecutions(task.id, { status: 'failed', limit: 1, cursor: failed.nextCursor });
  assert.equal(nextFailure.executions[0].id, ids[36]);
  assert.equal(nextFailure.nextCursor, '');
  const foreign = await createTrigger({ sourceSessionId: 'other-source', sessionTemplate: template,
    text: 'Different task', scheduledAt: new Date(now + 3600000).toISOString(), enabled: false });
  await assert.rejects(listAutomationTaskExecutions(task.id, { cursor: foreign.id }), /does not belong/);
  await assert.rejects(listAutomationTaskExecutions(task.id, { limit: 101 }), /limit/);
  await assert.rejects(listAutomationTaskExecutions(task.id, { status: 'completed' }), /status/);
  assert.equal(await listAutomationTaskExecutions('sch_' + 'f'.repeat(24)), null);
  const stored = JSON.parse(await readFile(CHAT_TRIGGERS_FILE, 'utf8'));
  await writeFile(CHAT_TRIGGERS_FILE, JSON.stringify(stored.map(item => item.id === foreign.id
    ? { ...item, status: 'delivered', runId: 'run_' + 'f'.repeat(24) } : item)));
  const unverified = await getAutomationTask(foreign.id);
  assert.equal(unverified.lastExecution.runAvailable, false, 'old admissions without execution evidence cannot be live jobs');
  assert.equal(unverified.health.failedExecutions, 0);
  const listed = await listAutomationTasks();
  assert.equal(listed.filter(item => item.kind === 'recurring').length, 1);
  assert.ok(!listed.some(item => ids.includes(item.id)), 'schedule occurrences must remain nested beneath their task');
  console.log('Automation history: older failures, recovery, pagination, scope, and unverified admissions passed.');
} finally { await rm(fixture, { recursive: true, force: true }); }

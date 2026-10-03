import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { automationDay, summarizeAutomationExecutions } from '../chat/automation-execution-summary.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'remotelab-task-history-'));
setIsolatedTestHome(fixture);
const { createRecurringSchedule } = await import('../chat/recurring-schedules.mjs');
const { createTrigger } = await import('../chat/triggers.mjs');
const { requests } = await import('../chat/requests.mjs');
const { createRun } = await import('../chat/runs.mjs');
const { getAutomationTask, listAutomationTasks, listAutomationTaskExecutions } = await import('../chat/automation-tasks.mjs');
const { CHAT_TRIGGERS_FILE, CHAT_RECURRING_SCHEDULES_FILE, CONFIG_DIR } = await import('../lib/config.mjs');
const { ensureRequestSchema } = await import('../lib/request-schema.mjs');
await ensureRequestSchema(CONFIG_DIR);
const template = { folder: fixture, tool: 'codex', name: 'History fixture' };
const now = Date.now();
async function writeFixtureTriggers(rows) {
  await writeFile(CHAT_TRIGGERS_FILE, JSON.stringify(rows));
  // This fixture bypasses the producer API to retain arbitrary execution states.
  // Give the store an unambiguous external revision even on coarse mtime filesystems.
  await utimes(CHAT_TRIGGERS_FILE, new Date(), new Date(Date.now() + 1000));
}
try {
  const clock = '2026-10-03T00:30:00Z';
  const actual = [
    { state: 'completed', triggerStatus: 'delivered', runAvailable: true, scheduledAt: '2026-10-02T23:00:00Z' },
    { state: 'failed', triggerStatus: 'failed', attemptedAt: '2026-10-03T00:00:00Z' },
    { state: 'running', triggerStatus: 'delivered', runAvailable: true, admittedAt: '2026-10-03T00:01:00Z' },
    { state: 'admitted', triggerStatus: 'delivered', runAvailable: false, admittedAt: '2026-10-03T00:02:00Z' },
    { state: 'cancelled', triggerStatus: 'cancelled', runAvailable: true, admittedAt: '2026-10-03T00:03:00Z' },
    { state: 'scheduled', triggerStatus: 'pending', scheduledAt: '2030-01-01T00:00:00Z' },
    { state: 'cancelled', triggerStatus: 'cancelled', scheduledAt: '2026-10-03T00:04:00Z' },
    { state: 'paused', triggerStatus: 'paused', scheduledAt: '2026-10-03T00:05:00Z' },
    { state: 'completed', triggerStatus: 'delivered', runAvailable: true,
      scheduledAt: '2026-10-02T12:00:00Z', attemptedAt: '2026-10-03T00:06:00Z' },
  ];
  const counts = summarizeAutomationExecutions(actual, { now: clock, timezone: 'Asia/Shanghai' });
  assert.equal(counts.totalRuns, 6, 'planned and pre-execution cancelled/paused triggers are not executions');
  assert.equal(counts.failedRuns, 1);
  assert.equal(counts.latestExecution, actual[8], 'latest uses actual attempt time and excludes future plans');
  assert.equal(counts.firstRunAt, '2026-10-02T23:00:00Z');
  assert.deepEqual(counts.today, { runs: 6, completed: 2, failed: 1, running: 1, cancelled: 1, unverified: 1 });
  assert.equal(summarizeAutomationExecutions(actual, { now: clock, timezone: 'UTC' }).today.completed, 1,
    'today uses the task timezone and actual attempt date, not a delayed scheduled date');
  assert.equal(automationDay('invalid'), '');
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
  await writeFixtureTriggers(fixtureTriggers);
  const summary = await getAutomationTask(task.id);
  assert.equal(summary.summary.totalRuns, 38);
  assert.equal(summary.summary.failedRuns, 2);
  assert.equal(summary.summary.latestExecution.id, ids[0]);
  assert.equal(summary.summary.firstRunAt, fixtureTriggers[37].scheduledAt, 'totals and date range include retained older runs');
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
  await writeFixtureTriggers(stored.map(item => item.id === foreign.id
    ? { ...item, status: 'delivered', runId: 'run_' + 'f'.repeat(24) } : item));
  const unverified = await getAutomationTask(foreign.id);
  assert.equal(unverified.lastExecution.runAvailable, false, 'old admissions without execution evidence cannot be live jobs');
  assert.equal(unverified.health.failedExecutions, 0);
  const accepted = await requests.accept({ sessionId: 'logical-request', requestId: 'no-retained-run',
    text: 'Fixture only', runId: 'run_' + 'f'.repeat(24) });
  const admittedOnly = await getAutomationTask(foreign.id);
  assert.equal(admittedOnly.lastExecution.state, 'admitted', 'a Request receipt alone must not turn old admissions into active jobs');
  assert.equal(admittedOnly.lastExecution.runAvailable, false);
  await requests.settle(accepted.record.key, { state: 'failed', error: 'Retained request failure without a physical Run' }, []);
  const retainedFailure = await getAutomationTask(foreign.id);
  assert.equal(retainedFailure.lastExecution.state, 'failed');
  assert.match(retainedFailure.lastExecution.error, /Retained request failure/);

  const listed = await listAutomationTasks();
  assert.equal(listed.filter(item => item.kind === 'recurring').length, 1);
  assert.ok(!listed.some(item => ids.includes(item.id)), 'schedule occurrences must remain nested beneath their task');
  // Titles and prompts can change at each follow-up. Origin and execution lineage
  // define the package, including active children and follow-ups of recurring tasks.
  const firstStep = await createTrigger({ sourceSessionId: 'package-source', sessionTemplate: template,
    title: 'Initial checkpoint', text: 'Start the first stage', scheduledAt: new Date(now - 10 * 86400000).toISOString(), enabled: false });
  const nextStep = await createTrigger({ sourceSessionId: 'package-source', sessionTemplate: template,
    title: 'Check the later stage', text: 'Different instructions', scheduledAt: new Date(now + 3600000).toISOString(), enabled: false });
  const nestedStep = await createTrigger({ sourceSessionId: 'package-step-execution', sessionTemplate: template,
    title: 'Follow up from execution', text: 'A third prompt', scheduledAt: new Date(now + 7200000).toISOString(), enabled: false });
  const scheduleFollowup = await createTrigger({ sourceSessionId: 'history-execution', sessionTemplate: template,
    title: 'Continue the scheduled check', text: 'Follow-up in an execution Session', scheduledAt: new Date(now + 10800000).toISOString(), enabled: false });
  const independent = await createRecurringSchedule({ sourceSessionId: 'history-source', sessionTemplate: template,
    title: 'Independent recurring task', text: 'Separate schedule from the same setup conversation', cron: '0 1 1 1 *', timezone: 'UTC' });
  const packageFailure = await createRun({ status: { sessionId: 'package-step-execution', state: 'failed',
    completedAt: firstStep.scheduledAt, failureReason: 'An older package failure' }, manifest: {} });
  const packageRows = JSON.parse(await readFile(CHAT_TRIGGERS_FILE, 'utf8'));
  await writeFixtureTriggers(packageRows.map(item => item.id === firstStep.id
    ? { ...item, status: 'delivered', runId: packageFailure.id, executionSessionId: 'package-step-execution' } : item));
  const packaged = await listAutomationTasks();
  const find = id => packaged.find(item => item.id === id);
  assert.equal(find(firstStep.id).package.id, find(nextStep.id).package.id, 'different titles/prompts must fold under the same source task');
  assert.equal(find(firstStep.id).package.id, find(nestedStep.id).package.id, 'follow-ups made in an execution inherit the original package');
  assert.equal(find(scheduleFollowup.id).package.id, task.id, 'a recurring execution follow-up belongs to its schedule');
  assert.notEqual(find(independent.id).package.id, task.id, 'independent schedules never merge by shared source Session');
  assert.equal(find(firstStep.id).health.recordedFailures, 1, 'package badges include retained failures older than the recent health window');
  assert.equal(find(firstStep.id).health.failedExecutions, 0, 'recent monitoring health retains its existing window');
  const packageHistory = await listAutomationTaskExecutions(nextStep.id, { scope: 'package' });
  assert.equal(packageHistory.totalOccurrences, 3);
  assert.deepEqual(new Set(packageHistory.executions.map(item => item.id)), new Set([firstStep.id, nextStep.id, nestedStep.id]));
  assert.match(packageHistory.executions.find(item => item.id === firstStep.id).error, /older package failure/);
  assert.equal(packageHistory.executions.find(item => item.id === nestedStep.id).taskId, nestedStep.id);
  const schedulePackageHistory = await listAutomationTaskExecutions(task.id, { scope: 'package', status: 'failed' });
  assert.equal(schedulePackageHistory.totalOccurrences, 39);
  assert.equal(schedulePackageHistory.executions.length, 2);
  await assert.rejects(listAutomationTaskExecutions(nextStep.id, { scope: 'package', cursor: foreign.id }), /does not belong/);
  await assert.rejects(listAutomationTaskExecutions(nextStep.id, { scope: 'everything' }), /scope/);
  assert.equal(find(scheduleFollowup.id).summary.timezone, 'UTC', 'schedule follow-ups share the parent day boundary');
  const replacement = await createRecurringSchedule({ sourceSessionId: 'history-source', sessionTemplate: template,
    title: 'Task with older failures', text: 'Fixture only', cron: '0 2 1 1 *', timezone: 'UTC' });
  const latestDefinitions = await listAutomationTasks();
  assert.equal(latestDefinitions.find(item => item.id === replacement.id).package.id,
    latestDefinitions.find(item => item.id === task.id).package.id, 'recreated business definitions share one task package');
  assert.notEqual(latestDefinitions.find(item => item.id === independent.id).package.id,
    latestDefinitions.find(item => item.id === task.id).package.id, 'different business definitions remain separate');
  // Conditional automations do useful script work without launching an AI Run.
  // The persisted check ledger and retained AI history must stay separate.
  const observer = await createRecurringSchedule({ sourceSessionId: 'observer-source', sessionTemplate: template,
    title: 'Conditional observer', text: 'Inspect only on changes', cron: '0 3 1 1 *', timezone: 'UTC',
    gate: { mode: 'script', runtime: 'node', source: 'console.log(JSON.stringify({trigger:false}))' } });
  const checkAt = new Date(now - 60000).toISOString();
  const scheduleRows = JSON.parse(await readFile(CHAT_RECURRING_SCHEDULES_FILE, 'utf8'));
  await writeFile(CHAT_RECURRING_SCHEDULES_FILE, JSON.stringify(scheduleRows.map(row => row.id === observer.id
    ? { ...row, checkCount: 10, gateErrorCount: 1, lastCheckAt: checkAt, lastGateReason: 'gate_error', lastError: 'Fixture script check failed' } : row)));
  await utimes(CHAT_RECURRING_SCHEDULES_FILE, new Date(), new Date(Date.now() + 1000));
  const observed = await getAutomationTask(observer.id);
  assert.equal(observed.summary.totalRuns, 0, 'checks do not invent AI Runs');
  assert.equal(observed.summary.latestExecution, null);
  assert.equal(observed.summary.inspection.total, 10);
  assert.equal(observed.summary.inspection.failed, 1);
  assert.deepEqual(observed.summary.inspection.latest, { at: checkAt, state: 'failed', error: 'Fixture script check failed' });
  assert.equal((await listAutomationTaskExecutions(observer.id)).executions.length, 0, 'aggregate check counters do not fabricate historical timestamps');
  assert.equal((await getAutomationTask(task.id)).summary.totalRuns, 38, 'ordinary schedule totals use retained executions, not scheduler check counters');
  const { createSession } = await import('../chat/session-manager.mjs');
  const chat = await createSession(fixture, 'codex', 'Feishu 私聊');
  const daily = await createTrigger({ sourceSessionId: chat.id, sessionTemplate: template,
    title: 'Daily report', text: 'First daily run', scheduledAt: new Date(now + 3600000).toISOString(), enabled: false });
  const dailyAgain = await createTrigger({ sourceSessionId: chat.id, sessionTemplate: template,
    title: 'Daily report', text: 'Second daily run', scheduledAt: new Date(now + 7200000).toISOString(), enabled: false });
  const weekly = await createTrigger({ sourceSessionId: chat.id, sessionTemplate: template,
    title: 'Weekly research', text: 'Different business task', scheduledAt: new Date(now + 10800000).toISOString(), enabled: false });
  const chatTasks = await listAutomationTasks();
  assert.equal(chatTasks.find(item => item.id === daily.id).package.sourceSessionName, 'Feishu 私聊',
    'archived or unloaded source Sessions retain a readable origin in the view projection');
  const chatPackage = id => chatTasks.find(item => item.id === id).package.id;
  assert.equal(chatPackage(daily.id), chatPackage(dailyAgain.id));
  assert.notEqual(chatPackage(daily.id), chatPackage(weekly.id), 'a common Feishu chat is not a parent business task');
  console.log('Automation packages and history: actual attempt totals, latest actual execution, separate script check counts, daily timezone outcomes, parent lineage, recreated definitions, generic chat isolation, older failures and pagination passed.');
} finally { await rm(fixture, { recursive: true, force: true }); }

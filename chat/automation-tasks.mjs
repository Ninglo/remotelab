import {
  cancelScheduleTriggers,
  createTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from './triggers.mjs';
import {
  createRecurringSchedule,
  getRecurringSchedule,
  listRecurringSchedules,
  updateRecurringSchedule,
} from './recurring-schedules.mjs';
import { getRun } from './runs.mjs';
import { requests } from './requests.mjs';
import { getSession, getRunState } from './session-manager.mjs';
import { createHash } from 'node:crypto';
import { summarizeAutomationExecutions, automationDay } from './automation-execution-summary.mjs';
import { scheduledRuntimeIntent } from '../lib/scheduled-runtime-policy.mjs';

const RECENT_EXECUTION_LIMIT = 5;
const HEALTH_WINDOW_DAYS = 7;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectTarget(record) {
  const template = record?.sessionTemplate || {};
  if (template.reuse === 'fixed_session' && trimString(template.sessionId)) {
    return {
      mode: 'fixed_session',
      sessionId: trimString(template.sessionId),
    };
  }
  if (template.reuse === 'calendar_day') {
    return {
      mode: 'calendar_day_session',
      sourceSessionId: trimString(record?.sourceSessionId),
      timezone: trimString(template.reuseTimezone),
    };
  }
  return {
    mode: 'new_session',
    sourceSessionId: trimString(record?.sourceSessionId),
  };
}

function projectNotification(record) {
  const conversation = record?.sessionTemplate?.conversation;
  if (!conversation) return { mode: 'remotelab' };
  return {
    mode: 'conversation',
    connector: trimString(conversation.connector),
    sourceRouteId: trimString(conversation.sourceRouteId),
    target: conversation.target && typeof conversation.target === 'object'
      ? JSON.parse(JSON.stringify(conversation.target))
      : {},
  };
}

function projectAlerts(record) {
  const alerts = record?.alerts && typeof record.alerts === 'object' ? record.alerts : {};
  return {
    mode: trimString(alerts.mode) || 'remotelab',
    on: Array.isArray(alerts.on) ? [...alerts.on] : ['gate_error', 'execution_failure'],
  };
}

function projectGate(record) {
  const gate = record?.gate && typeof record.gate === 'object' ? record.gate : { mode: 'direct' };
  if (gate.mode !== 'script') return { mode: 'direct' };
  return {
    mode: 'script',
    runtime: trimString(gate.runtime),
    snapshotSha256: trimString(gate.snapshotSha256),
    timeoutSeconds: Number(gate.timeoutSeconds) || 0,
    cooldownSeconds: Number(gate.cooldownSeconds) || 0,
  };
}

async function projectCreatedByIdentityId(record) {
  const explicit = trimString(record?.createdByIdentityId);
  if (explicit) return explicit;
  const sourceSessionId = trimString(record?.sourceSessionId);
  if (!sourceSessionId) return '';
  const source = await getSession(sourceSessionId);
  return trimString(source?.initiatedByIdentityId);
}

function projectExecutionState(trigger, run) {
  if (run?.state) return trimString(run.state);
  switch (trigger?.status) {
    case 'pending': return 'scheduled';
    case 'paused': return 'paused';
    case 'delivering': return 'starting';
    case 'delivered': return 'admitted';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return trimString(trigger?.status) || 'unknown';
  }
}

async function projectExecution(trigger) {
  if (!trigger) return null;
  const runId = trimString(trigger.runId);
  const storedRun = runId ? await getRun(runId) : null;
  const receipt = !storedRun && runId ? await requests.byRunId(runId) : null;
  const run = storedRun || (receipt?.nativeDispatchRunId ? await getRunState(runId)
    : receipt?.result ? { state: receipt.result.state, sessionId: receipt.sessionId,
      completedAt: receipt.settledAt, failureReason: receipt.result.error } : null);
  const runAvailable = Boolean(storedRun || run?.createdAt || ['completed', 'failed', 'cancelled'].includes(run?.state));
  return {
    id: trigger.id,
    taskId: trimString(trigger.scheduleId) || trigger.id,
    title: trimString(trigger.title),
    state: projectExecutionState(trigger, runAvailable ? run : null),
    triggerStatus: trigger.status,
    scheduledAt: trigger.scheduledAt,
    attemptedAt: trigger.lastAttemptAt || '',
    admittedAt: trigger.deliveredAt || '',
    completedAt: run?.completedAt || '',
    runId,
    runAvailable,
    sessionId: trimString(trigger.executionSessionId) || trimString(run?.sessionId),
    runtime: trigger.executionRuntime || null,
    error: trimString(run?.failureReason) || trimString(run?.error?.message)
      || trimString(run?.error) || trimString(receipt?.result?.error?.message)
      || trimString(receipt?.result?.error) || trimString(trigger.lastError),
  };
}

function executionHealth(executions, { lastError = '', lastErrorAt = '' } = {}) {
  const cutoff = Date.now() - HEALTH_WINDOW_DAYS * 86400000;
  const failed = executions.filter(item => item.state === 'failed'
    && timestamp(item.completedAt || item.attemptedAt || item.scheduledAt) >= cutoff);
  const latest = executions[0];
  return {
    windowDays: HEALTH_WINDOW_DAYS,
    failedExecutions: failed.length,
    recordedFailures: executions.filter(item => item.state === 'failed').length,
    lastFailure: failed[0] || null,
    needsAttention: latest?.state === 'failed' || Boolean(lastError),
    error: lastError || (latest?.state === 'failed' ? latest.error : ''),
    errorAt: lastErrorAt || (latest?.state === 'failed'
      ? latest.completedAt || latest.attemptedAt || latest.scheduledAt : ''),
  };
}

function oneTimeActions(trigger, execution) {
  if (trigger.status === 'pending') return ['pause', 'cancel'];
  if (trigger.status === 'paused' || trigger.status === 'failed') return ['resume', 'cancel'];
  if (execution?.state === 'scheduled') return ['pause', 'cancel'];
  return [];
}

function recurringActions(schedule) {
  if (schedule.status === 'active') return ['pause', 'cancel'];
  if (schedule.status === 'paused') return ['resume', 'cancel'];
  return [];
}

function oneTimeState(trigger, execution) {
  if (trigger.status === 'paused') return 'paused';
  if (trigger.status === 'cancelled') return 'cancelled';
  return execution?.state || trigger.status;
}

async function projectOneTimeTask(trigger) {
  const execution = await projectExecution(trigger);
  const resultDelivery = projectNotification(trigger);
  const createdByIdentityId = await projectCreatedByIdentityId(trigger);
  return {
    id: trigger.id,
    kind: 'one_time',
    title: trigger.title || 'One-time task',
    prompt: trigger.text,
    state: oneTimeState(trigger, execution),
    enabled: trigger.enabled === true,
    schedule: {
      type: 'once',
      scheduledAt: trigger.scheduledAt,
    },
    lifetime: { mode: 'bounded', maxExecutions: 1 },
    gate: { mode: 'direct' },
    target: projectTarget(trigger),
    runtime: scheduledRuntimeIntent(trigger),
    resultDelivery,
    notification: resultDelivery,
    alerts: projectAlerts(trigger),
    nextRunAt: trigger.status === 'pending' ? trigger.scheduledAt : '',
    lastExecution: execution,
    recentExecutions: execution ? [execution] : [],
    executionCount: execution ? 1 : 0,
    summary: summarizeAutomationExecutions(execution ? [execution] : [], { timezone: trigger.sessionTemplate?.reuseTimezone || 'Asia/Shanghai' }),
    health: executionHealth(execution ? [execution] : []),
    sourceSessionId: trigger.sourceSessionId,
    createdByIdentityId,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    actions: oneTimeActions(trigger, execution),
  };
}

async function projectRecurringTask(schedule, occurrences) {
  const selected = [...occurrences]
    .sort((a, b) => timestamp(b.scheduledAt) - timestamp(a.scheduledAt));
  const projected = await Promise.all(selected.map(projectExecution));
  const recentExecutions = projected.slice(0, RECENT_EXECUTION_LIMIT);
  const timezone = schedule.timezone || schedule.sessionTemplate?.reuseTimezone || 'Asia/Shanghai';
  const summary = summarizeAutomationExecutions(projected, { timezone });
  summary.today.checked = automationDay(schedule.lastCheckAt, timezone) === summary.day;
  summary.today.checkFailed = Boolean(schedule.lastError)
    && automationDay(schedule.lastErrorAt || schedule.lastCheckAt, timezone) === summary.day;
  // Script checks are real automation work even when they do not admit an AI Run.
  // Keep their exact persisted counter separate from AI attempts; never add the
  // matched AI Run again to its own check or infer missing historical checks.
  if (schedule.gate?.mode === 'script' || schedule.gateErrorCount) summary.inspection = {
    total: schedule.checkCount || 0,
    failed: schedule.gateErrorCount || 0,
    latest: schedule.lastCheckAt ? {
      at: schedule.lastCheckAt,
      state: schedule.lastGateReason === 'gate_error' ? 'failed' : 'checked',
      error: schedule.lastGateReason === 'gate_error' ? schedule.lastError || '' : '',
    } : null,
  };

  const resultDelivery = projectNotification(schedule);
  const admittedExecutions = occurrences.filter((trigger) => trigger.status === 'delivered').length;
  const pendingAdmissions = occurrences.filter((trigger) => ['pending', 'delivering'].includes(trigger.status)).length;
  const maxExecutions = schedule.lifetime?.maxExecutions || 0;
  const createdByIdentityId = await projectCreatedByIdentityId(schedule);
  return {
    id: schedule.id,
    kind: 'recurring',
    title: schedule.title || 'Recurring task',
    prompt: schedule.text,
    state: schedule.status,
    enabled: schedule.enabled === true,
    schedule: {
      type: schedule.cadence?.type || 'cron',
      ...(schedule.cadence?.type === 'interval'
        ? { everySeconds: schedule.cadence.everySeconds }
        : { cron: schedule.cron, timezone: schedule.timezone }),
      missedCount: schedule.missedCount,
      skippedCount: schedule.skippedCount,
    },
    lifetime: schedule.lifetime,
    wakeOn: schedule.wakeOn || [],
    automationPolicy: schedule.automationPolicy ? { minIdleSeconds: schedule.automationPolicy.minIdleSeconds,
      beforeLaunch: !!schedule.automationPolicy.beforeLaunch, afterRun: !!schedule.automationPolicy.afterRun } : null,
    gate: projectGate(schedule),
    counters: {
      checks: schedule.checkCount || 0,
      matches: schedule.matchCount || 0,
      gateSkips: schedule.gateSkipCount || 0,
      gateErrors: schedule.gateErrorCount || 0,
      deduplicated: schedule.deduplicatedCount || 0,
      admittedExecutions,
      pendingAdmissions,
      ...(maxExecutions ? { remainingExecutions: Math.max(0, maxExecutions - admittedExecutions) } : {}),
    },
    target: projectTarget(schedule),
    runtime: scheduledRuntimeIntent(schedule),
    resultDelivery,
    notification: resultDelivery,
    alerts: projectAlerts(schedule),
    nextRunAt: schedule.status === 'active' ? schedule.nextRunAt : '',
    lastExecution: recentExecutions[0] || null,
    recentExecutions,
    executionCount: occurrences.length,
    summary,
    health: executionHealth(projected, { lastError: schedule.lastError || '', lastErrorAt: schedule.lastErrorAt || '' }),
    check: { at: schedule.lastCheckAt || '', cause: schedule.lastCheckCause || '', reason: schedule.lastGateReason || '',
      error: schedule.lastError || '', errorAt: schedule.lastErrorAt || '' },
    sourceSessionId: schedule.sourceSessionId,
    createdByIdentityId,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    lastError: schedule.lastError || '',
    actions: recurringActions(schedule),
  };
}

function taskSort(left, right) {
  const stateRank = { active: 0, scheduled: 0, starting: 0, running: 0, paused: 1 };
  const leftRank = stateRank[left.state] ?? 2;
  const rightRank = stateRank[right.state] ?? 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftTime = timestamp(left.nextRunAt) || timestamp(left.updatedAt) || timestamp(left.createdAt);
  const rightTime = timestamp(right.nextRunAt) || timestamp(right.updatedAt) || timestamp(right.createdAt);
  return leftRank < 2 ? leftTime - rightTime : rightTime - leftTime;
}

// Read-only lineage: follow-ups made inside an execution stay with its parent
// automation. Independent schedules remain separate even in the same source Session.
async function automationPackages(schedules, triggers) {
  const sessionNames = new Map();
  await Promise.all([...new Set([...schedules, ...triggers].map(item => trimString(item.sourceSessionId)).filter(Boolean))]
    .map(async id => sessionNames.set(id, trimString((await getSession(id))?.name))));
  const schedulesById = new Map(schedules.map(item => [item.id, item]));
  const scheduleOrigins = new Map(), definitions = new Map();
  // Recreated definitions of the same task share history; independent purposes,
  // destinations and owners in a setup conversation remain separate.
  for (const schedule of [...schedules].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt) || a.id.localeCompare(b.id))) {
    const key = JSON.stringify([schedule.sourceSessionId, schedule.title, schedule.text,
      projectTarget(schedule), projectNotification(schedule), schedule.createdByIdentityId, schedule.timezone]);
    let origin = definitions.get(key);
    if (!origin) { origin = { id: schedule.id, title: schedule.title, sourceSessionId: schedule.sourceSessionId }; definitions.set(key, origin); }
    scheduleOrigins.set(schedule.id, origin);
  }
  const executionParents = new Map();
  for (const trigger of triggers) {
    const sessionId = trimString(trigger.executionSessionId);
    if (!sessionId || sessionId === trimString(trigger.sourceSessionId)) continue;
    const parents = executionParents.get(sessionId) || [];
    parents.push(trigger); executionParents.set(sessionId, parents);
  }
  const resolved = new Map();
  function resolve(trigger, path = new Set()) {
    const schedule = schedulesById.get(trimString(trigger.scheduleId));
    if (schedule) return scheduleOrigins.get(schedule.id);
    const sourceSessionId = trimString(trigger.sourceSessionId);
    const sourceName = sessionNames.get(sourceSessionId) || '';
    const genericConversation = /^(?:Feishu|Lark)\s*(?:私聊|群聊|chat|p2p|group)$|^(?:New Session|新会话)$/i.test(sourceName);
    const purpose = genericConversation ? trimString(trigger.title) || trimString(trigger.text) : '';
    const suffix = purpose ? ':' + createHash('sha256').update(purpose).digest('hex').slice(0, 12) : '';
    const fallback = { id: sourceSessionId ? `session:${sourceSessionId}${suffix}` : trigger.id,
      title: purpose ? trimString(trigger.title) : sourceName, sourceSessionId };
    if (path.has(trigger.id)) return fallback;
    if (resolved.has(trigger.id)) return resolved.get(trigger.id);
    const parents = executionParents.get(sourceSessionId) || [];
    const nextPath = new Set(path); nextPath.add(trigger.id);
    const origins = new Map(parents.map(parent => {
      const origin = resolve(parent, nextPath); return [origin.id, origin];
    }));
    // A Session reused by several independent schedules has no unique parent.
    // Keep those follow-ups under that Session rather than guessing a schedule.
    const origin = origins.size === 1 ? [...origins.values()][0] : fallback;
    resolved.set(trigger.id, origin); return origin;
  }
  const byTask = new Map(scheduleOrigins);
  for (const trigger of triggers) byTask.set(trigger.id, resolve(trigger));
  for (const origin of byTask.values()) origin.sourceSessionName = sessionNames.get(origin.sourceSessionId) || '';
  return byTask;
}

function attachPackage(task, packages, schedules) {
  task.package = packages.get(task.id);
  if (task.kind === 'one_time') {
    const parent = schedules.find(item => item.id === task.package?.id);
    if (parent) task.summary = summarizeAutomationExecutions(task.recentExecutions, {
      timezone: parent.timezone || parent.sessionTemplate?.reuseTimezone || 'Asia/Shanghai',
    });
  }
  return task;
}

export async function listAutomationTasks() {
  const [schedules, triggers] = await Promise.all([
    listRecurringSchedules(),
    listTriggers(),
  ]);
  const occurrencesBySchedule = new Map();
  const oneTimeTriggers = [];
  for (const trigger of triggers) {
    const scheduleId = trimString(trigger.scheduleId);
    if (!scheduleId) {
      oneTimeTriggers.push(trigger);
      continue;
    }
    const list = occurrencesBySchedule.get(scheduleId) || [];
    list.push(trigger);
    occurrencesBySchedule.set(scheduleId, list);
  }
  const tasks = await Promise.all([
    ...schedules.map((schedule) => projectRecurringTask(
      schedule,
      occurrencesBySchedule.get(schedule.id) || [],
    )),
    ...oneTimeTriggers.map(projectOneTimeTask),
  ]);
  const packages = await automationPackages(schedules, triggers);
  for (const task of tasks) attachPackage(task, packages, schedules);
  return tasks.sort(taskSort);
}

// Browse a task's durable occurrences without making each trigger a top-level task.
export async function listAutomationTaskExecutions(taskId, { cursor = '', limit = 25, status = 'all', scope = 'task' } = {}) {
  const pageSize = Number(limit);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('limit must be between 1 and 100');
  if (!['task', 'package'].includes(scope)) throw new Error('Unsupported execution scope');
  if (!['all', 'failed'].includes(status)) throw new Error('Unsupported execution status');
  const id = trimString(taskId);
  let occurrences;
  if (id.startsWith('sch_')) {
    if (!await getRecurringSchedule(id)) return null;
    occurrences = await listTriggers({ scheduleId: id });
  } else if (id.startsWith('trg_')) {
    const trigger = await getTrigger(id);
    if (!trigger) return null;
    occurrences = [trigger];
  } else return null;
  if (scope === 'package') {
    const [schedules, triggers] = await Promise.all([listRecurringSchedules(), listTriggers()]);
    const packages = await automationPackages(schedules, triggers);
    const packageId = packages.get(id)?.id;
    occurrences = triggers.filter(trigger => packages.get(trigger.id)?.id === packageId);
  }
  occurrences.sort((a, b) => timestamp(b.scheduledAt) - timestamp(a.scheduledAt) || b.id.localeCompare(a.id));
  const cursorIndex = cursor ? occurrences.findIndex(item => item.id === cursor) : -1;
  if (cursor && cursorIndex === -1) throw new Error('Cursor does not belong to this task');
  const pending = occurrences.slice(cursorIndex + 1);
  const executions = [];
  // A failed-only view must look beyond the first page of successful triggers.
  let hasMore = false;
  for (const trigger of pending) {
    const execution = await projectExecution(trigger);
    if (status === 'failed' && execution.state !== 'failed') continue;
    if (executions.length === pageSize) { hasMore = true; break; }
    executions.push(execution);
  }
  return { executions, totalOccurrences: occurrences.length, status,
    nextCursor: hasMore ? executions.at(-1).id : '', limit: pageSize };
}

export async function getAutomationTask(taskId) {
  const id = trimString(taskId);
  if (id.startsWith('sch_')) {
    const schedule = await getRecurringSchedule(id);
    if (!schedule) return null;
    const packages = await automationPackages(await listRecurringSchedules(), []);
    return { ...await projectRecurringTask(schedule, await listTriggers({ scheduleId: id })), package: packages.get(id) };
  }
  if (id.startsWith('trg_')) {
    const trigger = await getTrigger(id);
    if (!trigger) return null;
    const schedules = await listRecurringSchedules();
    const packages = await automationPackages(schedules, await listTriggers());
    return attachPackage(await projectOneTimeTask(trigger), packages, schedules);
  }
  return null;
}

export async function createAutomationTask(input = {}) {
  const kind = trimString(input.kind).toLowerCase();
  if (kind === 'recurring') {
    const schedule = await createRecurringSchedule(input);
    return getAutomationTask(schedule.id);
  }
  if (kind === 'one_time') {
    const trigger = await createTrigger(input);
    return getAutomationTask(trigger.id);
  }
  throw new Error('kind must be one_time or recurring');
}

export async function applyAutomationTaskAction(taskId, action) {
  const id = trimString(taskId);
  const normalizedAction = trimString(action).toLowerCase();
  if (!['pause', 'resume', 'cancel'].includes(normalizedAction)) {
    throw new Error('action must be pause, resume, or cancel');
  }

  let cancellation = null;
  if (id.startsWith('sch_')) {
    const current = await getRecurringSchedule(id);
    if (!current) return null;
    if (normalizedAction === 'resume') {
      if (current.status === 'cancelled') throw new Error('Cancelled tasks cannot be resumed');
      if (current.status !== 'active') await updateRecurringSchedule(id, { status: 'active' });
    } else {
      const status = normalizedAction === 'pause' ? 'paused' : 'cancelled';
      if (current.status !== status) await updateRecurringSchedule(id, { status });
      cancellation = await cancelScheduleTriggers(id, { includeActive: false });
    }
  } else if (id.startsWith('trg_')) {
    const current = await getTrigger(id);
    if (!current) return null;
    if (normalizedAction === 'resume') {
      if (current.status === 'cancelled') throw new Error('Cancelled tasks cannot be resumed');
      if (!['paused', 'failed', 'pending'].includes(current.status)) {
        throw new Error(`Task cannot be resumed from ${current.status}`);
      }
      if (current.status !== 'pending') await updateTrigger(id, { status: 'pending' });
    } else {
      if (['delivering', 'delivered'].includes(current.status)) {
        throw new Error('An admitted execution is not stopped by Task Center');
      }
      const status = normalizedAction === 'pause' ? 'paused' : 'cancelled';
      if (current.status !== status) await updateTrigger(id, { status });
    }
  } else {
    return null;
  }

  return {
    task: await getAutomationTask(id),
    cancellation,
  };
}

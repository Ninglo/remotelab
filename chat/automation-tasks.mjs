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

const RECENT_EXECUTION_LIMIT = 5;

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
  const run = runId ? await getRun(runId) : null;
  return {
    id: trigger.id,
    state: projectExecutionState(trigger, run),
    triggerStatus: trigger.status,
    scheduledAt: trigger.scheduledAt,
    attemptedAt: trigger.lastAttemptAt || '',
    admittedAt: trigger.deliveredAt || '',
    completedAt: run?.completedAt || '',
    runId,
    sessionId: trimString(trigger.executionSessionId),
    error: trimString(run?.failureReason) || trimString(run?.error?.message)
      || trimString(run?.error) || trimString(trigger.lastError),
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
    resultDelivery,
    notification: resultDelivery,
    alerts: projectAlerts(trigger),
    nextRunAt: trigger.status === 'pending' ? trigger.scheduledAt : '',
    lastExecution: execution,
    recentExecutions: execution ? [execution] : [],
    sourceSessionId: trigger.sourceSessionId,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    actions: oneTimeActions(trigger, execution),
  };
}

async function projectRecurringTask(schedule, occurrences) {
  const recentTriggers = [...occurrences]
    .sort((left, right) => timestamp(right.scheduledAt) - timestamp(left.scheduledAt))
    .slice(0, RECENT_EXECUTION_LIMIT);
  const recentExecutions = await Promise.all(recentTriggers.map(projectExecution));
  const resultDelivery = projectNotification(schedule);
  const admittedExecutions = occurrences.filter((trigger) => trigger.status === 'delivered').length;
  const pendingAdmissions = occurrences.filter((trigger) => ['pending', 'delivering'].includes(trigger.status)).length;
  const maxExecutions = schedule.lifetime?.maxExecutions || 0;
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
    resultDelivery,
    notification: resultDelivery,
    alerts: projectAlerts(schedule),
    nextRunAt: schedule.status === 'active' ? schedule.nextRunAt : '',
    lastExecution: recentExecutions[0] || null,
    recentExecutions,
    sourceSessionId: schedule.sourceSessionId,
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
  return tasks.sort(taskSort);
}

export async function getAutomationTask(taskId) {
  const id = trimString(taskId);
  if (id.startsWith('sch_')) {
    const schedule = await getRecurringSchedule(id);
    if (!schedule) return null;
    return projectRecurringTask(schedule, await listTriggers({ scheduleId: id }));
  }
  if (id.startsWith('trg_')) {
    const trigger = await getTrigger(id);
    return trigger ? projectOneTimeTask(trigger) : null;
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

export function isStoppedAutomation(task, now = Date.now()) {
  if (task?.enabled === false || ['paused', 'cancelled', 'completed'].includes(task?.state)) return true;
  const checkedAt = Date.parse(task?.check?.at || '');
  // This is an explicit business switch reported by its native condition,
  // not a guess from arbitrary no-match prose. Stale checks cannot stop work.
  return task?.check?.reason === 'consumer_disabled' && !task.lastError
    && Number.isFinite(checkedAt) && checkedAt <= now + 5000 && now - checkedAt <= 10 * 60_000;
}

// Current execution health is separate from the acceptance of an old repair.
// In particular, a stopped schedule is not a failed running automation.
export function currentAutomationStatus(task, incident, now = Date.now()) {
  if (!task) return 'unknown';
  if (['paused', 'cancelled', 'completed'].includes(task.state)) return task.state;
  if (isStoppedAutomation(task, now)) return 'paused';
  if (task.lastError || task.lastExecution?.state === 'failed') return 'failed';
  if (task.lastExecution?.runId && task.lastExecution.runId !== incident.originRunId
    && task.lastExecution.state === 'completed') return 'healthy';
  return 'unknown';
}

export function isCurrentRecovery(item) {
  return !['resolved', 'cancelled'].includes(item.status)
    && !['healthy', 'paused', 'cancelled', 'completed'].includes(item.currentResourceStatus);
}

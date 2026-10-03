const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const LIVE_STATES = new Set(['starting', 'accepted', 'admitted', 'running']);

function activityTime(execution) {
  return execution.attemptedAt || execution.admittedAt || execution.scheduledAt || '';
}

export function automationDay(value, timezone = DEFAULT_TIMEZONE) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const field = name => parts.find(part => part.type === name)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

// Count actual trigger attempts, not future plans or cancellation before admission.
// An old admission is an attempt, but is not evidence that its execution succeeded.
export function summarizeAutomationExecutions(executions, { timezone = DEFAULT_TIMEZONE, now = Date.now() } = {}) {
  const day = automationDay(now, timezone);
  const attempted = executions.filter(item => item.attemptedAt || item.admittedAt || item.runAvailable
    || ['delivering', 'delivered', 'failed'].includes(item.triggerStatus));
  const today = { runs: 0, completed: 0, failed: 0, running: 0, cancelled: 0, unverified: 0 };
  for (const item of attempted) {
    if (automationDay(activityTime(item), timezone) !== day) continue;
    today.runs += 1;
    if (item.state === 'completed') today.completed += 1;
    else if (item.state === 'failed') today.failed += 1;
    else if (item.state === 'cancelled') today.cancelled += 1;
    else if (LIVE_STATES.has(item.state) && item.runAvailable) today.running += 1;
    else today.unverified += 1;
  }
  return {
    day, timezone, today,
    totalRuns: attempted.length,
    failedRuns: attempted.filter(item => item.state === 'failed').length,
    unverifiedRuns: attempted.filter(item => !item.runAvailable && item.state !== 'failed').length,
  };
}

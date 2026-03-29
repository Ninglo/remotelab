import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');
const SCHEDULES_FILE = join(WORKFLOWS_DIR, 'schedules.json');

// Active timers: scheduleId → timeout handle
const activeTimers = new Map();

// Reference to the onTrigger callback (set by startScheduler)
let _onTrigger = null;

// ---- Helpers ----

function atomicWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filepath);
}

// Parse "minute hour * * *" style cron (daily-only subset, also supports day-of-week)
function parseCron(cron) {
  const parts = cron.split(' ');
  return {
    minute: parseInt(parts[0], 10),
    hour: parseInt(parts[1], 10),
    dayOfMonth: parts[2],   // '*' or number
    month: parts[3],         // '*' or number
    dayOfWeek: parts[4],     // '*' or number (0=Sun)
  };
}

// Milliseconds until next occurrence of a cron schedule
function msUntilNextCron(cron) {
  const { minute, hour, dayOfWeek } = parseCron(cron);
  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);

  if (dayOfWeek !== '*') {
    const targetDay = parseInt(dayOfWeek, 10);
    const currentDay = now.getDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && next <= now) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
  } else {
    if (next <= now) next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch (err) {
    console.error('[Scheduler] Failed to load schedules.json:', err.message);
    return { schedules: [] };
  }
}

export function updateLastRun(scheduleId) {
  try {
    const data = loadSchedules();
    const s = data.schedules.find(s => s.id === scheduleId);
    if (s) {
      s.lastRun = new Date().toISOString();
      atomicWriteJSON(SCHEDULES_FILE, data);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to update lastRun:', err.message);
  }
}

function ensureWorkflowsDir() {
  if (!existsSync(WORKFLOWS_DIR)) mkdirSync(WORKFLOWS_DIR, { recursive: true });
}

// ---- Schedule a single schedule entry ----

function scheduleOne(schedule, onTrigger) {
  // Clear any existing timer for this schedule
  clearScheduleTimer(schedule.id);

  if (!schedule.enabled) return;

  // runAt-based schedule (one-time delayed execution)
  if (schedule.runAt && !schedule.cron) {
    const runAtTime = new Date(schedule.runAt).getTime();
    const delay = runAtTime - Date.now();

    if (delay < 0) {
      // runAt is in the past — trigger only if never run before
      if (!schedule.lastRun) {
        console.log(`[Scheduler] runAt "${schedule.id}" is past due, triggering now`);
        triggerAndUpdate(schedule, onTrigger);
      } else {
        console.log(`[Scheduler] runAt "${schedule.id}" already ran, skipping`);
      }
      return;
    }

    const delayMin = Math.round(delay / 1000 / 60);
    console.log(`[Scheduler] runAt "${schedule.id}" scheduled in ${delayMin} min (${schedule.runAt})`);
    const timer = setTimeout(() => {
      activeTimers.delete(schedule.id);
      triggerAndUpdate(schedule, onTrigger);
    }, delay);
    activeTimers.set(schedule.id, timer);
    return;
  }

  // interval-based schedule (recurring with fixed interval)
  if (schedule.intervalMs && !schedule.cron) {
    const intervalMin = Math.round(schedule.intervalMs / 1000 / 60);
    console.log(`[Scheduler] "${schedule.id}" interval every ${intervalMin} min`);
    const timer = setTimeout(function tick() {
      console.log(`[Scheduler] Triggering "${schedule.id}" (interval)`);
      triggerAndUpdate(schedule, onTrigger);
      // Re-schedule from fresh disk state (might have been disabled/updated)
      const freshData = loadSchedules();
      const freshSchedule = freshData.schedules.find(s => s.id === schedule.id);
      if (freshSchedule && freshSchedule.enabled && freshSchedule.intervalMs) {
        const nextTimer = setTimeout(tick, freshSchedule.intervalMs);
        activeTimers.set(schedule.id, nextTimer);
      }
    }, schedule.intervalMs);
    activeTimers.set(schedule.id, timer);
    return;
  }

  // cron-based schedule
  if (!schedule.cron) return;

  const { hour, minute } = parseCron(schedule.cron);

  // Missed-run detection
  if (schedule.lastRun !== null) {
    const lastRun = new Date(schedule.lastRun);
    const expectedToday = new Date();
    expectedToday.setHours(hour, minute, 0, 0);
    const now = new Date();
    if (lastRun < expectedToday && expectedToday <= now) {
      console.log(`[Scheduler] Missed run detected for "${schedule.id}", triggering now`);
      triggerAndUpdate(schedule, onTrigger);
    }
  }

  const delay = msUntilNextCron(schedule.cron);
  const delayMin = Math.round(delay / 1000 / 60);
  console.log(`[Scheduler] "${schedule.id}" scheduled in ${delayMin} min (${schedule.cron})`);

  const timer = setTimeout(() => {
    activeTimers.delete(schedule.id);
    console.log(`[Scheduler] Triggering "${schedule.id}"`);
    triggerAndUpdate(schedule, onTrigger);
    // Re-schedule for next occurrence (reload from disk to get fresh data)
    const freshData = loadSchedules();
    const freshSchedule = freshData.schedules.find(s => s.id === schedule.id);
    if (freshSchedule) {
      scheduleOne(freshSchedule, onTrigger);
    }
  }, delay);
  activeTimers.set(schedule.id, timer);
}

async function triggerAndUpdate(schedule, onTrigger) {
  updateLastRun(schedule.id);
  try {
    const result = await onTrigger(schedule);
    // If the schedule was removed by post-run logic (maxRuns reached), clear its timer
    if (result?.meta?._scheduleRemoved) {
      clearScheduleTimer(schedule.id);
      console.log(`[Scheduler] Schedule "${schedule.id}" removed after maxRuns reached`);
    }
  } catch (err) {
    console.error(`[Scheduler] onTrigger error for "${schedule.id}":`, err);
  }
}

// ---- Public API ----

function clearScheduleTimer(scheduleId) {
  const existing = activeTimers.get(scheduleId);
  if (existing) {
    clearTimeout(existing);
    activeTimers.delete(scheduleId);
  }
}

/**
 * Reload a single schedule (e.g. after PATCH update).
 * Clears the old timer and re-schedules based on current disk state.
 */
export function reloadSchedule(scheduleId) {
  if (!_onTrigger) return;
  clearScheduleTimer(scheduleId);
  const data = loadSchedules();
  const schedule = data.schedules.find(s => s.id === scheduleId);
  if (schedule) {
    scheduleOne(schedule, _onTrigger);
  }
}

export function startScheduler(onTrigger) {
  ensureWorkflowsDir();
  _onTrigger = onTrigger;

  const data = loadSchedules();
  for (const schedule of data.schedules) {
    scheduleOne(schedule, onTrigger);
  }
}

import { getRun, isTerminalRunState } from './runs.mjs';

export async function resolveSessionRunActivity(meta) {
  if (meta?.activeRunId) {
    const run = await getRun(meta.activeRunId);
    if (run && !isTerminalRunState(run.state)) {
      return {
        state: 'running',
        run,
      };
    }
  }

  return {
    state: 'idle',
    run: null,
  };
}

export function getSessionRunState(session) {
  return session?.activity?.run?.state === 'running' ? 'running' : 'idle';
}

export function isSessionRunning(session) {
  return getSessionRunState(session) === 'running';
}

export function getSessionQueueCount(session) {
  return Number.isInteger(session?.activity?.queue?.count) ? session.activity.queue.count : 0;
}

export function getSessionRunId(session) {
  return typeof session?.activity?.run?.runId === 'string' && session.activity.run.runId
    ? session.activity.run.runId
    : null;
}

export function buildSessionActivity(meta, runtimeState, { runState, run, queuedCount }) {
  const renameState = runtimeState?.renameState === 'pending' || runtimeState?.renameState === 'failed'
    ? runtimeState.renameState
    : 'idle';
  const renameError = typeof runtimeState?.renameError === 'string' ? runtimeState.renameError : '';
  const compactState = runtimeState?.pendingCompact === true ? 'pending' : 'idle';
  const queueCount = Number.isInteger(queuedCount) ? queuedCount : 0;
  const planningQueue = Array.isArray(meta?.pendingPlanningQueue) ? meta.pendingPlanningQueue : [];
  const planningCount = planningQueue.length;
  const activePlanningEntry = planningCount > 0 ? planningQueue[0] : null;

  return {
    run: {
      state: runState === 'running' ? 'running' : 'idle',
      phase: runState === 'running'
        ? (typeof run?.state === 'string' ? run.state : null)
        : null,
      startedAt: runState === 'running'
        ? (typeof run?.startedAt === 'string' ? run.startedAt : null)
        : null,
      runId: runState === 'running'
        ? (typeof run?.id === 'string'
          ? run.id
          : (typeof meta?.activeRunId === 'string' ? meta.activeRunId : null))
        : null,
      cancelRequested: runState === 'running' && run?.cancelRequested === true,
    },
    queue: {
      state: queueCount > 0 ? 'queued' : 'idle',
      count: queueCount,
    },
    rename: {
      state: renameState,
      error: renameError || null,
    },
    compact: {
      state: compactState,
    },
    planning: {
      state: planningCount > 0 ? 'checking' : 'idle',
      count: planningCount,
      requestId: typeof activePlanningEntry?.requestId === 'string' && activePlanningEntry.requestId
        ? activePlanningEntry.requestId
        : null,
    },
  };
}

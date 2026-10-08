import { getRun, isTerminalRunState } from './runs.mjs';
import { nativeQuestionDeadlineExpired } from '../lib/native-question-surface.mjs';

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

export function buildSessionActivity(meta, runtimeState, { runState, run, queuedCount, nativeQuestion }) {
  const compactState = runtimeState?.pendingCompact === true ? 'pending' : 'idle';
  const queueCount = Number.isInteger(queuedCount) ? queuedCount : 0;
  // Waiting is a display fact; the live run still owns resources and can be
  // answered or stopped. Never turn a waiting native process into an idle run.
  const waiting = runState === 'running' && run?.cancelRequested !== true && (
    (nativeQuestion?.state === 'pending' && !nativeQuestionDeadlineExpired(nativeQuestion.deadline))
    || run?.providerRuntimeQueue?.state === 'waiting'
    || run?.sessionStartPreflight?.state === 'waiting_retry'
  );

  return {
    run: {
      state: runState === 'running' ? 'running' : 'idle',
      waiting,
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
    compact: {
      state: compactState,
    },
  };
}

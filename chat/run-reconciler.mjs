import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE } from './run-launcher.mjs';

const execFileAsync = promisify(execFileCallback);

function parseIsoTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRecordedProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function buildSystemctlArgsForUnitScope(scope, ...args) {
  return scope === 'user'
    ? ['--user', ...args]
    : args;
}

export async function isRecordedRunnerUnitActive(unitName, unitScope, {
  execFileImpl = execFileAsync,
} = {}) {
  const normalizedUnitName = typeof unitName === 'string' ? unitName.trim() : '';
  if (!normalizedUnitName || process.platform !== 'linux') {
    return false;
  }
  try {
    const { stdout } = await execFileImpl(
      'systemctl',
      buildSystemctlArgsForUnitScope(unitScope, 'show', '--property=ActiveState', '--value', normalizedUnitName),
      { timeout: 2_000, maxBuffer: 128 * 1024 },
    );
    const state = String(stdout || '').trim();
    return state === 'active' || state === 'activating' || state === 'reloading';
  } catch {
    return false;
  }
}

export function createDetachedRunReconciler({
  appendRunSpoolRecord,
  collectRunOutputPreview,
  graceMs,
  isTerminalRunState,
  nowIso,
  updateRun,
  writeRunResult,
} = {}) {
  return async function synthesizeDetachedRunTermination(runId, run) {
    const hasRecordedRunnerUnit = run?.runnerLaunchMode === DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE
      && typeof run?.runnerUnitName === 'string'
      && run.runnerUnitName.trim();
    const hasRecordedProcess = Number.isInteger(run?.runnerProcessId)
      || Number.isInteger(run?.toolProcessId)
      || Boolean(hasRecordedRunnerUnit);
    if (!hasRecordedProcess || isTerminalRunState(run?.state)) {
      return null;
    }

    const runnerProcessAlive = isRecordedProcessAlive(run?.runnerProcessId);
    const runnerUnitActive = !runnerProcessAlive
      ? await isRecordedRunnerUnitActive(run?.runnerUnitName, run?.runnerUnitScope)
      : false;
    const runnerAlive = runnerProcessAlive || runnerUnitActive;
    const toolAlive = isRecordedProcessAlive(run?.toolProcessId);
    if (runnerAlive || toolAlive) {
      return null;
    }

    const completedAt = nowIso();
    const cancelled = run?.cancelRequested === true;
    if (!cancelled) {
      const missingResultDetectedAtMs = parseIsoTimestampMs(run?.missingResultDetectedAt);
      if (!Number.isFinite(missingResultDetectedAtMs)) {
        await updateRun(runId, (current) => ({
          ...current,
          missingResultDetectedAt: current?.missingResultDetectedAt || nowIso(),
        }));
        return null;
      }
      if ((Date.now() - missingResultDetectedAtMs) < graceMs) {
        return null;
      }
    }

    const priorFailure = typeof run?.failureReason === 'string' && run.failureReason.trim()
      ? run.failureReason.trim()
      : '';
    const preview = await collectRunOutputPreview(runId);
    const diagnostic = {
      sessionId: run?.sessionId || null,
      state: run?.state || null,
      cancelRequested: cancelled,
      runnerProcessId: run?.runnerProcessId ?? null,
      runnerUnitName: run?.runnerUnitName || null,
      runnerUnitScope: run?.runnerUnitScope || null,
      runnerLaunchMode: run?.runnerLaunchMode || null,
      runnerProcessAlive,
      runnerUnitActive,
      toolProcessId: run?.toolProcessId ?? null,
      runnerAlive,
      toolAlive,
      startedAt: run?.startedAt || null,
      updatedAt: run?.updatedAt || null,
      lastNormalizedAt: run?.lastNormalizedAt || null,
      missingResultDetectedAt: run?.missingResultDetectedAt || null,
      normalizedLineCount: Number.isInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
      normalizedEventCount: Number.isInteger(run?.normalizedEventCount) ? run.normalizedEventCount : 0,
      preview,
    };
    const error = cancelled ? null : (priorFailure || 'Detached runner disappeared before writing a result');
    console.error(`[runs] Synthesizing missing-result failure for ${runId}: ${JSON.stringify(diagnostic)}`);
    try {
      await appendRunSpoolRecord(runId, {
        ts: completedAt,
        stream: 'error',
        line: error || 'Detached runner was cancelled before writing a result',
        json: {
          type: 'run.reconciled_missing_result',
          ...diagnostic,
        },
      });
    } catch (appendError) {
      console.error(`[runs] Failed to append missing-result diagnostic for ${runId}: ${appendError.message}`);
    }
    const result = {
      completedAt,
      exitCode: 1,
      signal: null,
      cancelled,
      ...(error ? { error } : {}),
    };
    await writeRunResult(runId, result);
    return updateRun(runId, (current) => ({
      ...current,
      state: cancelled ? 'cancelled' : 'failed',
      completedAt,
      result,
      failureReason: error,
    }));
  };
}

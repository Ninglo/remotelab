import { isProcessIdentityAlive } from '../lib/process-identity.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { join } from 'node:path';
import { CHAT_RUNS_DIR } from '../lib/config.mjs';
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

async function hasLiveExecution(runId, run) {
  const launch = await readRecord(join(CHAT_RUNS_DIR, runId, 'launch.json'));
  // Once the sidecar claims the work only that owner counts. Before the claim,
  // the spawn observation includes a birth identity, not just a reusable PID.
  const runnerProcessAlive = await isProcessIdentityAlive(launch ? launch.identity : run.runnerSpawnIdentity);
  return runnerProcessAlive || await isProcessIdentityAlive(run.toolProcessIdentity)
    || await isRecordedRunnerUnitActive(run.runnerUnitName, run.runnerUnitScope);
}

export function createDetachedRunReconciler({
  appendRunSpoolRecord,
  collectRunOutputPreview,
  getRun,
  getRunResult,
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

    const liveNow = async current => {
      if (!await hasLiveExecution(runId, current)) return false;
      if (current.missingResultDetectedAt) {
        await updateRun(runId, latest => ({ ...latest, missingResultDetectedAt: null }));
      }
      return true;
    };
    if (await liveNow(run)) return null;

    // The runner writes its result before exiting. It may have done so after
    // the controller's earlier read but before the liveness probes above.
    const current = await getRun(runId);
    if (!current) return null;
    if (isTerminalRunState(current.state) || await getRunResult(runId)) return current;
    run = current;

    if (!run.cancelRequested) {
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

    const preview = await collectRunOutputPreview(runId);
    // A startup claim (not only a final result) can arrive during diagnostics.
    run = await getRun(runId);
    if (!run || isTerminalRunState(run.state) || await getRunResult(runId)) return run;
    if (await liveNow(run)) return null;
    const completedAt = nowIso();
    const cancelled = run.cancelRequested === true;
    const priorFailure = typeof run?.failureReason === 'string' && run.failureReason.trim()
      ? run.failureReason.trim()
      : '';
    const diagnostic = {
      sessionId: run?.sessionId || null,
      state: run?.state || null,
      cancelRequested: cancelled,
      runnerProcessId: run?.runnerProcessId ?? null,
      runnerUnitName: run?.runnerUnitName || null,
      runnerUnitScope: run?.runnerUnitScope || null,
      runnerLaunchMode: run?.runnerLaunchMode || null,
      runnerProcessAlive: false,
      runnerUnitActive: false,
      toolProcessId: run?.toolProcessId ?? null,
      runnerAlive: false,
      toolAlive: false,
      startedAt: run?.startedAt || null,
      updatedAt: run?.updatedAt || null,
      lastNormalizedAt: run?.lastNormalizedAt || null,
      missingResultDetectedAt: run?.missingResultDetectedAt || null,
      normalizedLineCount: Number.isInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
      normalizedEventCount: Number.isInteger(run?.normalizedEventCount) ? run.normalizedEventCount : 0,
      preview,
    };
    const error = cancelled ? null : (priorFailure || 'Detached runner disappeared before writing a result');
    const result = {
      completedAt,
      exitCode: 1,
      signal: null,
      cancelled,
      ...(error ? { error } : {}),
    };
    // Diagnostic reads also yield; commit conditionally so a late real result
    // wins, and emit a failure diagnostic only when synthesis actually won.
    if (!await writeRunResult(runId, result, { onlyIfMissing: true })) return getRun(runId);
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
    return updateRun(runId, (current) => ({
      ...current,
      state: cancelled ? 'cancelled' : 'failed',
      completedAt,
      result,
      failureReason: error,
    }));
  };
}

#!/usr/bin/env node
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createToolInvocation, prependAttachmentPaths, resolveCommand } from './process-runner.mjs';
import { buildFileAssetDirectUrl, materializeFileAssetAttachments } from './file-assets.mjs';
import {
  buildCodexContextMetricsPayload,
  readLatestCodexSessionMetrics,
} from './codex-session-metrics.mjs';
import { CHAT_PORT } from '../lib/config.mjs';
import {
  appendRunSpoolRecord,
  getRun,
  getRunManifest,
  updateRun,
  writeRunResult,
} from './runs.mjs';
import { resolveRunnableSessionFolder } from './session-folder.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';

const runId = process.argv[2];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const IDLE_CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds
let fatalSidecarTerminationInFlight = false;

function nowIso() {
  return new Date().toISOString();
}

function normalizeErrorMessage(error, fallback = 'Unknown sidecar error') {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (error === null || error === undefined) return fallback;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== '{}' ? serialized : fallback;
  } catch {
    return fallback;
  }
}

function safeDiagnosticDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return null;
  }
}

async function logSidecarDiagnostic(runId, message, details = null) {
  const payload = safeDiagnosticDetails(details);
  const printable = payload ? ` ${JSON.stringify(payload)}` : '';
  console.error(`[sidecar] ${message}${printable}`);
  if (!runId) return;
  try {
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'error',
      line: payload ? `${message} ${JSON.stringify(payload)}` : message,
      json: payload
        ? { type: 'sidecar.diagnostic', message, details: payload }
        : { type: 'sidecar.diagnostic', message },
    });
  } catch (error) {
    console.error(`[sidecar] Failed to append diagnostic for run ${runId}: ${normalizeErrorMessage(error)}`);
  }
}

async function persistRunTerminalState(runId, result, nextState, options = {}) {
  try {
    await writeRunResult(runId, result);
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to persist detached runner result', {
      error: normalizeErrorMessage(error),
      nextState,
      resultCompletedAt: result?.completedAt || null,
    });
  }

  try {
    await updateRun(runId, (current) => ({
      ...current,
      state: nextState,
      completedAt: result?.completedAt || nowIso(),
      result,
      ...(Object.prototype.hasOwnProperty.call(options, 'failureReason')
        ? { failureReason: options.failureReason }
        : {}),
    }));
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to persist detached runner status', {
      error: normalizeErrorMessage(error),
      nextState,
      resultCompletedAt: result?.completedAt || null,
    });
  }
}

async function persistRunFailure(runId, error, options = {}) {
  const cancelled = options.cancelled === true;
  const message = normalizeErrorMessage(error);
  if (options.logMessage !== false) {
    await logSidecarDiagnostic(
      runId,
      options.logLabel || 'Detached runner failed before persisting a result',
      {
        error: message,
        ...(safeDiagnosticDetails(options.details) || {}),
      },
    );
  }

  const result = {
    completedAt: nowIso(),
    exitCode: Number.isInteger(options.exitCode) ? options.exitCode : 1,
    signal: typeof options.signal === 'string' && options.signal ? options.signal : null,
    cancelled,
    ...(cancelled ? {} : { error: message }),
  };

  await persistRunTerminalState(runId, result, cancelled ? 'cancelled' : 'failed', {
    ...(cancelled ? {} : { failureReason: message }),
  });
  return result;
}

async function cleanEnv(toolId, manifest = {}, options = {}) {
  const env = buildToolProcessEnv(options.envOverrides || {});
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.REMOTELAB_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
  env.REMOTELAB_PROJECT_ROOT = process.env.REMOTELAB_PROJECT_ROOT || PROJECT_ROOT;
  if (typeof manifest?.sessionId === 'string' && manifest.sessionId.trim()) {
    env.REMOTELAB_SESSION_ID = manifest.sessionId.trim();
  }
  if (runId) {
    env.REMOTELAB_RUN_ID = runId;
  }
  return applyManagedRuntimeEnv(toolId, env, {
    runtimeFamily: typeof options.runtimeFamily === 'string' ? options.runtimeFamily : '',
  });
}

function captureResume(run, parsed) {
  if (!run || !parsed || typeof parsed !== 'object') return null;
  if (parsed.session_id) {
    return {
      claudeSessionId: parsed.session_id,
      providerResumeId: parsed.session_id,
    };
  }
  if (parsed.type === 'thread.started' && parsed.thread_id) {
    return {
      codexThreadId: parsed.thread_id,
      providerResumeId: parsed.thread_id,
    };
  }
  return null;
}

async function appendCodexContextMetrics(runId) {
  const current = await getRun(runId);
  if (!current?.codexThreadId) return null;

  const metrics = await readLatestCodexSessionMetrics(current.codexThreadId, {
    startedAt: current.startedAt || current.createdAt || null,
    completedAt: current.completedAt || null,
  });
  const payload = buildCodexContextMetricsPayload(metrics);
  if (!payload) return null;

  const line = JSON.stringify(payload);
  await appendRunSpoolRecord(runId, {
    ts: nowIso(),
    stream: 'stdout',
    line,
    json: payload,
  });

  await updateRun(runId, (draft) => ({
    ...draft,
    contextInputTokens: metrics.contextTokens,
    ...(Number.isInteger(metrics.contextWindowTokens)
      ? { contextWindowTokens: metrics.contextWindowTokens }
      : {}),
  }));

  return metrics;
}

async function appendCodexContextMetricsSafely(runId) {
  try {
    if (process.env.REMOTELAB_TEST_THROW_ON_FINALIZATION_METRICS === '1') {
      throw new Error('Synthetic finalization metrics failure');
    }
    return await appendCodexContextMetrics(runId);
  } catch (error) {
    await logSidecarDiagnostic(runId, 'Failed to append Codex context metrics during runner finalization', {
      error: normalizeErrorMessage(error),
    });
    return null;
  }
}

async function abortSidecarFromFatal(error, label) {
  if (fatalSidecarTerminationInFlight) return;
  fatalSidecarTerminationInFlight = true;
  const details = {};
  if (typeof error?.stack === 'string' && error.stack) {
    details.stack = error.stack;
  }
  try {
    await persistRunFailure(runId, error, {
      logLabel: label,
      details,
    });
  } catch (persistError) {
    console.error(`[sidecar] Failed to persist fatal termination for run ${runId}: ${normalizeErrorMessage(persistError)}`);
  }
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  void abortSidecarFromFatal(reason, 'Detached runner hit an unhandled rejection');
});

process.on('uncaughtException', (error) => {
  void abortSidecarFromFatal(error, 'Detached runner crashed with an uncaught exception');
});

async function main() {
  if (!runId) {
    process.exit(1);
  }

  const run = await getRun(runId);
  const manifest = await getRunManifest(runId);
  if (!run || !manifest) {
    process.exit(1);
  }

  await updateRun(runId, (current) => ({
    ...current,
    state: 'running',
    startedAt: current.startedAt || nowIso(),
    runnerProcessId: process.pid,
    runnerUnitName: current?.runnerUnitName || process.env.REMOTELAB_RUNNER_UNIT_NAME || null,
    runnerUnitScope: current?.runnerUnitScope || process.env.REMOTELAB_RUNNER_UNIT_SCOPE || null,
    runnerLaunchMode: current?.runnerLaunchMode || process.env.REMOTELAB_RUNNER_LAUNCH_MODE || null,
  }));

  if (process.env.REMOTELAB_TEST_RUNNER_SIDECAR_FAIL_BEFORE_TOOL_SPAWN === '1') {
    throw new Error('Synthetic sidecar failure before tool spawn');
  }

  const materializedImages = await materializeFileAssetAttachments(manifest.options?.images || []);
  if (materializedImages.some((attachment) => typeof attachment?.assetId === 'string' && typeof attachment?.savedPath === 'string')) {
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      line: JSON.stringify({
        type: 'status',
        content: 'Localized external file attachments for this run.',
      }),
      json: {
        type: 'status',
        content: 'Localized external file attachments for this run.',
      },
    });
  }

  const prompt = prependAttachmentPaths(manifest.prompt || '', materializedImages);
  const { command, args, runtimeFamily, envOverrides } = await createToolInvocation(manifest.tool, prompt, {
    dangerouslySkipPermissions: true,
    claudeSessionId: manifest.options?.claudeSessionId,
    codexThreadId: manifest.options?.codexThreadId,
    thinking: manifest.options?.thinking,
    model: manifest.options?.model,
    effort: manifest.options?.effort,
  });

  const spawnEnv = await cleanEnv(manifest.tool, manifest, { runtimeFamily, envOverrides });

  const attachmentPaths = [];
  for (const img of materializedImages) {
    if (typeof img?.savedPath !== 'string' || !img.savedPath) continue;
    const entry = {
      path: img.savedPath,
      mimeType: typeof img?.mimeType === 'string' ? img.mimeType : '',
      originalName: typeof img?.originalName === 'string' ? img.originalName : '',
    };
    if (typeof img?.assetId === 'string' && img.assetId) {
      try {
        const direct = await buildFileAssetDirectUrl(img.assetId);
        if (direct?.url && !direct.url.startsWith('/')) {
          entry.url = direct.url;
        }
      } catch {
        // no direct URL available — base64 fallback will be used
      }
    }
    attachmentPaths.push(entry);
  }
  if (attachmentPaths.length > 0) {
    spawnEnv.REMOTELAB_ATTACHMENT_PATHS = JSON.stringify(attachmentPaths);
  }

  const resolvedFolder = resolveRunnableSessionFolder(manifest.folder);
  if (resolvedFolder.repaired) {
    await logSidecarDiagnostic(runId, 'Repaired stale session folder before tool launch', {
      requestedCwd: resolvedFolder.requestedCwd,
      cwd: resolvedFolder.cwd,
      reason: resolvedFolder.reason,
    });
  }

  const proc = spawn(await resolveCommand(command), args, {
    cwd: resolvedFolder.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv,
  });

  await updateRun(runId, (current) => ({
    ...current,
    toolProcessId: proc.pid,
  }));

  let cancelSent = false;
  let lastOutputAt = Date.now();
  const idleTimeoutMs = Number.isFinite(Number(process.env.REMOTELAB_RUN_IDLE_TIMEOUT_MS))
    && Number(process.env.REMOTELAB_RUN_IDLE_TIMEOUT_MS) > 0
    ? Number(process.env.REMOTELAB_RUN_IDLE_TIMEOUT_MS)
    : DEFAULT_IDLE_TIMEOUT_MS;

  const cancelTimer = setInterval(() => {
    void (async () => {
      const current = await getRun(runId);
      if (!current?.cancelRequested || cancelSent) return;
      cancelSent = true;
      try {
        proc.kill('SIGTERM');
      } catch {}
    })();
  }, 250);

  const idleTimer = setInterval(() => {
    if (cancelSent) return;
    const idleMs = Date.now() - lastOutputAt;
    if (idleMs >= idleTimeoutMs) {
      cancelSent = true;
      const idleMinutes = Math.round(idleMs / 60000);
      console.error(`[sidecar] Killing tool process for run ${runId} after ${idleMinutes}m idle (no output)`);
      void (async () => {
        await appendRunSpoolRecord(runId, {
          ts: nowIso(),
          stream: 'error',
          line: `Tool process killed after ${idleMinutes} minutes of inactivity`,
        });
      })();
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  }, IDLE_CHECK_INTERVAL_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();

  const recordStdoutLine = async (line) => {
    lastOutputAt = Date.now();
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {}
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'stdout',
      line,
      ...(parsed ? { json: parsed } : {}),
    });
    const resumeUpdate = captureResume(await getRun(runId), parsed);
    if (resumeUpdate) {
      await updateRun(runId, (current) => ({
        ...current,
        ...resumeUpdate,
      }));
    }
  };

  const recordStderrText = async (text) => {
    lastOutputAt = Date.now();
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean) continue;
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'stderr',
        line: clean,
      });
    }
  };

  createInterface({ input: proc.stdout }).on('line', (line) => {
    void recordStdoutLine(line);
  });
  proc.stderr.on('data', (chunk) => {
    void recordStderrText(chunk.toString());
  });

  proc.on('error', (error) => {
    void (async () => {
      clearInterval(cancelTimer);
      clearInterval(idleTimer);
      const current = await getRun(runId) || run;
      await persistRunFailure(runId, error, {
        cancelled: current.cancelRequested === true,
        logLabel: 'Detached tool process failed before completion',
        details: {
          phase: 'tool-process-error',
        },
      });
      process.exit(1);
    })();
  });

  proc.on('exit', (code, signal) => {
    void (async () => {
      clearInterval(cancelTimer);
      clearInterval(idleTimer);
      const current = await getRun(runId) || run;
      const completedAt = nowIso();
      await appendCodexContextMetricsSafely(runId);
      const result = {
        completedAt,
        exitCode: code ?? 1,
        signal: signal || null,
        cancelled: current.cancelRequested === true,
      };
      await persistRunTerminalState(
        runId,
        result,
        current.cancelRequested
          ? 'cancelled'
          : (code ?? 1) === 0
            ? 'completed'
            : 'failed',
      );
      process.exit(code ?? 1);
    })();
  });
}

main().catch((error) => {
  void (async () => {
    const current = await getRun(runId);
    await persistRunFailure(runId, error, {
      cancelled: current?.cancelRequested === true,
      logLabel: 'Detached runner main() failed before tool completion',
      details: {
        phase: 'main-catch',
      },
    });
    process.exit(1);
  })();
});

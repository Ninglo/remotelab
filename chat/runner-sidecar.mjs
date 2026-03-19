#!/usr/bin/env node
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createToolInvocation, prependAttachmentPaths, resolveCommand, resolveCwd } from './process-runner.mjs';
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
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { applyManagedRuntimeEnv } from './runtime-policy.mjs';

const runId = process.argv[2];
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function nowIso() {
  return new Date().toISOString();
}

async function cleanEnv(toolId, manifest = {}, options = {}) {
  const env = buildToolProcessEnv();
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.REMOTELAB_CHAT_BASE_URL = process.env.REMOTELAB_CHAT_BASE_URL || `http://127.0.0.1:${CHAT_PORT}`;
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

  const metrics = await readLatestCodexSessionMetrics(current.codexThreadId);
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

async function main() {
  if (!runId) {
    process.exit(1);
  }

  const run = await getRun(runId);
  const manifest = await getRunManifest(runId);
  if (!run || !manifest) {
    process.exit(1);
  }

  const prompt = prependAttachmentPaths(manifest.prompt || '', manifest.options?.images || []);
  const { command, args, runtimeFamily } = await createToolInvocation(manifest.tool, prompt, {
    dangerouslySkipPermissions: true,
    claudeSessionId: manifest.options?.claudeSessionId,
    codexThreadId: manifest.options?.codexThreadId,
    thinking: manifest.options?.thinking,
    model: manifest.options?.model,
    effort: manifest.options?.effort,
  });

  const proc = spawn(await resolveCommand(command), args, {
    cwd: resolveCwd(manifest.folder),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: await cleanEnv(manifest.tool, manifest, { runtimeFamily }),
  });

  await updateRun(runId, (current) => ({
    ...current,
    state: 'running',
    startedAt: current.startedAt || nowIso(),
    runnerProcessId: process.pid,
    toolProcessId: proc.pid,
  }));

  let cancelSent = false;
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

  const recordStdoutLine = async (line) => {
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
      await appendRunSpoolRecord(runId, {
        ts: nowIso(),
        stream: 'error',
        line: error.message,
      });
      const result = {
        completedAt: nowIso(),
        exitCode: 1,
        signal: null,
        error: error.message,
      };
      await writeRunResult(runId, result);
      await updateRun(runId, (current) => ({
        ...current,
        state: current.cancelRequested ? 'cancelled' : 'failed',
        completedAt: result.completedAt,
        result,
        failureReason: error.message,
      }));
      process.exit(1);
    })();
  });

  proc.on('exit', (code, signal) => {
    void (async () => {
      clearInterval(cancelTimer);
      const current = await getRun(runId) || run;
      const completedAt = nowIso();
      await appendCodexContextMetrics(runId);
      const result = {
        completedAt,
        exitCode: code ?? 1,
        signal: signal || null,
        cancelled: current.cancelRequested === true,
      };
      await writeRunResult(runId, result);
      await updateRun(runId, (draft) => ({
        ...draft,
        state: draft.cancelRequested
          ? 'cancelled'
          : (code ?? 1) === 0
            ? 'completed'
            : 'failed',
        completedAt,
        result,
      }));
      process.exit(code ?? 1);
    })();
  });
}

main().catch((error) => {
  void (async () => {
    await appendRunSpoolRecord(runId, {
      ts: nowIso(),
      stream: 'error',
      line: error.message,
    });
    await updateRun(runId, (current) => ({
      ...current,
      state: current?.cancelRequested ? 'cancelled' : 'failed',
      completedAt: nowIso(),
      failureReason: error.message,
    }));
    process.exit(1);
  })();
});

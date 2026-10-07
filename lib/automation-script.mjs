import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const DEFAULT_GATE_TIMEOUT_SECONDS = 5, MAX_GATE_TIMEOUT_SECONDS = 30;
const MAX_GATE_SOURCE_BYTES = 64 * 1024, MAX_GATE_OUTPUT_BYTES = 16 * 1024;
const trimString = value => typeof value === 'string' ? value.trim() : '';
const positiveInteger = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

export function normalizeGate(value, { strict = false } = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = trimString(raw.mode).toLowerCase() || 'direct';
  if (!['direct', 'script'].includes(mode)) throw new Error('gate.mode must be direct or script');
  if (mode === 'direct') return { mode };
  const runtime = trimString(raw.runtime || raw.language).toLowerCase() || 'bash';
  if (!['bash', 'python', 'node'].includes(runtime)) throw new Error('gate.runtime must be bash, python, or node');
  const source = typeof raw.source === 'string'
    ? raw.source
    : typeof raw.script?.source === 'string'
      ? raw.script.source
      : '';
  if (!source.trim()) throw new Error('gate.source is required for script gates');
  if (Buffer.byteLength(source, 'utf8') > MAX_GATE_SOURCE_BYTES) {
    throw new Error(`gate.source must not exceed ${MAX_GATE_SOURCE_BYTES} bytes`);
  }
  const requestedTimeout = raw.timeoutSeconds ?? raw.script?.timeoutSeconds;
  const timeoutSeconds = requestedTimeout === undefined
    ? DEFAULT_GATE_TIMEOUT_SECONDS
    : positiveInteger(requestedTimeout);
  if (!timeoutSeconds || timeoutSeconds > MAX_GATE_TIMEOUT_SECONDS) {
    throw new Error(`gate.timeoutSeconds must be between 1 and ${MAX_GATE_TIMEOUT_SECONDS}`);
  }
  const cooldownSeconds = raw.cooldownSeconds === undefined ? 0 : Number(raw.cooldownSeconds);
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    if (strict) throw new Error('gate.cooldownSeconds must be a non-negative integer');
    throw new Error('Invalid gate cooldown');
  }
  return {
    mode,
    runtime,
    source,
    snapshotSha256: createHash('sha256').update(source).digest('hex'),
    timeoutSeconds,
    cooldownSeconds,
  };
}

export function parseGateOutput(value) {
  const output = trimString(value);
  if (/^yes$/i.test(output)) return { trigger: true, reason: '', dedupeKey: '' };
  if (/^no$/i.test(output)) return { trigger: false, reason: '', dedupeKey: '' };
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Gate output must be yes, no, or one JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.trigger !== 'boolean') {
    throw new Error('Gate JSON must contain a boolean trigger field');
  }
  return {
    trigger: parsed.trigger,
    reason: trimString(parsed.reason).slice(0, 500),
    dedupeKey: trimString(parsed.dedupeKey).slice(0, 500),
  };
}

function gateCommand(runtime) {
  if (runtime === 'python') return { command: 'python3', args: ['-'] };
  if (runtime === 'node') return { command: process.execPath, args: ['-'] };
  return { command: '/bin/bash', args: ['--noprofile', '--norc', '-s'] };
}

export async function runScheduleGate(schedule, scheduledAt, { checkCause = 'cadence', sessionId = '', runId = '' } = {}) {
  if (schedule.gate?.mode !== 'script') return { trigger: true, reason: '', dedupeKey: '' };
  const { command, args } = gateCommand(schedule.gate.runtime);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: schedule.sessionTemplate?.folder || process.cwd(),
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        REMOTELAB_TASK_ID: schedule.id,
        REMOTELAB_TASK_CHECK_AT: scheduledAt,
        REMOTELAB_TASK_CHECK_CAUSE: checkCause,
        REMOTELAB_SESSION_ID: sessionId,
        REMOTELAB_RUN_ID: runId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      handler(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Gate timed out after ${schedule.gate.timeoutSeconds}s`));
    }, schedule.gate.timeoutSeconds * 1000);
    child.on('error', (error) => finish(reject, error));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GATE_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error(`Gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = trimString(stderr);
        finish(reject, new Error(`Gate exited with ${signal || code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        finish(resolve, parseGateOutput(stdout));
      } catch (error) {
        finish(reject, error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(schedule.gate.source);
  });
}

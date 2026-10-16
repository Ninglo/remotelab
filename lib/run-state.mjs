import { join } from 'node:path';
import { readRecord } from './durable-records.mjs';
const isTerminalRunState = state => ['completed', 'failed', 'cancelled'].includes(state);

// Pure read model, also used by cross-instance diagnostics and maintenance.
export function mergeRunState(base, execution = {}, recovery = {}) {
  if (!base) return null;
  const run = { ...base, ...recovery, ...execution };
  // A real terminal execution takes precedence over a missing-process inference.
  const terminal = isTerminalRunState(execution.state) ? execution
    : isTerminalRunState(recovery.state) ? recovery : isTerminalRunState(base.state) ? base : null;
  if (terminal) for (const key of ['state', 'completedAt', 'result', 'failureReason']) {
    if (Object.hasOwn(terminal, key)) run[key] = terminal[key];
  }
  if (base.executionValidationFailure) { run.state = 'failed'; run.failureReason = base.failureReason; }
  for (const key of ['cancelRequested', 'cancelRequestedAt', 'finalizedAt', 'lastNormalizedAt',
    'normalizedLineCount', 'normalizedByteOffset', 'normalizedEventCount']) {
    if (Object.hasOwn(base, key)) run[key] = base[key];
  }
  for (const key of ['contextInputTokens', 'contextWindowTokens']) run[key] = [base[key], execution[key]].filter(Number.isInteger).reduce((max, value) => max === null ? value : Math.max(max, value), null);
  run.updatedAt = [base.updatedAt, execution.updatedAt, recovery.updatedAt].filter(Boolean).sort().at(-1);
  return run;
}

export async function readRunState(directory, read = readRecord) {
  const base = await read(join(directory, 'status.json'));
  if (!base) return null;
  const [execution, recovery] = await Promise.all([read(join(directory, 'execution.json')), read(join(directory, 'recovery.json'))]);
  return mergeRunState(base, execution || {}, recovery || {});
}

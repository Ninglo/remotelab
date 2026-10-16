import { normalizeGate, runScheduleGate } from './automation-script.mjs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

const pendingFile = join(CONFIG_DIR, 'automation-execution-hooks.json');
const mutations = createSerialTaskQueue();
async function pendingHooks() { return (await readJson(pendingFile)) || []; }
export async function registerAutomationHook(runId, manifest) {
  if (!manifest?.automationPolicy?.afterRun) return;
  await mutations(async () => {
    const rows = await pendingHooks();
    if (!rows.includes(runId)) await writeJsonAtomic(pendingFile, [...rows, runId]);
  });
}
async function clearPending(runId) {
  await mutations(async () => writeJsonAtomic(pendingFile, (await pendingHooks()).filter(id => id !== runId)));
}
export async function recoverAutomationHooks({ getRun, getManifest, observe, updateRun }) {
  const recovering = [];
  for (const id of await mutations(pendingHooks)) {
    const [run, manifest] = await Promise.all([getRun(id), getManifest(id)]);
    if (!run || !manifest) continue; // Keep an incomplete durable intent for recovery.
    if (run.automationHookCompletedAt) await clearPending(id);
    else if (run.finalizedAt && ['completed', 'failed', 'cancelled'].includes(run.state)) recovering.push(reconcileAutomationHook(run, manifest, { updateRun }));
    else observe(run.sessionId, id);
  }
  return recovering.filter(Boolean);
}

// Opt-in scripts are frozen with the occurrence, like its ordinary gate. They
// run in the control plane, outside the model runner's cancellation scope.
export function normalizeAutomationPolicy(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid automationPolicy');
  const minIdleSeconds = Number(value.minIdleSeconds || 0);
  if (!Number.isInteger(minIdleSeconds) || minIdleSeconds < 0 || minIdleSeconds > 86400) {
    throw new Error('automationPolicy.minIdleSeconds must be between 0 and 86400');
  }
  const result = { minIdleSeconds };
  for (const phase of ['beforeLaunch', 'afterRun']) {
    if (!value[phase]) continue;
    const gate = normalizeGate(value[phase], { strict: true });
    if (gate.mode !== 'script') throw new Error(`${phase} requires a script`);
    result[phase] = gate;
  }
  return result;
}

export async function runAutomationHook(policy, phase, { runId, sessionId, scheduleId, folder }) {
  if (!policy?.[phase]) return { trigger: true };
  return runScheduleGate({ id: scheduleId || '', sessionTemplate: { folder }, gate: policy[phase] },
    new Date().toISOString(), { checkCause: phase, sessionId, runId });
}

const terminalHooks = new Map();
const retryTimers = new Map();
export function reconcileAutomationHook(run, manifest, { updateRun, execute = runAutomationHook, schedule = setImmediate,
  onError = error => console.error(`[automation-hook] ${error.message}`) } = {}) {
  if (!manifest?.automationPolicy?.afterRun || !['completed', 'failed', 'cancelled'].includes(run?.state)
    || run.automationHookCompletedAt || terminalHooks.has(run.id)) return;
  const retry = latest => {
    if (retryTimers.has(run.id)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(run.id);
      reconcileAutomationHook(latest, manifest, { updateRun, execute, schedule, onError });
    }, Math.max(0, Date.parse(latest.automationHookRetryAt) - Date.now()));
    timer.unref?.();
    retryTimers.set(run.id, timer);
  };
  if (Date.parse(run.automationHookRetryAt) > Date.now()) { retry(run); return; }
  clearTimeout(retryTimers.get(run.id)); retryTimers.delete(run.id);
  // Hooks progress on completion, due retry and boot recovery; GET is read-only.
  // Scripts must make their external writes idempotent across a crash.
  let failed;
  const pending = new Promise(resolve => schedule(resolve)).then(async () => {
    const result = await execute(manifest.automationPolicy, 'afterRun', {
      runId: run.id, sessionId: run.sessionId, scheduleId: manifest.scheduleId, folder: manifest.folder,
    });
    if (!result.trigger) throw new Error(result.reason || 'Terminal hook declined');
    await updateRun(run.id, current => ({ ...current, automationHookCompletedAt: new Date().toISOString(), automationHookPending: false, automationHookError: '' }));
    await clearPending(run.id);
  }).catch(async error => {
    onError(error);
    failed = await updateRun(run.id, current => ({ ...current, automationHookError: error.message,
      automationHookAttempts: (current.automationHookAttempts || 0) + 1,
      automationHookRetryAt: new Date(Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(5, current.automationHookAttempts || 0))).toISOString(),
    })).catch(onError);
  }).finally(() => { terminalHooks.delete(run.id); if (failed) retry(failed); });
  terminalHooks.set(run.id, pending);
  return pending;
}

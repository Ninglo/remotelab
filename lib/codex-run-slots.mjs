import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProviderRuntimeLease } from '../chat/provider-runtime-queue.mjs';
import { DETACHED_RUNNER_PROCESS_LAUNCH_MODE } from '../chat/run-launcher.mjs';
import { readRecord } from './durable-records.mjs';
import { isProcessIdentityAlive } from './process-identity.mjs';

const runIdPattern = /^run_[a-f0-9]{24}$/;
const slotPattern = /^slot-(run_[a-f0-9]{24}|helper)-[a-f0-9-]{36}$/;
const positivePid = pid => Number.isInteger(pid) && pid > 0;
const slotsFor = (root, home) => join(root, 'runs', createHash('sha256').update(home).digest('hex'));

export function acquireCodexRunSlot(root, home, { runId, sessionId, isCancelled }) {
  return acquireProviderRuntimeLease({
    queueKey: `slot-${runIdPattern.test(runId) ? runId : 'helper'}-${randomUUID()}`,
    runId, sessionId, isCancelled, rootDir: slotsFor(root, home), wait: false, uniqueKey: true,
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// A detached runner starts its own process group. Checking that group also
// covers a child spawned just before the runner died, before PID publication.
// Without that positive launch evidence (e.g. systemd or a legacy slot), an
// unreadable record is NOT evidence that its runner and children have stopped.
async function detachedRunOccupancy(root, runId) {
  const directory = join(root, '..', 'chat-runs', runId);
  const [launch, execution] = await Promise.all([
    readRecord(join(directory, 'launch.json')), readRecord(join(directory, 'execution.json')),
  ]);
  if (launch?.runId !== runId || !positivePid(launch.pid) || launch.identity?.pid !== launch.pid
    || !launch.identity.birth || execution?.runnerProcessId !== launch.pid
    || execution.runnerLaunchMode !== DETACHED_RUNNER_PROCESS_LAUNCH_MODE || process.platform === 'win32') return 'unknown';
  if (await isProcessIdentityAlive(launch.identity) || processExists(-launch.pid)) return 'active';
  if (execution.toolProcessIdentity ? await isProcessIdentityAlive(execution.toolProcessIdentity)
    : positivePid(execution.toolProcessId) && processExists(execution.toolProcessId)) return 'active';
  return 'stopped';
}

export async function readCodexRunSlots(root, home) {
  const accountRoot = slotsFor(root, home);
  let entries;
  try { entries = await readdir(accountRoot); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const owners = [];
  for (const entry of entries) {
    const directory = join(accountRoot, entry);
    const lock = join(directory, 'active.lock');
    const runId = slotPattern.exec(entry)?.[1];
    let owner, stopped = false;
    try {
      const record = await readRecord(join(lock, 'owner.json'));
      if (positivePid(record?.sidecarPid) && (record.toolProcessId === null || positivePid(record.toolProcessId))
        && (!runId || runId === 'helper' || record.runId === runId)) {
        owner = record;
        if (processExists(owner.sidecarPid) || (owner.toolProcessId && processExists(owner.toolProcessId))) {
          owners.push(owner);
          continue;
        }
        // Old, valid records retain their liveness rule. Model runs with the
        // new key may have a child in the PID-publication window: check below.
        stopped = !runId || runId === 'helper';
      }
    } catch {
      // Only this record failed, not the account directory. Count it as one
      // unknown slot, never as empty or as a reason to abort other accounts.
    }
    if (!stopped && runId && runId !== 'helper') {
      let state;
      try { state = await detachedRunOccupancy(root, runId); } catch { /* liveness lookup failed */ }
      if (state === 'active') { owners.push({ runId }); continue; }
      stopped = state === 'stopped';
    }
    if (stopped) { await rm(directory, { recursive: true, force: true }); continue; }
    try { await lstat(lock); } catch (error) { if (error.code === 'ENOENT') continue; }
    owners.push({ occupancyUnknown: true });
  }
  return owners;
}

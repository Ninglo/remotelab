import { readFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { validSettingObservation, validUsageSetting } from './usage-setting-schema.mjs';

export const settingHash = value => createHash('sha256').update(`usage-v1:${value}`).digest('hex');
const blank = () => ({ version: 1, startedAt: null, revision: 0, rows: {}, pending: [], receipts: [], incomplete: false });
function validState(state) {
  return state?.version === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0
    && state.rows && typeof state.rows === 'object' && !Array.isArray(state.rows)
    && Object.entries(state.rows).every(([key, row]) => /^[a-f0-9]{64}$/.test(key) && validSettingObservation(row))
    && Array.isArray(state.pending)
    && (state.receipts === undefined || Array.isArray(state.receipts) && state.receipts.every(id => typeof id === 'string'));
}
async function hasFailure(directory) {
  try { await readFile(join(directory, 'health.json'), 'utf8'); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

export async function readSettingSnapshot(directory) {
  try {
    const state = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
    if (!validState(state)) throw Error('Invalid setting state');
    return { ...state, incomplete: state.incomplete || state.pending.length > 0 || await hasFailure(directory) };
  } catch (error) { return { ...blank(), incomplete: error.code !== 'ENOENT' || await hasFailure(directory) }; }
}

// One core-owned writer. A durable outbox prevents restart or a failed event
// append from turning a saved setting into a lost change observation.
export function createSettingObserver({ directory, emit, now = Date.now, maxPending = 2048, maxRows = 20_000 }) {
  const serial = createSerialTaskQueue();
  let failed = false;
  async function noteFailure() {
    failed = true;
    try { await writeJsonAtomic(join(directory, 'health.json'), { version: 1, failedAt: now() }, { mode: 0o600 }); }
    catch {} // A full disk may prevent its own receipt; retain the process flag.
  }
  async function observe(batch, context = {}) {
    return serial(async () => {
      let state;
      try {
        const raw = await readFile(join(directory, 'current.json'), 'utf8');
        state = JSON.parse(raw);
        if (!validState(state)) throw Error('Invalid setting state');
      } catch (error) {
        if (error.code !== 'ENOENT') { await noteFailure(); return false; }
        state = blank();
      }
      const timestamp = now();
      state.incomplete ||= failed || await hasFailure(directory);
      const contextTime = Number.isFinite(context.observedAt) ? context.observedAt : timestamp;
      state.startedAt ||= new Date(timestamp).toISOString();
      const duplicate = context.operationId && state.receipts?.includes(context.operationId);
      for (const candidate of batch) {
        if (duplicate) break;
        if (!validSettingObservation(candidate)) continue;
        const { setting, value, scope, scopeKey, stage, authority } = candidate;
        const observedAt = Number.isFinite(candidate.observedAt) ? candidate.observedAt : contextTime;
        const key = settingHash(JSON.stringify([setting, scope, scopeKey, stage]));
        const prior = state.rows[key];
        if (prior?.lastObservedAt > observedAt || prior?.lastObservedAt === observedAt
            && context.operation === 'snapshot' && prior.value !== value) continue;
        const before = validUsageSetting(setting, candidate.previousValue) ? candidate.previousValue : prior?.value;
        const changed = before !== undefined && before !== value;
        const operation = context.operation === 'change' && changed ? 'change'
          : context.operation === 'preview' && (!prior || prior.value !== value) ? 'preview' : 'snapshot';
        const subjectHash = /^[a-f0-9]{64}$/.test(candidate.subjectHash || '') ? candidate.subjectHash : undefined;
        if (!prior && Object.keys(state.rows).length >= maxRows) { state.incomplete = true; continue; }
        const row = { setting, value, scope, scopeKey, stage, authority,
          ...(subjectHash ? { subjectHash } : {}), firstObservedAt: prior?.firstObservedAt || timestamp,
          lastObservedAt: observedAt, changedAt: changed ? observedAt : prior?.changedAt || null };
        state.rows[key] = row;
        // Repeated saves and page/bootstrap observations refresh current state
        // without being counted as a new choice. Initial state is not adoption.
        if (prior?.value === value && operation !== 'change') continue;
        if (state.pending.length >= maxPending) { state.incomplete = true; continue; }
        state.revision++;
        const event = { event: 'setting_state', eventId: settingHash(`setting:${key}:${state.revision}`),
          timestamp, setting, settingValue: value, settingScope: scope, scopeKey, stage, authority, operation,
          ...(before !== undefined ? { previousValue: before } : {}), ...(subjectHash ? { subjectHash } : {}),
          actorKind: context.personId ? 'human' : context.actorKind || 'system', surface: context.surface || 'runtime',
          ...(context.personId ? { personHash: settingHash(`person:${context.personId}`) } : {}) };
        state.pending.push(event);
      }
      if (context.operationId && !duplicate) state.receipts = [...(state.receipts || []), context.operationId].slice(-2048);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        await writeJsonAtomic(join(directory, 'current.json'), state, { mode: 0o600 });
        if (state.pending.length && await emit(state.pending)) {
          state.pending = [];
          await writeJsonAtomic(join(directory, 'current.json'), state, { mode: 0o600 });
        }
        failed = false;
        return state.pending.length === 0;
      } catch { await noteFailure(); return false; }
    });
  }
  return { observe, async snapshot() { return { ...await readSettingSnapshot(directory), writerFailed: failed }; } };
}

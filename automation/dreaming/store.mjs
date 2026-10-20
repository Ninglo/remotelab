// Instance-scoped incremental material and review receipts. No model or scheduler.
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readProcessIdentity, isProcessIdentityAlive } from '../../lib/process-identity.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export async function read(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function save(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
export const initialState = () => ({ version: 1, sources: {}, pending: [], processed: [], attempts: [], candidates: [], active: null });
export async function transact(root, fn) {
  await mkdir(root, { recursive: true });
  const lock = join(root, 'store.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await read(join(lock, 'owner.json'), null);
    if (!owner?.birth || await isProcessIdentityAlive(owner)) throw new Error('Dreaming store busy; retry on next normal trigger');
    await rm(lock, { recursive: true });
    await mkdir(lock); // Exclusive retry; another contender may have won.
  }
  try {
    await save(join(lock, 'owner.json'), await readProcessIdentity(process.pid));
    const state = await read(join(root, 'state.json'), initialState());
    const result = await fn(state);
    await save(join(root, 'state.json'), state);
    return result;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export function changedLines(previous, current) {
  if (previous === current) return '';
  if (previous === undefined) return current;
  // Multisets retain duplicate-line additions/removals; unchanged lines cost no context.
  const counts = lines => { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) || 0) + 1); return m; };
  const old = previous.split('\n'), next = current.split('\n'), a = counts(old), b = counts(next);
  const changed = [];
  for (const [prefix, lines, available] of [['+', next, a], ['-', old, b]]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], n = available.get(line) || 0;
      if (n) available.set(line, n - 1);
      else if (line.trim()) changed.push(`${prefix}${i + 1}: ${line}`);
    }
  }
  return changed.length ? changed.join('\n') : '内容顺序发生变化；按原件重新核对相关结论。';
}
export async function ingest(root, config, state, now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const coverage = [];
  for (const input of config.inputs) {
    const path = input.path.replaceAll('{date}', day);
    const sourceKey = `${path}${input.heading ? '#' + input.heading : ''}`;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 2_000_000) throw new Error('source exceeds 2 MB or is not a file');
      let body = await readFile(path, 'utf8');
      if (input.heading) {
        const lines = body.split('\n'), start = lines.findIndex(line => line.startsWith(input.heading));
        if (start < 0) throw new Error('Configured section missing; retain previous checkpoint');
        const level = lines[start].match(/^#+/)?.[0].length;
        if (!level) throw new Error('Configured section is not a Markdown heading');
        const next = lines.findIndex((line, i) => i > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= level);
        body = lines.slice(start, next < 0 ? undefined : next).join('\n');
      }
      const version = hash(body), key = hash(sourceKey);
      const prior = state.sources[sourceKey];
      if (prior?.version === version) { coverage.push({ path, state: 'unchanged' }); continue; }
      const old = prior ? await readFile(join(root, 'snapshots', `${prior.version}.txt`), 'utf8') : undefined;
      const delta = !prior && input.baselineOnly ? '' : changedLines(old, body);
      await mkdir(join(root, 'snapshots'), { recursive: true });
      await writeFile(join(root, 'snapshots', `${version}.txt`), body, { mode: 0o600 });
      for (let offset = 0; offset < delta.length; offset += 2400) {
        const id = `${key.slice(0, 12)}-${version.slice(0, 12)}-${offset}`;
        if (!state.pending.some(x => x.id === id) && !state.processed.includes(id)) state.pending.push({ id, path, version,
          section: input.heading || '', previousVersion: prior?.version || '', observedAt: now.toISOString(), excerpt: delta.slice(offset, offset + 2400),
          kind: prior ? 'changed-lines' : 'initial-material', partial: delta.length > 2400 });
      }
      state.sources[sourceKey] = { version, observedAt: now.toISOString() };
      coverage.push({ path, state: delta ? 'queued' : 'baseline', chars: delta.length });
    } catch (error) { coverage.push({ path, state: 'unavailable', error: error.message }); }
  }
  state.coverage = coverage;
  return coverage;
}
export function selectBatch(state, config) {
  const items = [], max = config.maxBatchChars || 9600;
  let chars = 0;
  for (const item of state.pending) {
    if (items.length >= (config.maxBatchItems || 4) || chars + item.excerpt.length > max) break;
    items.push(item); chars += item.excerpt.length;
  }
  const candidates = []; let candidateChars = 0;
  for (const original of state.candidates.filter(c => c.status === 'pending')) {
    const candidate = { id: original.id, kind: original.kind, runId: original.runId, status: original.status };
    for (const key of ['change', 'overlap', 'validation', 'destination']) candidate[key] = original[key].slice(0, 600);
    const size = JSON.stringify(candidate).length;
    if (candidateChars + size > 6000 || candidates.length === 5) break;
    candidates.push(candidate); candidateChars += size;
  }
  return { id: hash(items.map(x => x.id).join('\n')).slice(0, 24), items,
    candidates, coverage: state.coverage };
}
export function validateResult(result, batch) {
  if (result.batchId !== batch.id || typeof result.finding !== 'string' || !result.finding.trim() || result.finding.length > 3000) throw new Error('Invalid batch or finding');
  const allowed = new Set(batch.items.map(i => i.id));
  if (!Array.isArray(result.reviewedIds) || result.reviewedIds.length !== allowed.size || new Set(result.reviewedIds).size !== allowed.size || result.reviewedIds.some(id => !allowed.has(id))) throw new Error('Incomplete material coverage');
  const evidence = refs => Array.isArray(refs) && refs.length && refs.every(id => allowed.has(id));
  if (!Array.isArray(result.candidates) || result.candidates.length > 2) throw new Error('At most two candidates per batch');
  for (const c of result.candidates) {
    if (!['method', 'project', 'personal'].includes(c.kind) || !['change', 'overlap', 'validation', 'destination'].every(k => typeof c[k] === 'string' && c[k].trim() && c[k].length <= 1600) || !evidence(c.evidenceIds)) throw new Error('Candidate lacks bounded provenance/validation');
  }
  if (!Array.isArray(result.validations) || result.validations.length > 5) throw new Error('Invalid validations');
  for (const v of result.validations) {
    if (!batch.candidates.some(c => c.id === v.candidateId) || !['supported', 'rejected', 'pending'].includes(v.status)
      || !evidence(v.evidenceIds) || typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 1600) throw new Error('Validation lacks new evidence');
  }
  if (result.activitySummary !== undefined && (typeof result.activitySummary !== 'string'
    || !result.activitySummary.trim() || result.activitySummary.length > 1000)) throw new Error('Activity summary must be non-empty and at most 1000 characters');
  return result;
}
export async function commitReview(root, state, active, result, now = new Date().toISOString()) {
  validateResult(result, active.batch);
  if (state.attempts.some(a => a.runId === active.runId && a.committed)) return;
  const receipt = { runId: active.runId, sessionId: active.sessionId, reviewedAt: now, batch: active.batch, result };
  await save(join(root, 'reviews', `${active.runId}.json`), receipt);
  const ids = new Set(result.reviewedIds);
  state.pending = state.pending.filter(x => !ids.has(x.id));
  state.processed = [...new Set([...state.processed, ...ids])];
  for (let i = 0; i < result.candidates.length; i++) state.candidates.push({ ...result.candidates[i],
    id: `${active.batch.id}-${i}`, status: 'pending', runId: active.runId, createdAt: now, history: [] });
  for (const v of result.validations) {
    const candidate = state.candidates.find(c => c.id === v.candidateId);
    candidate.history.push({ ...v, runId: active.runId, at: now }); candidate.status = v.status;
  }
  state.lastReview = { runId: active.runId, at: now, finding: result.finding, candidates: result.candidates.length };
  const attempt = state.attempts.find(a => a.runId === active.runId);
  if (attempt) attempt.committed = true;
}

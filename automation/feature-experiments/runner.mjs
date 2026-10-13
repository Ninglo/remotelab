import { open, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentExperiment, readRecord, safeId, publishRecord } from '../../chat/feature-experiment-store.mjs';
import { prepareBatch, saveLabels, scorePacket, saveDraft, commitDrafts, report } from './review.mjs';
import { createWorker, budgetDecision } from '../dreaming/runner.mjs';
import { transact, save, initialState } from '../dreaming/store.mjs';
import { readProcessIdentity, isProcessIdentityAlive } from '../../lib/process-identity.mjs';

const filename = fileURLToPath(import.meta.url);
export async function runReview(root, command, file, dependencies = {}) {
  const experiment = await currentExperiment(root);
  if (!experiment) return { trigger: false, reason: 'No configured experiment' };
  const dir = experiment.directory;
  if (command === 'report') {
    if (process.env.REMOTELAB_RUN_ID && (await readRecord(join(dir, 'state.json')))?.active?.runId === process.env.REMOTELAB_RUN_ID) throw new Error('Scorer cannot inspect assignment report');
    return report(experiment);
  }
  const worker = dependencies.worker || await createWorker(dir);
  const runId = process.env.REMOTELAB_RUN_ID, sessionId = process.env.REMOTELAB_SESSION_ID;
  const state = () => readRecord(join(dir, 'state.json'), initialState());
  const pending = () => readRecord(join(dir, 'pending.json'));
  async function owned() {
    const s = await state();
    if (s.active?.runId !== runId || s.active?.sessionId !== sessionId) throw new Error('No owned evaluation batch');
    if (await readRecord(join(dir, `stop-${runId}.json`))) throw new Error('Evaluation was stopped; keep draft only');
    const { run } = await worker.api(`/api/runs/${encodeURIComponent(runId)}`);
    if (run?.sessionId !== sessionId || !['accepted', 'running'].includes(run.state)) throw new Error('Scoring Run is not active');
    return s.active;
  }
  if (command === 'gate') {
    await commitDrafts(experiment);
    if (experiment.active.reviewEnabled === false) return { trigger: false, reason: 'Evaluation paused' };
    const budget = budgetDecision(worker.config, await state());
    if (!budget.trigger) return budget;
    // Conditions are checked before reading any potentially large case trace.
    const conditions = await worker.conditions();
    if (!conditions.trigger) return conditions;
    const batch = await prepareBatch(experiment);
    if (!batch.id) return { trigger: false, reason: 'No mature sampled cases', ...batch };
    await publishRecord(join(dir, 'batch-index', batch.id + '.json'), { id: batch.id });
    await save(join(dir, 'pending.json'), batch);
    return { trigger: true, reason: 'New sampled cases ready for blind review', dedupeKey: batch.id + ':' + (await state()).attempts.length };
  }
  if (command === 'before') {
    if (!runId || !sessionId) throw new Error('Native Run and Session IDs required');
    const { run } = await worker.api(`/api/runs/${encodeURIComponent(runId)}`);
    if (run?.sessionId !== sessionId || run.state !== 'accepted') throw new Error('Expected owned accepted Run');
    const expected = experiment.spec.judge;
    if (expected && (run.tool !== expected.tool || run.model !== expected.model || run.effort !== expected.effort)) throw new Error('Scorer profile differs from frozen specification');
    const conditions = await worker.conditions(sessionId);
    if (!conditions.trigger) return conditions;
    const batch = await pending();
    if (!batch?.id || await readRecord(join(dir, 'batches', batch.id, 'committed.json'))) throw new Error('No pending batch');
    await transact(dir, s => {
      if (s.active?.runId === runId) return;
      const d = budgetDecision(worker.config, s); if (!d.trigger) throw new Error(d.reason);
      s.active = { runId, sessionId, batch, at: new Date().toISOString() };
      s.attempts.push({ runId, sessionId, at: s.active.at, tokens: 0 });
    });
    // Reuse the existing bounded notification-based resource guard. Only its
    // guard function runs; the Dreaming intake and promotion paths are unused.
    const guardPath = join(dir, `guard-${runId}.json`), old = await readRecord(guardPath);
    let child;
    if (!old?.birth || !await isProcessIdentityAlive(old)) {
      const log = await open(join(dir, `guard-${runId}.log`), 'a', 0o600);
      try {
        child = spawn(process.execPath, [fileURLToPath(new URL('../dreaming/runner.mjs', import.meta.url)), dir, 'guard', runId, sessionId],
          { detached: true, stdio: ['ignore', log.fd, log.fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } });
        child.unref();
      } finally { await log.close(); }
      await save(guardPath, await readProcessIdentity(child.pid));
    }
    return new Promise((resolveReady, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); fn(value); };
      const inspect = () => readRecord(join(dir, `ready-${runId}.json`)).then(value => {
        if (value?.pid === (child?.pid || old?.pid)) finish(resolveReady, value);
      }).catch(e => finish(reject, e));
      const watcher = watch(dir, () => { void inspect(); });
      const timer = setTimeout(() => finish(reject, new Error('Evaluation guard readiness timeout')), 12000);
      child?.once('error', e => finish(reject, e)); void inspect();
    });
  }
  if (command === 'after') {
    const { run } = await worker.api(`/api/runs/${encodeURIComponent(runId)}`);
    if (run?.sessionId !== sessionId || !['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error('Expected owned terminal Run');
    const usage = await worker.api(`/api/usage/summary?days=2&sessionId=${encodeURIComponent(sessionId)}&top=1`);
    const committed = await commitDrafts(experiment);
    await transact(dir, s => {
      let attempt = s.attempts.find(a => a.runId === runId);
      if (!attempt) { attempt = { runId, sessionId, at: run.createdAt || new Date().toISOString() }; s.attempts.push(attempt); }
      attempt.tokens = Math.max(attempt.tokens || 0, usage.totals?.totalTokens || 0); attempt.state = run.state;
      if (s.active?.runId === runId) s.active = null;
    });
    const summary = await report(experiment);
    await save(join(dir, 'latest-report.json'), { ...summary, generatedAt: new Date().toISOString(),
      scoringAttempts: (await state()).attempts });
    return { trigger: true, committedBatches: committed.committed };
  }
  const active = await owned(), batchId = active.batch.id;
  if (!safeId(batchId)) throw new Error('Invalid batch identity');
  if (command === 'labels-input') {
    const frozenLabels = await readRecord(join(dir, 'batches', batchId, 'labels.json'));
    return { batchId, labelsFrozen: Boolean(frozenLabels), frozenLabels,
      ...await readRecord(join(dir, 'batches', batchId, 'labels-input.json')) };
  }
  if (command === 'labels') return saveLabels(experiment, batchId, JSON.parse(await readFile(file, 'utf8')));
  if (command === 'scores-input') return scorePacket(experiment, batchId);
  if (command === 'submit') return saveDraft(experiment, batchId, JSON.parse(await readFile(file, 'utf8')), runId);
  throw new Error('Use gate|before|after|labels-input|labels|scores-input|submit|report');
}
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const [, , root, command, file] = process.argv;
  if (!root || !command) throw new Error('Usage: runner.mjs <experiment-root> <command> [input.json]');
  try { console.log(JSON.stringify(await runReview(resolve(root), command, file))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

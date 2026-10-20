import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, save, read, validateResult, commitReview } from '../automation/dreaming/store.mjs';
import { deliverReview } from '../automation/dreaming/delivery.mjs';
import { resourceDecision, budgetDecision } from '../automation/dreaming/runner.mjs';

const root = await mkdtemp(join(tmpdir(), 'dreaming-delivery-'));
try {
  const runId = 'run_delivery', sessionId = 'review-session';
  const target = { connector: 'feishu', sourceRouteId: 'test-bot', target: { chatId: 'test-group' } };
  const batch = { id: 'batch', items: [{ id: 'source-1' }], candidates: [] };
  const result = { batchId: batch.id, finding: 'isolated experiment evidence', reviewedIds: ['source-1'], candidates: [], validations: [],
    activitySummary: '核对了一项实际执行记录，本轮没有新增候选。' };
  validateResult(result, batch);
  assert.throws(() => validateResult({ ...result, activitySummary: '' }, batch), /Activity summary/);
  assert.throws(() => validateResult({ ...result, activitySummary: 'x'.repeat(1001) }, batch), /Activity summary/);
  const calls = [], packets = new Map();
  let bound = null, loseReply = true;
  const worker = { config: { resultDelivery: target, scheduleId: 'test-schedule', publicBaseUrl: 'https://example.test/' }, api: async (path, options = {}) => {
    calls.push({ path, options: structuredClone(options) });
    if (path === `/api/sessions/${sessionId}`) {
      if (options.method === 'PATCH') bound = options.body.conversation;
      return { session: { id: sessionId, conversation: bound } };
    }
    if (path === '/api/source-deliveries') {
      const key = options.body.responseId;
      if (packets.has(key)) assert.deepEqual(packets.get(key), options.body, 'retry preserves the exact outbox packet');
      else packets.set(key, structuredClone(options.body));
      if (loseReply) { loseReply = false; throw new Error('lost response after accepted write'); }
      return { delivery: { id: 'srcd_test_1' } };
    }
    throw new Error(`Unexpected API: ${path}`);
  } };
  const state = initialState();
  await save(join(root, 'state.json'), state);
  assert.equal((await deliverReview(root, worker, runId, sessionId)).state, 'not_started');
  state.attempts.push({ runId, sessionId, state: 'cancelled', stopReason: 'before-launch rejected' });
  await save(join(root, 'state.json'), state);
  assert.equal((await deliverReview(root, worker, runId, sessionId)).state, 'not_started');
  assert.equal(calls.length, 0, 'gate and preflight failures never bind or post');
  const active = { runId, sessionId, batch };
  state.attempts[0].state = 'completed';
  await commitReview(root, state, active, result);
  await save(join(root, 'state.json'), state);
  await assert.rejects(deliverReview(root, worker, runId, 'wrong-session'), /owner mismatch/);
  await assert.rejects(deliverReview(root, worker, runId, sessionId), /lost response/);
  assert.equal((await read(join(root, 'deliveries', `${runId}.json`))).state, 'prepared');
  worker.config.resultDelivery = { ...target, target: { chatId: 'changed-after-uncertain-write' } };
  assert.equal((await deliverReview(root, worker, runId, sessionId)).state, 'queued');
  const count = calls.length;
  await deliverReview(root, worker, runId, sessionId);
  assert.equal(calls.length, count, 'completed hook retries do not requeue');
  assert.equal(packets.size, 1);
  assert.equal(bound.target.chatId, 'test-group');
  assert.match(packets.values().next().value.text, /session=review-session/);
  assert.match(packets.values().next().value.text, /没有新增候选/, 'a successful zero-candidate review still reports its actual work');
  assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
  state.attempts.push({ runId: 'run_cancelled', sessionId, state: 'cancelled', claimedAt: new Date().toISOString(), batchItemCount: 2, stopReason: '等待前台空闲' });
  await save(join(root, 'state.json'), state);
  worker.config.resultDelivery = target;
  await deliverReview(root, worker, 'run_cancelled', sessionId);
  assert.match(packets.get('dreaming-result:run_cancelled').text, /已领取 2 条材料/);
  assert.match(packets.get('dreaming-result:run_cancelled').text, /被中断/);
  assert.doesNotMatch(packets.get('dreaming-result:run_cancelled').text, /完成本轮/);

  // The revised instance parameters admit a realistic prior run while still
  // respecting foreground work, three daily attempts and the observed budget.
  const config = { minIdleSeconds: 60, maxDailyAttempts: 3, maxDailyObservedTokens: 400000,
    cooldownSeconds: 3600, maxLoadPerCpu: 0.7, minFreeMemoryRatio: 0.1 };
  const now = Date.now(), at = new Date(now - 7200000).toISOString();
  assert.equal(budgetDecision(config, { ...initialState(), attempts: [{ at, tokens: 94496, state: 'cancelled' }] }, now).trigger, true);
  assert.equal(budgetDecision(config, { ...initialState(), attempts: Array.from({ length: 3 }, () => ({ at, tokens: 100000 })) }, now).trigger, false);
  assert.equal(budgetDecision(config, { ...initialState(), attempts: [{ at, tokens: 400000 }] }, now).trigger, false);
  assert.equal(budgetDecision(config, { ...initialState(), attempts: [{ at: new Date(now - 1000).toISOString(), tokens: 1 }] }, now).trigger, false);
  const resources = { status: 'ready', sessions: [], idleSince: new Date(now - 61000).toISOString(), host: { loadPerCpu: 0.1, freeMemoryRatio: 0.5 } };
  assert.equal(resourceDecision(config, resources, '', now).trigger, true);
  assert.equal(resourceDecision(config, { ...resources, idleSince: new Date(now - 59000).toISOString() }, '', now).trigger, false);
  assert.equal(resourceDecision(config, { ...resources, sessions: [{ id: 'foreground', activity: { run: { state: 'running' }, queue: { count: 0 }, compact: { state: 'idle' } } }] }, '', now).trigger, false);
  console.log('Dreaming: no-start silence, zero-candidate work report, interrupted worker report, ownership, uncertain-write retry and revised budget boundaries passed');
} finally { await rm(root, { recursive: true, force: true }); }

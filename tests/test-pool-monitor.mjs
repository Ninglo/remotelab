import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assessPool, observePool, retainPoolEvidence } from '../chat/pool-monitor.mjs';
const start = Date.parse('2026-11-03T07:00:00Z');
const iso = ms => new Date(ms).toISOString();
function sample(now, { accepted = 10, infra = 0, state = 'running' } = {}) {
  return { resources: { observedAt: iso(now), controllerStale: false, machines: [] },
    queue: { _readAt: iso(now), runs: [{ run_id: 'run', generation: 0, state, progress: { accepted, expected: 100, infra_failed: infra } }] } };
}
test('waiting or execution time alone never means stalled; fresh errors and no progress do', () => {
  let prior;
  for (let minute = 0; minute <= 31; minute++) {
    const now = start + minute * 60000;
    prior = assessPool(prior, sample(now, { infra: minute }), { now });
  }
  assert.equal(prior.attention.filter(x => x.kind === 'poolTask').length, 1);
  const recovered = assessPool(prior, sample(start + 32 * 60000, { accepted: 11 }), { now: start + 32 * 60000 });
  assert.ok(recovered.recovered.some(x => x.kind === 'poolTask'));
  for (const opts of [{ state: 'queued', infra: 50 }, { infra: 0 }]) {
    let previous;
    for (let minute = 0; minute <= 31; minute++) previous = assessPool(previous, sample(start + minute * 60000, opts), { now: start + minute * 60000 });
    assert.ok(!previous.attention.some(x => x.kind === 'poolTask'));
  }
});
test('observation gaps cannot establish or resolve a stalled run', () => {
  let prior = assessPool(null, sample(start), { now: start });
  prior = assessPool(prior, sample(start + 31 * 60000, { infra: 50 }), { now: start + 31 * 60000 });
  assert.ok(!prior.attention.some(x => x.kind === 'poolTask'));
  prior.tasks.run.alerted = true;
  const missing = assessPool(prior, {}, { now: start + 32 * 60000 });
  assert.ok(!missing.recovered.some(x => x.kind === 'poolTask'));
  const terminal = assessPool(missing, { terminals: [{ run_id: 'run', state: 'stopped' }] }, { now: start + 33 * 60000 });
  assert.ok(terminal.recovered.some(x => x.kind === 'poolTask'));
});
test('source recovery needs ten continuous minutes and advancing samples; flaps keep one incident', () => {
  let prior = assessPool(null, {}, { now: start, sourceGraceMs: 1800000 });
  for (let minute = 1; minute <= 30; minute++) {
    const now = start + minute * 60000;
    prior = assessPool(prior, minute === 10 ? sample(now) : {}, { now, sourceGraceMs: 1800000 });
  }
  assert.equal(prior.attention.length, 2);
  const failedSince = prior.sources.controller.failedSince;
  for (let minute = 31; minute <= 40; minute++) {
    const now = start + minute * 60000;
    prior = assessPool(prior, sample(now), { now });
    assert.equal(prior.sources.controller.failedSince, failedSince);
    assert.ok(!prior.recovered.some(x => x.id === 'controller'));
  }
  const now = start + 41 * 60000;
  prior = assessPool(prior, sample(now), { now });
  assert.ok(prior.recovered.some(x => x.id === 'controller'));
  assert.equal(prior.sources.controller.failedSince, null);
});
test('a repeated device sample or an observation gap cannot prove stable recovery', () => {
  const device = now => ({ ...sample(now), resources: { ...sample(now).resources,
    machines: [{ id: 'dev', observation: { observedAt: iso(start), maxAgeSeconds: 3600 } }] } });
  let prior = { sources: { 'device:dev': { failedSince: iso(start - 1800000), alerted: true } } };
  for (let minute = 0; minute <= 11; minute++) {
    const now = start + minute * 60000;
    prior = assessPool(prior, device(now), { now });
  }
  assert.ok(!prior.recovered.some(x => x.id === 'device:dev'));
  const now = start + 20 * 60000, next = device(now);
  next.resources.machines[0].observation.observedAt = iso(now);
  prior = assessPool(prior, next, { now });
  assert.ok(!prior.recovered.some(x => x.id === 'device:dev'));
});
test('one failed upstream does not suppress the other or forge a new success time', async () => {
  let saved;
  const old = sample(start);
  const config = { enabled: true, resourceUrl: 'http://127.0.0.1:18788/ui/resources.json', queueUrl: 'http://127.0.0.1:8878/v1/queue?view=status' };
  const result = await observePool({ config, now: start + 60000, load: async () => old, save: async (_, value) => { saved = value; },
    fetchImpl: async url => { if (url.port === '18788') throw Error('source unavailable'); return { ok: true, json: async () => ({ runs: [] }) }; } });
  assert.equal(saved.resources.observedAt, iso(start));
  assert.equal(result.queue._readAt, iso(start + 60000));
  assert.equal(result.errors.length, 1);
});

test('a measured slow queue can use its own deadline and real timeouts retain old evidence', async t => {
  // Scale the observed 11-second response and source budgets by 100, using real
  // HTTP and AbortSignals so this exercises cancellation, parsing and recovery.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => timeout(Math.ceil(ms / 100)));
  const server = createServer((request, response) => {
    const body = request.url.startsWith('/queue') ? { active: 1, runs: sample(start).queue.runs } : sample(start).resources;
    const reply = () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    if (request.url.startsWith('/queue')) setTimeout(reply, 110); else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { enabled: true, resourceUrl: `${base}/resources`, queueUrl: `${base}/queue` };
  const options = { config, now: start + 60000, load: async () => sample(start), save: async () => {} };
  const expired = await observePool(options);
  assert.equal(expired.queue._readAt, iso(start));
  assert.match(expired.errors.join('\n'), /queue读取失败（TimeoutError:/);
  assert.equal(expired.assessment.sources.controller.ok, true);
  const recovered = await observePool({ ...options, config: { ...config, queueTimeoutMs: 20000 } });
  assert.equal(recovered.queue._readAt, iso(start + 60000));
  assert.equal(recovered.queue.runs[0].progress.accepted, 10);
  assert.deepEqual(recovered.errors, []);
});


test('Hub cold start preserves inventory and each source time without inventing new measurements', () => {
  const previous = {observedAt: iso(start), machines: [{id: 'cloud', cards: [{id: '0', state: 'used', memoryMiB: 42}],
    observation: {observedAt: iso(start), maxAgeSeconds: 600},
    cloudObservation: {observedAt: iso(start), maxAgeSeconds: 120}, jobs: [{id: 'work', state: 'Running'}], quota: {total: 1, allocated: 1}}]};
  const noController = retainPoolEvidence(previous, {observedAt: null, machines: [], stale: true}, start + 60000);
  assert.equal(noController.machines.length, 1); assert.equal(noController.controllerStale, true);
  const current = {observedAt: iso(start + 60000), machines: [{id: 'cloud', cards: [{id: '0', state: 'unknown', allocation: {state: 'unallocated'}}],
    observation: {observedAt: null, refreshing: true}, cloudObservation: {observedAt: null, refreshing: true}}]};
  const fresh = retainPoolEvidence(previous, current, start + 60000).machines[0];
  assert.equal(fresh.observation.observedAt, iso(start)); assert.equal(fresh.cards[0].memoryMiB, 42);
  assert.equal(fresh.cards[0].allocation.state, 'unallocated'); assert.equal(fresh.jobs[0].id, 'work');
  assert.equal(fresh.cloudObservation.observedAt, iso(start));
  const expired = retainPoolEvidence(previous, current, start + 900000).machines[0];
  assert.equal(expired.cards[0].state, 'unknown'); assert.equal(expired.cards[0].reportedState, 'used');
});


test('silent execution loss requires persistent pending work and no active attempts', () => {
  let prior;
  for (let minute = 0; minute <= 31; minute++) {
    const now = start + minute * 60000, value = sample(now);
    value.queue.runs[0].activeAttemptCount = 0; value.queue.runs[0].progress.pending = 90;
    prior = assessPool(prior, value, {now});
  }
  assert.ok(prior.attention.some(x => x.kind === 'poolTask' && x.detail.includes('没有活动 Attempt')));
});


test('unreachable terminal runs share one budget and rotate checks across cycles', async () => {
  let elapsed = 0, saved, calls = [];
  const config = { enabled: true, resourceUrl: 'http://127.0.0.1:18788/ui/resources.json', queueUrl: 'http://127.0.0.1:8878/v1/queue?view=status' };
  let prior = {assessment: {tasks: Object.fromEntries(['a','b','c'].map(id => [id, {alerted: true}]))}};
  const fetchImpl = async url => {
    if (url.pathname.startsWith('/v1/runs/')) { calls.push(url.pathname.split('/').at(-1)); elapsed += 4000; return {ok:false,status:503}; }
    return {ok:true,json:async()=>url.port==='18788'?sample(start).resources:{runs:[]}};
  };
  await observePool({config, now:start, clock:()=>elapsed, fetchImpl, load:async()=>prior, save:async(_,v)=>{saved=v;}});
  assert.deepEqual(calls, ['a','b']);
  prior=saved;calls=[];
  await observePool({config, now:start+60000, clock:()=>elapsed, fetchImpl, load:async()=>prior, save:async()=>{}});
  assert.equal(calls[0], 'c'); assert.equal(calls.length, 2);
});

function trainingSample(now, { total = 32, allocated = 0, available = total - allocated, failed = false, observedAt = iso(now) } = {}) {
  const value = sample(now);
  value.resources.machines = [{ id: 'training', name: 'Training pool', quota: { total, allocated, available },
    cloudObservation: { observedAt, failed, maxAgeSeconds: 600 } }];
  return value;
}
const trainingIdle = { machineIds: ['training'], afterMs: 21600000 };
test('whole training pool needs six continuous hours; restart preserves the evidence clock', async () => {
  let prior;
  for (let minute = 0; minute < 360; minute++) {
    const now = start + minute * 60000;
    prior = assessPool(prior, trainingSample(now), { now, trainingIdle });
    assert.ok(!prior.attention.some(item => item.kind === 'poolIdle'));
  }
  // Exercise the production observer's configuration forwarding and durable state.
  const now = start + 21600000, value = trainingSample(now);
  const result = await observePool({ now, config: { enabled: true, resourceUrl: 'http://127.0.0.1/resources',
    queueUrl: 'http://127.0.0.1/queue', trainingIdle }, load: async () => JSON.parse(JSON.stringify({ assessment: prior })), save: async () => {},
    fetchImpl: async url => ({ ok: true, json: async () => url.pathname === '/queue' ? value.queue : value.resources }) });
  const issue = result.assessment.attention.find(item => item.kind === 'poolIdle');
  assert.equal(issue.idleSince, iso(start));
  assert.match(issue.detail, /360 分钟.*32 卡/);
  assert.equal(assessPool(null, value, { now }).idle.training, undefined, 'other pools are opt-in');
});
test('partial allocation, bad quota and missing samples cannot establish whole-pool idleness', () => {
  for (const bad of [{ allocated: 1 }, { available: 31 }, { failed: true }, { observedAt: iso(start - 3600000) }, { total: 0 }]) {
    const first = assessPool(null, trainingSample(start), { now: start, trainingIdle });
    const interrupted = assessPool(first, trainingSample(start + 60000, bad), { now: start + 60000, trainingIdle });
    assert.equal(interrupted.idle.training.since, null);
    const resumed = assessPool(interrupted, trainingSample(start + 120000), { now: start + 120000, trainingIdle });
    assert.equal(resumed.idle.training.since, iso(start + 120000));
  }
  const first = assessPool(null, trainingSample(start), { now: start, trainingIdle });
  const gap = assessPool(first, trainingSample(start + 21600000), { now: start + 21600000, trainingIdle });
  assert.equal(gap.idle.training.since, iso(start + 21600000));
  assert.ok(!gap.attention.some(item => item.kind === 'poolIdle'));
});
test('unknown evidence does not close an idle notice; confirmed allocation closes and rearms it', () => {
  const previous = { idle: { training: { empty: true, total: 32, since: iso(start), checkedAt: iso(start), observedAt: iso(start), alerted: true } } };
  const unknown = assessPool(previous, trainingSample(start + 60000, { failed: true }), { now: start + 60000, trainingIdle });
  assert.equal(unknown.idle.training.alerted, true);
  assert.ok(!unknown.recovered.some(item => item.kind === 'poolIdle'));
  const used = assessPool(unknown, trainingSample(start + 120000, { allocated: 1 }), { now: start + 120000, trainingIdle });
  assert.equal(used.idle.training.alerted, false);
  assert.ok(used.recovered.some(item => item.kind === 'poolIdle'));
  const empty = assessPool(used, trainingSample(start + 180000), { now: start + 180000, trainingIdle });
  assert.equal(empty.idle.training.since, iso(start + 180000));
  assert.ok(!empty.attention.some(item => item.kind === 'poolIdle'));
});

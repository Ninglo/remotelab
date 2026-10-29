import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { responseTimeSummary, requestResponseTime, runResponseTimeCommand, renderResponseTime } from '../lib/response-time-command.mjs';
import { createRequestStore, requestKey } from '../chat/requests.mjs';

const metric = (count, median) => ({ count, median, mean: median + 10, p95: median + 100 });
const snapshot = {
  generatedAt: '2026-10-29T10:00:00Z', transcripts: 'must not appear', sessions: [{ content: 'private' }],
  agentDashboard: { schema: 2, responseScope: 'ordinary-input', timezone: 'Asia/Shanghai', dayStartHour: 5,
    days: [1, 2].map(n => ({ day: `day${n}`, start: `start${n}`, firstResponse: metric(n, n * 1000),
      delivery: metric(n + 2, n * 3000), journeyStages: { total: metric(n, n * 4000), receive: metric(n, 300) },
      originCoverage: { ordinary: n, unknown: 1 } })),
    coverage: { truncated: true, missingRequests: 3 },
    groupParticipation: { days: [{ day: 'day2', textLatency: metric(3, 800) }], coverage: { partial: true } },
    semantics: { firstResponse: 'first definition', delivery: 'delivery definition', journey: 'journey definition' } },
};
const one = responseTimeSummary(snapshot);
assert.equal(one.days.length, 1);
assert.deepEqual(one.days[0].ordinary.firstResponseMs, metric(2, 2000));
assert.deepEqual(one.days[0].ordinary.finalDeliveryMs, metric(2, 8000));
assert.deepEqual(one.days[0].ordinary.acceptedToFinalMs, metric(4, 6000));
assert.equal(one.days[0].groupMainline.finalDeliveryMs, null);
assert.equal(one.coverage.truncated, true);
assert.equal(one.groupCoverage.partial, true);
assert.equal(responseTimeSummary(snapshot, 7).days.length, 2);
assert(!JSON.stringify(one).includes('private'));
assert.throws(() => responseTimeSummary({}), /unavailable/);
assert.match(renderResponseTime(one), /首响.*完整交付可能覆盖不同样本/);

let calls = [], output = '';
await runResponseTimeCommand(['--json'], { stdout: { write: s => output += s }, client: { request: async path => {
  calls.push(path); return { response: { ok: true }, json: snapshot };
} } });
assert.deepEqual(calls, ['/api/monitoring/sessions?days=1&dashboard=1']);
assert.equal(JSON.parse(output).days[0].ordinary.firstResponseMs.median, 2000);
await assert.rejects(runResponseTimeCommand(['--days', '2']), /must be 1 or 7/);
await assert.rejects(runResponseTimeCommand(['--request-id', 'r', '--session', 's', '--base-url', 'http://other']), /local/);
await assert.rejects(runResponseTimeCommand([], { client: { request: async () => ({ response: { ok: false, status: 503 }, json: { error: 'offline' } }) } }), /offline/);

const t = Date.parse('2026-10-29T10:00:00Z');
const delivery = (id, surfaceKind, extra = {}) => ({ id, connector: 'feishu', kind: 'content', state: 'delivered',
  surfaceKind, createdAt: t + 4000, deliveredAt: t + 5000, ...extra });
const root = { sessionId: 's', requestId: 'r', runId: 'run-r', acceptedAt: t + 1000, preparedAt: t + 2000,
  options: { sourceContext: { connector: 'feishu', createTime: String(t) } }, result: null,
  deliveries: [delivery('reaction', null, { kind: 'reaction', deliveredAt: t + 500 }),
    delivery('opening', 'opening', { deliveredAt: t + 3000 }), delivery('foreign', 'final', { publicationRequestId: 'other' }),
    delivery('final', 'final'), delivery('file', 'final', { kind: 'attachment', state: 'pending', deliveredAt: null })] };
const reads = [];
const store = { byRequest: async (sid, id) => { reads.push([sid, id]); return id === 'r' ? root : null; } };
let result = await requestResponseTime('s', 'r', store);
assert.deepEqual(reads, [['s', 'r']]);
assert.equal(result.metricsMs.firstResponse, 3000);
assert.equal(result.metricsMs.finalDelivery, null, 'pending attachment prevents complete delivery');
assert.equal(result.replyState, 'awaiting-delivery');
assert(!result.receiptIds.includes('foreign'));
root.deliveries.at(-1).state = 'delivered'; root.deliveries.at(-1).deliveredAt = t + 7000;
result = await requestResponseTime('s', 'r', store);
assert.equal(result.metricsMs.finalDelivery, 7000);
assert.equal(result.metricsMs.acceptedToFinal, 6000);
assert.equal(result.executionState, 'running', 'response delivery does not complete a steered execution');

const extra = { ...root, requestId: 'extra', nativeDispatchRunId: 'run-r', deliveries: [],
  mainlineReply: { contract: { ownerRequestId: 'r' } } };
root.mainlineReply = { contract: { ownerRequestId: 'r', requestIds: ['r', 'extra'], providerMessageId: 'combined' } };
root.deliveries.push(delivery('combined', 'final', { providerMessageId: 'combined', deliveredAt: t + 9000 }));
const steeredStore = { byRequest: async (sid, id) => id === 'extra' ? extra : root };
result = await requestResponseTime('s', 'extra', steeredStore);
assert.deepEqual(result.receiptIds, ['combined']);
assert.equal(result.metricsMs.finalDelivery, 9000);
delete root.mainlineReply;
result = await requestResponseTime('s', 'extra', steeredStore);
assert.equal(result.metricsMs.finalDelivery, null, 'unattributed root output does not answer a supplement');
await assert.rejects(requestResponseTime('s', 'missing', store), /not found/);

// Real durable point lookup: archive access works without listing or touching spools.
const dir = await mkdtemp(join(tmpdir(), 'response-time-'));
try {
  await mkdir(join(dir, 'archive'));
  await writeFile(join(dir, 'archive', requestKey('s', 'r') + '.json'), JSON.stringify({ ...root, schema: 1 }));
  result = await requestResponseTime('s', 'r', createRequestStore(dir));
  assert.equal(result.metricsMs.finalDelivery, 9000);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('response-time: one monitoring read, preserved scopes/quantiles, partial coverage, exact archived/steered receipts, pending files and failures passed');

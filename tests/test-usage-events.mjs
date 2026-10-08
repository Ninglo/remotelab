import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageEventStore, normalizeUsageEvent, summarizeSurfacePaths, usageEvents, usageKey } from '../chat/usage-events.mjs';
import { createRequestStore } from '../chat/requests.mjs';
import { observeRequestUsage } from '../chat/usage-event-projection.mjs';

test('collection is bounded, strips content and client attribution, survives retry and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-events-'));
  try {
    const store = createUsageEventStore({ directory });
    const input = { eventId: 'browser-1', event: 'session_open', sessionId: 'session-a', actorKind: 'agent', surface: 'feishu',
      personId: 'spoofed', personHash: 'spoofed', content: 'secret dialogue', url: 'https://secret', ip: 'private-ip',
      props: { token: 'secret credential' }, tool: 'secret-tool', action: 'secret-action', page: 'sessions' };
    assert.equal(await store.record(input, { client: true, personId: 'verified-person' }), true);
    await store.record(input, { client: true, personId: 'verified-person' });
    let summary = await store.query();
    assert.equal(summary.total, 1);
    assert.equal(summary.events[0].actorKind, 'human'); assert.equal(summary.events[0].surface, 'web');
    assert.equal(summary.events[0].personHash, usageKey('person:verified-person'));
    assert.equal(summary.events[0].tool, undefined); assert.equal(summary.events[0].action, undefined);
    const restarted = createUsageEventStore({ directory });
    await restarted.record(input, { client: true, personId: 'verified-person' });
    summary = await restarted.query(); assert.equal(summary.total, 1, 'durable IDs deduplicate across processes');
    assert.equal((await restarted.query({ sessionId: 'other' })).total, 0);
    const log = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
    const raw = await readFile(join(directory, log), 'utf8');
    for (const forbidden of ['secret', 'private-ip', 'spoofed', 'verified-person']) assert.equal(raw.includes(forbidden), false);
    assert.equal((await stat(join(directory, log))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(normalizeUsageEvent({ ...input, event: 'run_state' }, { client: true }), null);
    assert.equal(normalizeUsageEvent({ ...input, eventId: '../unsafe id' }, { client: true }), null);
    assert.equal((await restarted.query({ maxScanned: 1 })).coverage.incomplete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed storage and full queue never reject the primary work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-failure-'));
  try {
    const file = join(root, 'file'); await writeFile(file, 'not a directory');
    const store = createUsageEventStore({ directory: file });
    assert.equal(await store.record({ eventId: 'a', event: 'session_created' }), false);
    assert.equal((await store.query()).coverage.failures, 1);
    const capped = createUsageEventStore({ directory: join(root, 'queue'), maxPending: 1 });
    const first = capped.record({ eventId: 'first', event: 'session_created' });
    assert.equal(await capped.record({ eventId: 'dropped', event: 'session_created' }), false);
    await first; assert.equal((await capped.query()).coverage.dropped, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('surface paths require same person, same Session, ordered human inputs and original thread', () => {
  const e = (timestamp, event, surface, extra = {}) => ({ timestamp, event, surface, personHash: 'person-a', sessionId: 's', actorKind: 'human', ...extra });
  const events = [e(1, 'message_submitted', 'feishu', { conversationKey: 'thread-a' }),
    e(2, 'session_open', 'web', { personHash: 'person-b' }),
    e(3, 'message_submitted', 'web', { sessionId: 'other' }),
    e(4, 'delivery_state', 'feishu', { actorKind: 'system' })];
  assert.deepEqual(summarizeSurfacePaths(events).webOpened, 0);
  events.push(e(5, 'session_open', 'web'), e(6, 'message_submitted', 'web'),
    e(7, 'message_submitted', 'feishu', { conversationKey: 'other-thread' }));
  assert.equal(summarizeSurfacePaths(events).webContinued, 1); assert.equal(summarizeSurfacePaths(events).originalFeishuContinued, 0);
  events.push(e(8, 'message_submitted', 'feishu', { conversationKey: 'thread-a' }));
  const result = summarizeSurfacePaths(events);
  assert.equal(result.feishuStarted, 1); assert.equal(result.webOpened, 1); assert.equal(result.originalFeishuContinued, 1);
});

test('startup history and concurrent duplicate receipts leave capacity for new actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-recovery-'));
  try {
    const since = Date.now() - 1000;
    await writeFile(join(directory, 'collection.json'), JSON.stringify({ startedAt: new Date(since).toISOString() }));
    const store = createUsageEventStore({ directory, maxPending: 2 });
    const recovered = Array.from({ length: 3000 }, (_, n) => store.record({
      eventId: `old-${n}`, event: 'delivery_state', timestamp: since - 1,
    }));
    const retries = Array.from({ length: 3000 }, () => store.record({
      eventId: 'same-receipt', event: 'delivery_state', timestamp: since + 1,
    }));
    const current = store.record({ eventId: 'new-action', event: 'message_submitted' });
    // Do not await record: idle must include asynchronous admission itself.
    await store.idle();
    const summary = await store.query();
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.byEvent, { delivery_state: 1, message_submitted: 1 });
    assert.equal(summary.coverage.dropped, 0);
    assert.equal(summary.coverage.failures, 0);
    assert.equal((await Promise.all([...recovered, ...retries, current])).every(Boolean), true);
    const restarted = createUsageEventStore({ directory });
    void restarted.record({ eventId: 'next-action', event: 'message_submitted' });
    assert.equal((await restarted.query()).total, 3, 'reads include calls awaiting collection metadata');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('request observation receives prior result and receipt state on recovery metadata changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-request-'));
  const originalRecord = usageEvents.record, emissions = [];
  usageEvents.record = event => { emissions.push(event); return Promise.resolve(true); };
  try {
    const observed = [];
    const store = createRequestStore(root, { onChange: (record, meta) => {
      observed.push({ record, meta }); observeRequestUsage(record, meta);
    } });
    const { record } = await store.accept({ sessionId: 's', requestId: 'r', text: 'test' });
    await store.settle(record.key, { state: 'completed' }, [{ connector: 'feishu', kind: 'final' }]);
    await store.mutate(record.key, current => ({ ...current, deliveries: current.deliveries.map(part => ({
      ...part, state: 'delivered', attempts: 1,
    })) }));
    await store.mutate(record.key, current => ({ ...current, postCompletionPending: false }));
    const last = observed.at(-1);
    assert.equal(last.meta.accepted, false);
    assert.equal(last.meta.previous.resultState, last.record.result.state);
    assert.equal(last.meta.previous.settledAt, last.record.settledAt);
    assert.deepEqual(last.meta.previous.deliveries, [{ id: last.record.deliveries[0].id, state: 'delivered', attempts: 1 }]);
    assert.equal(observed[2].meta.previous.deliveries[0].state, 'pending');
    assert.equal(observed[0].meta.accepted, true);
    assert.deepEqual(emissions.map(event => event.event), ['message_submitted', 'request_state', 'delivery_state'],
      'post-completion bookkeeping must not enqueue settled results or unchanged receipts');
  } finally { usageEvents.record = originalRecord; await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageEventStore, normalizeUsageEvent, summarizeSurfacePaths, usageKey } from '../chat/usage-events.mjs';

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

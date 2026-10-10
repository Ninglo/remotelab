import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';
import { feishuReadRetryPolicy } from '../lib/feishu-retry-policy.mjs';
const root = await mkdtemp(join(tmpdir(), 'connector-inbox-'));
try {
  let prepared;
  let attempts = 0;
  const makeInbox = () => createConnectorInbox(root, {
    conversationKey: entry => entry.chat,
    onError: () => {},
    process: async (entry, save) => {
      attempts++;
      if (!entry.submission) await save({ submission: { model: 'original', attachmentId: 'asset-original' } });
      else prepared = entry.submission;
      if (attempts === 1) throw new Error('accepted but response lost');
      return { requestId: entry.id };
    },
  });
  let inbox = makeInbox();
  const accepted = await inbox.accept('event-1', { chat: 'chat-a', text: 'hello' });
  await inbox.tick(); await inbox.idle();
  assert.deepEqual((await inbox.store.get(accepted.key)).submission, { model: 'original', attachmentId: 'asset-original' });
  inbox = makeInbox();
  await inbox.store.mutate(accepted.key, current => ({ ...current, nextAttemptAt: 0 }));
  await inbox.tick(); await inbox.idle();
  assert.deepEqual(prepared, { model: 'original', attachmentId: 'asset-original' });
  assert.equal((await inbox.store.active()).length, 0);
  const duplicate = await inbox.accept('event-1', { chat: 'chat-a', text: 'hello' });
  assert.equal(duplicate.complete, true);
  await assert.rejects(inbox.accept('event-1', { chat: 'chat-a', text: 'changed input' }), /different content/);
  await inbox.tick(); await inbox.idle();
  assert.equal(attempts, 2, 'completed inbox handoffs are not repeated');
  const immediate = [];
  inbox = createConnectorInbox(join(root, 'immediate'), {
    conversationKey: entry => entry.chat,
    process: async entry => { immediate.push(entry.id); return {}; },
  });
  try {
    inbox.start();
    await inbox.accept('immediate-1', { chat: 'chat-a' });
    await inbox.idle();
    assert.deepEqual(immediate, ['immediate-1'], 'accepted input dispatches without waiting for the recovery interval');
  } finally { inbox.stop(); await inbox.idle(); }

  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const dispatched = [];
  inbox = createConnectorInbox(join(root, 'handoff'), {
    conversationKey: entry => entry.chat,
    process: async entry => {
      dispatched.push(entry.id);
      if (entry.id === 'first') await firstGate;
      return {};
    },
  });
  try {
    await inbox.accept('first', { chat: 'chat-a' });
    await inbox.accept('second', { chat: 'chat-a' });
    inbox.start();
    await inbox.tick();
    assert.deepEqual(dispatched, ['first'], 'same-conversation preparation remains ordered');
    releaseFirst();
    await inbox.idle();
    assert.deepEqual(dispatched, ['first', 'second'], 'a completed handoff immediately releases its successor');
    await inbox.accept('stopped', { chat: 'chat-a' });
    inbox.stop();
    await inbox.idle();
    const stoppedCount = dispatched.length;
    await inbox.accept('after-stop', { chat: 'chat-a' });
    await inbox.idle();
    assert.equal(dispatched.length, stoppedCount, 'shutdown leaves newly accepted work durable without dispatching it');
  } finally { releaseFirst(); inbox.stop(); await inbox.idle(); }

  const stale = [];
  inbox = createConnectorInbox(join(root, 'stale'), {
    conversationKey: entry => entry.chat,
    process: async entry => { stale.push(entry.id); return {}; },
  });
  const beforeCompletion = await inbox.accept('stale-snapshot', { chat: 'chat-a' });
  await inbox.tick(); await inbox.idle();
  const active = inbox.store.active;
  inbox.store.active = async () => [beforeCompletion];
  await Promise.all([inbox.tick(), inbox.tick()]); await inbox.idle();
  inbox.store.active = active;
  assert.deepEqual(stale, ['stale-snapshot'], 'a stale disk scan cannot execute an already completed receipt again');

  const rejected = [];
  inbox = createConnectorInbox(join(root, 'rejection'), {
    conversationKey: entry => entry.chat,
    onError: () => {},
    process: async entry => {
      rejected.push(entry.id);
      if (entry.id === 'invalid') throw Object.assign(new Error('definite HTTP 400'), { retryable: false });
      return {};
    },
  });
  const invalid = await inbox.accept('invalid', { chat: 'chat-a' });
  await inbox.accept('restore', { chat: 'chat-a' });
  inbox.start();
  try {
    await inbox.idle();
    assert.deepEqual(rejected, ['invalid', 'restore'], 'a permanent rejection releases the next message in the same conversation');
    assert.equal((await inbox.store.get(invalid.key)).receipt.permanent, true);
    assert.equal((await inbox.accept('invalid', { chat: 'chat-a' })).complete, true);
    assert.deepEqual(rejected, ['invalid', 'restore'], 'redelivery retains the original failure without re-executing it');
  } finally { inbox.stop(); await inbox.idle(); }
  let clock = 1000, retryCalls = 0;
  const retryRoot = join(root, 'bounded-retries');
  const retryInbox = () => createConnectorInbox(retryRoot, {
    conversationKey: entry => entry.chat, retryPolicy: feishuReadRetryPolicy, now: () => clock,
    onError: () => {}, process: async () => { retryCalls++; throw Object.assign(new Error('rate limited'), {
      code: 99991400, retryAfterMs: retryCalls === 1 ? 15_000 : 0,
    }); },
  });
  inbox = retryInbox();
  const rateLimited = await inbox.accept('rate-limited', { chat: 'doc' });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await inbox.tick(); await inbox.idle();
    const record = await inbox.store.get(rateLimited.key);
    assert.equal(record.attempts, attempt);
    if (attempt < 5) {
      assert.equal(record.nextAttemptAt - clock, attempt === 1 ? 15_000 : 5000 * 2 ** (attempt - 1));
      await inbox.tick(); await inbox.idle();
      assert.equal(retryCalls, attempt, 'a premature tick makes no request');
      clock = record.nextAttemptAt;
      inbox = retryInbox(); // The attempt budget and deadline survive process restart.
    } else {
      assert.equal(record.receipt.retryExhausted, true);
      assert.equal(record.complete, true);
      assert.equal((await inbox.store.active()).length, 0);
    }
  }
  await inbox.tick(); await inbox.idle();
  assert.equal(retryCalls, 5, 'transient failures stop at the durable attempt limit');
  const interrupted = await inbox.accept('interrupted-final-attempt', { chat: 'doc' });
  await inbox.store.mutate(interrupted.key, record => ({ ...record, attempts: 5 }));
  inbox = retryInbox(); await inbox.tick(); await inbox.idle();
  assert.equal(retryCalls, 5, 'a crash after persisting the final attempt cannot reset or exceed the budget');
  assert.equal((await inbox.store.get(interrupted.key)).receipt.retryExhausted, true);
  assert.equal(feishuReadRetryPolicy({ code: 99991672 }).retryable, false);
  assert.equal(feishuReadRetryPolicy({ httpStatus: 404 }).retryable, false);
  assert.equal(feishuReadRetryPolicy({ httpStatus: 503 }).retryable, true);

  let activeCount = 0, maxActive = 0, cappedCalls = 0;
  const releases = [];
  inbox = createConnectorInbox(join(root, 'capped'), {
    conversationKey: entry => entry.chat, maxConcurrency: 2,
    process: async () => { cappedCalls++; activeCount++; maxActive = Math.max(maxActive, activeCount);
      await new Promise(resolve => releases.push(resolve)); activeCount--; return {}; },
  });
  for (let i = 0; i < 4; i++) await inbox.accept(`capped-${i}`, { chat: `doc-${i}` });
  await inbox.tick();
  assert.equal(cappedCalls, 2, 'only two documents can start at once');
  await inbox.tick();
  assert.equal(cappedCalls, 2);
  releases.splice(0).forEach(release => release());
  await inbox.idle(); await inbox.tick();
  assert.equal(cappedCalls, 4);
  releases.splice(0).forEach(release => release());
  await inbox.idle();
  assert.equal(maxActive, 2);
  console.log('connector inbox: durable replay, ordering, bounded concurrency and restart-safe retry budget pass');
} finally { await rm(root, { recursive: true, force: true }); }

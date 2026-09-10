import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorInbox } from '../lib/connector-inbox.mjs';
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
  console.log('connector inbox: durable replay, immediate dispatch, ordered handoff, shutdown and stale-scan deduplication pass');
} finally { await rm(root, { recursive: true, force: true }); }

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
  console.log('connector inbox: prepared handoff survives restart and completed input deduplicates');
} finally { await rm(root, { recursive: true, force: true }); }

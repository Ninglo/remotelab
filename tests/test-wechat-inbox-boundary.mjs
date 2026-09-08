#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-wechat-boundary-'));
setIsolatedTestHome(home);
const { loadConfig, createRuntimeContext, initializeWeChatInbox, pollAccountOnce, replayUnhandledMessages,
  processWeChatSourceDeliveryOnce } = await import('../scripts/wechat-connector.mjs');
let inbox;
try {
  const path = join(home, 'config.json');
  await writeFile(path, JSON.stringify({ storageDir: join(home, 'wechat'), chatBaseUrl: 'http://127.0.0.1:1' }));
  const config = await loadConfig(path);
  const runtime = createRuntimeContext(config, { accountsDoc: { accounts: {
    a: { accountId: 'a', userId: 'bot-a', token: 'fixture-a' }, b: { accountId: 'b', userId: 'bot-b', token: 'fixture-b' },
  } } });
  const processed = [];
  inbox = initializeWeChatInbox(runtime, { handleMessageImpl: async (_runtime, summary) => { processed.push(summary); } });
  runtime.inbox = inbox;
  let token = 'first-context';
  const getUpdates = async () => ({ ret: 0, get_updates_buf: 'next-cursor', msgs: [{
    message_id: 'same-id', from_user_id: 'peer', to_user_id: 'bot', message_type: 1, message_state: 2,
    context_token: token, item_list: [{ type: 1, text_item: { text: 'Fixture input' } }],
  }] });
  let cursorWrites = 0;
  await assert.rejects(pollAccountOnce(runtime, 'a', { getUpdates,
    acceptInboundMessage: async () => { throw new Error('inbox disk failure'); },
    saveSyncStateDocument: async () => { cursorWrites++; },
  }), /inbox disk failure/);
  assert.equal(cursorWrites, 0, 'upstream cursor cannot advance before durable admission');
  assert.equal(runtime.syncStateDoc.accounts.a?.getUpdatesBuf, undefined);

  await assert.rejects(pollAccountOnce(runtime, 'a', { getUpdates,
    saveSyncStateDocument: async () => { throw new Error('cursor disk failure'); },
  }), /cursor disk failure/);
  assert.equal((await inbox.store.active()).length, 1, 'event survives a crash before cursor acknowledgement');
  assert.equal(runtime.syncStateDoc.accounts.a?.getUpdatesBuf, undefined, 'failed cursor write cannot advance even the memory cursor');
  token = 'refreshed-context';
  await pollAccountOnce(runtime, 'a', { getUpdates });
  await pollAccountOnce(runtime, 'b', { getUpdates });
  assert.equal((await inbox.store.active()).length, 2, 'message ids are isolated by account; redelivery only deduplicates its own account');
  token = 'newest-context';
  await pollAccountOnce(runtime, 'a', { getUpdates });
  await replayUnhandledMessages(runtime, { accountIds: ['a', 'b'] });
  assert.equal((await inbox.store.active()).length, 2, 'restart log replay remains idempotent after context-token changes');
  await inbox.tick(); await inbox.idle();
  assert.equal(processed.length, 2);
  assert.equal(processed.find(item => item.accountId === 'a').contextToken, 'newest-context');

  // An attachment-only outbox record must produce usable user-facing output,
  // not be falsely acknowledged after calling the fallback helper incorrectly.
  runtime.config.publicBaseUrl = 'https://fixture.example.test';
  let claimed = false;
  const text = [];
  await processWeChatSourceDeliveryOnce(runtime, {
    requestRemoteLab: async (path, options = {}) => {
      if (path.endsWith('/claim')) {
        if (claimed) return { response: { ok: true }, json: { claim: null } };
        claimed = true;
        return { response: { ok: true }, json: { claim: { leaseId: 'fixture-lease', delivery: {
          id: `srcd_${'a'.repeat(24)}_0`, sessionId: 'fixture-session', target: { accountId: 'a', peerUserId: 'peer' },
          text: '', attachment: { originalName: 'result.txt', savedPath: join(home, 'result.txt') },
        } } } };
      }
      assert(path.endsWith('/complete'), 'attachment is acknowledged only after text/link transmission');
      return { response: { ok: true }, json: { delivery: { state: 'delivered', ...options.body } } };
    },
    sendWeChatText: async (_runtime, summary, body) => {
      text.push(body); assert.equal(summary.contextToken, 'newest-context'); return { message_id: 'fixture-message' };
    },
  });
  assert.equal(text.length, 1);
  assert.match(text[0], /result\.txt/);
  assert.match(text[0], /https:\/\/fixture\.example\.test\/\?session=fixture-session/);
  console.log('WeChat boundaries: inbox before cursor, cursor write failure, account dedup, refreshed-token replay and attachment-only fallback passed');
} finally {
  inbox?.stop(); await inbox?.idle();
  await rm(home, { recursive: true, force: true });
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-bot-handoff-'));
setIsolatedTestHome(home);
const { handleMessage, processSourceDeliveryOnce, recordFeishuThreadSessionBinding, summarizeEvent } = await import('../scripts/feishu-connector.mjs');
const { claimFeishuBotHandoff, restoreFeishuBotHandoffScopes } = await import('../connectors/feishu/bot-handoff.mjs');
const { createDeliveryReceipts } = await import('../lib/delivery-receipts.mjs');
const { shouldReplyInFeishuThread } = await import('../connectors/feishu/index.mjs');
const runtime = () => ({
  config: { storageDir: home, sourceRouteId: 'bot-self', appId: 'cli_self', responsePolicy: { group: 'all' } },
  storagePaths: { messageIndexPath: join(home, 'message-index.json') },
  botIdentity: { openId: 'ou_self', userId: 'user_self' },
});
let rt = runtime();
const base = summarizeEvent({
  tenant_key: 'tenant',
  sender: { sender_type: 'app', sender_id: { open_id: 'ou_peer' } },
  message: { message_id: 'handoff', chat_id: 'chat', chat_type: 'group', message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 please help' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
  },
});
const effects = [];
const helpers = {
  addProcessingReaction: async () => { effects.push('reaction'); },
  queueFeishuReply: async () => { effects.push('usage'); return {}; },
  submitRemoteLabRequest: async (_runtime, summary) => {
    effects.push(summary);
    return { sessionId: `session-${summary.messageId}`, requestId: `feishu:${summary.messageId}` };
  },
};
const send = (patch = {}, overrides = {}) => handleMessage(rt, { ...base, ...patch }, 'test', { ...helpers, ...overrides });
async function ignored(patch) {
  const before = effects.length;
  assert.equal((await send(patch)).ignored, true);
  assert.equal(effects.length, before, 'denied bots cause no reaction, command reply or AI submission');
}

try {
  await ignored({ mentions: [] });
  await ignored({ mentions: [], chatType: 'p2p' });
  await ignored({ mentions: [{ name: 'self', openId: 'someone-else' }] });
  await ignored({ mentions: [{ openId: 'all' }] });
  await ignored({ mentions: [{ userId: 'ou_self' }] });
  await ignored({ sender: { senderType: 'app', openId: 'ou_self' } });
  await ignored({ sender: { senderType: 'app', openId: 'cli_self' } });
  await ignored({ sender: { senderType: 'system' } });

  await send();
  assert.equal(effects[1].forkCommand, true);
  assert.equal(effects[1].forkText, 'please help');
  assert.equal(effects[1].botHandoffMessageId, 'handoff');
  assert.equal(effects[1].replyInThread, true);
  await ignored({ messageId: 'before-reply', rootId: 'handoff', messageText: '/fork again' });

  // Retry after a crash retains the original reservation. Distinct bot events do not.
  rt = runtime();
  assert.equal(await claimFeishuBotHandoff(rt, { ...base, forkCommand: true }), true);
  await ignored({ messageId: 'different-bot', parentId: 'handoff', sender: { senderType: 'bot', openId: 'ou_third' } });

  // Delivery acknowledgement persists the server-assigned thread and reply aliases.
  let claimed = false;
  let racingReply;
  await processSourceDeliveryOnce(rt, {
    requestRemoteLab: async (path) => {
      if (path.endsWith('/claim')) {
        if (claimed) return { response: { ok: true }, json: { claim: null } };
        claimed = true;
        return { response: { ok: true }, json: { claim: { leaseId: 'lease', delivery: {
          id: 'delivery', text: 'done', sessionId: 'session-handoff', target: effects[1],
        } } } };
      }
      return { response: { ok: true }, json: { delivery: { status: 'sent' } } };
    },
    sendFeishuText: async () => {
      racingReply = send({ messageId: 'immediate-peer-reply', threadId: 'created-thread', parentId: 'outbound' });
      return { message_id: 'outbound', thread_id: 'created-thread' };
    },
  });
  assert.equal((await racingReply).ignored, true, 'a peer reply arriving during publication waits for alias persistence');
  rt = runtime();
  await ignored({ messageId: 'thread-followup', threadId: 'created-thread' });
  await ignored({ messageId: 'quoted-followup', parentId: 'outbound' });
  await ignored({ messageId: 'unmentioned-thread-bot', threadId: 'created-thread', mentions: [] });
  // Recover aliases from a receipt left behind before the previous process could acknowledge it.
  await createDeliveryReceipts(join(home, 'delivery-receipts')).record({
    deliveryId: 'unacknowledged', leaseId: 'lease-2', target: effects[1],
    sessionId: 'session-handoff', threadId: 'restored-thread', messageId: 'restored-outbound',
  });
  rt = runtime();
  await restoreFeishuBotHandoffScopes(rt);
  await ignored({ messageId: 'after-receipt-restart', threadId: 'restored-thread', parentId: 'restored-outbound' });
  await ignored({ messageId: 'empty-fork-followup', threadId: 'created-thread', messageText: '/fork' });
  await recordFeishuThreadSessionBinding(rt, { ...base, threadId: 'session-alias' }, 'session-handoff');
  await ignored({ messageId: 'session-followup', threadId: 'session-alias' });

  // Human continuation and explicit human forks still work; neither resets the quota.
  await send({ messageId: 'human', threadId: 'created-thread', sender: { senderType: 'user' }, messageText: 'continue please' });
  assert.equal(effects.at(-1).forkCommand, undefined);
  await send({ messageId: 'human-fork', threadId: 'created-thread', sender: { senderType: 'user' }, messageText: '/fork new task' });
  assert.equal(effects.at(-1).forkCommand, true);
  rt = runtime();
  await ignored({ messageId: 'after-human-fork', threadId: 'created-thread' });

  // One shared quota, not one allowance per peer bot, even under concurrent admission.
  const concurrent = await Promise.all(['one', 'two'].map(messageId => send({
    messageId, threadId: 'racing-thread', sender: { senderType: 'app', openId: messageId },
  })));
  assert.equal(concurrent.filter(result => !result.ignored).length, 1);
  assert.equal(concurrent.filter(result => result.reason === 'bot_handoff_consumed').length, 1);

  // Failure before submission cannot open a second admission. The same event retries.
  const failed = { messageId: 'failed', threadId: 'failure-thread' };
  await assert.rejects(send(failed, { submitRemoteLabRequest: async () => { throw new Error('offline'); } }), /offline/);
  rt = runtime();
  await ignored({ messageId: 'failure-racer', threadId: 'failure-thread' });
  assert.equal((await send(failed)).sessionId, 'session-failed');

  assert.equal((await send({ messageId: 'independent' })).sessionId, 'session-independent');
  await send({ messageId: 'private-first', chatType: 'p2p', chatId: 'private-chat' });
  rt = runtime();
  await ignored({ messageId: 'private-second', chatType: 'p2p', chatId: 'private-chat' });
  await send({ messageId: 'shared-first', messageText: '/continue shared task' });
  rt = runtime();
  await ignored({ messageId: 'shared-second', messageText: '/continue another task' });
  assert.equal((await send({ messageId: 'tenant-isolation', tenantKey: 'other', threadId: 'created-thread' })).sessionId, 'session-tenant-isolation');
  assert.equal((await send({ messageId: 'chat-isolation', chatId: 'other-chat', threadId: 'created-thread' })).sessionId, 'session-chat-isolation');
  rt = { ...runtime(), config: { ...runtime().config, sourceRouteId: 'other-route' } };
  assert.equal((await send({ messageId: 'route-isolation', threadId: 'created-thread' })).sessionId, 'session-route-isolation');

  // Bot admission must not alter the routing policy selected for human messages.
  for (const [name, patch, sessionPolicy, expectedThread] of [
    ['default-fork', {}, undefined, true],
    ['explicit-continue', { messageText: '/continue task' }, undefined, false],
    ['group-continue', {}, { defaultMode: 'continue' }, false],
    ['group-override', {}, { defaultMode: 'fork', groups: { 'parity-group-override': 'continue' } }, false],
    ['explicit-fork', { messageText: '/fork task' }, { defaultMode: 'continue' }, true],
    ['private', { chatType: 'p2p' }, undefined, false],
    ['existing-thread', { threadId: 'parity-thread' }, { defaultMode: 'continue' }, true],
  ]) {
    rt = runtime();
    rt.config.sessionPolicy = sessionPolicy;
    const summary = { ...base, ...patch, chatId: `parity-${name}` };
    if (patch.threadId) await recordFeishuThreadSessionBinding(rt, summary, `parity-session-${name}`);
    const routed = [];
    for (const senderType of ['user', 'bot']) {
      await handleMessage(rt, { ...summary, messageId: `parity-${name}-${senderType}`,
        sender: { ...base.sender, senderType } }, 'test', {
        addProcessingReaction: async () => null,
        submitRemoteLabRequest: async (_runtime, value) => {
          routed.push(value);
          return { sessionId: `parity-session-${name}` };
        },
      });
    }
    assert.equal(routed.length, 2, `${name}: both senders are admitted`);
    for (const field of ['forkCommand', 'forkText', 'continueCommand', 'replyInThread']) {
      assert.equal(routed[1][field], routed[0][field], `${name}: bot and human ${field} match`);
    }
    assert.equal(shouldReplyInFeishuThread(routed[1]), expectedThread, `${name}: common outbound routing`);
  }

  // Fail closed when durability is unavailable or corrupt, not an in-memory reset.
  rt = { ...runtime(), storagePaths: {}, config: { responsePolicy: { group: 'all' } } };
  await ignored({ messageId: 'no-storage' });
  rt = runtime();
  const records = await readdir(join(home, 'bot-handoffs', 'active'));
  for (const file of records) await writeFile(join(home, 'bot-handoffs', 'active', file), '{broken');
  await assert.rejects(send({ messageId: 'corrupt-state' }), SyntaxError);
  console.log('ok - bot handoffs are explicit, durable, one-shot, alias-aware and restart-safe');
} finally {
  await rm(home, { recursive: true, force: true });
}

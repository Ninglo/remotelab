#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'feishu-response-policy-'));
setIsolatedTestHome(testHome);
const { addProcessingReaction, handleMessage, loadConfig } = await import('../scripts/feishu-connector.mjs');
const base = {
  messageId: 'routing-test', chatId: 'group-1', chatType: 'group',
  chatMode: 'group', messageType: 'text', messageText: 'hello', mentions: [],
  sender: { senderType: 'user' },
};
let effects = [];
const runtime = {
  config: { responsePolicy: { group: 'mention_only' } },
  botIdentity: { openId: 'bot-self', unionId: 'bot-union' },
  storagePaths: {},
};
const helpers = {
  addProcessingReaction: async () => { effects.push('reaction'); },
  submitRemoteLabRequest: async () => {
    effects.push('submit');
    return { sessionId: 'routing-session', requestId: 'routing-request', runId: 'routing-run' };
  },
};
async function check(label, changes, expected, responsePolicy = { group: 'mention_only' }) {
  effects = [];
  runtime.config.responsePolicy = responsePolicy;
  await handleMessage(runtime, { ...base, ...changes }, 'test', helpers);
  assert.deepEqual(effects, expected, label);
}

try {
  await check('ordinary group chatter stays silent', {}, []);
  await check('mentions of another user stay silent', { mentions: [{ openId: 'human' }] }, []);
  await check('this Bot mention is admitted and acknowledged', { mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  await check('private chat always responds immediately', { chatType: 'p2p', chatMode: 'private' }, ['reaction', 'submit']);
  await check('all group mode admits every message', {}, ['reaction', 'submit'], { group: 'all' });

  effects = [];
  runtime.config.responsePolicy = { group: 'mention_only' };
  await handleMessage(runtime, { ...base, mentions: [{ openId: 'bot-self' }] }, 'test', {
    addProcessingReaction: async () => { effects.push('reaction-failed'); throw new Error('reaction unavailable'); },
    submitRemoteLabRequest: helpers.submitRemoteLabRequest,
  });
  assert.deepEqual(effects, ['reaction-failed', 'submit'], 'reaction failures must not block AI admission');

  let reactionPayload = null;
  const reaction = await addProcessingReaction({
    appClient: { im: { v1: { messageReaction: { create: async (payload) => {
      reactionPayload = payload;
      return { code: 0, data: { reaction_id: 'reaction-1' } };
    } } } } },
  }, base);
  assert.equal(reaction.reactionId, 'reaction-1');
  assert.equal(reactionPayload.data.reaction_type.emoji_type, 'THINKING');

  const configPath = join(testHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    appId: 'test', appSecret: 'test',
    accessPolicy: { mode: 'all' },
    responsePolicy: { group: 'mention_only' },
  }));
  const config = await loadConfig(configPath);
  assert.equal(config.accessPolicy.mode, 'all');
  assert.deepEqual(config.responsePolicy, { group: 'mention_only' });
  assert.equal('intakePolicy' in config, false);
  assert.equal('groupReplyPolicy' in config, false);
  assert.equal('processingReaction' in config, false);
  assert.equal('silentConfirmationText' in config, false);

  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test' }));
  const defaults = await loadConfig(configPath);
  assert.equal(defaults.accessPolicy.mode, 'all');
  assert.deepEqual(defaults.responsePolicy, { group: 'mention_only' });
  await check('omitting the group setting rejects ordinary group messages', {}, [], {});
  await check('omitting the group setting admits explicit Bot mentions', { mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit'], {});
  await check('omitting the group setting still admits private messages', { chatType: 'p2p', chatMode: 'private' }, ['reaction', 'submit'], {});

  for (const legacyKey of ['intakePolicy', 'groupReplyPolicy', 'processingReaction', 'silentConfirmationText']) {
    await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', [legacyKey]: {} }));
    await assert.rejects(loadConfig(configPath), new RegExp(legacyKey));
  }
  const { findFeishuThreadSessionBinding, recordFeishuThreadSessionBinding,
    recordFeishuMessageSession } = await import('../connectors/feishu/session-flow.mjs');
  runtime.storagePaths.messageIndexPath = join(testHome, 'bot-1', 'message-index.json');
  const thread = { threadId: 'thread-1', tenantKey: 'tenant-1' };
  await check('an unjoined thread stays silent', thread, []);
  await check('another mention cannot activate a thread', { ...thread, mentions: [{ openId: 'human' }] }, []);
  await check('@all cannot activate a thread', { ...thread, mentions: [{ openId: 'all' }] }, []);
  await check('explicit mention joins a thread', { ...thread, mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  assert.equal((await findFeishuThreadSessionBinding(runtime, { ...base, ...thread })).sessionId, 'routing-session');
  await check('thread replies need no further mention', thread, ['reaction', 'submit']);
  await check('another human may continue the same thread', {
    ...thread, sender: { senderType: 'user', openId: 'another-human' },
  }, ['reaction', 'submit']);
  await check('the rest of the group stays silent after activation', {}, []);
  await check('sibling threads stay silent', { ...thread, threadId: 'thread-2' }, []);
  await check('thread IDs cannot cross groups', { ...thread, chatId: 'group-2' }, []);
  await check('thread IDs cannot cross tenants', { ...thread, tenantKey: 'tenant-2' }, []);
  await check('topic ID alias can continue a joined thread', {
    tenantKey: thread.tenantKey, topicId: thread.threadId,
  }, ['reaction', 'submit']);
  await check('an unmentioned app cannot loop in a joined thread', {
    ...thread, sender: { senderType: 'app', openId: 'other-bot' },
  }, []);
  await check('self messages do not continue a joined thread', {
    ...thread, sender: { senderType: 'app', openId: 'bot-self' },
  }, []);

  effects = [];
  const restartedRuntime = {
    config: structuredClone(runtime.config), botIdentity: structuredClone(runtime.botIdentity),
    storagePaths: { ...runtime.storagePaths },
  };
  await handleMessage(restartedRuntime, { ...base, ...thread }, 'test', helpers);
  assert.deepEqual(effects, ['reaction', 'submit'], 'participation survives a fresh runtime');
  const firstBotIndex = runtime.storagePaths.messageIndexPath;
  runtime.storagePaths.messageIndexPath = join(testHome, 'bot-2', 'message-index.json');
  await check('another Bot does not inherit participation', thread, []);
  runtime.storagePaths.messageIndexPath = firstBotIndex;

  await recordFeishuMessageSession(runtime, base, 'old-group-session');
  await check('a group session does not activate unrelated threads', { threadId: 'unjoined' }, []);
  await check('a quoted group reply without thread identity stays silent', {
    rootId: base.messageId, parentId: base.messageId,
  }, []);
  await check('a topic root may invite the Bot before a thread ID exists', {
    chatMode: 'topic', messageId: 'topic-root', mentions: [{ openId: 'bot-self' }],
  }, ['reaction', 'submit']);
  await check('native topic replies can identify the joined topic by root ID', {
    chatMode: 'topic', messageId: 'topic-reply', rootId: 'topic-root',
  }, ['reaction', 'submit']);
  await check('a different topic root stays silent', {
    chatMode: 'topic', messageId: 'other-topic-reply', rootId: 'other-topic-root',
  }, []);

  // Sending a reply may assign a new Feishu thread ID to an admitted group root.
  await recordFeishuThreadSessionBinding(runtime, base, 'outbound-session', { threadId: 'created-by-reply' });
  await check('a thread created by the Bot reply can be continued', {
    threadId: 'created-by-reply',
  }, ['reaction', 'submit']);

  effects = [];
  await assert.rejects(handleMessage(runtime, {
    ...base, threadId: 'failed-admission', mentions: [{ openId: 'bot-self' }],
  }, 'test', {
    ...helpers, submitRemoteLabRequest: async () => { throw new Error('submission failed'); },
  }), /submission failed/);
  await check('failed submission does not activate a thread', { threadId: 'failed-admission' }, []);

  console.log('Feishu access, response, durable thread continuation and processing acknowledgement tests passed');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

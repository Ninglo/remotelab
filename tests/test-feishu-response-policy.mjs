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
  await check('ordinary group chatter reaches the Session for reply judgment', {}, ['submit']);
  await check('another human mention is context for the Session, not an intake filter', { mentions: [{ openId: 'human' }] }, ['submit']);
  await check('this Bot mention is admitted and acknowledged', { mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  await check('private chat always responds immediately', { chatType: 'p2p', chatMode: 'private' }, ['reaction', 'submit']);
  await check('all group mode admits every message', {}, ['reaction', 'submit'], { group: 'all' });
  await check('chat-mode topic groups admit plain text by default', {
    chatMode: 'topic', messageId: 'topic-default-root',
  }, ['reaction', 'submit']);
  await check('thread-type topic groups admit plain text by default', {
    groupMessageType: 'thread', messageId: 'thread-type-default-root',
  }, ['reaction', 'submit']);
  await check('first human reply in an ordinary group Thread needs no invitation', {
    threadId: 'ordinary-group-thread',
  }, ['reaction', 'submit']);
  await check('topic ID alone admits the first human reply', {
    topicId: 'script-created-topic', messageText: '目前有完成的对局吗',
  }, ['reaction', 'submit']);
  await check('normalized Thread identity needs no mention', {
    conversationKind: 'thread', rootId: 'script-root',
  }, ['reaction', 'submit']);
  await check('normalized topic identity needs no mention', {
    conversationKind: 'topic', rootId: 'topic-root',
  }, ['reaction', 'submit']);

  runtime.config.groups = { 'group-1': { responseMode: 'all', systemPrompt: 'Group instructions' } };
  await check('group override admits plain text without a file or mention', {}, ['reaction', 'submit']);
  await check('other groups also receive the Session fallback', { chatId: 'group-2' }, ['submit']);
  await check('self remains excluded under group override', { sender: { senderType: 'app', openId: 'bot-self' } }, []);
  runtime.config.groups = { 'group-1': { responseMode: 'mention_only' } };
  await check('legacy mention-only override now uses Session judgment', {}, ['submit'], { group: 'all' });
  await check('mainline mention override cannot narrow native topics', {
    chatMode: 'topic', groupMessageType: 'thread', messageId: 'topic-explicit-mention-root',
  }, ['reaction', 'submit']);
  await check('mainline mention override cannot narrow ordinary group Threads', {
    threadId: 'report-thread',
  }, ['reaction', 'submit']);
  delete runtime.config.groups;

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

  const { resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', systemPrompt: 'Global instructions',
    replyPolicy: { group: 'inline', private: 'inline', chats: { 'group-1': 'inline' } },
    groups: { 'group-1': { responseMode: 'all', replyMode: 'thread', systemPrompt: 'Group instructions' } },
  }));
  const groupConfig = await loadConfig(configPath);
  const mainlineSettings = resolveFeishuGroupSettings(groupConfig, base);
  assert.equal(mainlineSettings.responseMode, 'all');
  assert.equal(mainlineSettings.replyMode, 'thread');
  assert.match(mainlineSettings.systemPrompt, /Global instructions\n\nGroup instructions/);
  assert.match(mainlineSettings.systemPrompt, /A concrete unanswered question or request needs a reply/);
  assert.equal(resolveFeishuGroupSettings(groupConfig, { chatId: 'other' }).systemPrompt, 'Global instructions');
  const topicDefaults = resolveFeishuGroupSettings(groupConfig, {
    ...base, chatId: 'topic-chat', chatMode: 'topic', threadId: 'topic-1',
  });
  assert.equal(topicDefaults.responseMode, 'all');
  assert.match(topicDefaults.systemPrompt, /Reply to each human message in the current topic/);
  for (const topicIdentity of [{ threadId: 'report-thread' }, { topicId: 'report-topic' },
    { conversationKind: 'thread' }, { chatMode: 'topic', rootId: 'native-root' }]) {
    const topicSettings = resolveFeishuGroupSettings({
      groups: { 'group-1': { responseMode: 'mention_only', participationMode: 'ambient', quickReactions: true } },
    }, { ...base, ...topicIdentity });
    assert.equal(topicSettings.responseMode, 'all');
    assert.match(topicSettings.systemPrompt, /By default, the human is speaking to you/);
    assert.match(topicSettings.systemPrompt, /Reply to each human message in the current topic/);
    assert.equal(topicSettings.participationMode, undefined);
    assert.equal(topicSettings.quickReactions, undefined, 'topic replies cannot become reaction-only ambient turns');
  }
  for (const groups of [{ 'group-1': { fileOnly: true } }, { 'group-1': { responseMode: 'typo' } }, { 'group-1': { systemPrompt: 123 } }]) {
    await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', groups }));
    await assert.rejects(loadConfig(configPath), /group|Group/);
  }
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test' }));
  const defaults = await loadConfig(configPath);
  assert.equal(defaults.accessPolicy.mode, 'all');
  assert.deepEqual(defaults.responsePolicy, { group: 'mention_only' });
  await check('omitting the group setting still forwards ordinary group messages', {}, ['submit'], {});
  await check('omitting the group setting admits explicit Bot mentions', { mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit'], {});
  await check('omitting the group setting still admits private messages', { chatType: 'p2p', chatMode: 'private' }, ['reaction', 'submit'], {});

  for (const legacyKey of ['intakePolicy', 'groupReplyPolicy', 'sessionPolicy', 'processingReaction', 'silentConfirmationText']) {
    await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', [legacyKey]: {} }));
    await assert.rejects(loadConfig(configPath), new RegExp(legacyKey));
  }
  const { findFeishuThreadSessionBinding, recordFeishuThreadSessionBinding,
    recordFeishuMessageSession } = await import('../connectors/feishu/session-flow.mjs');
  runtime.storagePaths.messageIndexPath = join(testHome, 'bot-1', 'message-index.json');
  const thread = { threadId: 'thread-1', tenantKey: 'tenant-1' };
  await check('an unjoined thread admits its first human message', thread, ['reaction', 'submit']);
  await check('another human mention does not block a topic reply', { ...thread, mentions: [{ openId: 'human' }] }, ['reaction', 'submit']);
  await check('@all does not block a topic reply', { ...thread, mentions: [{ openId: 'all' }] }, ['reaction', 'submit']);
  await check('explicit mention joins a thread', { ...thread, mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  assert.equal((await findFeishuThreadSessionBinding(runtime, { ...base, ...thread })).sessionId, 'routing-session');
  await check('thread replies need no further mention', thread, ['reaction', 'submit']);
  await check('another human may continue the same thread', {
    ...thread, sender: { senderType: 'user', openId: 'another-human' },
  }, ['reaction', 'submit']);
  await check('the group mainline also reaches its own Session', {}, ['submit']);
  for (const [label, identity] of [
    ['sibling thread', { ...thread, threadId: 'thread-2' }],
    ['same thread ID in another group', { ...thread, chatId: 'group-2' }],
    ['same thread ID in another tenant', { ...thread, tenantKey: 'tenant-2' }],
  ]) {
    assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, ...identity }), null,
      `${label} must not inherit a binding`);
    await check(`${label} can start its own conversation`, identity, ['reaction', 'submit']);
  }
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
  assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, ...thread }), null,
    'another Bot does not inherit the existing Session binding');
  await check('another Bot accepts human topic messages independently', thread, ['reaction', 'submit']);
  runtime.storagePaths.messageIndexPath = firstBotIndex;

  await recordFeishuMessageSession(runtime, base, 'old-group-session');
  assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, threadId: 'unjoined' }), null,
    'a group Session is not the unrelated Thread Session');
  await check('unrelated threads admit messages without a group Session invitation', { threadId: 'unjoined' }, ['reaction', 'submit']);
  await check('a group quote without topic identity remains a mainline observation', {
    rootId: base.messageId, parentId: base.messageId,
  }, ['submit']);
  await check('a topic root may invite the Bot before a thread ID exists', {
    chatMode: 'topic', messageId: 'topic-root', mentions: [{ openId: 'bot-self' }],
  }, ['reaction', 'submit']);
  await check('native topic replies can identify the joined topic by root ID', {
    chatMode: 'topic', messageId: 'topic-reply', rootId: 'topic-root',
  }, ['reaction', 'submit']);
  await check('a different native topic is admitted by the topic-group default', {
    chatMode: 'topic', messageId: 'other-topic-reply', rootId: 'other-topic-root',
  }, ['reaction', 'submit']);

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
  assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, threadId: 'failed-admission' }), null,
    'failed submission must not leave a Session binding');
  await check('next topic message can recover after failed submission without an @', {
    threadId: 'failed-admission',
  }, ['reaction', 'submit']);

  console.log('Feishu access, response, durable thread continuation and processing acknowledgement tests passed');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

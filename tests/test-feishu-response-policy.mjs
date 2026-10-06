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
  await check('ordinary group chatter does not trigger an unconfigured Bot', {}, []);
  await check('mentioning another human cannot enable proactive intake', { mentions: [{ openId: 'human' }] }, []);
  await check('@all cannot enable proactive intake', { mentions: [{ openId: 'all' }] }, []);
  await check('attachments cannot enable proactive intake', { messageType: 'file' }, []);
  await check('merge-forwards cannot enable proactive intake', { messageType: 'merge_forward' }, []);
  await check('this Bot mention is admitted and acknowledged', { mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  await check('private chat always responds immediately', { chatType: 'p2p', chatMode: 'private' }, ['reaction', 'submit']);
  await check('connector-wide all mode cannot opt in ordinary groups', {}, [], { group: 'all' });
  await check('partial group metadata cannot inherit connector-wide all mode', {
    chatType: '', chatMode: '', groupMessageType: 'group',
  }, [], { group: 'all' });
  await check('new topic groups require an explicit invitation', {
    chatMode: 'topic', messageId: 'topic-default-root',
  }, []);
  await check('thread-type groups default to passive reception', {
    groupMessageType: 'thread', messageId: 'thread-type-default-root',
  }, []);
  await check('an uninvited ordinary-group Thread stays passive', {
    threadId: 'ordinary-group-thread',
  }, []);
  await check('topic ID alone cannot invite the first human reply', {
    topicId: 'script-created-topic', messageText: '目前有完成的对局吗',
  }, []);
  await check('normalized Thread identity alone cannot activate reception', {
    conversationKind: 'thread', rootId: 'script-root',
  }, []);
  await check('normalized topic identity alone cannot activate reception', {
    conversationKind: 'topic', rootId: 'topic-root',
  }, []);

  await check('missing chat metadata cannot activate an uninvited topic', {
    chatType: '', chatMode: '', groupMessageType: '', topicId: 'new-topic-without-metadata',
  }, []);

  runtime.config.groups = { 'group-1': { responseMode: 'all', systemPrompt: 'Group instructions' } };
  await check('group override admits plain text without a file or mention', {}, ['reaction', 'submit']);
  await check('a group opt-in does not spread to other groups', { chatId: 'group-2' }, []);
  await check('self remains excluded under group override', { sender: { senderType: 'app', openId: 'bot-self' } }, []);
  runtime.config.groups = { 'group-1': { responseMode: 'mention_only' } };
  await check('explicit mention-only override blocks ordinary chatter', {}, [], { group: 'all' });
  await check('mention-only native topics require an invitation', {
    chatMode: 'topic', groupMessageType: 'thread', messageId: 'topic-explicit-mention-root',
  }, []);
  await check('mention-only unjoined Threads require an invitation', {
    threadId: 'report-thread',
  }, []);
  delete runtime.config.groups;

  runtime.config.groups = { 'group-1': { participationMode: 'ambient' } };
  await check('ambient opt-in also allows new topics in that exact group', { threadId: 'ambient-new-thread' }, ['reaction', 'submit']);
  await check('explicit ambient opt-in admits ordinary chatter', {}, ['submit']);
  await check('ambient opt-in does not spread through connector-wide all mode', { chatId: 'group-2' }, [], { group: 'all' });
  runtime.config.groups = { 'group-1': { quickReactions: true } };
  await check('a reaction preference cannot opt in proactive participation', {}, []);
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
  assert.equal(topicDefaults.responseMode, 'mention_only');
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
  await check('omitting the group setting blocks ordinary group messages', {}, [], {});
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
  await check('an unjoined thread requires an invitation', thread, []);
  await check('another human mention cannot invite this Bot into an unjoined topic', { ...thread, mentions: [{ openId: 'human' }] }, []);
  await check('@all cannot invite this Bot into an unjoined topic', { ...thread, mentions: [{ openId: 'all' }] }, []);
  await check('explicit mention joins a thread', { ...thread, mentions: [{ openId: 'bot-self' }] }, ['reaction', 'submit']);
  assert.equal((await findFeishuThreadSessionBinding(runtime, { ...base, ...thread })).sessionId, 'routing-session');
  await check('thread replies need no further mention', thread, ['reaction', 'submit']);
  await check('another human may continue the same thread', {
    ...thread, sender: { senderType: 'user', openId: 'another-human' },
  }, ['reaction', 'submit']);
  await check('a joined topic does not activate the group mainline', {}, []);
  for (const [label, identity] of [
    ['sibling thread', { ...thread, threadId: 'thread-2' }],
    ['same thread ID in another group', { ...thread, chatId: 'group-2' }],
    ['same thread ID in another tenant', { ...thread, tenantKey: 'tenant-2' }],
  ]) {
    assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, ...identity }), null,
      `${label} must not inherit a binding`);
    await check(`${label} cannot inherit another conversation's invitation`, identity, []);
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
  await check('another Bot needs its own invitation into the topic', thread, []);
  runtime.storagePaths.messageIndexPath = firstBotIndex;

  await recordFeishuMessageSession(runtime, base, 'old-group-session');
  assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, threadId: 'unjoined' }), null,
    'a group Session is not the unrelated Thread Session');
  await check('a group Session cannot invite unrelated Threads', { threadId: 'unjoined' }, []);
  await check('a group quote without topic identity cannot activate proactive intake', {
    rootId: base.messageId, parentId: base.messageId,
  }, []);
  await check('a topic root may invite the Bot before a thread ID exists', {
    chatMode: 'topic', messageId: 'topic-root', mentions: [{ openId: 'bot-self' }],
  }, ['reaction', 'submit']);
  await check('native topic replies can identify the joined topic by root ID', {
    chatMode: 'topic', messageId: 'topic-reply', rootId: 'topic-root',
  }, ['reaction', 'submit']);
  await check('a different native topic stays passive', {
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
  assert.equal(await findFeishuThreadSessionBinding(runtime, { ...base, threadId: 'failed-admission' }), null,
    'failed submission must not leave a Session binding');
  await check('failed submission does not activate subsequent unmentioned topic messages', {
    threadId: 'failed-admission',
  }, []);

  console.log('Feishu access, response, durable thread continuation and processing acknowledgement tests passed');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

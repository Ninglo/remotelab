#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'feishu-group-routing-'));
setIsolatedTestHome(testHome);
const { handleMessage, loadConfig } = await import('../scripts/feishu-connector.mjs');
const base = {
  messageId: 'routing-test', chatId: 'target-group', chatType: 'group',
  chatMode: 'group', messageType: 'text', messageText: 'hello', mentions: [],
  sender: { senderType: 'user' },
};
const policy = { mode: 'all', chatModes: { 'target-group': 'mention_only' } };
let effects = [];
const runtime = {
  config: { groupReplyPolicy: policy },
  botIdentity: { openId: 'bot-self', unionId: 'bot-union' },
  processingMessageIds: new Set(), storagePaths: {},
};
const helpers = {
  wasMessageHandled: async () => { effects.push('dedupe'); return false; },
  addProcessingReaction: async () => { effects.push('reaction'); return null; },
  generateRemoteLabReply: async () => { effects.push('generate'); return { replyText: 'ok' }; },
  sendFeishuText: async () => { effects.push('send'); return { message_id: 'reply-test' }; },
  markMessageHandled: async () => { effects.push('mark'); },
};
async function check(label, changes, expected, routePolicy = policy) {
  effects = [];
  runtime.config.groupReplyPolicy = routePolicy;
  await handleMessage(runtime, { ...base, ...changes }, 'test', helpers);
  assert.equal(effects.includes('generate'), expected, label);
  if (!expected) assert.deepEqual(effects, [], `${label}: must stop before all processing side effects`);
}
try {
  await check('ordinary group chatter must not trigger AI', {}, false);
  await check('mentioning another person must not trigger AI', { mentions: [{ openId: 'human' }] }, false);
  await check('mentioning another bot must not trigger AI', { mentions: [{ openId: 'bot-other' }] }, false);
  await check('mentioning this bot must trigger AI', { mentions: [{ openId: 'bot-self' }] }, true);
  await check('union ID mentions work', { mentions: [{ unionId: 'bot-union' }] }, true);
  await check('existing thread is not permission to trigger', { threadId: 'old-thread', rootId: 'old-bot-reply', parentId: 'old-bot-reply' }, false);
  await check('topic groups obey mention policy', { chatType: 'topic', chatMode: 'topic', threadId: 'topic' }, false);
  await check('group commands require mention too', { messageText: '/fork some task' }, false);
  await check('stale replay mentionedBot flags cannot bypass identity matching', { mentionedBot: true }, false);
  await check('private chats continue normally', { chatType: 'p2p', chatMode: 'private' }, true);
  await check('other groups retain current behavior', { chatId: 'other-group' }, true);
  await check('explicit all mode allows chatter', {}, true, { mode: 'all' });
  await check('connector-wide mention mode works', {}, false, { mode: 'mention_only' });
  await check('unconfigured connectors keep current behavior', {}, true, null);
  const savedIdentity = runtime.botIdentity;
  runtime.botIdentity = null;
  await check('missing bot identity fails closed', { mentions: [{ openId: 'bot-self' }] }, false);
  runtime.botIdentity = savedIdentity;
  const configPath = join(testHome, 'config.json');
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', groupReplyPolicy: policy }));
  assert.deepEqual((await loadConfig(configPath)).groupReplyPolicy, policy);
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', groupReplyPolicy: { mode: 'typo' } }));
  await assert.rejects(loadConfig(configPath), /groupReplyPolicy/);
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', groupReplyPolicy: { chatModes: { 'target-group': 'typo' } } }));
  await assert.rejects(loadConfig(configPath), /groupReplyPolicy/);
  console.log('Feishu group routing tests passed');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

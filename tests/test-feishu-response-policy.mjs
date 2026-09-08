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
  assert.deepEqual(defaults.responsePolicy, { group: 'all' });

  for (const legacyKey of ['intakePolicy', 'groupReplyPolicy', 'processingReaction', 'silentConfirmationText']) {
    await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', [legacyKey]: {} }));
    await assert.rejects(loadConfig(configPath), new RegExp(legacyKey));
  }
  console.log('Feishu access, response and processing acknowledgement tests passed');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

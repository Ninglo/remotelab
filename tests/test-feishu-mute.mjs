import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-mute-'));
setIsolatedTestHome(home);
try {
  const { handleMessage, extractLocalCommand, recordFeishuThreadSessionBinding } = await import('../scripts/feishu-connector.mjs');
  const { getFeishuConversationSettings } = await import('../connectors/feishu/conversation-settings.mjs');
  const { shouldRouteFeishuMessageToRemoteLab } = await import('../connectors/feishu/response-policy.mjs');
  const makeRuntime = () => ({
    config: { storageDir: home, sourceRouteId: 'bot-1', responsePolicy: { group: 'all' } },
    storagePaths: { messageIndexPath: join(home, 'index.json') },
    botIdentity: { openId: 'self' },
  });
  let runtime = makeRuntime();
  const base = { chatType: 'group', chatId: 'chat', threadId: 'thread', tenantKey: 'tenant',
    messageType: 'text', sender: { senderType: 'user', openId: 'human' }, mentions: [] };
  const effects = [];
  const replies = [];
  const helpers = {
    addProcessingReaction: async () => effects.push('reaction'),
    submitRemoteLabRequest: async () => { effects.push('submit'); return { sessionId: 's1' }; },
    queueFeishuReply: async (_runtime, _summary, text) => { replies.push(text); return { message_id: 'reply' }; },
    resolveFeishuRuntimeSelection: async () => ({ mode: 'ui', tool: 'codex', model: 'alpha', effort: 'low' }),
    requestRemoteLab: async path => {
      const json = path === '/api/sessions/s1' ? { session: { id: 's1' } }
        : { defaultModel: 'alpha', models: [{ id: 'alpha' }] };
      return { response: { ok: true }, json };
    },
  };
  let seq = 0;
  const send = (text, patch = {}, overrides = {}) => handleMessage(runtime,
    { ...base, messageId: `m${++seq}`, messageText: text, ...patch }, 'test', { ...helpers, ...overrides });
  const silent = async (text, patch = {}) => {
    effects.length = 0;
    const replyCount = replies.length;
    const result = await send(text, patch);
    assert.equal(result.ignored, true);
    assert.deepEqual(effects, [], 'muted input causes no reaction, session creation or model submission');
    assert.equal(replies.length, replyCount, 'muted chatter gets no automatic reply');
  };
  assert.deepEqual(extractLocalCommand({ ...base, messageText: '@_user_1 /mute' }), { type: 'mute', text: '' });
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, false);
  await recordFeishuThreadSessionBinding(runtime, base, 's1');
  const otherBotCommand = await send('@_user_1 /mute', { mentions: [{ openId: 'other-bot' }] });
  assert.equal(otherBotCommand.ignored, true, 'a command addressed to another recipient must not mute this joined Bot');
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, false);
  await send('/mute');
  assert.deepEqual(effects, [], '/mute is a local command, not an AI task');
  assert.match(replies.at(-1), /已静默当前话题/);
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, true);
  assert.equal(await shouldRouteFeishuMessageToRemoteLab(runtime, base), false);
  await silent('human discussion');
  await silent('attachment discussion', { messageType: 'file', attachments: [{ fileKey: 'file' }] });
  await silent('mention someone else', { mentions: [{ openId: 'another-human' }] });
  await silent('@all', { mentions: [{ openId: 'all' }] });
  await send('please help once', { mentions: [{ openId: 'self' }] });
  assert.deepEqual(effects, ['reaction', 'submit']);
  await silent('continue human discussion');
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, true);
  await send('/status');
  assert.match(replies.at(-1), /静默：开启/);
  await send('/help');
  assert.match(replies.at(-1), /\/unmute/);
  await send('/mute unexpected');
  assert.equal(replies.at(-1), '用法：/mute');
  await send('/fork explicit task');
  assert.deepEqual(effects, ['reaction', 'submit'], 'explicit task commands remain available');
  effects.length = 0;

  runtime = makeRuntime();
  await silent('still muted after restart');
  assert.equal((await getFeishuConversationSettings(runtime, { ...base, threadId: '', topicId: 'thread' })).muted, true);
  for (const patch of [{ threadId: 'sibling' }, { chatId: 'other-chat' }, { tenantKey: 'other-tenant' }]) {
    assert.equal((await getFeishuConversationSettings(runtime, { ...base, ...patch })).muted, false);
  }
  runtime.config.sourceRouteId = 'bot-2';
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, false);
  runtime.config.sourceRouteId = 'bot-1';
  await silent('/unmute', { mentions: [{ openId: 'self' }], sender: { senderType: 'app', openId: 'peer' } });
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, true, 'peer bots cannot unmute');
  await send('explicit peer handoff', { mentions: [{ openId: 'self' }], sender: { senderType: 'app', openId: 'peer' } });
  assert.deepEqual(effects, ['reaction', 'submit']);
  await silent('second peer handoff', { mentions: [{ openId: 'self' }], sender: { senderType: 'app', openId: 'peer' } });
  await send('/unmute');
  assert.match(replies.at(-1), /已恢复当前话题/);
  assert.equal((await getFeishuConversationSettings(runtime, base)).muted, false);
  await send('automatic continuation restored');
  assert.deepEqual(effects, ['reaction', 'submit']);

  // A command remains recoverable when its acknowledgement fails after the save.
  await assert.rejects(send('/mute', {}, { queueFeishuReply: async () => { throw new Error('reply failed'); } }), /reply failed/);
  runtime = makeRuntime();
  await silent('no AI after acknowledgement failure');
  await send('/unmute');
  const privateChat = { chatType: 'p2p', chatId: 'private', threadId: '' };
  await send('/mute', privateChat);
  await silent('private chatter', privateChat);
  await send('/unmute', privateChat);
  assert.equal((await getFeishuConversationSettings(runtime, { ...base, ...privateChat })).muted, false);
  console.log('test-feishu-mute: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

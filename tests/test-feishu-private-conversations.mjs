import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-new-conversation-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remote.example';
try {
  const { createSession, getSession } = await import('../chat/session-manager.mjs');
  const { startFeishuPrivateConversation: start, filterPrivateConversationContext: filter } = await import('../connectors/feishu/private-conversations.mjs');
  const { extractLocalCommand, handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { loadFeishuConversationContext: context } = await import('../connectors/feishu/conversation-context.mjs');
  const { appendEvent, getHistoryHeadSeq } = await import('../chat/history.mjs');
  const { findSessionConversation } = await import('../chat/session-conversations.mjs');
  await mkdir(join(home, 'work'));
  const runtime = { config: { sourceRouteId: 'bot-2', sessionFolder: join(home, 'work') } };
  const summary = { chatId: 'oc_private', tenantKey: 'tenant', chatType: 'p2p', messageId: 'om_new1',
    messageText: '开启新对话', createTime: '1792485000000', sender: { openId: 'ou_human' } };
  for (const text of ['开启新对话', '新对话', '/new', 'New conversation']) {
    assert.equal(extractLocalCommand({ ...summary, messageText: text }).commands[0].name, 'new');
  }
  assert.equal(extractLocalCommand({ ...summary, messageText: '所有私聊是否都要开启新对话？' }), null,
    'a discussion of the feature is never a command');
  const conversation = { connector: 'feishu', sourceRouteId: 'bot-2', target: {
    chatId: summary.chatId, tenantKey: summary.tenantKey, chatType: 'p2p', conversationKind: 'main',
  } };
  const old = await createSession(runtime.config.sessionFolder, 'codex', 'Old work', { conversation });
  await appendEvent(old.id, { type: 'message', role: 'user', content: 'OLD_PRIVATE_CONTEXT' });
  const request = async (path, options) => {
    assert.equal(path, '/api/sessions');
    const { folder, tool, name, ...extra } = options.body;
    return { response: { ok: true }, json: { session: await createSession(folder, tool, name, extra) } };
  };
  const deps = { request, resolveDefault: async () => ({ tool: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }) };
  const fresh = await start(runtime, summary, deps);
  assert.notEqual(fresh.sessionId, old.id);
  assert.equal((await getSession(old.id)).conversation, null);
  assert.equal(await getHistoryHeadSeq(old.id), 1, 'old evidence remains intact');
  assert.equal(await getHistoryHeadSeq(fresh.sessionId), 0, 'new provider work receives no old transcript');
  const freshSession = await getSession(fresh.sessionId);
  assert.match(fresh.text, /模型：gpt-6\.1-sol · 思考强度：xhigh · 执行工具：codex/);
  assert.ok(fresh.text.includes(`https://remote.example/?session=${fresh.sessionId}&tab=sessions`),
    'creation receipt contains the new Session link before the first question');
  assert.deepEqual(freshSession.privateConversationStart, { messageId: summary.messageId, at: 1792485000000 });
  assert.equal((await start(runtime, summary, deps)).sessionId, fresh.sessionId, 'duplicate command is idempotent');
  const changedDefaults = await start(runtime, summary, { ...deps,
    resolveDefault: async () => ({ tool: 'codex', model: 'gpt-6-astra', effort: 'high' }),
  });
  assert.equal(changedDefaults.text, fresh.text, 'retry describes the stored Session, not newer defaults');
  const newer = await start(runtime, { ...summary, messageId: 'om_new2', createTime: '1792485002000' }, deps);
  const replay = await start(runtime, summary, deps);
  assert.equal(replay.superseded, true);
  assert.equal((await findSessionConversation(conversation)).id, newer.sessionId, 'old retries cannot reclaim the chat');
  let called = false;
  assert.equal((await start(runtime, { ...summary, chatType: 'group' }, { request: () => { called = true; } })).created, false);
  assert.equal(called, false, 'group input does not rotate any conversation');
  await assert.rejects(createSession(runtime.config.sessionFolder, 'codex', 'Bad boundary', {
    conversation: { ...conversation, target: { ...conversation.target, chatType: 'group' } },
    privateConversationStart: freshSession.privateConversationStart,
  }), /Invalid private conversation boundary/);
  let params;
  const loaded = await context({ config: { sourceRouteId: 'bot-2' }, appClient: { im: { v1: { message: { list: async input => {
    params = input.params;
    return { code: 0, data: { has_more: false, items: [
      { message_id: 'om_old', create_time: '1792484999000', msg_type: 'text', body: { content: JSON.stringify({ text: 'OLD_PRIVATE_CONTEXT' }) } },
      { message_id: 'om_after', create_time: '1792485001000', msg_type: 'text', body: { content: JSON.stringify({ text: 'NEW_INPUT' }) } },
    ] } };
  } } } } } }, { ...summary, messageId: 'om_current', createTime: '1792485003000' }, {
    complete: true, includeMetadata: true, sinceTimeMs: freshSession.privateConversationStart.at,
    sinceMessageId: freshSession.privateConversationStart.messageId,
  });
  assert.equal(params.start_time, '1792485000');
  assert.deepEqual(loaded.messages.map(m => m.text), ['NEW_INPUT'], 'provider backfill respects the new context boundary');
  const filtered = await filter({ storagePaths: { messageIndexPath: 'fixture' } }, summary, freshSession, {
    messages: [{ messageId: 'old-finish', senderType: 'app', text: 'OLD_RESULT' },
      { messageId: 'new-answer', senderType: 'app', text: 'NEW_RESULT' },
      { messageId: 'human', senderType: 'user', text: 'NEW_QUESTION' }],
  }, { lookup: async (_path, key) => ({ sessionId: key.messageId === 'old-finish' ? old.id : freshSession.id }) });
  assert.deepEqual(filtered.messages.map(m => m.text), ['NEW_RESULT', 'NEW_QUESTION'],
    'a late old-task result is delivered but does not contaminate the new model context');
  const replies = [];
  await handleMessage(runtime, { ...summary, messageId: 'om_menu', messageType: 'text',
    messageText: '新对话', createTime: '1792485004000' }, 'test', {
    enrichSummaryWithChatMetadata: async (_runtime, incoming) => incoming,
    requestRemoteLab: request,
    resolveFeishuRuntimeSelection: deps.resolveDefault,
    queueFeishuReply: async (_runtime, incoming, text) => {
      replies.push({ incoming, text });
      return { deliveryId: 'new-conversation-receipt' };
    },
    submitRemoteLabRequest: async () => { assert.fail('new conversation must not wait for a model turn'); },
  });
  const menuSession = await findSessionConversation(conversation);
  assert.equal(replies.length, 1, 'one menu click queues one complete receipt');
  assert.equal(replies[0].incoming.chatId, summary.chatId);
  assert.match(replies[0].text, /模型：gpt-6\.1-sol · 思考强度：xhigh · 执行工具：codex/);
  assert.ok(replies[0].text.includes(`https://remote.example/?session=${menuSession.id}&tab=sessions`));
  assert.equal(await getHistoryHeadSeq(menuSession.id), 0, 'receipt does not require a question or model run');
  console.log('PRIVATE_CONVERSATIONS_VERIFIED: immediate menu receipt with saved runtime and new link, no model turn, fresh history, retained old work, atomic binding, idempotent replay, provider boundary, late old replies and group isolation');
} finally { await rm(home, { recursive: true, force: true }); }

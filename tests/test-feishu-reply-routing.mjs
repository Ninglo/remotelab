#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sameConversation } from '../lib/conversation-target.mjs';
import { normalizeFeishuReplyPolicy, resolveFeishuReplyMode } from '../connectors/feishu/reply-policy.mjs';
import {
  applyFeishuReplyRouting,
  buildFeishuSessionConversationTarget,
  buildFeishuSessionExternalTriggerId,
} from '../connectors/feishu/reply-routing.mjs';
import { recordFeishuThreadSessionBinding } from '../connectors/feishu/session-flow.mjs';
import { handleMessage, submitRemoteLabRequest } from '../scripts/feishu-connector.mjs';

assert.deepEqual(normalizeFeishuReplyPolicy(), { group: 'thread', private: 'inline', chats: {} });
assert.deepEqual(normalizeFeishuReplyPolicy({ group: 'inline', private: 'thread', chats: { chat: 'thread' } }), {
  group: 'inline', private: 'thread', chats: { chat: 'thread' },
});
for (const invalid of [null, [], { group: 'fork' }, { private: 'continue' }, { chats: [] }, { chats: { chat: 'fork' } }]) {
  assert.throws(() => normalizeFeishuReplyPolicy(invalid), /replyPolicy/);
}
const policy = { replyPolicy: { group: 'thread', private: 'inline', chats: { inline_group: 'inline' } } };
assert.equal(resolveFeishuReplyMode(policy, { chatId: 'group', chatType: 'group' }), 'thread');
assert.equal(resolveFeishuReplyMode(policy, { chatId: 'inline_group', chatType: 'group' }), 'inline');
assert.equal(resolveFeishuReplyMode(policy, { chatId: 'dm', chatType: 'p2p' }), 'inline');

const mainSummary = applyFeishuReplyRouting(policy, {
  tenantKey: 'tenant', chatId: 'inline_group', chatType: 'group', messageId: 'main-1', messageText: 'main task',
});
assert.equal(mainSummary.conversationKind, 'main');
assert.equal(mainSummary.replyInThread, false);
assert.deepEqual(buildFeishuSessionConversationTarget(mainSummary), {
  chatId: 'inline_group', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main',
});
const threadSummary = applyFeishuReplyRouting(policy, {
  tenantKey: 'tenant', chatId: 'group', chatType: 'group', messageId: 'root-1', messageText: 'thread task',
});
assert.equal(threadSummary.conversationKind, 'thread');
assert.equal(threadSummary.startThread, true);
assert.equal(buildFeishuSessionConversationTarget(threadSummary).rootId, 'root-1');
assert.notEqual(
  buildFeishuSessionExternalTriggerId(threadSummary, 'bot'),
  buildFeishuSessionExternalTriggerId({ ...threadSummary, messageId: 'root-2', rootId: 'root-2' }, 'bot'),
  'separate root messages create separate Thread Sessions',
);
const existingThread = applyFeishuReplyRouting(policy, {
  tenantKey: 'tenant', chatId: 'group', chatType: 'group', messageId: 'reply-1', rootId: 'root-1', threadId: 'thread-1',
});
assert.equal(existingThread.conversationKind, 'thread');
assert.equal(existingThread.startThread, undefined, 'existing topology wins over the configured mainline mode');

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-reply-routing-'));
const sessions = [];
const submitted = [];
let nextSession = 1;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'POST' && req.url === '/api/session-conversations/resolve') {
    const found = sessions.find(session => sameConversation(session.conversation, body.conversation));
    return json(200, { sessionId: found?.id || null });
  }
  if (req.method === 'POST' && req.url === '/api/sessions') {
    const found = sessions.find(session => sameConversation(session.conversation, body.conversation));
    if (found) return json(200, { session: found });
    const session = { ...body, id: `session-${nextSession++}` };
    sessions.push(session);
    return json(201, { session });
  }
  const messageMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && messageMatch) {
    submitted.push({ sessionId: messageMatch[1], body });
    return json(202, { response: { id: body.requestId }, run: { id: `run-${submitted.length}` }, duplicate: false, queued: false });
  }
  const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionMatch) {
    const session = sessions.find(item => item.id === sessionMatch[1]);
    return session ? json(200, { session }) : json(404, { error: 'Not found' });
  }
  return json(404, { error: `Unhandled ${req.method} ${req.url}` });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

try {
  const runtime = {
    authCookie: 'session_token=test',
    config: {
      chatBaseUrl: `http://127.0.0.1:${server.address().port}`,
      sourceRouteId: 'bot', sessionFolder: tempDir, sessionTool: 'codex',
      runtimeSelectionMode: 'pinned', region: 'feishu-cn', responsePolicy: { group: 'all' },
      replyPolicy: normalizeFeishuReplyPolicy({ group: 'inline', private: 'inline' }), groups: {},
    },
    storagePaths: { messageIndexPath: join(tempDir, 'connector-message-index.json') },
  };
  const base = {
    tenantKey: 'tenant', chatId: 'chat', chatType: 'group', messageType: 'text',
    sender: { senderType: 'user', tenantKey: 'tenant' },
  };
  const firstMain = await submitRemoteLabRequest(runtime, { ...base, messageId: 'main-1', messageText: 'first' });
  const secondMain = await submitRemoteLabRequest(runtime, { ...base, messageId: 'main-2', messageText: 'second' });
  assert.equal(secondMain.sessionId, firstMain.sessionId, 'one mainline reuses one Session indefinitely');
  assert.equal(submitted.at(-1).body.sourceDelivery.target.messageId, 'main-2');
  assert.equal(submitted.at(-1).body.sourceDelivery.target.conversationKind, 'main');
  assert.equal(submitted.at(-1).body.sourceDelivery.target.replyInThread, undefined);

  runtime.config.replyPolicy = normalizeFeishuReplyPolicy({ group: 'thread', private: 'inline' });
  const firstThread = await submitRemoteLabRequest(runtime, { ...base, messageId: 'thread-root-1', messageText: 'new thread' });
  const secondThread = await submitRemoteLabRequest(runtime, { ...base, messageId: 'thread-root-2', messageText: 'another thread' });
  assert.notEqual(secondThread.sessionId, firstThread.sessionId);
  assert.equal(submitted.at(-1).body.sourceDelivery.target.replyInThread, true);
  assert.equal(submitted.at(-1).body.sourceDelivery.target.conversationKind, 'thread');

  await recordFeishuThreadSessionBinding(runtime, {
    ...base, messageId: 'thread-root-1', conversationKind: 'thread', replyInThread: true,
  }, firstThread.sessionId, { threadId: 'provider-thread-1' });
  const followup = await submitRemoteLabRequest(runtime, {
    ...base, messageId: 'thread-followup', rootId: 'thread-root-1', threadId: 'provider-thread-1', messageText: 'continue here',
  });
  assert.equal(followup.sessionId, firstThread.sessionId, 'an existing Thread always reuses its topology-bound Session');

  let commandReply = '';
  await handleMessage(runtime, {
    ...base, messageId: 'thread-command', rootId: 'thread-root-1', threadId: 'provider-thread-1',
    messageText: '/inline task', textPreview: '/inline task',
  }, 'test', {
    queueFeishuReply: async (_runtime, _summary, text) => { commandReply = text; return { queued: true }; },
  });
  assert.match(commandReply, /Thread 内的回复位置已经固定/);

  console.log('ok - explicit main/thread topology and inline/thread reply routing');
} finally {
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

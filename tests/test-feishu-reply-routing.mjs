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
  buildFeishuRequestDeliveryTarget,
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
const nestedThreadSummary = applyFeishuReplyRouting(policy, {
  tenantKey: 'tenant', chatId: 'group', chatType: 'group',
  messageId: 'reply-root', rootId: 'forward-message', parentId: 'forward-message',
  messageText: 'new thread from an inline reply',
});
assert.equal(nestedThreadSummary.startThread, true);
assert.equal(buildFeishuSessionConversationTarget(nestedThreadSummary).rootId, 'reply-root');
assert.equal(buildFeishuRequestDeliveryTarget(nestedThreadSummary).rootId, 'reply-root');
assert.match(buildFeishuSessionExternalTriggerId(nestedThreadSummary, 'bot'), /:reply-root$/);
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

  const inlineReplyThread = await submitRemoteLabRequest(runtime, {
    ...base, messageId: 'reply-root', rootId: 'thread-root-1', parentId: 'thread-root-1',
    messageText: 'start a thread from a reply',
  });
  assert.notEqual(inlineReplyThread.sessionId, firstThread.sessionId,
    'a new thread on a reply must not reuse the reply parent Session');
  assert.equal(sessions.find(item => item.id === inlineReplyThread.sessionId).conversation.target.rootId, 'reply-root');
  assert.equal(submitted.at(-1).body.sourceDelivery.target.rootId, 'reply-root');
  const inlineReplyFollowup = await submitRemoteLabRequest(runtime, {
    ...base, messageId: 'reply-followup', rootId: 'reply-root', parentId: 'reply-root',
    threadId: 'provider-reply-thread', messageText: 'continue the new thread',
  });
  assert.equal(inlineReplyFollowup.sessionId, inlineReplyThread.sessionId,
    'a follow-up with the provider thread ID reuses the Session started on the reply');

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
  assert.match(commandReply, /Thread 内不能切换为 inline/);

  let explicitThreadSummary = null;
  await handleMessage(runtime, {
    ...base, messageId: 'thread-command-explicit', rootId: 'thread-root-1', threadId: 'provider-thread-1',
    messageText: '/thread continue explicitly', textPreview: '/thread continue explicitly',
  }, 'test', {
    addProcessingReaction: async () => null,
    submitRemoteLabRequest: async (_runtime, summary) => {
      explicitThreadSummary = summary;
      return { sessionId: firstThread.sessionId };
    },
  });
  assert.equal(explicitThreadSummary.messageText, 'continue explicitly');
  assert.equal(explicitThreadSummary.conversationKind, 'thread', '/thread is idempotent inside an existing Thread');

  const topicRoot = {
    ...base, chatId: 'topic-chat', threadId: 'provider-topic-quick',
    messageId: 'topic-quick-root', messageText: '/quick fast answer', textPreview: '/quick fast answer',
  };
  const quickTopic = await handleMessage(runtime, topicRoot, 'test', { addProcessingReaction: async () => null });
  const quickTopicSession = sessions.find(session => session.id === quickTopic.sessionId);
  assert.equal(quickTopicSession.executionProfile, 'quick',
    'a new topic root may create a Quick Session even before chat metadata enrichment');
  assert.equal(quickTopicSession.conversation.target.conversationKind, 'thread');
  assert.equal(submitted.at(-1).body.text, 'fast answer');
  assert.equal(submitted.at(-1).body.sourceDelivery.target.threadId, 'provider-topic-quick');

  const quickTopicFollowup = await handleMessage(runtime, {
    ...topicRoot, messageId: 'topic-quick-followup', rootId: 'topic-quick-root',
    messageText: '/quick another fast answer', textPreview: '/quick another fast answer',
  }, 'test', { addProcessingReaction: async () => null });
  assert.equal(quickTopicFollowup.sessionId, quickTopic.sessionId,
    'an explicit /quick in an already-Quick topic remains on the bound Quick Session');

  commandReply = '';
  await handleMessage(runtime, {
    ...base, chatId: 'topic-inline-chat', chatMode: 'topic', threadId: 'provider-topic-inline',
    messageId: 'topic-inline-root', messageText: '/inline impossible', textPreview: '/inline impossible',
  }, 'test', {
    queueFeishuReply: async (_runtime, _summary, text) => { commandReply = text; return { queued: true }; },
  });
  assert.match(commandReply, /话题群只支持 Thread/);

  const standardTopicRoot = {
    ...base, chatId: 'topic-standard-chat', chatMode: 'topic', threadId: 'provider-topic-standard',
    messageId: 'topic-standard-root', messageText: 'standard task', textPreview: 'standard task',
  };
  const standardTopic = await handleMessage(runtime, standardTopicRoot, 'test', { addProcessingReaction: async () => null });
  assert.equal(sessions.find(session => session.id === standardTopic.sessionId).executionProfile, undefined);
  commandReply = '';
  await handleMessage(runtime, {
    ...standardTopicRoot, messageId: 'topic-standard-followup', rootId: 'topic-standard-root',
    messageText: '/quick switch profile', textPreview: '/quick switch profile',
  }, 'test', {
    addProcessingReaction: async () => null,
    queueFeishuReply: async (_runtime, _summary, text) => { commandReply = text; return { queued: true }; },
  });
  assert.match(commandReply, /已经绑定 Standard Session/,
    'Quick remains immutable after a Standard Session is bound to the topic');

  runtime.config.replyPolicy = normalizeFeishuReplyPolicy({ group: 'inline', private: 'inline' });
  const inlineQuick = await handleMessage(runtime, {
    ...base, chatId: 'quick-inline-chat', messageId: 'quick-inline-root',
    messageText: '/quick inline fast answer', textPreview: '/quick inline fast answer',
  }, 'test', { addProcessingReaction: async () => null });
  const inlineQuickSession = sessions.find(session => session.id === inlineQuick.sessionId);
  assert.equal(inlineQuickSession.executionProfile, 'quick');
  assert.equal(inlineQuickSession.conversation.target.conversationKind, 'main',
    'Quick selects an execution profile without forcing Thread placement');

  console.log('ok - chat-style topology and Quick execution profile remain independent');
} finally {
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

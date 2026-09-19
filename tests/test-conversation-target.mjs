import assert from 'node:assert/strict';
import {
  normalizeConversation,
  sameConversation,
  sameConversationScope,
  conversationAfterReceipt,
  refineConversation,
} from '../lib/conversation-target.mjs';

const group = { connector: 'feishu', sourceRouteId: 'bot-a', target: { chatId: 'group' } };
const topic = { ...group, target: { chatId: 'group', threadId: 'thread', rootId: 'root', messageId: 'input', replyInThread: true } };
assert.deepEqual(normalizeConversation(group), group);
assert.equal(sameConversation(group, group), false, 'group-only destinations create independent conversations');
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', rootId: 'root', replyInThread: true } }), true);
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', topicId: 'thread' } }), true);
assert.equal(sameConversation(topic, { ...topic, sourceRouteId: 'bot-b' }), false);
assert.equal(sameConversation(topic, { ...topic, target: { ...topic.target, chatId: 'elsewhere' } }), false);
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', rootId: 'different', replyInThread: true } }), false);
const currentRoot = { ...group, target: { chatId: 'group', messageId: 'current-root', replyInThread: true } };
assert.equal(sameConversationScope(topic, currentRoot), true,
  'different Feishu topics in one Bot and chat share a safe request-delivery scope');
assert.equal(sameConversationScope(topic, { ...currentRoot, sourceRouteId: 'bot-b' }), false);
assert.equal(sameConversationScope(topic, { ...currentRoot, target: { ...currentRoot.target, chatId: 'other-group' } }), false);
assert.deepEqual(refineConversation(currentRoot, topic), currentRoot,
  'a request-scoped root reply must not be redirected into the Session\'s older topic');
const unthreadedCurrentRoot = { ...group, target: { chatId: 'group', messageId: 'current-root' } };
assert.deepEqual(refineConversation(unthreadedCurrentRoot, topic), unthreadedCurrentRoot,
  'an unthreaded continue-mode reply must not be redirected into the Session\'s older topic');
assert.deepEqual(conversationAfterReceipt(unthreadedCurrentRoot, { messageId: 'group-reply', threadId: 'new-thread' }), unthreadedCurrentRoot,
  'an outbound receipt must not turn an unthreaded continue-mode binding into a topic');
assert.equal(normalizeConversation({ connector: 'feishu', target: { threadId: 'no-group' } }), null);
const created = conversationAfterReceipt(group, { messageId: 'new-root', threadId: '' });
assert.equal(created.target.rootId, 'new-root');
assert.equal(created.target.messageId, 'new-root');
assert.equal(created.target.replyInThread, true);
const resolved = conversationAfterReceipt(created, { messageId: 'reply', threadId: 'assigned-thread' });
assert.equal(resolved.target.rootId, 'new-root');
assert.equal(resolved.target.threadId, 'assigned-thread');
assert.equal(sameConversation(created, resolved), true);
assert.equal(conversationAfterReceipt(topic, { messageId: 'reply', threadId: 'thread' }).target.rootId, 'root');
const dm = { ...group, target: { chatId: 'private', chatType: 'p2p' } };
assert.equal(sameConversation(dm, dm), true);
assert.deepEqual(conversationAfterReceipt(dm, { messageId: 'reply' }), dm);
assert.equal(conversationAfterReceipt(group, {}), null, 'missing send receipts cannot bind a topic');
console.log('PASS: conversation identity, route isolation and first-publication binding');

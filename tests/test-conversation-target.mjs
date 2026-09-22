import assert from 'node:assert/strict';
import {
  normalizeConversation,
  sameConversation,
  sameConversationScope,
  conversationAfterReceipt,
  refineConversation,
} from '../lib/conversation-target.mjs';

const group = { connector: 'feishu', sourceRouteId: 'bot-a', target: { chatId: 'group' } };
const main = { ...group, target: { chatId: 'group', conversationKind: 'main' } };
const topic = { ...group, target: { chatId: 'group', conversationKind: 'thread', threadId: 'thread', rootId: 'root', messageId: 'input', replyInThread: true } };
assert.deepEqual(normalizeConversation(group), group);
assert.equal(sameConversation(group, group), false, 'unaddressed group publications create independent conversations');
assert.equal(sameConversation(main, { ...main, target: { ...main.target, messageId: 'new-input' } }), true,
  'one chat mainline has one explicit main conversation');
assert.equal(sameConversation(main, topic), false, 'main and thread topology never alias');
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', conversationKind: 'thread', rootId: 'root', replyInThread: true } }), true);
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', conversationKind: 'thread', topicId: 'thread' } }), true);
assert.equal(sameConversation(topic, { ...topic, sourceRouteId: 'bot-b' }), false);
assert.equal(sameConversation(topic, { ...topic, target: { ...topic.target, chatId: 'elsewhere' } }), false);
assert.equal(sameConversation(topic, { ...group, target: { chatId: 'group', conversationKind: 'thread', rootId: 'different', replyInThread: true } }), false);
const currentRoot = { ...group, target: { chatId: 'group', conversationKind: 'thread', messageId: 'current-root', replyInThread: true } };
assert.equal(sameConversationScope(topic, currentRoot), true,
  'different Feishu threads in one Bot and chat share a safe request-delivery scope');
assert.equal(sameConversationScope(topic, { ...currentRoot, sourceRouteId: 'bot-b' }), false);
assert.equal(sameConversationScope(topic, { ...currentRoot, target: { ...currentRoot.target, chatId: 'other-group' } }), false);
assert.deepEqual(refineConversation(currentRoot, topic), currentRoot,
  'a request-scoped thread reply must not be redirected into an older thread');
assert.deepEqual(conversationAfterReceipt(main, { messageId: 'group-reply', threadId: 'new-thread' }), main,
  'an inline main binding must never learn a thread from an outbound receipt');
assert.equal(normalizeConversation({ connector: 'feishu', target: { threadId: 'no-group' } }), null);
const created = conversationAfterReceipt(group, { messageId: 'new-root', threadId: '' });
assert.equal(created.target.rootId, 'new-root');
assert.equal(created.target.messageId, 'new-root');
assert.equal(created.target.replyInThread, true);
const resolved = conversationAfterReceipt(currentRoot, { messageId: 'reply', threadId: 'assigned-thread' });
assert.equal(resolved.target.rootId, 'current-root');
assert.equal(resolved.target.threadId, 'assigned-thread');
assert.equal(sameConversation(currentRoot, resolved), true);
assert.equal(conversationAfterReceipt(topic, { messageId: 'reply', threadId: 'thread' }).target.rootId, 'root');
const dmMain = { ...group, target: { chatId: 'private', chatType: 'p2p', conversationKind: 'main' } };
const dmThread = { ...group, target: { chatId: 'private', chatType: 'p2p', conversationKind: 'thread', messageId: 'dm-root', replyInThread: true } };
assert.equal(sameConversation(dmMain, { ...dmMain }), true);
assert.equal(sameConversation(dmMain, dmThread), false);
assert.equal(conversationAfterReceipt(dmThread, { messageId: 'reply', threadId: 'dm-thread' }).target.threadId, 'dm-thread');
assert.equal(conversationAfterReceipt(group, {}), null, 'missing send receipts cannot bind a thread');
console.log('PASS: explicit main/thread identity, route isolation and first-publication binding');

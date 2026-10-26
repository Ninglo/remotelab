import assert from 'node:assert/strict';
import { buildMessageSourceContext } from '../connectors/feishu/index.mjs';
import {
  feishuConversationBoundary,
  loadFeishuConversationContext,
  loadFeishuTurnContext,
  normalizeFeishuHistoryItem,
  parseFeishuMessageTime,
} from '../connectors/feishu/conversation-context.mjs';

const at = (iso) => String(Date.parse(iso));
const textItem = (messageId, iso, name, text, senderType = 'user') => ({
  message_id: messageId,
  create_time: at(iso),
  msg_type: 'text',
  sender: { sender_name: name, sender_type: senderType },
  body: { content: JSON.stringify({ text }) },
});

assert.equal(parseFeishuMessageTime('1790065894'), 1790065894000);
assert.equal(parseFeishuMessageTime('1790065894744'), 1790065894744);
assert.deepEqual(normalizeFeishuHistoryItem({
  ...textItem('mention', '2026-09-22T09:00:00.000Z', 'Alice', '请看 @_user_1'),
  mentions: [{ key: '@_user_1', name: 'Bob' }],
}, { timeZone: 'Asia/Shanghai' }), {
  messageId: 'mention', sender: 'Alice（身份未核实）', time: '2026-09-22 17:00:00', text: '请看 @Bob',
  timestamp: Date.parse('2026-09-22T09:00:00.000Z'),
});
const sameNameA = normalizeFeishuHistoryItem({
  ...textItem('same-a', '2026-09-22T09:00:00.000Z', '同名成员', '同意'),
  sender: { sender_name: '同名成员', sender_type: 'user', id: 'ou_history_a' },
});
const sameNameB = normalizeFeishuHistoryItem({
  ...textItem('same-b', '2026-09-22T09:01:00.000Z', '同名成员', '反对'),
  sender: { sender_name: '同名成员', sender_type: 'user', id: 'ou_history_b' },
});
assert.notEqual(sameNameA.sender, sameNameB.sender,
  'recent group history must distinguish people who share a display name');
assert.equal(sameNameA.authorRef.subjectId, 'ou_history_a');
assert.equal(sameNameB.authorRef.subjectId, 'ou_history_b');
assert.equal(buildMessageSourceContext({ sourceRouteId: 'route', mentions: [{ name: '被提及的人', key: '@_user', openId: 'ou_mentioned' }] }).mentions[0].subjectId, 'ou_mentioned');

function runtimeFor(items, calls) {
  return {
    appClient: {
      im: { v1: { message: { async list(request) {
        calls.push(request);
        return { code: 0, data: { items, has_more: false } };
      } } } },
    },
  };
}

const topicCalls = [];
const topicContext = await loadFeishuConversationContext(runtimeFor([
  textItem('after-current', '2026-09-22T11:01:00.000Z', 'Later', '这条不应出现'),
  textItem('current', '2026-09-22T11:00:00.000Z', '酒嘉年', '当前消息'),
  textItem('receipt', '2026-09-22T10:30:00.000Z', 'RemoteLab',
    '会话已创建。\n查看会话详情和进度：https://example.test/?session=one', 'app'),
  textItem('reply', '2026-09-22T10:00:00.000Z', '张予', '第二条'),
  textItem('root', '2026-09-22T08:00:00.000Z', '酒嘉年', '第一条'),
], topicCalls), {
  chatId: 'chat-secret', threadId: 'thread-secret', messageId: 'current',
  createTime: at('2026-09-22T11:00:00.000Z'),
}, { timeZone: 'Asia/Shanghai' });

assert.deepEqual(topicContext, {
  messages: [
    { messageId: 'root', sender: '酒嘉年（身份未核实）', time: '2026-09-22 16:00:00', text: '第一条' },
    { messageId: 'reply', sender: '张予（身份未核实）', time: '2026-09-22 18:00:00', text: '第二条' },
  ],
  truncated: false,
});
assert.equal(topicCalls.length, 1);
assert.equal(topicCalls[0].params.container_id_type, 'thread');
assert.equal(topicCalls[0].params.container_id, 'thread-secret');
assert.equal(topicCalls[0].params.with_sender_name, true);
assert.equal(topicCalls[0].params.start_time, undefined);

const groupCalls = [];
const groupContext = await loadFeishuConversationContext(runtimeFor([
  textItem('current', '2026-09-22T11:00:00.000Z', '酒嘉年', '当前消息'),
  textItem('recent', '2026-09-22T10:45:00.000Z', '张予', '最近一条'),
  textItem('middle', '2026-09-22T08:00:00.000Z', 'Alice', '本轮开始'),
  textItem('old', '2026-09-22T02:00:00.000Z', 'Bob', '上一轮，不应出现'),
], groupCalls), {
  chatId: 'chat-secret', chatType: 'group', messageId: 'current',
  createTime: at('2026-09-22T11:00:00.000Z'),
}, { timeZone: 'Asia/Shanghai' });

assert.deepEqual(groupContext.messages, [
  { messageId: 'middle', sender: 'Alice（身份未核实）', time: '2026-09-22 16:00:00', text: '本轮开始' },
  { messageId: 'recent', sender: '张予（身份未核实）', time: '2026-09-22 18:45:00', text: '最近一条' },
]);
assert.equal(groupCalls[0].params.container_id_type, 'chat');
assert.equal(groupCalls[0].params.container_id, 'chat-secret');
assert.ok(groupCalls[0].params.start_time);
assert.ok(groupCalls[0].params.end_time);

const boundary = feishuConversationBoundary({ message: {
  connector: 'feishu', messageId: 'previous', chatId: 'chat-secret', topicId: '',
  sourceRouteId: 'bot-2', createTime: at('2026-09-22T10:45:00.000Z'),
} }, {
  chatId: 'chat-secret', chatType: 'group', sourceRouteId: 'bot-2',
  createTime: at('2026-09-22T11:00:00.000Z'),
});
assert.deepEqual(boundary, {
  sinceTimeMs: Date.parse('2026-09-22T10:45:00.000Z'), sinceMessageId: 'previous',
});
const incrementalCalls = [];
const incremental = await loadFeishuConversationContext(runtimeFor([
  textItem('current', '2026-09-22T11:00:00.000Z', '酒嘉年', '当前消息'),
  textItem('new', '2026-09-22T10:50:00.000Z', '张予', '新增讨论'),
  textItem('previous', '2026-09-22T10:45:00.000Z', '酒嘉年', '上一轮已入 Session'),
  textItem('same-time', '2026-09-22T10:45:00.000Z', 'Alice', '同一时刻的其他消息'),
  textItem('old', '2026-09-22T08:00:00.000Z', 'Bob', '更早的重复历史'),
], incrementalCalls), {
  chatId: 'chat-secret', chatType: 'group', messageId: 'current',
  createTime: at('2026-09-22T11:00:00.000Z'),
}, { ...boundary, timeZone: 'Asia/Shanghai' });
assert.deepEqual(incremental.messages.map(({ text }) => text), [
  '同一时刻的其他消息', '新增讨论',
]);
assert.equal(incrementalCalls[0].params.start_time,
  String(Math.floor(boundary.sinceTimeMs / 1000)));
assert.equal(feishuConversationBoundary({ message: {
  connector: 'feishu', messageId: 'previous', chatId: 'other-chat',
  sourceRouteId: 'bot-2', createTime: at('2026-09-22T10:45:00.000Z'),
} }, { chatId: 'chat-secret', sourceRouteId: 'bot-2',
  createTime: at('2026-09-22T11:00:00.000Z') }), null,
'a different chat must retain its full first-turn context');
assert.equal(feishuConversationBoundary({ message: {
  connector: 'feishu', messageId: 'previous', chatId: 'chat-secret', topicId: 'other-thread',
  sourceRouteId: 'bot-2', createTime: at('2026-09-22T10:45:00.000Z'),
} }, { chatId: 'chat-secret', threadId: 'current-thread', sourceRouteId: 'bot-2',
  createTime: at('2026-09-22T11:00:00.000Z') }), null,
'a different topic must retain its full first-turn context');
assert.equal(feishuConversationBoundary({ message: {
  connector: 'feishu', feishuParticipation: 'feedback', messageId: 'feedback',
  chatId: 'chat-secret', sourceRouteId: 'bot-2',
  createTime: at('2026-09-22T10:45:00.000Z'),
} }, { chatId: 'chat-secret', sourceRouteId: 'bot-2',
  createTime: at('2026-09-22T11:00:00.000Z') }), null,
'feedback events are not a safe conversation-history boundary');

const metadataContext = await loadFeishuConversationContext(runtimeFor([
  textItem('bot-answer', '2026-09-22T10:45:00.000Z', '茵蒂克丝', '我会继续查。', 'app'),
], []), {
  chatId: 'chat-secret', chatType: 'group', createTime: at('2026-09-22T11:00:00.000Z'),
}, { includeMetadata: true });
assert.equal(metadataContext.messages[0].messageId, 'bot-answer');
assert.equal(metadataContext.messages[0].senderType, 'app');
assert.equal(metadataContext.messages[0].timestamp, Date.parse('2026-09-22T10:45:00.000Z'));

const sourceContext = buildMessageSourceContext({
  chatId: 'chat-secret', messageId: 'current', chatType: 'group',
  createTime: at('2026-09-22T11:00:00.000Z'),
  conversationContext: groupContext,
});
assert.deepEqual(sourceContext.conversationContext.messages, groupContext.messages);
assert.equal(JSON.stringify(sourceContext.conversationContext).includes('secret'), false,
  'history entries must contain only display name, time and readable content');

const missingApi = await loadFeishuConversationContext({ appClient: {} }, {
  chatId: 'chat', messageId: 'current', createTime: at('2026-09-22T11:00:00.000Z'),
});
assert.equal(missingApi, null, 'connectors without history permission should fail open');

// A provider-shaped fixture exercises the same admission policy as the connector.
const now = Date.parse('2026-10-26T00:00:00.500Z');
const hour = 3600000;
function paginatedRuntime(items, calls) {
  return { appClient: { im: { v1: { message: { list: async ({ params }) => {
    calls.push(params);
    const selected = items.filter(item => Number(item.create_time) >= Number(params.start_time || 0) * 1000
      && Number(item.create_time) < Number(params.end_time) * 1000)
      .sort((a,b) => Number(b.create_time) - Number(a.create_time));
    const offset = Number(params.page_token || 0), end = offset + params.page_size;
    return { code: 0, data: { items: selected.slice(offset,end), has_more: end < selected.length, page_token: String(end) } };
  } } } } } };
}
const fixture = (id, time, text=id) => textItem(id,new Date(time).toISOString(),'Alice',text);
const summary = { chatId:'group', chatType:'group', messageId:'current', createTime:String(now) };
const raw = Array.from({length:150},(_,i)=>fixture(String(i),now - (150-i)*60000));
raw.push(fixture('yesterday',now - 25*hour));
const calls = [];
const bounded = await loadFeishuTurnContext(paginatedRuntime(raw,calls),summary);
assert.equal(calls.length,2,'busy groups stop after 100 provider messages');
assert.equal(bounded.messages.length,100);
assert.equal(bounded.messages[0].messageId,'50');
assert.equal(bounded.messages.at(-1).messageId,'149');
assert.equal(calls[0].start_time,String(Math.floor((now-24*hour)/1000)));
assert.equal(bounded.truncated,true);
assert.equal(bounded.coverage,undefined,'a recent window is not a complete-history receipt');
const sparse = await loadFeishuTurnContext(paginatedRuntime([
  fixture('previous-day',now-25*hour), fixture('morning',now-20*hour),
  fixture('same-second',now-100), fixture('future',now+100),
],[]),summary);
assert.deepEqual(sparse.messages.map(m=>m.messageId),['morning','same-second'],
  'retain the full day despite idle gaps; exclude later messages even in the same second');
const threadCalls=[];
const thread = await loadFeishuTurnContext(paginatedRuntime(raw,threadCalls),{...summary,threadId:'thread'});
assert.equal(thread.messages.length,100);
assert.equal(threadCalls[0].container_id_type,'thread');
assert.equal(threadCalls[0].start_time,undefined,'a quiet topic can retain its prior-day context');
const quietThread = await loadFeishuTurnContext(paginatedRuntime([raw.at(-1)],[]),{...summary,threadId:'thread'});
assert.equal(quietThread.messages[0].messageId,'yesterday');
const privateContext = await loadFeishuTurnContext(paginatedRuntime(raw,[]),{...summary,chatType:'p2p'});
assert.equal(privateContext.messages.length,151,'private conversation history policy is unchanged');
const longText = '完整背景'.repeat(16000) + '末尾纠正：暂停';
const longContext = await loadFeishuTurnContext(paginatedRuntime([fixture('long',now-100,longText)],[]),summary);
assert.equal(longContext.messages[0].text,longText,'admission bounds the source selection, not message bodies');

console.log('Feishu conversation context: bounded turn admission, same-second/gap handling, private scope, full selected bodies and legacy readers passed');

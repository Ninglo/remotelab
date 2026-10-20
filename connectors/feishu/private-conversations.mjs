import { createConnectorSession } from '../../lib/connector-turn-flow.mjs';
import { buildFeishuTopicId, buildSessionSourceContext } from './index.mjs';
import { buildFeishuSessionConversationTarget, buildFeishuSessionExternalTriggerId } from './reply-routing.mjs';
import { parseFeishuMessageTime } from './conversation-context.mjs';
import { findConnectorMessageIndexRecord } from '../../lib/connector-message-index.mjs';
import { appendSessionEntryFooter, buildSessionEntry } from '../../lib/session-navigation.mjs';

export async function filterPrivateConversationContext(runtime, summary, session, context, {
  lookup = findConnectorMessageIndexRecord,
} = {}) {
  if (!session.privateConversationStart || !context?.messages?.length) return context;
  const messages = await Promise.all(context.messages.map(async message => {
    if (Number.isFinite(message.timestamp) && message.timestamp <= session.privateConversationStart.at) return null;
    if (message.senderType !== 'app' || !runtime.storagePaths?.messageIndexPath) return message;
    const indexed = await lookup(runtime.storagePaths.messageIndexPath, { connector: 'feishu',
      accountId: summary.tenantKey || summary.sender?.tenantKey || '', chatId: summary.chatId,
      messageId: message.messageId });
    return indexed?.sessionId && indexed.sessionId !== session.id ? null : message;
  }));
  return { ...context, messages: messages.filter(Boolean) };
}

export async function startFeishuPrivateConversation(runtime, summary, { request, resolveDefault, systemPrompt = '' } = {}) {
  if (!['p2p', 'private'].includes(summary.chatType) || buildFeishuTopicId(summary)) {
    return { text: '“新对话”用于私聊。项目工作请在对应群里新开话题。', created: false };
  }
  const at = parseFeishuMessageTime(summary.createTime);
  if (!summary.messageId || !at) throw new Error('New private conversation requires the actual command message and time');
  const sourceRouteId = runtime.config.sourceRouteId || 'default';
  const routed = { ...summary, sourceRouteId, conversationKind: 'main', replyInThread: false, startThread: false };
  const selection = await resolveDefault();
  const session = await createConnectorSession(request, {
    folder: runtime.config.sessionFolder, tool: selection.tool, model: selection.model || '',
    effort: selection.effort || '', thinking: selection.thinking === true,
    sourceId: 'feishu', sourceName: 'Feishu', group: 'Feishu', name: '私聊新对话',
    systemPrompt, sourceContext: buildSessionSourceContext(routed),
    conversation: { connector: 'feishu', sourceRouteId, target: buildFeishuSessionConversationTarget(routed) },
    replaceConversation: true,
    externalTriggerId: buildFeishuSessionExternalTriggerId(routed, sourceRouteId) + ':new:' + summary.messageId,
    privateConversationStart: { messageId: summary.messageId, at },
  });
  // The existing atomic replace/replay contract leaves older Sessions intact;
  // replaying an old command cannot reclaim a newer conversation binding.
  if (!session.conversation) return { created: false, superseded: true, sessionId: session.id };
  return { created: true, sessionId: session.id,
    text: appendSessionEntryFooter('已开启新对话，直接发送新问题即可。', buildSessionEntry(session)) };
}

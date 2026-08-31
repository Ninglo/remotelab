import {
  findConnectorMessageIndexRecord,
  loadConnectorMessageIndex,
} from '../../lib/connector-message-index.mjs';
import {
  FEISHU_CONNECTOR_ID,
  buildFeishuTopicId,
  normalizeFeishuMode,
  trimString,
} from './index.mjs';

export const DEFAULT_FEISHU_GROUP_REPLY_POLICY_MODE = 'mention_or_reply';

export function normalizeFeishuGroupReplyPolicy(value = {}) {
  const mode = trimString(value?.mode || DEFAULT_FEISHU_GROUP_REPLY_POLICY_MODE).toLowerCase();
  if (!['mention_or_reply', 'all'].includes(mode)) {
    throw new Error(`Unsupported groupReplyPolicy.mode: ${value?.mode || '(missing)'}`);
  }
  return { mode };
}

export async function resolveFeishuBotIdentity(runtime) {
  const response = await runtime?.appClient?.request?.({
    url: '/open-apis/bot/v3/info',
    method: 'GET',
  });
  const bot = response?.bot || response?.data?.bot || {};
  const identity = {
    openId: trimString(bot.open_id || bot.openId),
    userId: trimString(bot.user_id || bot.userId),
    unionId: trimString(bot.union_id || bot.unionId),
    name: trimString(bot.app_name || bot.name),
  };
  if (!identity.openId && !identity.userId && !identity.unionId) {
    throw new Error(`Feishu Bot identity response did not include an ID: ${JSON.stringify(response || {}).slice(0, 240)}`);
  }
  return identity;
}

export function applyFeishuBotIdentity(summary, botIdentity = {}) {
  const botIds = new Set([
    trimString(botIdentity.openId),
    trimString(botIdentity.userId),
    trimString(botIdentity.unionId),
  ].filter(Boolean));
  const mentionedBot = summary?.mentionedBot === true || (Array.isArray(summary?.mentions) && summary.mentions.some((mention) => (
    [mention?.openId, mention?.userId, mention?.unionId]
      .map((value) => trimString(value))
      .some((value) => value && botIds.has(value))
  )));
  return {
    ...summary,
    mentionedBot,
  };
}

function isFeishuGroupMessage(summary) {
  const modes = [summary?.chatType, summary?.chatMode, summary?.groupMessageType]
    .map((value) => normalizeFeishuMode(value))
    .filter(Boolean);
  if (modes.includes('p2p') || modes.includes('private')) return false;
  return modes.some((mode) => ['group', 'topic', 'thread'].includes(mode));
}

function recordMatchesFeishuConversation(record, summary, conversationId) {
  if (trimString(record?.connector) !== FEISHU_CONNECTOR_ID) return false;
  if (trimString(record?.direction) !== 'outbound') return false;
  if (trimString(record?.conversationId) !== conversationId) return false;
  const chatId = trimString(summary?.chatId);
  if (chatId && trimString(record?.chatId) && trimString(record.chatId) !== chatId) return false;
  const accountId = trimString(summary?.tenantKey || summary?.sender?.tenantKey);
  if (accountId && trimString(record?.accountId) && trimString(record.accountId) !== accountId) return false;
  return true;
}

async function hasIndexedFeishuBotReply(runtime, summary) {
  const indexPath = trimString(runtime?.storagePaths?.messageIndexPath);
  if (!indexPath) return false;
  const accountId = trimString(summary?.tenantKey || summary?.sender?.tenantKey);
  const chatId = trimString(summary?.chatId);
  const messageIdCandidates = [summary?.parentId, summary?.rootId]
    .map((value) => trimString(value))
    .filter(Boolean);
  for (const messageId of messageIdCandidates) {
    const record = await findConnectorMessageIndexRecord(indexPath, {
      connector: FEISHU_CONNECTOR_ID,
      accountId,
      messageId,
      chatId,
    });
    if (trimString(record?.direction) === 'outbound') return true;
  }

  const topicId = buildFeishuTopicId(summary);
  if (!topicId) return false;
  const document = await loadConnectorMessageIndex(indexPath);
  return Object.values(document.records || {}).some((record) => (
    recordMatchesFeishuConversation(record, summary, topicId)
  ));
}

export async function shouldRouteFeishuMessageToRemoteLab(runtime, summary) {
  if (!isFeishuGroupMessage(summary)) return true;
  const policy = normalizeFeishuGroupReplyPolicy(runtime?.config?.groupReplyPolicy);
  if (policy.mode === 'all') return true;
  if (summary?.mentionedBot === true) return true;
  return await hasIndexedFeishuBotReply(runtime, summary);
}

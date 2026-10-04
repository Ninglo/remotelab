import { trimString } from './index.mjs';
import { getFeishuConversationSettings } from './conversation-settings.mjs';

function normalizeGroupResponseMode(value) {
  const mode = trimString(value).toLowerCase();
  if (!['all', 'mention_only'].includes(mode)) {
    throw new Error(`Unsupported responsePolicy.group: ${value}`);
  }
  return mode;
}

export function normalizeFeishuResponsePolicy(value = {}) {
  return { group: normalizeGroupResponseMode(value?.group ?? 'mention_only') };
}

export async function resolveFeishuBotIdentity(runtime) {
  const response = await runtime.appClient.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
  const bot = response?.bot || response?.data?.bot || {};
  const identity = {
    openId: trimString(bot.open_id || bot.openId),
    userId: trimString(bot.user_id || bot.userId),
    unionId: trimString(bot.union_id || bot.unionId),
  };
  if (!Object.values(identity).some(Boolean)) {
    throw new Error('Feishu Bot identity response did not include an ID');
  }
  return identity;
}

export function isFeishuBotSender(summary) {
  return ['app', 'bot'].includes(trimString(summary?.sender?.senderType).toLowerCase());
}

export function isFeishuSelfSender(runtime, summary) {
  const sender = summary?.sender || {};
  return ['openId', 'userId', 'unionId'].some(key => (
    trimString(runtime?.botIdentity?.[key]) && trimString(sender[key]) === trimString(runtime.botIdentity[key])
  )) || Boolean(trimString(runtime?.config?.appId) && (
    sender.appId === runtime.config.appId || sender.openId === runtime.config.appId
  ));
}

export function mentionsFeishuBot(runtime, summary) {
  const identity = runtime?.botIdentity || {};
  // Match IDs by namespace; names, stale flags, thread bindings and @all are not mentions of this Bot.
  return (Array.isArray(summary?.mentions) ? summary.mentions : []).some((mention) => (
    ['openId', 'userId', 'unionId'].some((key) => (
      trimString(identity[key]) && trimString(mention?.[key]) === trimString(identity[key])
    ))
  ));
}

export async function shouldRouteFeishuMessageToRemoteLab(runtime, summary, { explicitCommand = false } = {}) {
  if (isFeishuSelfSender(runtime, summary)) return false;
  const mentioned = mentionsFeishuBot(runtime, summary);
  // Bot handoffs always need an explicit mention, even in private chats or group=all.
  if (isFeishuBotSender(summary)) return mentioned;
  if (!mentioned && !explicitCommand && (await getFeishuConversationSettings(runtime, summary)).muted) return false;
  // Access control and explicit quiet controls fence reception. Every other
  // human message reaches the Session; the Harness owns reply judgment.
  return true;
}

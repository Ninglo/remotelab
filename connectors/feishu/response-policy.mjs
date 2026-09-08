import { normalizeFeishuMode, trimString } from './index.mjs';

function normalizeGroupResponseMode(value) {
  const mode = trimString(value).toLowerCase();
  if (!['all', 'mention_only'].includes(mode)) {
    throw new Error(`Unsupported responsePolicy.group: ${value}`);
  }
  return mode;
}

export function normalizeFeishuResponsePolicy(value = {}) {
  return { group: normalizeGroupResponseMode(value?.group ?? 'all') };
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

export function shouldRouteFeishuMessageToRemoteLab(runtime, summary) {
  const modes = [summary?.chatType, summary?.chatMode, summary?.groupMessageType].map(normalizeFeishuMode);
  if (modes.includes('p2p') || modes.includes('private')) return true;
  if (!modes.some((mode) => ['group', 'topic', 'thread'].includes(mode))) return true;
  const policy = normalizeFeishuResponsePolicy(runtime?.config?.responsePolicy);
  if (policy.group === 'all') return true;
  const identity = runtime?.botIdentity || {};
  // Match IDs by namespace; names, stale flags, thread bindings and @all are not mentions of this Bot.
  return (Array.isArray(summary?.mentions) ? summary.mentions : []).some((mention) => (
    ['openId', 'userId', 'unionId'].some((key) => (
      trimString(identity[key]) && trimString(mention?.[key]) === trimString(identity[key])
    ))
  ));
}

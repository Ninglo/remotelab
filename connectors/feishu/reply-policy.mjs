import { resolveFeishuGroupSettings } from './group-settings.mjs';

const MODES = new Set(['inline', 'thread']);

function mode(value, key) {
  if (!MODES.has(value)) throw new Error(`Unsupported ${key}: ${value}`);
  return value;
}

export function normalizeFeishuReplyPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('replyPolicy must be an object');
  }
  const chats = value.chats ?? {};
  if (typeof chats !== 'object' || !chats || Array.isArray(chats)) {
    throw new Error('replyPolicy.chats must be a chat-ID to mode object');
  }
  return {
    group: mode(value.group ?? 'thread', 'replyPolicy.group'),
    private: mode(value.private ?? 'inline', 'replyPolicy.private'),
    chats: Object.fromEntries(Object.entries(chats).map(([chatId, setting]) => {
      if (!chatId.trim()) throw new Error('replyPolicy.chats requires nonempty chat IDs');
      return [chatId, mode(setting, `replyPolicy.chats.${chatId}`)];
    })),
  };
}

export function resolveFeishuReplyMode(config, summary) {
  return resolveFeishuGroupSettings(config, summary).replyMode;
}

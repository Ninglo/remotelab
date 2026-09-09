import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRecordStore } from '../../lib/durable-records.mjs';
import { buildFeishuTopicId, trimString } from './index.mjs';

function scope(runtime, summary) {
  const chatId = trimString(summary?.chatId);
  if (!chatId) return null;
  return {
    sourceRouteId: trimString(runtime.config?.sourceRouteId) || 'default',
    tenantKey: trimString(summary.tenantKey || summary.sender?.tenantKey),
    chatId,
    topicId: buildFeishuTopicId(summary),
  };
}

function storeFor(runtime) {
  const root = trimString(runtime.config?.storageDir)
    || (runtime.storagePaths?.messageIndexPath ? dirname(runtime.storagePaths.messageIndexPath) : '');
  if (!root) return null;
  const stores = runtime.feishuConversationSettingsStores ||= new Map();
  if (!stores.has(root)) stores.set(root, createRecordStore(join(root, 'conversation-settings')));
  return stores.get(root);
}

function recordKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export function feishuConversationScopeLabel(summary) {
  if (buildFeishuTopicId(summary)) return '当前话题';
  return ['p2p', 'private'].includes(summary?.chatType) ? '当前私聊' : '当前群主时间线';
}

export async function getFeishuConversationSettings(runtime, summary) {
  const currentScope = scope(runtime, summary);
  const store = storeFor(runtime);
  const record = currentScope && store ? await store.get(recordKey(currentScope)) : null;
  return { muted: record?.muted === true };
}

export async function setFeishuConversationMuted(runtime, summary, muted) {
  const currentScope = scope(runtime, summary);
  const store = storeFor(runtime);
  if (!currentScope || !store) throw new Error('Cannot persist Feishu conversation settings without chat identity and storage');
  if (typeof muted !== 'boolean') throw new Error('muted must be a boolean');
  await store.mutate(recordKey(currentScope), current => current?.muted === muted ? current : {
    scope: currentScope, muted, updatedAt: new Date().toISOString(),
    commandMessageId: trimString(summary.messageId),
  });
  return { muted };
}

export async function describeFeishuMuteSetting(runtime, summary) {
  const { muted } = await getFeishuConversationSettings(runtime, summary);
  return `静默：${muted ? '开启' : '关闭'}（${feishuConversationScopeLabel(summary)}）`
    + (muted ? '\n普通消息不触发 AI；明确 @ 可单次唤醒，/unmute 恢复自动响应。' : '');
}

export async function handleFeishuMuteCommand(runtime, summary, command) {
  if (command.text) return `用法：/${command.type}`;
  const muted = command.type === 'mute';
  await setFeishuConversationMuted(runtime, summary, muted);
  const label = feishuConversationScopeLabel(summary);
  return muted
    ? `已静默${label}。普通消息不再触发 AI；明确 @ 或任务命令仍可单次唤醒，之后保持静默。用 /unmute 恢复。已接收的任务继续执行。`
    : `已恢复${label}的正常响应，继续遵循原有群响应规则。静默期间跳过的消息不会自动重放。`;
}

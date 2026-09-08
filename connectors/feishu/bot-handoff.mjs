import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { buildExternalTriggerId, trimString } from './index.mjs';

// Separate from the best-effort message index: admission must survive a crash,
// retries and concurrent delivery acknowledgements without losing a used quota.
function handoffStore(runtime) {
  const root = trimString(runtime.config?.storageDir)
    || (runtime.storagePaths?.messageIndexPath ? dirname(runtime.storagePaths.messageIndexPath) : '');
  if (!root) return null;
  return runtime.botHandoffStore ||= createRecordStore(join(root, 'bot-handoffs'));
}

function conversationKey(runtime, summary) {
  return createHash('sha256').update(JSON.stringify([
    runtime.config?.sourceRouteId || 'default',
    summary.tenantKey || summary.sender?.tenantKey || '',
    summary.chatId,
  ])).digest('hex').slice(0, 24);
}

// A peer can respond before the Feishu send call returns. Serialize publication
// and admission so its new reply/thread aliases are installed before that event.
export function withFeishuHandoffLock(runtime, summary, operation) {
  if (!summary?.chatId) return operation();
  const locks = runtime.feishuHandoffLocks ||= new Map();
  const key = conversationKey(runtime, summary);
  if (!locks.has(key)) locks.set(key, serialQueue());
  return locks.get(key)(operation);
}

export async function restoreFeishuBotHandoffScopes(runtime) {
  const receipts = createRecordStore(join(runtime.config.storageDir, 'delivery-receipts'));
  for (const receipt of await receipts.active()) {
    await recordFeishuBotHandoffScope(runtime, receipt.target, {
      sessionId: receipt.sessionId, threadId: receipt.threadId, messageId: receipt.messageId,
    });
  }
}

function scopeKeys(summary, { sessionId = '', threadId = '', messageId = '' } = {}) {
  return [...new Set([
    ...[summary.messageId, summary.rootId, summary.parentId, messageId]
      .map(trimString).filter(Boolean).map(id => `message:${id}`),
    ...[summary.threadId, summary.topicId, threadId]
      .map(trimString).filter(Boolean).map(id => `thread:${id}`),
    ...(sessionId ? [`session:${sessionId}`] : []),
    // Private chats and /continue reuse a session even without a thread binding.
    ...(!summary.forkCommand ? [`conversation:${buildExternalTriggerId(summary)}`] : []),
  ])];
}

export async function claimFeishuBotHandoff(runtime, summary, sessionId = '') {
  const store = handoffStore(runtime);
  if (!store) return false; // Never admit a bot without durable loop protection.
  const keys = scopeKeys(summary, { sessionId });
  let admitted = false;
  await store.mutate(conversationKey(runtime, summary), current => {
    const claims = current?.claims || {};
    if (keys.some(key => claims[key] && claims[key] !== summary.messageId)) return current;
    admitted = true; // A retry of the same upstream event keeps its reservation.
    return { ...current, claims: { ...claims, ...Object.fromEntries(keys.map(key => [key, summary.messageId])) } };
  });
  return admitted;
}

// Link newly assigned session/thread/outbound IDs back to the initial admission.
// Human forks and replies inherit a consumed thread quota, but never consume one.
export async function recordFeishuBotHandoffScope(runtime, summary, aliases = {}) {
  if (!summary?.chatId) return;
  const store = handoffStore(runtime);
  if (!store) return;
  const keys = scopeKeys(summary, aliases);
  await store.mutate(conversationKey(runtime, summary), current => {
    const claims = current?.claims || {};
    const owner = keys.map(key => claims[key]).find(Boolean) || trimString(summary.botHandoffMessageId);
    if (!owner) return current;
    return { ...current, claims: { ...claims,
      ...Object.fromEntries(keys.filter(key => !claims[key]).map(key => [key, owner])),
    } };
  });
}

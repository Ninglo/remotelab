import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createRecordStore } from '../lib/durable-records.mjs';
import { normalizeConversation, sameConversation } from '../lib/conversation-target.mjs';
import { requests } from './requests.mjs';
import { getRun, getRunManifest } from './runs.mjs';

export function sameFeishuConversation(left, right) {
  const a = normalizeConversation(left), b = normalizeConversation(right);
  if (!a || !b || a.connector !== 'feishu' || b.connector !== 'feishu'
      || (a.target.tenantKey || '') !== (b.target.tenantKey || '')) return false;
  if (a.target.threadId && b.target.threadId && a.target.threadId !== b.target.threadId) return false;
  return sameConversation(a, b);
}

export function hasDeliveredFeishuThread(record, value) {
  const conversation = normalizeConversation(value);
  return conversation?.connector === 'feishu' && conversation.target.conversationKind === 'thread'
    && Boolean(record?.deliveries?.some(part => part.state === 'delivered'
      && ['content', 'attachment'].includes(part.kind)
      && part.target?.sourceKind === 'ambient_thread_open'
      && (part.target?.tenantKey || '') === (conversation.target.tenantKey || '')
      && sameFeishuConversation({ ...part, target: { ...part.target,
        ...(part.deliveredThreadId ? { threadId: part.deliveredThreadId } : {}) } }, conversation)));
}

// A reply surface keeps its originating execution as provenance after the Run
// ends. This is not a replacement for the Session's main conversation binding.
const surfaces = createRecordStore(join(CONFIG_DIR, 'feishu-thread-surfaces'));
const surfaceKey = (conversation, id) => createHash('sha256').update(JSON.stringify([
  conversation.sourceRouteId, conversation.target.tenantKey || '', conversation.target.chatId, id,
])).digest('hex').slice(0, 24);
const surfaceIds = conversation => [...new Set([conversation.target.threadId,
  conversation.target.topicId, conversation.target.rootId].filter(Boolean))];
export async function rememberFeishuThreadSurface(delivery, { registry = surfaces } = {}) {
  if (delivery?.connector !== 'feishu' || delivery.state !== 'delivered'
      || !['content', 'attachment'].includes(delivery.kind)
      || delivery.target?.sourceKind !== 'ambient_thread_open' || !delivery.runId) return;
  const conversation = normalizeConversation({ ...delivery, target: { ...delivery.target,
    ...(delivery.deliveredThreadId ? { threadId: delivery.deliveredThreadId } : {}) } });
  for (const id of surfaceIds(conversation)) {
    await registry.mutate(surfaceKey(conversation, id), current => ({
      origins: [...new Set([...(current?.origins || []), delivery.runId])],
    }));
  }
}

const legacyIndexJobs = new WeakMap();
const legacyIndexKey = createHash('sha256').update('feishu-thread-surfaces:legacy-v1').digest('hex').slice(0, 24);
async function ensureLegacyThreadSurfaces(store, registry) {
  if (!store.archived) return;
  if (!legacyIndexJobs.has(registry)) {
    const job = (async () => {
      if ((await registry.get(legacyIndexKey))?.complete) return;
      // Completed phase-one surfaces predate the index. Rebuild once from their
      // actual delivered receipts, never from conversation titles or text.
      for await (const record of store.archived()) {
        if (record.options?.deliveryOnly || record.options?.internalOperation) continue;
        for (const delivery of record.deliveries || []) {
          await rememberFeishuThreadSurface({ ...delivery, runId: record.runId }, { registry });
        }
      }
      await registry.mutate(legacyIndexKey, () => ({ complete: true }));
    })();
    legacyIndexJobs.set(registry, job);
    job.catch(() => legacyIndexJobs.delete(registry));
  }
  await legacyIndexJobs.get(registry);
}

export async function findActiveFeishuThreadExecution(value, {
  store = requests, readRun = getRun, readManifest = getRunManifest, registry = surfaces,
} = {}) {
  const conversation = normalizeConversation(value);
  if (conversation?.connector !== 'feishu' || conversation.target.conversationKind !== 'thread') return null;
  await ensureLegacyThreadSurfaces(store, registry);
  const indexed = await Promise.all(surfaceIds(conversation).map(id => registry.get(surfaceKey(conversation, id))));
  const ids = [...new Set(indexed.flatMap(record => record?.origins || []))];
  // Include old not-yet-archived receipts; new receipts are indexed durably at
  // acknowledgement, before archive. Conflicting ownership is never guessed.
  const active = await store.projectActive(records => records.filter(record =>
    !record.options?.deliveryOnly && !record.options?.internalOperation
    && hasDeliveredFeishuThread(record, conversation)));
  const candidates = [...new Map([...active, ...await Promise.all(ids.map(id => store.byRunId(id)))]
    .filter(record => record && hasDeliveredFeishuThread(record, conversation)).map(record => [record.runId, record])).values()];
  if (new Set(candidates.map(record => record.nativeDispatchRunId || record.runId)).size !== 1) return null;
  const record = candidates.sort((a, b) => a.sequence - b.sequence)[0];
  const executionRunId = record.nativeDispatchRunId || record.runId;
  const execution = record.nativeDispatchRunId ? await store.byRunId(executionRunId) : record;
  const [run, manifest] = await Promise.all([readRun(executionRunId), readManifest(executionRunId)]);
  const live = execution && !execution.result && !execution.releasedAt && !execution.cancelRequestedAt
    && run && !run.cancelRequested && !['completed', 'cancelled', 'failed'].includes(run.state)
    && manifest?.inputMode === 'native' && manifest.options?.feishuThreadContinuationVersion === 1;
  return { sessionId: record.sessionId, threadOriginRunId: record.runId,
    ...(live ? { continuationRunId: executionRunId } : {}) };
}

export async function validateFeishuThreadOrigin(sessionId, originRunId, conversation, store = requests) {
  const origin = await store.byRunId(originRunId);
  return origin?.sessionId === sessionId && hasDeliveredFeishuThread(origin, conversation);
}

export const THREAD_CONTINUATION_EXPIRED = 'THREAD_CONTINUATION_EXPIRED';
export const threadContinuationExpired = () => Object.assign(new Error(
  '原执行已结束或正在停止，这条追加消息不能启动另一个执行。'), { code: THREAD_CONTINUATION_EXPIRED });

export function belongsToFeishuConversation(record, value) {
  const conversation = normalizeConversation(value);
  const source = normalizeConversation(record?.deliveryPlan || record?.options?.sourceDelivery);
  return conversation?.connector === 'feishu' && source?.connector === 'feishu'
    && source.sourceRouteId === conversation.sourceRouteId
    && (source.target.tenantKey || '') === (conversation.target.tenantKey || '')
    && (sameFeishuConversation(source, conversation) || hasDeliveredFeishuThread(record, conversation));
}

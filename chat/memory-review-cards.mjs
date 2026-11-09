import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR, MEMORY_DIR } from '../lib/config.mjs';
import { claimOnce, readRecord } from '../lib/durable-records.mjs';
import { requests } from './requests.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';

export const memoryReviewKey = (personId, entryId) => createHash('sha256').update(`${personId}:${entryId}`).digest('hex').slice(0, 24);
// Resolve only the accepted source request. This never discovers historical candidates.
export async function memoryReviewSource({ personId, identityId, sources = [], memoryDir = MEMORY_DIR }) {
  if (memoryDir !== MEMORY_DIR) return null;
  const source = sources.find(s => s.type === 'user');
  if (!source) return null;
  const request = await requests.byRunId(source.runId);
  const plan = request?.deliveryPlan || request?.options?.sourceDelivery;
  if (request?.options?.viewPersonId !== personId || request?.options?.initiatedByIdentityId !== identityId
    || !request.options.feishuConnectorAuthenticated || plan?.connector !== 'feishu' || plan.target?.commentId
    || !plan.target?.chatId || !plan.target?.tenantKey) return null;
  return { request, plan };
}

// One origin per memory. A new entry's durable intent also recovers an interrupted enqueue.
export async function queueMemoryReviewCards({ personId, identityId, results = [], updates = [], sources = [], memoryDir = MEMORY_DIR }) {
  const source = await memoryReviewSource({ personId, identityId, sources, memoryDir });
  if (!source) return [];
  const { request, plan } = source;
  const queued = [];
  for (const result of results) {
    if (!result.path.endsWith(`/people/${personId}.md`) || result.status === 'withdrawn') continue;
    const update = updates.find(u => result.id === `mem_${createHash('sha256').update(`personal:instance::${u.key}`).digest('hex').slice(0, 16)}`);
    if (result.version !== 1 && update?.action !== 'propose' && result.reviewDelivery?.runId !== request.runId) continue;
    const key = memoryReviewKey(personId, result.id);
    const path = join(CONFIG_DIR, 'memory-review-origins', `${key}.json`);
    const packet = { sessionId: request.sessionId, responseId: `memory-review:${key}`, sourceDelivery: plan,
      text: '个人记忆审阅', memoryReview: { key, personId, identityId, entryId: result.id } };
    await claimOnce(path, packet);
    const original = await readRecord(path);
    queued.push(await enqueueSourceDelivery(original));
  }
  return queued;
}

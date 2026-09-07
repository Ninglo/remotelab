import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { canonicalJson, createRecordStore, readRecord, serialQueue, writeDurableJson } from '../lib/durable-records.mjs';

export const requestKey = (sessionId, requestId) => createHash('sha256')
  .update(JSON.stringify([sessionId, requestId])).digest('hex').slice(0, 24);

function withResult(current, result, plans) {
  const now = new Date().toISOString();
  return { ...current, result, settledAt: now, postCompletionPending: !current.options.deliveryOnly && !current.options.internalOperation, deliveries: plans.map((plan, index) => ({
    ...plan, id: `srcd_${current.key}_${index}`, responseId: current.responseId,
    sessionId: current.sessionId, runId: current.runId,
    state: 'pending', attempts: 0, availableAt: now, createdAt: now,
    leaseId: '', claimedAt: '', externalId: '', lastError: '',
  })) };
}

export function createRequestStore(root) {
  const records = createRecordStore(root);
  const admission = serialQueue();
  const get = records.get;
  const indexPath = (kind, scope, id) => join(root, 'lookup', kind, `${requestKey(scope, id)}.json`);
  const index = async (kind, scope, id, key) => {
    const path = indexPath(kind, scope, id);
    const previous = await readRecord(path);
    if (previous && previous.key !== key) throw new Error(`${kind} identity already belongs to another request`);
    if (!previous) await writeDurableJson(path, { key });
  };
  const lookup = async (kind, scope, id) => {
    const entry = await readRecord(indexPath(kind, scope, id));
    return entry ? get(entry.key) : null;
  };
  const accept = input => admission(async () => {
    const { sessionId, requestId, text, options = {}, images = [] } = input;
    if (!sessionId || !requestId || typeof text !== 'string' || (!text.trim() && images.length === 0)) throw new Error('sessionId, requestId and text or attachments are required');
    const key = requestKey(sessionId, requestId);
    const fingerprint = canonicalJson({ text, images, options, ...(input.result ? { result: input.result, plans: input.plans } : {}) });
    const previous = await get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('requestId already accepted with different content');
      return { record: previous, duplicate: true };
    }
    const counterPath = join(root, 'sequence.json');
    const sequence = ((await readRecord(counterPath))?.value || 0) + 1;
    await writeDurableJson(counterPath, { value: sequence });
    const initial = {
      key,
      sessionId, requestId, responseId: options.responseId || requestId,
      runId: input.runId || `run_${key}`, sequence, fingerprint, text, images, options,
      acceptedAt: new Date().toISOString(), result: null, releasedAt: null, deliveries: [],
    };
    // Indices are immutable addresses, published before the accepted record.
    // A crash can leave an unused address, but cannot accept an unfindable request.
    await index('response', sessionId, initial.responseId, key);
    await index('run', '', initial.runId, key);
    const record = await records.mutate(key, () => input.result ? withResult(initial, input.result, input.plans || []) : initial);
    return { record, duplicate: false };
  });
  return {
    get, accept, active: records.active, mutate: records.mutate,
    byRequest: (sessionId, requestId) => get(requestKey(sessionId, requestId)),
    byResponse: (sessionId, responseId) => lookup('response', sessionId, responseId),
    byRunId: runId => lookup('run', '', runId),
    settle: (key, result, plans = []) => records.mutate(key, current => {
      if (!current) throw new Error('Request not found');
      if (current.result) return current;
      return withResult(current, result, plans);
    }),
    archiveFinished: async key => {
      const record = await get(key);
      if (record?.result && !record.postCompletionPending && (record.releasedAt || record.options.deliveryOnly) && record.deliveries.every(x => ['delivered', 'delivery_failed', 'cancelled'].includes(x.state))) {
        await records.archive(key);
      }
    },
    idle: async () => { await admission.idle(); await records.idle(); },
  };
}

export const requests = createRequestStore(join(CONFIG_DIR, 'requests'));

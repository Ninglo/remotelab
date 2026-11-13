import { requests } from './requests.mjs';
import { loadHistory, appendEvent } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';
import { personalCodexFallbackText } from '../lib/codex-account-ownership.mjs';

// Deterministic transport notice, independent of model wording and reply
// visibility preferences. The existing durable outbox handles retries/receipts.
export async function publishPersonalCodexFallbackNotice(run, {
  store = requests, history = loadHistory, append = appendEvent, enqueue = enqueueSourceDelivery,
} = {}) {
  const fallback = run?.personalCodexFallback;
  if (!fallback || !run.requestId) return false;
  const record = await store.byRunId(run.id);
  if (!record || record.personalCodexFallbackNotice) return false;
  if (record.options?.codexAccountPolicy?.personId !== fallback.personId) return false;
  const source = 'personal_codex_fallback';
  const text = personalCodexFallbackText();
  const events = await history(run.sessionId, { includeBodies: false, deferFileDiffs: true });
  if (!events.some(e => e.source === source && e.requestId === record.requestId)) {
    await append(run.sessionId, messageEvent('system', text, undefined, {
      source, requestId: record.requestId, runId: run.id, channel: 'commentary',
      excludeFromModelContext: true,
    }));
  }
  const plan = record.options?.suppressSourceDelivery ? null : record.deliveryPlan || record.options?.sourceDelivery;
  const receipt = plan ? await enqueue({ sessionId: run.sessionId,
    responseId: `personal-codex-fallback:${run.id}`, sourceDelivery: plan, text }) : null;
  await store.mutate(record.key, current => ({ ...current, personalCodexFallbackNotice: {
    at: new Date().toISOString(), deliveryId: receipt?.id || null,
    personalAccountId: fallback.personalAccountId, reason: fallback.reason,
  } }));
  return true;
}

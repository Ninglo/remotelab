import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, createRecordStore, readRecord, serialQueue, writeDurableJson } from './durable-records.mjs';

export function createConnectorInbox(root, { process, conversationKey, onError = console.error,
  maxConcurrency = Infinity, archiveRetentionDays = 0, retryPolicy = null, onRetryExhausted = null, now = Date.now }) {
  const store = createRecordStore(root);
  const admission = serialQueue();
  let lastPruneDay = '';
  const archive = async key => {
    await store.archive(key);
    const at = now(), today = new Date(at).toISOString().slice(0, 10);
    if (archiveRetentionDays > 0 && lastPruneDay !== today) {
      lastPruneDay = today;
      try { await store.pruneArchive(at - archiveRetentionDays * 86400_000); }
      catch (error) { lastPruneDay = ''; onError(error); }
    }
  };
  const dispatch = serialQueue();
  const running = new Map();
  let timer = null;
  let started = false;
  let wakeQueued = false;
  let pendingTicks = 0;
  const wake = () => {
    if (!started || wakeQueued) return;
    wakeQueued = true;
    setImmediate(() => { wakeQueued = false; if (started) void tick(true).catch(onError); });
  };
  const finishExhausted = async record => {
    const notification = await onRetryExhausted?.(record);
    await store.mutate(record.key, current => ({ ...current, complete: true,
      receipt: { ...current.receipt, ...notification } }));
    await archive(record.key);
  };
  const consume = async record => {
    try {
      // An unfinished persisted attempt belongs to the previous process. Count
      // it once before either retrying the input or completing its notices.
      if (retryPolicy && record.attemptInFlight) record = await store.mutate(record.key, current => ({ ...current,
        attemptInFlight: false, crashAttempts: (current.crashAttempts || 0) + 1 }));
      if (record.receipt?.retryExhausted) return await finishExhausted(record);
      const policy = retryPolicy?.(null, record);
      if (policy && (record.attempts >= policy.maxAttempts || record.crashAttempts >= policy.maxCrashAttempts))
        throw new Error('Persisted retry attempt limit reached');
      if (retryPolicy) record = await store.mutate(record.key, current => ({ ...current,
        attempts: (current.attempts || 0) + 1, attemptInFlight: true, lastAttemptAt: now() }));
      const receipt = await process(record, patch => store.mutate(record.key, current => ({ ...current, ...patch })));
      await store.mutate(record.key, current => ({ ...current, attemptInFlight: false, receipt: receipt || {}, complete: true }));
      await archive(record.key);
    } catch (error) {
      // Notification transport can retry, but an exhausted input never executes
      // again. Its stable notification IDs are owned by the existing outbox.
      const current = await store.get(record.key);
      if (current.receipt?.retryExhausted) {
        await store.mutate(record.key, value => ({ ...value, nextAttemptAt: now() + 5000,
          notificationError: error.message }));
        onError(error);
        return;
      }
      const retry = retryPolicy?.(error, record);
      const exhausted = retry && (record.attempts >= retry.maxAttempts || record.crashAttempts >= retry.maxCrashAttempts);
      if (error.retryable === false || retry?.retryable === false || exhausted) {
        record = await store.mutate(record.key, value => ({ ...value, attemptInFlight: false,
          complete: !exhausted, lastError: error.message, receipt: { failed: true, permanent: !exhausted,
            ...(exhausted ? { retryExhausted: true } : {}), error: error.message } }));
        if (exhausted) {
          try { await finishExhausted(record); }
          catch (notificationError) {
            await store.mutate(record.key, value => ({ ...value, nextAttemptAt: now() + 5000,
              notificationError: notificationError.message }));
            onError(notificationError);
          }
        } else await archive(record.key);
        onError(error);
        return;
      }
      await store.mutate(record.key, value => ({ ...value, attemptInFlight: false, lastError: error.message,
        nextAttemptAt: now() + (retry?.delayMs ?? 5000) }));
      onError(error);
    }
  };
  const tick = (automatic = false) => {
    pendingTicks++;
    return dispatch(async () => {
      if (automatic && !started) return;
      clearTimeout(timer); timer = null;
      let nextAttemptAt = Infinity;
      const seen = new Set();
      for (const snapshot of await store.active()) {
        if (running.size >= maxConcurrency) break;
        const key = conversationKey(snapshot);
        if (seen.has(key)) continue;
        if (running.has(key)) { seen.add(key); continue; }
        // A previous consumer can finish while the directory scan is reading.
        // Recheck the durable receipt before starting work from that snapshot.
        const record = await store.get(snapshot.key);
        if (!record) continue;
        if (record.complete) { await store.archive(record.key); continue; }
        seen.add(key);
        if (record.nextAttemptAt > now()) { nextAttemptAt = Math.min(nextAttemptAt, record.nextAttemptAt); continue; }
        if (automatic && !started) return;
        const promise = consume(record).catch(onError).finally(() => {
          running.delete(key);
          wake();
        });
        running.set(key, promise);
      }
      if (started && Number.isFinite(nextAttemptAt)) {
        timer = setTimeout(wake, Math.max(0, nextAttemptAt - now())); timer.unref?.();
      }
    }).catch(error => {
      // A transient storage failure must not strand an accepted inbox after
      // its only wake-up. Retry this failed scan, without polling healthy idle state.
      if (started) {
        clearTimeout(timer);
        timer = setTimeout(wake, 5000); timer.unref?.();
      }
      throw error;
    }).finally(() => { pendingTicks--; });
  };
  return {
    store, tick,
    accept: (id, envelope) => admission(async () => {
      if (!id) throw new Error('Upstream event id is required');
      const key = createHash('sha256').update(id).digest('hex').slice(0, 24);
      const fingerprint = canonicalJson(envelope.summary || envelope);
      const existing = await store.get(key);
      if (existing) {
        // Legacy handled receipts predate complete event fingerprints. They reserve
        // the upstream ID without executing a replay with newly added fields.
        if (existing.id === id && existing.complete && existing.legacyReceiptImported
          && existing.receipt?.legacyHandledMessageId === id) return existing;
        if (existing.fingerprint !== fingerprint) throw new Error('Upstream event id already accepted with different content');
        if (!existing.complete) wake();
        return existing;
      }
      const counter = join(root, 'sequence.json');
      const sequence = ((await readRecord(counter))?.value || 0) + 1;
      await writeDurableJson(counter, { value: sequence });
      const record = await store.mutate(key, () => ({ ...envelope, fingerprint, sequence, id, complete: false, nextAttemptAt: 0 }));
      wake();
      return record;
    }),
    // Admission/completion wake dispatch; one due-time timer handles retries.
    // completed HTTP handoffs do not wait for it or for any model response.
    start() { if (!started) { started = true; wake(); } },
    stop() { started = false; clearTimeout(timer); timer = null; },
    async idle() {
      await admission.idle();
      do {
        if (wakeQueued) await new Promise(setImmediate);
        await dispatch.idle();
        await Promise.all(running.values());
        await store.idle();
      } while (wakeQueued || pendingTicks || running.size);
    },
  };
}

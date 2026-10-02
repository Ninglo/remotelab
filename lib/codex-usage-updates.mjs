import { codexAccounts } from './codex-accounts.mjs';

// The controller owns this best-effort sink. Runners only write their ordinary
// durable spool; no task output/completion awaits quota-cache persistence.
export function createCodexUsageUpdates({ pool = codexAccounts, now = Date.now,
  onError = () => console.warn('[codex-accounts] Background quota cache update failed') } = {}) {
  const samples = new Map(), failures = new Map();
  let scheduled = null, flushing = null;
  const report = () => { try { onError(); } catch { /* Diagnostics cannot fail a turn either. */ } };
  const schedule = () => {
    if (scheduled || flushing) return;
    scheduled = setImmediate(() => { scheduled = null; void flush(); });
  };
  const reserveSample = sample => sample.usage?.status === 'ready'
    && (sample.usage.buckets || []).some(bucket => bucket.id === 'codex'
      && [bucket.primary, bucket.secondary].some(window => Number.isFinite(window?.remainingPercent)
        && window.remainingPercent >= 0 && window.remainingPercent <= 10));
  function enqueue(id, event, checkedAt) {
    if (!id || !event) return;
    const stamp = Date.parse(checkedAt || '');
    if (!Number.isFinite(stamp) || stamp > now() + 5000) return;
    if (event.type === 'remotelab.codex_usage') {
      if (!Array.isArray(event.usage?.buckets)) return;
      const sample = { id, usage: event.usage, checkedAt };
      const previous = samples.get(id);
      if (previous && stamp < Date.parse(previous.latest.checkedAt)) return;
      // Keep a reserve crossing as well as the latest sample. Batching must not
      // hide a low-quota notification behind another concurrent response.
      samples.set(id, { latest: sample, reserve: reserveSample(sample) ? sample : previous?.reserve });
    } else if (event.type === 'remotelab.codex_quota_exhausted') {
      if (now() - stamp > 60_000) return;
      failures.set(id, { id, model: event.model || '', checkedAt });
    } else return;
    schedule();
  }
  function flush() {
    if (scheduled) { clearImmediate(scheduled); scheduled = null; }
    if (flushing) return flushing;
    flushing = (async () => {
      while (samples.size || failures.size) {
        const batch = [...samples.values()].flatMap(({ latest, reserve }) =>
          reserve && reserve !== latest ? [reserve, latest] : [latest]);
        const exhausted = [...failures.values()];
        samples.clear(); failures.clear();
        if (batch.length) {
          try { await pool.observeUsages(batch); } catch { report(); }
        }
        for (const entry of exhausted) {
          try { await pool.markExhausted(entry.id, entry.model, { checkedAt: entry.checkedAt }); }
          catch { report(); }
        }
      }
    })().finally(() => { flushing = null; if (samples.size || failures.size) schedule(); });
    return flushing;
  }
  return { enqueue, flush };
}

export const codexUsageUpdates = createCodexUsageUpdates();

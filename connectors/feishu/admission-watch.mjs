import { FEISHU_ADMISSION_BUDGET_MS, FEISHU_ADMISSION_TIMEOUT, observeRecentError } from '../../lib/recent-errors.mjs';

// These observations cover routed human tasks, not ignored chatter, Bot events,
// or the time spent generating a reply. The durable Inbox still owns retries.
export async function watchFeishuAdmission(operation, action, {
  startedAt, now = Date.now, thresholdMs = FEISHU_ADMISSION_BUDGET_MS,
  observe = observeRecentError,
} = {}) {
  const remaining = Math.max(0, thresholdMs - (now() - startedAt));
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    void Promise.resolve().then(() => observe('feishu-inbox', { operation, attempt: 'admission-deadline',
      error: new Error(FEISHU_ADMISSION_TIMEOUT) })).catch(() => {});
  };
  const timer = setTimeout(report, remaining);
  timer.unref?.();
  try { return await action(); }
  finally {
    clearTimeout(timer);
    // Catch delays where the event loop could not fire the timer on time.
    if (now() - startedAt >= thresholdMs) report();
  }
}

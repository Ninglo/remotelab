// Read/reconciliation retries only. Uncertain provider writes still require
// their own durable receipt and must never use this as permission to resend.
export function feishuReadRetryPolicy(error, record = {}) {
  const code = Number(error?.code ?? error?.feishuCode ?? error?.response?.data?.code) || 0;
  const status = Number(error?.httpStatus ?? error?.response?.status) || 0;
  const transient = code === 99991400 || [408, 425, 429].includes(status) || status >= 500;
  // Do not freeze a binding for an unfamiliar business error: it may be a
  // temporary provider failure or an expired token refreshed by the SDK.
  const permanent = [99991672, 1061004].includes(code)
    || (status >= 400 && status < 500 && !transient);
  const retryable = error?.retryable !== false && !permanent;
  return { retryable, maxAttempts: 5,
    delayMs: Math.max(Math.min(300_000, 5000 * 2 ** Math.min(6, Math.max(0, (record.attempts || 1) - 1))),
      Math.min(3_600_000, Math.max(0, Number(error?.retryAfterMs) || 0))) };
}

import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { createFeishuApiLogger } from './feishu-api-log.mjs';

// The Feishu SDK uses verb helpers during token acquisition as well as request().
// Keep every supported entry point behind the same bounded transport.
function safeTransportError(error) {
  // The SDK logs rejected errors verbatim. Axios errors contain authenticated
  // request headers, so expose only the provider's diagnostic fields.
  const data = error?.response?.data;
  const code = typeof data?.code === 'number' ? data.code : error?.code;
  const status = error?.response?.status;
  const message = typeof data?.msg === 'string' ? data.msg : 'Feishu transport request failed';
  const safe = new Error(`${status ? `HTTP ${status}: ` : ''}${message}`);
  safe.code = typeof code === 'number' || typeof code === 'string' ? code : null;
  if (Number.isInteger(status)) safe.httpStatus = status;
  if (error?.response) safe.response = { status, data: { code: data?.code, msg: data?.msg } };
  const logId = data?.error?.log_id || data?.log_id || error?.response?.headers?.['x-tt-logid'];
  if (typeof logId === 'string') safe.logId = logId;
  const retryAfter = Number(error?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) safe.retryAfterMs = Math.min(3_600_000, retryAfter * 1000);
  return safe;
}

export function createFeishuHttpInstance(httpInstance, timeoutMs = 30000, audit = null) {
  const logger = audit?.logger || (audit ? createFeishuApiLogger(audit) : null);
  const fingerprintKey = randomBytes(32);
  const fingerprint = value => createHmac('sha256', fingerprintKey).update(JSON.stringify(value)).digest('hex');
  const request = (options = {}) => {
    const timeout = Number(options.timeout) > 0
      ? Math.min(Number(options.timeout), timeoutMs)
      : timeoutMs;
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const requestId = randomUUID(), startedAt = Date.now();
    let dispatched = false, settled = false;
    const record = (value, error, aborted = false) => {
      if (settled) return; settled = true;
      if (!dispatched || !logger) return;
      const body = value?.data?.code !== undefined ? value.data : value;
      // Compare unchanged reads within this process without storing resource
      // IDs, queries or response text. Authentication and writes are excluded.
      let readFingerprint, dataFingerprint;
      if (String(options.method || 'GET').toUpperCase() === 'GET' && body?.code === 0 && body?.data !== undefined
        && !/\/(auth|authen|oauth)\//.test(String(options.url))) {
        try {
          readFingerprint = fingerprint({ url: options.url, params: options.params || null });
          dataFingerprint = fingerprint(body.data);
        } catch { /* Unsupported response shapes keep ordinary accounting. */ }
      }
      try { void Promise.resolve(logger.record({ ts: new Date(startedAt).toISOString(), requestId,
        method: String(options.method || 'GET').toUpperCase(), url: options.url,
        durationMs: Date.now() - startedAt, httpStatus: error?.response?.status ?? value?.status,
        code: error?.response?.data?.code ?? body?.code,
        outcome: aborted ? 'aborted' : error ? 'transport_error' : body?.code === 0 ? 'success'
          : body?.code !== undefined ? 'business_error' : 'unknown',
        errorCode: error?.code, logId: error?.logId || error?.response?.data?.error?.log_id
          || error?.response?.headers?.['x-tt-logid'] || body?.error?.log_id || body?.log_id
          || value?.headers?.['x-tt-logid'],
        readFingerprint, dataFingerprint,
      })).catch(() => {}); } catch { /* Logging cannot change request settlement. */ }
    };
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); record(null, signal.reason, true); reject(signal.reason || new Error('Feishu request aborted')); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      // Bound settlement even when an SDK/transport forgets to honor abort.
      Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason;
        dispatched = true;
        return httpInstance.request({ ...options, timeout, signal });
      }).then(value => { cleanup(); record(value); resolve(value); }, error => {
        cleanup(); record(null, error); reject(safeTransportError(error));
      });
    });
  };
  const withoutBody = method => (url, options = {}) => request({ ...options, url, method });
  const withBody = method => (url, data, options = {}) => request({ ...options, url, method, data });
  return {
    flushLog: async () => { await logger?.flush(); },
    request,
    get: withoutBody('GET'),
    delete: withoutBody('DELETE'),
    head: withoutBody('HEAD'),
    options: withoutBody('OPTIONS'),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
  };
}

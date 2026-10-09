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
  return safe;
}

export function createFeishuHttpInstance(httpInstance, timeoutMs = 30000) {
  const request = (options = {}) => {
    const timeout = Number(options.timeout) > 0
      ? Math.min(Number(options.timeout), timeoutMs)
      : timeoutMs;
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(signal.reason || new Error('Feishu request aborted')); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      // Bound settlement even when an SDK/transport forgets to honor abort.
      Promise.resolve().then(() => httpInstance.request({ ...options, timeout, signal }))
        .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(safeTransportError(error)); });
    });
  };
  const withoutBody = method => (url, options = {}) => request({ ...options, url, method });
  const withBody = method => (url, data, options = {}) => request({ ...options, url, method, data });
  return {
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

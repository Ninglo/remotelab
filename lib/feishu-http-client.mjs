// The Feishu SDK uses verb helpers during token acquisition as well as request().
// Keep every supported entry point behind the same bounded transport.
export function createFeishuHttpInstance(httpInstance, timeoutMs = 30000) {
  const request = (options = {}) => {
    const timeout = Number(options.timeout) > 0
      ? Math.min(Number(options.timeout), timeoutMs)
      : timeoutMs;
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    return httpInstance.request({ ...options, timeout, signal });
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

// Keep platform rejection evidence without serializing SDK request headers.
export function feishuResponseError(response, fallback) {
  return Object.assign(new Error(response?.msg || fallback), {
    feishuCode: response?.code,
  });
}

export function classifyFeishuDeliveryError(error) {
  const status = Number(error?.response?.status) || 0;
  const code = Number(error?.feishuCode ?? error?.response?.data?.code) || 0;
  const detail = error?.response?.data?.msg || error?.message || String(error);
  // A structured Feishu 4xx/business rejection proves no message was accepted.
  // Gateway failures, timeouts and missing success receipts do not prove that.
  const rejected = code !== 0 && status < 500 && status !== 408;
  const definiteFailure = error?.definiteFailure === true || rejected;
  return {
    error: code ? `Feishu ${code}: ${detail}` : String(detail),
    safeToRetry: status === 429 || (!definiteFailure && error?.deliveryPhase === 'prepare'),
    definiteFailure,
  };
}

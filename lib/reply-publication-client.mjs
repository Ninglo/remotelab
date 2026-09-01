function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function createReplyPublicationLoadError(result, responseId) {
  const status = Number(result?.response?.status) || 0;
  const error = new Error(
    result?.json?.error
      || result?.text
      || `Failed to load reply publication ${responseId}`,
  );
  error.status = status || null;
  error.retryable = TRANSIENT_HTTP_STATUSES.has(status);
  return error;
}

export function isTransientReplyPublicationError(error) {
  let current = error;
  const visited = new Set();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (current.retryable === true) return true;
    if (TRANSIENT_HTTP_STATUSES.has(Number(current.status || current.statusCode))) return true;
    if (TRANSIENT_NETWORK_CODES.has(trimString(current.code).toUpperCase())) return true;
    if (current instanceof TypeError && /^fetch failed$/i.test(trimString(current.message))) return true;
    current = current.cause;
  }
  return false;
}

export function isTerminalReplyPublicationState(state) {
  const normalized = trimString(state).toLowerCase();
  return normalized === 'ready' || normalized === 'failed' || normalized === 'cancelled';
}

export async function loadReplyPublication(requester, sessionId, responseId) {
  const result = await requester(`/api/sessions/${sessionId}/responses/${encodeURIComponent(responseId)}`);
  if (result?.response?.status === 404) {
    return null;
  }
  if (!result.response?.ok || !result.json?.replyPublication) {
    throw createReplyPublicationLoadError(result, responseId);
  }
  return result.json.replyPublication;
}

export async function waitForReplyPublication(requester, sessionId, responseId, {
  timeoutMs = 60_000,
  intervalMs = 500,
} = {}) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const deadline = hasTimeout ? Date.now() + timeoutMs : 0;
  const pollIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 500;
  let publication = null;
  while (!hasTimeout || Date.now() < deadline) {
    try {
      publication = await loadReplyPublication(requester, sessionId, responseId);
    } catch (error) {
      if (!isTransientReplyPublicationError(error)) throw error;
    }
    if (publication && isTerminalReplyPublicationState(publication.state)) {
      return publication;
    }
    const waitMs = hasTimeout
      ? Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))
      : pollIntervalMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`reply publication timed out after ${timeoutMs}ms`);
}

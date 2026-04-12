function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isTerminalReplyPublicationState(state) {
  const normalized = trimString(state).toLowerCase();
  return normalized === 'ready' || normalized === 'failed' || normalized === 'cancelled';
}

export async function loadReplyPublication(requester, sessionId, responseId) {
  const result = await requester(`/api/sessions/${sessionId}/responses/${encodeURIComponent(responseId)}`);
  if (result.response?.status === 404) {
    return null;
  }
  if (!result.response.ok || !result.json?.replyPublication) {
    throw new Error(result.json?.error || result.text || `Failed to load reply publication ${responseId}`);
  }
  return result.json.replyPublication;
}

export async function waitForReplyPublication(requester, sessionId, responseId, {
  timeoutMs = 60_000,
  intervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let publication = null;
  while (Date.now() < deadline) {
    publication = await loadReplyPublication(requester, sessionId, responseId);
    if (publication && isTerminalReplyPublicationState(publication.state)) {
      return publication;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`reply publication timed out after ${timeoutMs}ms`);
}

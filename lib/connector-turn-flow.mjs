import { waitForReplyPublication } from './reply-publication-client.mjs';
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from './reply-selection.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function createConnectorSession(requester, payload, options = {}) {
  const forkFromSessionId = trimString(options.forkFromSessionId);
  if (forkFromSessionId) {
    const forkResult = await requester(`/api/sessions/${encodeURIComponent(forkFromSessionId)}/fork`, {
      method: 'POST',
      body: payload,
    });
    if (forkResult.response?.ok && forkResult.json?.session?.id) {
      return forkResult.json.session;
    }
    if (options.fallbackCreateOnForkFailure !== true) {
      throw new Error(forkResult.json?.error || forkResult.text || `Failed to fork connector session (${forkResult.response?.status || 'unknown'})`);
    }
  }

  const result = await requester('/api/sessions', {
    method: 'POST',
    body: payload,
  });
  if (!result.response?.ok || !result.json?.session?.id) {
    throw new Error(result.json?.error || result.text || `Failed to create session (${result.response?.status || 'unknown'})`);
  }
  return result.json.session;
}

export async function submitConnectorMessage(requester, sessionId, payload) {
  const result = await requester(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: payload,
  });
  if (![200, 202].includes(result.response?.status)) {
    throw new Error(result.json?.error || result.text || `Failed to submit session message (${result.response?.status || 'unknown'})`);
  }
  return {
    requestId: payload.requestId,
    responseId: trimString(result.json?.response?.id) || payload.requestId,
    runId: trimString(result.json?.run?.id) || null,
    duplicate: result.json?.duplicate === true,
    queued: result.json?.queued === true,
    raw: result.json || null,
  };
}

export async function waitForConnectorPublication(requester, sessionId, responseId, {
  timeoutMs = 60_000,
  intervalMs = 500,
} = {}) {
  return waitForReplyPublication(requester, sessionId, responseId, {
    timeoutMs,
    intervalMs,
  });
}

export function normalizeConnectorPublicationText(publication) {
  return stripHiddenBlocks(String(publication?.payload?.text || '').replace(/\r\n/g, '\n')).trim();
}

export async function loadConnectorAssistantReply(requester, sessionId, {
  runId = '',
  requestId = '',
  eventsPath = `/api/sessions/${sessionId}/events`,
  eventBodyPath = (seq) => `/api/sessions/${sessionId}/events/${seq}/body`,
  match = null,
} = {}) {
  const eventsResult = await requester(eventsPath);
  if (!eventsResult.response?.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const selected = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: typeof match === 'function'
      ? match
      : (event) => (
        (runId && trimString(event?.runId) === trimString(runId))
        || (requestId && trimString(event?.requestId) === trimString(requestId))
      ),
    hydrate: async (event) => {
      if (!event?.bodyAvailable || event.bodyLoaded !== false || trimString(event.content)) {
        return event;
      }
      const bodyResult = await requester(eventBodyPath(event.seq));
      if (!bodyResult.response?.ok || bodyResult.json?.body?.value === undefined) {
        return event;
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      };
    },
  });

  if (!selected) return null;
  return {
    ...selected,
    normalizedContent: stripHiddenBlocks([
      selected.content || '',
      buildAssistantReplyAttachmentFallbackText(selected),
    ].filter(Boolean).join('\n\n')).trim(),
  };
}

export async function runConnectorTurn({
  requester,
  sessionPayload,
  messagePayload,
  prepareSession = async (session) => session,
  timeoutMs = 60_000,
  intervalMs = 500,
} = {}) {
  const session = await createConnectorSession(requester, sessionPayload);
  const readySession = await prepareSession(session);
  const submission = await submitConnectorMessage(requester, readySession.id, messagePayload);
  const publication = await waitForConnectorPublication(requester, readySession.id, submission.responseId, {
    timeoutMs,
    intervalMs,
  });
  return {
    session: readySession,
    submission,
    publication,
  };
}

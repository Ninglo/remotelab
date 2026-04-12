import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { setTimeout as delay } from 'timers/promises'

import { AUTH_FILE } from '../lib/config.mjs'
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs'
import { waitForReplyPublication } from '../lib/reply-publication-client.mjs'

const RUN_POLL_INTERVAL_MS = 1500
const RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '')
}

function sanitizeIdPart(value, fallback = 'default') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function buildExternalTriggerId(summary, config = {}) {
  const connectorId = trimString(summary?.connectorId || config.connectorId || summary?.roomName || config.roomName)
  const baseId = `voice:${sanitizeIdPart(connectorId, 'main')}`
  if (trimString(config.sessionMode).toLowerCase() === 'per-wake') {
    const eventPart = sanitizeIdPart(summary?.eventId || randomUUID())
    return `${baseId}:${eventPart}`
  }
  return baseId
}

function buildRequestId(summary, config = {}) {
  const triggerId = buildExternalTriggerId(summary, config)
  const eventPart = sanitizeIdPart(summary?.eventId || randomUUID())
  return `${triggerId}:${eventPart}`
}

function buildSessionName(config, summary) {
  if (trimString(config.sessionName)) return config.sessionName
  return trimString(summary?.roomName || config.roomName || summary?.connectorId || config.connectorId)
}

function buildSessionDescription(config, summary) {
  if (trimString(config.description)) return config.description
  const parts = ['Wake-word voice connector']
  const roomName = trimString(summary?.roomName || config.roomName)
  const wakeWord = trimString(summary?.wakeWord || config.wake?.keyword)
  if (roomName) parts.push(`room ${roomName}`)
  if (wakeWord) parts.push(`wake ${wakeWord}`)
  return parts.join(' · ')
}

function buildRemoteLabMessage(summary) {
  return trimString(summary?.transcript)
}

function normalizeSpokenReplyText(text) {
  return stripHiddenBlocks(String(text || '').replace(/\r\n/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  const token = trimString(auth?.token)
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`)
  }
  return token
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  })
  const setCookie = response.headers.get('set-cookie')
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`)
  }
  return setCookie.split(';')[0]
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  }
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })

  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}

  return { response, json, text }
}

async function loadAssistantReply(requester, sessionId, runId, requestId) {
  const eventsResult = await requester(`/api/sessions/${sessionId}/events`)
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`)
  }

  const candidate = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => (
      (runId && event.runId === runId)
      || (requestId && event.requestId === requestId)
    ),
    hydrate: async (event) => {
      const bodyResult = await requester(`/api/sessions/${sessionId}/events/${event.seq}/body`)
      if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
        return event
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      }
    },
  })
  return candidate || null
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie
  }
  if (forceRefresh) {
    runtime.authCookie = ''
    runtime.authToken = ''
  }
  if (!runtime.authToken) {
    runtime.authToken = typeof runtime.readOwnerToken === 'function'
      ? await runtime.readOwnerToken()
      : await readOwnerToken()
  }
  const login = typeof runtime.loginWithToken === 'function' ? runtime.loginWithToken : loginWithToken
  runtime.authCookie = await login(runtime.config.chatBaseUrl, runtime.authToken)
  return runtime.authCookie
}

async function requestRemoteLab(runtime, path, options = {}) {
  const cookie = await ensureAuthCookie(runtime, false)
  let result = await requestJson(runtime.config.chatBaseUrl, path, { ...options, cookie })
  if ([401, 403].includes(result.response.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true)
    result = await requestJson(runtime.config.chatBaseUrl, path, { ...options, cookie: refreshedCookie })
  }
  return result
}

async function createOrReuseSession(runtime, summary) {
  const payload = {
    folder: runtime.config.sessionFolder,
    tool: runtime.config.sessionTool,
    name: buildSessionName(runtime.config, summary),
    sourceId: 'voice',
    sourceName: runtime.config.appName,
    group: runtime.config.group,
    description: buildSessionDescription(runtime.config, summary),
    systemPrompt: runtime.config.systemPrompt,
    externalTriggerId: buildExternalTriggerId(summary, runtime.config),
  }
  const result = await requestRemoteLab(runtime, '/api/sessions', {
    method: 'POST',
    body: payload,
  })
  if (!result.response.ok || !result.json?.session?.id) {
    throw new Error(result.json?.error || result.text || `Failed to create session (${result.response.status})`)
  }
  return result.json.session
}

async function submitRemoteLabMessage(runtime, sessionId, summary) {
  const payload = {
    requestId: buildRequestId(summary, runtime.config),
    text: buildRemoteLabMessage(summary),
    tool: runtime.config.sessionTool,
    thinking: runtime.config.thinking === true,
  }
  if (runtime.config.model) payload.model = runtime.config.model
  if (runtime.config.effort) payload.effort = runtime.config.effort

  const result = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: payload,
  })
  const queued = result.json?.queued === true
  const duplicate = result.json?.duplicate === true
  const runId = trimString(result.json?.run?.id)
  if (![200, 202].includes(result.response.status) || (!runId && !queued && !duplicate)) {
    throw new Error(result.json?.error || result.text || `Failed to submit session message (${result.response.status})`)
  }

  return {
    requestId: payload.requestId,
    runId: runId || null,
    queued,
    duplicate,
  }
}

async function waitForRunCompletion(runtime, runId) {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await requestRemoteLab(runtime, `/api/runs/${runId}`)
    if (!result.response.ok || !result.json?.run) {
      throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`)
    }
    const run = result.json.run
    if (run.state === 'completed') {
      return run
    }
    if (['failed', 'cancelled'].includes(run.state)) {
      throw new Error(`run ${run.state}`)
    }
    await delay(RUN_POLL_INTERVAL_MS)
  }
  throw new Error(`run timed out after ${RUN_POLL_TIMEOUT_MS}ms`)
}

async function generateRemoteLabReply(runtime, summary) {
  const session = await createOrReuseSession(runtime, summary)
  const submission = await submitRemoteLabMessage(runtime, session.id, summary)
  if (!submission.runId && submission.duplicate) {
    return {
      sessionId: session.id,
      runId: '',
      requestId: submission.requestId,
      duplicate: true,
      replyText: '',
      silent: true,
    }
  }
  const publication = await waitForReplyPublication(
    (path) => requestRemoteLab(runtime, path),
    session.id,
    submission.requestId,
    {
      timeoutMs: RUN_POLL_TIMEOUT_MS,
      intervalMs: RUN_POLL_INTERVAL_MS,
    },
  )
  if (publication.state !== 'ready') {
    throw new Error(`reply publication ${publication.state || 'failed'}`)
  }
  const replyText = normalizeSpokenReplyText(publication.payload?.text || '')
  const finalizedRunId = trimString(publication.finalRunId) || submission.runId || ''
  return {
    sessionId: session.id,
    runId: finalizedRunId,
    requestId: submission.requestId,
    duplicate: submission.duplicate,
    replyText,
    silent: !replyText,
  }
}

export {
  buildExternalTriggerId,
  buildRemoteLabMessage,
  ensureAuthCookie,
  generateRemoteLabReply,
  loginWithToken,
  normalizeSpokenReplyText,
  readOwnerToken,
}

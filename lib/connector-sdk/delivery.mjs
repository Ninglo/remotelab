/**
 * Delivery — send messages to RemoteLab instances via HTTP API.
 *
 * Handles session creation/reuse, message submission, retry, and dead letter.
 * Uses the existing external-message-protocol.md HTTP contract:
 *   POST /api/sessions (create/reuse)
 *   POST /api/sessions/:id/messages (submit message)
 */

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const RETRY_DELAYS = [5000, 15000, 60000]

async function httpPost(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, ok: res.ok, body: json }
}

/**
 * Deliver a normalized message to a target instance.
 *
 * @param {object} target - { instanceUrl, token } from dispatch table entry
 * @param {object} message - normalized message with from, to, content, sourceContext, etc.
 * @param {object} options - { channel, tool }
 * @returns {object} - { delivered, sessionId, runId, error }
 */
export async function deliverToInstance(target, message, options = {}) {
  const { instanceUrl, token } = target
  const { channel = 'connector', tool = 'claude' } = options

  const externalTriggerId = message.thread?.externalId
    || `${channel}:${message.id}`

  let sessionRes
  try {
    // Step 1: Create or reuse session
    sessionRes = await httpPost(`${instanceUrl}/api/sessions`, {
      folder: '~',
      tool,
      sourceId: channel,
      sourceName: options.sourceName || channel,
      externalTriggerId,
      group: options.group || channel,
      description: options.description || '',
    }, token)
  } catch (err) {
    return { delivered: false, error: 'session_create_failed', message: err.message }
  }

  if (!sessionRes.ok) {
    return { delivered: false, error: `session_create_failed`, status: sessionRes.status, detail: sessionRes.body }
  }

  const sessionId = sessionRes.body.id || sessionRes.body.sessionId

  // Step 2: Submit message
  const text = formatMessageText(message, channel)
  let msgRes
  try {
    msgRes = await httpPost(`${instanceUrl}/api/sessions/${sessionId}/messages`, {
      requestId: message.id,
      text,
      sourceContext: message.sourceContext || {},
    }, token)
  } catch (err) {
    return { delivered: false, sessionId, error: 'message_submit_failed', message: err.message }
  }

  if (!msgRes.ok) {
    return { delivered: false, sessionId, error: 'message_submit_failed', status: msgRes.status, detail: msgRes.body }
  }

  return {
    delivered: true,
    sessionId,
    runId: msgRes.body.run?.id || null,
    duplicate: msgRes.body.duplicate || false,
  }
}

/**
 * Deliver with retry. On permanent failure, write to dead letter queue.
 */
export async function deliverWithRetry(target, message, options = {}) {
  let lastError = null

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]))
    }
    try {
      const result = await deliverToInstance(target, message, options)
      if (result.delivered || result.status === 200) return result
      // 4xx (except 429) is not retryable
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        lastError = result
        break
      }
      lastError = result
    } catch (err) {
      lastError = { delivered: false, error: 'network_error', message: err.message }
    }
  }

  return { delivered: false, ...lastError, retriesExhausted: true }
}

/**
 * Write a failed message to the dead letter queue.
 */
export function writeDeadLetter(stateDir, message, target, error) {
  const dlDir = join(stateDir, 'dead_letter')
  if (!existsSync(dlDir)) mkdirSync(dlDir, { recursive: true })

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const entry = {
    originalMessage: message,
    targetInstanceId: target.instanceId || 'unknown',
    failureReason: error.error || 'unknown',
    lastError: error.message || error.detail || null,
    retryCount: RETRY_DELAYS.length,
    failedAt: new Date().toISOString(),
  }
  const tmp = join(dlDir, `${id}.tmp`)
  const dst = join(dlDir, `${id}.json`)
  writeFileSync(tmp, JSON.stringify(entry, null, 2))
  renameSync(tmp, dst)
  return dst
}

/**
 * Format the text body for message submission.
 * Follows the preface pattern from external-message-protocol.md.
 */
function formatMessageText(message, channel) {
  const lines = []
  if (channel) lines.push(`Source: ${channel}`)
  if (message.from?.address) lines.push(`From: ${message.from.address}`)
  if (message.from?.name) lines.push(`Name: ${message.from.name}`)
  if (message.content?.subject) lines.push(`Subject: ${message.content.subject}`)
  if (message.createdAt) lines.push(`Date: ${message.createdAt}`)
  lines.push('')
  lines.push(message.content?.body || '')
  return lines.join('\n')
}

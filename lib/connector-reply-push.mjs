/**
 * Connector Reply Push — instance-side module that pushes AI replies to connectors.
 *
 * When a session run completes and the session was created by a connector (has sourceId
 * and sourceContext), this module extracts the assistant reply and POSTs it to the
 * connector's callback URL.
 *
 * Integration: called from session-turn-completion or connector-action-dispatcher
 * after a run reaches terminal state.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const RETRY_DELAYS = [5000, 15000, 60000]

/**
 * Registry of connector callbacks. Populated when an instance registers with connectors.
 * Maps sourceId → { replyUrl, token }
 */
let callbackRegistry = {}
let registryPath = null

export function initCallbackRegistry(configDir) {
  registryPath = join(configDir, 'connector-callbacks.json')
  if (existsSync(registryPath)) {
    try {
      callbackRegistry = JSON.parse(readFileSync(registryPath, 'utf8'))
    } catch { callbackRegistry = {} }
  }
}

export function registerCallback(sourceId, { replyUrl, token }) {
  callbackRegistry[sourceId] = { replyUrl, token }
  if (registryPath) {
    const tmp = registryPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(callbackRegistry, null, 2))
    renameSync(tmp, registryPath)
  }
}

export function getCallback(sourceId) {
  return callbackRegistry[sourceId] || null
}

/**
 * Push an AI reply to the connector that created this session.
 *
 * @param {object} session - Session object with sourceId, externalTriggerId, sourceContext
 * @param {object} replyContent - { body, html?, attachments? }
 * @returns {object} - { pushed, error? }
 */
export async function pushReplyToConnector(session, replyContent) {
  const sourceId = session.sourceId
  if (!sourceId) return { pushed: false, error: 'no_sourceId' }

  const callback = getCallback(sourceId)
  if (!callback) return { pushed: false, error: 'no_callback_registered', sourceId }

  // Build the sourceContext from session metadata
  const sourceContext = session.sourceContext || session.lastSourceContext || {}

  const payload = {
    instanceId: session.instanceId || 'default',
    sessionId: session.id,
    externalTriggerId: session.externalTriggerId || '',
    sourceContext,
    reply: {
      body: replyContent.body || '',
      html: replyContent.html || null,
      attachments: replyContent.attachments || [],
    },
  }

  return await pushWithRetry(callback, payload)
}

async function pushWithRetry(callback, payload) {
  let lastError = null

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]))
    }
    try {
      const res = await fetch(callback.replyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${callback.token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      })

      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        return { pushed: true, ...body }
      }

      const text = await res.text().catch(() => '')
      lastError = { status: res.status, message: text }

      // 4xx (except 429) is not retryable
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break
    } catch (err) {
      lastError = { message: err.message }
    }
  }

  return { pushed: false, error: 'reply_push_failed', ...lastError }
}

/**
 * Save a failed reply to the pending queue for later retry.
 */
export function savePendingReply(configDir, session, replyContent) {
  const dir = join(configDir, 'connector-pending-replies')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const entry = {
    sessionId: session.id,
    sourceId: session.sourceId,
    externalTriggerId: session.externalTriggerId,
    sourceContext: session.sourceContext || {},
    reply: replyContent,
    createdAt: new Date().toISOString(),
  }

  const tmp = join(dir, `${id}.tmp`)
  const dst = join(dir, `${id}.json`)
  writeFileSync(tmp, JSON.stringify(entry, null, 2))
  renameSync(tmp, dst)
  return dst
}

/**
 * Flush pending replies for a given sourceId.
 */
export async function flushPendingReplies(configDir, sourceId) {
  const dir = join(configDir, 'connector-pending-replies')
  if (!existsSync(dir)) return []

  const callback = getCallback(sourceId)
  if (!callback) return []

  const results = []
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  for (const f of files) {
    const entry = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (entry.sourceId !== sourceId) continue

    const result = await pushWithRetry(callback, {
      instanceId: 'default',
      sessionId: entry.sessionId,
      externalTriggerId: entry.externalTriggerId,
      sourceContext: entry.sourceContext,
      reply: entry.reply,
    })

    if (result.pushed) {
      unlinkSync(join(dir, f))
      results.push({ file: f, ...result })
    } else {
      results.push({ file: f, ...result })
      break // stop on first failure
    }
  }
  return results
}

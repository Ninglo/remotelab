#!/usr/bin/env node

import {
  createConnectorRuntime,
  readBody,
  sendJson,
} from '../../lib/connector-sdk/index.mjs'
import {
  createConnectorSession,
  loadConnectorAssistantReply,
  normalizeConnectorPublicationText,
  submitConnectorMessage,
  waitForConnectorPublication,
} from '../../lib/connector-turn-flow.mjs'
import {
  AUTH_FILE,
  CHAT_PORT,
  MANAGED_WORK_ROOT_DIR,
} from '../../lib/config.mjs'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '')
}

function safeId(value, fallback = 'default') {
  const normalized = trimString(value)
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

function normalizeDistanceLabel(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}m`
  const text = trimString(value)
  return text || ''
}

function normalizeDistanceMeters(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = trimString(value)
  const matched = text.match(/^(\d+(?:\.\d+)?)m$/i) || text.match(/^(\d+(?:\.\d+)?)$/)
  if (!matched) return null
  return Number.parseFloat(matched[1])
}

function normalizeScoreValue(value) {
  const text = trimString(value).toUpperCase()
  if (!text) return 'M'
  if (text === 'X') return 'X'
  if (text === 'M') return 'M'
  const number = Number.parseInt(text, 10)
  if (Number.isNaN(number) || number < 1 || number > 10) return 'M'
  return String(number)
}

function numericArrowScore(value) {
  const normalized = normalizeScoreValue(value)
  if (normalized === 'X' || normalized === '10') return 10
  if (normalized === 'M') return 0
  return Number.parseInt(normalized, 10)
}

function normalizeArrow(arrow, arrowIndex) {
  if (arrow && typeof arrow === 'object' && !Array.isArray(arrow)) {
    const value = normalizeScoreValue(arrow.value)
    return {
      arrowIndex: Number.isInteger(arrow.arrowIndex) ? arrow.arrowIndex : arrowIndex + 1,
      value,
      numericScore: numericArrowScore(value),
    }
  }
  const value = normalizeScoreValue(arrow)
  return {
    arrowIndex: arrowIndex + 1,
    value,
    numericScore: numericArrowScore(value),
  }
}

function normalizeEnd(rawEnd, endIndex) {
  const arrows = Array.isArray(rawEnd?.arrows)
    ? rawEnd.arrows.map((arrow, index) => normalizeArrow(arrow, index))
    : []
  const computedTotal = arrows.reduce((sum, arrow) => sum + arrow.numericScore, 0)
  const providedTotal = Number.isFinite(rawEnd?.total) ? Number(rawEnd.total) : null
  return {
    endIndex: endIndex + 1,
    arrows,
    total: providedTotal ?? computedTotal,
    note: trimString(rawEnd?.note),
  }
}

function extractSessionPayload(payload) {
  if (payload?.session && typeof payload.session === 'object' && !Array.isArray(payload.session)) {
    return payload.session
  }
  return payload
}

function normalizeSession(payload) {
  const session = extractSessionPayload(payload)
  const config = session?.config && typeof session.config === 'object' ? session.config : {}
  const ends = Array.isArray(session?.sets)
    ? session.sets.map((end, index) => normalizeEnd(end, index))
    : []
  const totalScore = Number.isFinite(session?.totalScore)
    ? Number(session.totalScore)
    : ends.reduce((sum, end) => sum + end.total, 0)
  const totalArrows = ends.reduce((sum, end) => sum + end.arrows.length, 0)
  const averageScore = Number.isFinite(session?.averageScore)
    ? Number(session.averageScore)
    : (totalArrows > 0 ? totalScore / totalArrows : 0)

  return {
    id: trimString(session?.id),
    createdAt: trimString(session?.createdAt),
    completedAt: trimString(session?.completedAt),
    config: {
      bowType: trimString(config?.bowType),
      distance: normalizeDistanceLabel(config?.distance),
      distanceM: normalizeDistanceMeters(config?.distance),
      sets: Number.isFinite(config?.sets) ? Number(config.sets) : ends.length,
      arrowsPerSet: Number.isFinite(config?.arrowsPerSet) ? Number(config.arrowsPerSet) : (ends[0]?.arrows.length || 0),
    },
    ends,
    totalScore,
    averageScore,
  }
}

function normalizeAttachments(payload) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : []
  return attachments
    .map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      return {
        attachmentId: safeId(item.id || item.name || `attachment_${index + 1}`),
        kind: trimString(item.kind) || 'attachment',
        name: trimString(item.name) || `attachment-${index + 1}`,
        url: trimString(item.url),
        mimeType: trimString(item.mimeType),
      }
    })
    .filter(Boolean)
}

function normalizeEnvironment(payload) {
  const environment = payload?.environment
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    return {}
  }
  return {
    indoorOutdoor: trimString(environment.indoorOutdoor),
    weather: trimString(environment.weather),
    wind: trimString(environment.wind),
    temperature: trimString(environment.temperature),
    light: trimString(environment.light),
  }
}

function normalizeTags(payload) {
  const values = Array.isArray(payload?.tags)
    ? payload.tags
    : (typeof payload?.tags === 'string' ? payload.tags.split(',') : [])
  return values.map((value) => trimString(value)).filter(Boolean)
}

function getAthlete(payload) {
  const athleteId = safeId(
    payload?.athleteId
      || payload?.user?.id
      || payload?.userId
      || payload?.profile?.id,
    'default'
  )
  return {
    athleteId,
    athleteName: trimString(payload?.athleteName || payload?.user?.name || payload?.profile?.name || athleteId),
  }
}

function buildExternalTriggerId(payload, session, athleteId, config) {
  const explicit = trimString(payload?.externalTriggerId)
  if (explicit) return explicit
  const threadMode = trimString(payload?.threadMode || config.threadMode || 'athlete').toLowerCase()
  if (threadMode === 'session' && trimString(session.id)) {
    return `archery:${athleteId}:session:${safeId(session.id)}`
  }
  return `archery:${athleteId}:coach`
}

function buildRequestId(payload, session, athleteId) {
  const explicit = trimString(payload?.requestId)
  if (explicit) return explicit
  if (trimString(session.id)) return `archery:${athleteId}:session:${safeId(session.id)}`
  return `archery:${athleteId}:upload:${Date.now().toString(36)}`
}

function summarizeEnds(ends) {
  return ends.map((end) => {
    const arrows = end.arrows.map((arrow) => arrow.value).join(' ')
    const note = end.note ? ` | note: ${end.note}` : ''
    return `${end.endIndex}. ${arrows} | total: ${end.total}${note}`
  }).join('\n')
}

function renderCoachMessage({
  athleteId,
  athleteName,
  session,
  tags,
  environment,
  attachments,
  payload,
  requestId,
}) {
  const overview = [
    'Archery training session uploaded.',
    '',
    'Please analyze this training session using this session data plus prior session context when relevant.',
    'Base numeric calculations on the provided structured data and do not invent missing metrics.',
    '',
    'Expected output:',
    '1. Today summary',
    '2. Potential issues',
    '3. Risk points',
    '4. Next training arrangement',
    '5. Missing context, only if it materially weakens the analysis',
    '',
    'Session overview:',
    `- athleteId: ${athleteId}`,
    `- athleteName: ${athleteName || athleteId}`,
    `- bowType: ${session.config.bowType || 'unknown'}`,
    `- distance: ${session.config.distance || 'unknown'}`,
    `- ends: ${session.config.sets || session.ends.length}`,
    `- arrowsPerEnd: ${session.config.arrowsPerSet || 0}`,
    `- totalScore: ${session.totalScore}`,
    `- averageScore: ${session.averageScore.toFixed(2)}`,
    `- startedAt: ${session.createdAt || 'unknown'}`,
    `- completedAt: ${session.completedAt || 'unknown'}`,
  ]

  if (tags.length > 0) {
    overview.push(`- tags: ${tags.join(', ')}`)
  }
  if (Object.values(environment).some(Boolean)) {
    overview.push(`- environment: ${JSON.stringify(environment)}`)
  }
  if (attachments.length > 0) {
    overview.push(`- attachments: ${attachments.map((item) => item.name || item.attachmentId).join(', ')}`)
  }
  if (trimString(payload?.coachRequest)) {
    overview.push(`- coachRequest: ${trimString(payload.coachRequest)}`)
  }

  overview.push(
    '',
    'End details:',
    summarizeEnds(session.ends) || '(no end data)',
    '',
    'Structured JSON:',
    JSON.stringify({
      requestId,
      athleteId,
      athleteName,
      tags,
      environment,
      attachments,
      session,
    }, null, 2),
  )

  return overview.join('\n')
}

export function normalizeArcherySession(payload, config = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object')
  }

  const session = normalizeSession(payload)
  if (!session.ends.length) {
    throw new Error('payload.session.sets is required')
  }

  const { athleteId, athleteName } = getAthlete(payload)
  const tags = normalizeTags(payload)
  const environment = normalizeEnvironment(payload)
  const attachments = normalizeAttachments(payload)
  const externalTriggerId = buildExternalTriggerId(payload, session, athleteId, config)
  const requestId = buildRequestId(payload, session, athleteId)
  const createdAt = session.completedAt || session.createdAt || new Date().toISOString()
  const subject = `Archery ${session.config.distance || 'session'} ${session.totalScore}`
  const messageBody = renderCoachMessage({
    athleteId,
    athleteName,
    session,
    tags,
    environment,
    attachments,
    payload,
    requestId,
  })

  return {
    id: requestId,
    channel: 'archery',
    direction: 'inbound',
    from: {
      address: `athlete:${athleteId}`,
      name: athleteName || athleteId,
    },
    to: {
      address: 'coach:remotelab',
    },
    thread: {
      externalId: externalTriggerId,
    },
    content: {
      subject,
      body: messageBody,
      attachments: [],
    },
    sourceContext: {
      channel: 'archery',
      connectorId: 'archery',
      athleteId,
      athleteName,
      requestId,
      externalTriggerId,
      tags,
      environment,
      attachments,
      session,
      coachRequest: trimString(payload?.coachRequest),
      submittedAt: new Date().toISOString(),
    },
    createdAt,
  }
}

export function archeryMatchFn(pattern, message) {
  const normalizedPattern = trimString(pattern).toLowerCase()
  if (!normalizedPattern || normalizedPattern === '*' || normalizedPattern === 'default') return true

  const athleteId = trimString(message?.sourceContext?.athleteId).toLowerCase()
  const externalTriggerId = trimString(message?.thread?.externalId).toLowerCase()

  if (normalizedPattern.startsWith('athlete:')) {
    return athleteId === normalizedPattern.slice('athlete:'.length)
  }
  if (normalizedPattern.startsWith('thread:')) {
    return externalTriggerId === normalizedPattern.slice('thread:'.length)
  }
  return athleteId === normalizedPattern || externalTriggerId === normalizedPattern
}

function replyStorePaths(stateDir, lookupValue) {
  const repliesDir = join(stateDir, 'replies')
  const byRequestDir = join(repliesDir, 'by-request')
  const byAthleteDir = join(repliesDir, 'by-athlete')
  ensureDir(byRequestDir)
  ensureDir(byAthleteDir)
  return {
    byRequest: join(byRequestDir, `${safeId(lookupValue.requestId)}.json`),
    byAthlete: join(byAthleteDir, `${safeId(lookupValue.athleteId)}.json`),
  }
}

export function storeArcheryReply(stateDir, payload) {
  const sourceContext = payload?.sourceContext && typeof payload.sourceContext === 'object'
    ? payload.sourceContext
    : {}
  const athleteId = safeId(sourceContext.athleteId, 'default')
  const requestId = safeId(sourceContext.requestId || payload?.externalTriggerId || `reply_${Date.now().toString(36)}`)
  const entry = {
    athleteId,
    requestId,
    externalTriggerId: trimString(payload?.externalTriggerId || sourceContext.externalTriggerId),
    remotelabSessionId: trimString(payload?.sessionId),
    responseId: trimString(payload?.responseId),
    runId: trimString(payload?.runId),
    status: trimString(payload?.status || 'ready') || 'ready',
    error: trimString(payload?.error),
    sourceContext,
    reply: payload?.reply && typeof payload.reply === 'object' ? payload.reply : { body: '' },
    updatedAt: new Date().toISOString(),
  }
  const paths = replyStorePaths(stateDir, { athleteId, requestId })
  writeJsonAtomic(paths.byRequest, entry)
  writeJsonAtomic(paths.byAthlete, entry)
  return entry
}

export function readStoredArcheryReply(stateDir, lookup = {}) {
  const requestId = trimString(lookup.requestId)
  const athleteId = trimString(lookup.athleteId)
  if (!requestId && !athleteId) return null

  const repliesDir = join(stateDir, 'replies')
  const candidatePath = requestId
    ? join(repliesDir, 'by-request', `${safeId(requestId)}.json`)
    : join(repliesDir, 'by-athlete', `${safeId(athleteId)}.json`)
  if (!existsSync(candidatePath)) return null

  try {
    return JSON.parse(readFileSync(candidatePath, 'utf8'))
  } catch {
    return null
  }
}

function loadConfig(stateDir) {
  const defaults = {
    port: 7696,
    host: '127.0.0.1',
    channel: 'archery',
    callbackToken: '',
    ingestToken: '',
    deliveryMode: 'direct',
    threadMode: 'athlete',
    tool: 'codex',
    sessionTool: 'codex',
    sourceName: 'Archery',
    group: 'Training',
    chatBaseUrl: `http://127.0.0.1:${CHAT_PORT}`,
    authToken: '',
    authTokenFile: AUTH_FILE,
    sessionFolder: MANAGED_WORK_ROOT_DIR,
    replyPollTimeoutMs: 10 * 60 * 1000,
    replyPollIntervalMs: 1500,
  }
  const configPath = join(stateDir, 'config.json')
  if (!existsSync(configPath)) return defaults
  try {
    return { ...defaults, ...JSON.parse(readFileSync(configPath, 'utf8')) }
  } catch {
    return defaults
  }
}

function isAuthorizedIngest(req, config) {
  if (!config.ingestToken) return true
  const authHeader = req.headers.authorization || req.headers['x-archery-token'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  return token === config.ingestToken
}

function sendArcheryJson(res, status, payload) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  sendJson(res, status, payload)
}

function buildSchemaExample() {
  return {
    athleteId: 'ninglo',
    athleteName: 'Ninglo',
    session: {
      id: 'sess_2026_04_14_01',
      config: {
        bowType: '复合',
        distance: '50m',
        sets: 12,
        arrowsPerSet: 6,
      },
      sets: [
        {
          arrows: [{ value: '10' }, { value: '10' }, { value: '10' }, { value: '9' }, { value: '9' }, { value: '8' }],
          note: 'front shoulder felt tight on the last two arrows',
          total: 56,
        },
      ],
      totalScore: 675,
      averageScore: 9.38,
      createdAt: '2026-04-14T10:00:00Z',
      completedAt: '2026-04-14T11:05:00Z',
    },
    tags: ['outdoor', 'fatigue'],
    environment: {
      indoorOutdoor: 'outdoor',
      weather: 'cloudy',
      wind: 'crosswind',
    },
    attachments: [
      {
        kind: 'target_photo',
        name: 'target-1.jpg',
        url: 'https://example.test/target-1.jpg',
      },
    ],
  }
}

function buildImportItems(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  if (!Array.isArray(payload.sessions)) return []
  const { sessions, ...shared } = payload
  return sessions.map((session) => ({ ...shared, session }))
}

function usesDirectRemoteLab(config) {
  return trimString(config.deliveryMode || 'direct').toLowerCase() !== 'dispatch'
}

async function resolveRemoteLabToken(config) {
  const explicit = trimString(config.authToken)
  if (explicit) return explicit
  const tokenFile = trimString(config.authTokenFile || AUTH_FILE) || AUTH_FILE
  const auth = JSON.parse(readFileSync(tokenFile, 'utf8'))
  const token = trimString(auth?.token)
  if (!token) {
    throw new Error(`No owner token found in ${tokenFile}`)
  }
  return token
}

async function requestRemoteLab(config, path, { method = 'GET', body } = {}) {
  const token = await resolveRemoteLabToken(config)
  const response = await fetch(`${normalizeBaseUrl(config.chatBaseUrl)}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })

  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}

  return { response, json, text }
}

function buildRemoteLabSessionPayload(message, config) {
  const athleteId = trimString(message?.sourceContext?.athleteId) || 'default'
  const athleteName = trimString(message?.sourceContext?.athleteName) || athleteId
  const sessionLabel = trimString(config.sessionName) || athleteName
  const sessionDescription = [
    'Archery training coach thread',
    athleteName ? `athlete ${athleteName}` : '',
    trimString(message?.sourceContext?.session?.config?.distance)
      ? `distance ${trimString(message.sourceContext.session.config.distance)}`
      : '',
  ].filter(Boolean).join(' · ')

  return {
    folder: trimString(config.sessionFolder) || MANAGED_WORK_ROOT_DIR,
    tool: trimString(config.sessionTool || config.tool || 'codex') || 'codex',
    name: sessionLabel,
    sourceId: 'archery',
    sourceName: trimString(config.sourceName) || 'Archery',
    group: trimString(config.group) || 'Training',
    description: sessionDescription,
    externalTriggerId: trimString(message?.thread?.externalId),
    sourceContext: {
      channel: 'archery',
      connectorId: 'archery',
      athleteId,
      athleteName,
    },
  }
}

function buildRemoteLabMessagePayload(message, config) {
  const payload = {
    requestId: trimString(message.id),
    text: trimString(message?.content?.body),
    tool: trimString(config.sessionTool || config.tool || 'codex') || 'codex',
    sourceContext: message.sourceContext || {},
  }
  return payload
}

async function collectArcheryReply(stateDir, config, entry) {
  const requester = (path, options = {}) => requestRemoteLab(config, path, options)
  try {
    const publication = await waitForConnectorPublication(
      requester,
      entry.sessionId,
      entry.responseId,
      {
        timeoutMs: Number(config.replyPollTimeoutMs) || 10 * 60 * 1000,
        intervalMs: Number(config.replyPollIntervalMs) || 1500,
      },
    )

    if (trimString(publication?.state).toLowerCase() !== 'ready') {
      storeArcheryReply(stateDir, {
        ...entry,
        status: trimString(publication?.state || 'failed') || 'failed',
        error: `reply publication ${trimString(publication?.state || 'failed')}`,
        reply: { body: '' },
      })
      return
    }

    let replyText = normalizeConnectorPublicationText(publication)
    const finalizedRunId = trimString(publication?.finalRunId || entry.runId)
    if (!replyText) {
      const replyEvent = await loadConnectorAssistantReply(requester, entry.sessionId, {
        runId: finalizedRunId,
        requestId: entry.requestId,
      })
      replyText = trimString(replyEvent?.normalizedContent || replyEvent?.content)
    }

    storeArcheryReply(stateDir, {
      ...entry,
      runId: finalizedRunId,
      status: replyText ? 'ready' : 'empty',
      reply: {
        body: replyText,
      },
    })
  } catch (error) {
    storeArcheryReply(stateDir, {
      ...entry,
      status: 'failed',
      error: error?.message || String(error),
      reply: { body: '' },
    })
  }
}

function queueArcheryReplyCollection(stateDir, config, entry) {
  collectArcheryReply(stateDir, config, entry).catch(() => {})
}

async function deliverArcheryMessage(message, config, connector, stateDir) {
  if (!usesDirectRemoteLab(config)) {
    return connector.deliver(message)
  }

  const requester = (path, options = {}) => requestRemoteLab(config, path, options)
  const session = await createConnectorSession(requester, buildRemoteLabSessionPayload(message, config))
  const submission = await submitConnectorMessage(requester, session.id, buildRemoteLabMessagePayload(message, config))
  const pendingEntry = storeArcheryReply(stateDir, {
    sessionId: session.id,
    runId: submission.runId || '',
    responseId: submission.responseId,
    externalTriggerId: message.thread.externalId,
    sourceContext: message.sourceContext,
    status: submission.duplicate ? 'pending_duplicate' : 'pending',
    reply: { body: '' },
  })
  queueArcheryReplyCollection(stateDir, config, {
    sessionId: session.id,
    runId: submission.runId || '',
    responseId: submission.responseId,
    requestId: pendingEntry.requestId,
    externalTriggerId: pendingEntry.externalTriggerId,
    sourceContext: pendingEntry.sourceContext,
  })
  return {
    delivered: true,
    sessionId: session.id,
    runId: submission.runId || null,
    duplicate: submission.duplicate,
    queued: submission.queued,
    responseId: submission.responseId,
  }
}

export async function startArcheryConnector(options = {}) {
  const stateDir = options.stateDir || join(__dirname, 'state')
  ensureDir(stateDir)
  const config = { ...loadConfig(stateDir), ...options }

  const connector = createConnectorRuntime({
    channel: 'archery',
    port: config.port,
    host: config.host,
    stateDir,
    callbackToken: config.callbackToken,
    matchFn: archeryMatchFn,
    sourceName: config.sourceName,
    group: config.group,
    tool: config.tool,
    onReply: async (reply) => {
      const stored = storeArcheryReply(stateDir, reply)
      return {
        stored: true,
        athleteId: stored.athleteId,
        requestId: stored.requestId,
      }
    },
  })

  connector.route('POST', '/archery/session', async (req, res) => {
    if (!isAuthorizedIngest(req, config)) {
      return sendArcheryJson(res, 403, { ok: false, error: 'invalid_ingest_token' })
    }

    try {
      const payload = await readBody(req)
      const message = normalizeArcherySession(payload, config)
      const result = await deliverArcheryMessage(message, config, connector, stateDir)
      const baseUrl = `http://${config.host}:${config.port}`
      const statusCode = result.delivered ? 202 : 502
      sendArcheryJson(res, statusCode, {
        ok: result.delivered,
        ...result,
        athleteId: message.sourceContext.athleteId,
        requestId: message.id,
        externalTriggerId: message.thread.externalId,
        replyPollUrl: `${baseUrl}/archery/replies?requestId=${encodeURIComponent(message.id)}`,
        latestAthleteReplyUrl: `${baseUrl}/archery/replies?athleteId=${encodeURIComponent(message.sourceContext.athleteId)}`,
      })
    } catch (error) {
      sendArcheryJson(res, 500, { ok: false, error: 'ingest_failed', message: error?.message || String(error) })
    }
  })

  connector.route('POST', '/archery/import', async (req, res) => {
    if (!isAuthorizedIngest(req, config)) {
      return sendArcheryJson(res, 403, { ok: false, error: 'invalid_ingest_token' })
    }

    try {
      const payload = await readBody(req)
      const items = buildImportItems(payload)
      if (!items.length) {
        return sendArcheryJson(res, 400, { ok: false, error: 'sessions_array_required' })
      }

      const results = []
      for (const item of items) {
        try {
          const message = normalizeArcherySession(item, config)
          const result = await deliverArcheryMessage(message, config, connector, stateDir)
          results.push({
            ok: result.delivered,
            athleteId: message.sourceContext.athleteId,
            requestId: message.id,
            externalTriggerId: message.thread.externalId,
            sessionId: result.sessionId || null,
            runId: result.runId || null,
            responseId: result.responseId || '',
            duplicate: result.duplicate || false,
            error: result.delivered ? '' : (result.error || 'delivery_failed'),
          })
        } catch (error) {
          results.push({
            ok: false,
            athleteId: safeId(item?.athleteId || item?.user?.id || item?.userId, 'default'),
            requestId: '',
            externalTriggerId: '',
            sessionId: null,
            runId: null,
            duplicate: false,
            error: error?.message || String(error),
          })
        }
      }

      const deliveredCount = results.filter((entry) => entry.ok).length
      sendArcheryJson(res, deliveredCount > 0 ? 202 : 502, {
        ok: deliveredCount === results.length,
        total: results.length,
        delivered: deliveredCount,
        failed: results.length - deliveredCount,
        results,
      })
    } catch (error) {
      sendArcheryJson(res, 500, { ok: false, error: 'import_failed', message: error?.message || String(error) })
    }
  })

  connector.route('GET', '/archery/replies', async (req, res) => {
    const url = new URL(req.url || '/archery/replies', 'http://127.0.0.1')
    const requestId = trimString(url.searchParams.get('requestId'))
    const athleteId = trimString(url.searchParams.get('athleteId'))
    if (!requestId && !athleteId) {
      return sendArcheryJson(res, 400, { ok: false, error: 'requestId_or_athleteId_required' })
    }
    const entry = readStoredArcheryReply(stateDir, { requestId, athleteId })
    if (!entry) {
      return sendArcheryJson(res, 404, { ok: false, error: 'reply_not_found' })
    }
    sendArcheryJson(res, 200, { ok: true, reply: entry })
  })

  connector.route('GET', '/archery/schema', async (_req, res) => {
    sendArcheryJson(res, 200, {
      ok: true,
      channel: 'archery',
      defaultThreadMode: config.threadMode,
      sample: buildSchemaExample(),
    })
  })

  await connector.start()
  console.log(`Archery connector listening on ${config.host}:${config.port}`)
  return connector
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const stateDir = args.includes('--state-dir') ? args[args.indexOf('--state-dir') + 1] : join(__dirname, 'state')
  const port = args.includes('--port') ? Number.parseInt(args[args.indexOf('--port') + 1], 10) : undefined

  startArcheryConnector({ stateDir, ...(Number.isFinite(port) ? { port } : {}) }).catch((error) => {
    console.error('Failed to start archery connector:', error)
    process.exit(1)
  })
}

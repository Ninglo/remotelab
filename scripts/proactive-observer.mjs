#!/usr/bin/env node

import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import { setTimeout as delay } from 'timers/promises'
import { fileURLToPath, pathToFileURL } from 'url'

import { AUTH_FILE, CHAT_PORT } from '../lib/config.mjs'
import {
  buildAssistantReplyAttachmentFallbackText,
  selectAssistantReplyEvent,
  stripHiddenBlocks,
} from '../lib/reply-selection.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const DEFAULT_STORAGE_DIR = join(homedir(), '.config', 'remotelab', 'proactive-observer')
const DEFAULT_CONFIG_PATH = join(DEFAULT_STORAGE_DIR, 'config.json')
const DEFAULT_STATE_PATH = join(DEFAULT_STORAGE_DIR, 'state.json')
const DEFAULT_EVENTS_LOG_PATH = join(DEFAULT_STORAGE_DIR, 'events.jsonl')
const DEFAULT_CAPTURE_DIR = join(DEFAULT_STORAGE_DIR, 'captures')
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`
const DEFAULT_HTTP_PORT = 7960
const DEFAULT_SESSION_TOOL = 'codex'
const DEFAULT_APP_ID = 'observer-home'
const DEFAULT_APP_NAME = 'Home Coach'
const DEFAULT_GROUP = 'Observer'
const DEFAULT_CAPTURE_INTERVAL_MS = 4000
const DEFAULT_PRESENT_STREAK = 2
const DEFAULT_ABSENT_STREAK = 3
const DEFAULT_ARRIVAL_COOLDOWN_MS = 60 * 1000
const DEFAULT_FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_RUN_POLL_INTERVAL_MS = 1500
const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_SPEECH_TIMEOUT_MS = 30 * 1000
const DEFAULT_TTS_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_TTS_RATE = 190
const DEFAULT_TRIGGER_ID = 'home-arrival'
const LEGACY_DEFAULT_SYSTEM_PROMPT = [
  'You are the assistant behind a proactive local home observer running on the owner\'s machine.',
  'Each session is triggered by a local event, not by a normal typed chat.',
  'For this prototype, when the user has just arrived home, greet them warmly and briefly.',
  'If the user immediately gives a spoken request, help naturally and complete simple local actions on the Mac when appropriate.',
  'You may use shell commands or osascript on this machine when useful.',
  'If the user asks to play music, prefer the macOS Music app and complete the action before replying.',
  'Reply with the exact text that should be spoken aloud through the speaker.',
  'Keep replies short, natural, warm, and speech-friendly.',
  'Do not mention session ids, trigger ids, pipelines, or hidden system internals.',
].join('\n')
const DEFAULT_SYSTEM_PROMPT = [
  'You are interacting through a proactive local observer on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by RemoteLab backend prompt logic.',
].join('\n')

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeBaseUrl(value) {
  const normalized = trimString(value || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '')
  return normalized || DEFAULT_CHAT_BASE_URL
}

function resolveHomePath(value, fallback = '') {
  const trimmed = trimString(value || fallback)
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function normalizeSystemPrompt(value) {
  const normalized = trimString(value)
  if (!normalized || normalized === DEFAULT_SYSTEM_PROMPT || normalized === LEGACY_DEFAULT_SYSTEM_PROMPT) {
    return ''
  }
  return normalized
}

function sanitizeIdPart(value, fallback = 'default') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function parseJsonIfPossible(text) {
  const normalized = trimString(text)
  if (!normalized) return null
  if (!/^[\[{]/.test(normalized)) return null
  try {
    return JSON.parse(normalized)
  } catch {
    return null
  }
}

function normalizeEnvMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [trimString(key), String(entry ?? '')])
      .filter(([key]) => key)
  )
}

function localTimestampLabel(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function isoIdLabel(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}T${hour}${minute}${second}`
}

function mimeTypeFromPath(imagePath) {
  const ext = extname(imagePath || '').toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

async function appendJsonLine(pathname, entry) {
  await mkdir(dirname(pathname), { recursive: true })
  await appendFile(pathname, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function readJsonFile(pathname, fallback = null) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'))
  } catch {
    return fallback
  }
}

function normalizeCameraConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    enabled: normalizeBoolean(normalized.enabled, false),
    avfoundationDevice: trimString(normalized.avfoundationDevice),
    captureCommand: trimString(normalized.captureCommand),
    intervalMs: parsePositiveInteger(normalized.intervalMs, DEFAULT_CAPTURE_INTERVAL_MS),
    captureDir: resolveHomePath(normalized.captureDir, DEFAULT_CAPTURE_DIR),
    ffmpegPath: trimString(normalized.ffmpegPath) || 'ffmpeg',
    width: parsePositiveInteger(normalized.width, 1280),
    height: parsePositiveInteger(normalized.height, 720),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeVisionConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaultDetectorCommand = `swift "${join(PROJECT_ROOT, 'scripts', 'proactive-observer-human-detect.swift')}" --image "$REMOTELAB_OBSERVER_IMAGE_PATH"`
  return {
    enabled: normalizeBoolean(normalized.enabled, true),
    detectorCommand: trimString(normalized.detectorCommand || defaultDetectorCommand),
    presentStreak: parsePositiveInteger(normalized.presentStreak, DEFAULT_PRESENT_STREAK),
    absentStreak: parsePositiveInteger(normalized.absentStreak, DEFAULT_ABSENT_STREAK),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeSpeechConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const defaultListenCommand = `swift "${join(PROJECT_ROOT, 'scripts', 'proactive-observer-listen-once.swift')}" --timeout-ms "$REMOTELAB_OBSERVER_SPEECH_TIMEOUT_MS"`
  return {
    enabled: normalizeBoolean(normalized.enabled, true),
    listenCommand: trimString(normalized.listenCommand || defaultListenCommand),
    timeoutMs: parsePositiveInteger(normalized.timeoutMs, DEFAULT_SPEECH_TIMEOUT_MS),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeTtsConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const mode = trimString(normalized.mode || 'say').toLowerCase() || 'say'
  return {
    enabled: normalizeBoolean(normalized.enabled, true),
    mode,
    voice: trimString(normalized.voice),
    rate: parsePositiveInteger(normalized.rate, DEFAULT_TTS_RATE),
    timeoutMs: parsePositiveInteger(normalized.timeoutMs, DEFAULT_TTS_TIMEOUT_MS),
    command: trimString(normalized.command),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeHttpConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    enabled: normalizeBoolean(normalized.enabled, true),
    host: trimString(normalized.host || '127.0.0.1') || '127.0.0.1',
    port: parsePositiveInteger(normalized.port, DEFAULT_HTTP_PORT),
  }
}

function normalizeTrigger(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    id: sanitizeIdPart(normalized.id, DEFAULT_TRIGGER_ID),
    eventType: trimString(normalized.eventType || 'arrival').toLowerCase() || 'arrival',
    enabled: normalizeBoolean(normalized.enabled, true),
    sessionNamePrefix: trimString(normalized.sessionNamePrefix || 'Home Arrival') || 'Home Arrival',
    sessionDescription: trimString(normalized.sessionDescription || 'Proactive home-arrival episode triggered by the local observer service.'),
    speechFollowUp: normalizeBoolean(normalized.speechFollowUp, true),
    followUpTurns: parsePositiveInteger(normalized.followUpTurns, 1),
    followUpWindowMs: parsePositiveInteger(normalized.followUpWindowMs, DEFAULT_FOLLOW_UP_WINDOW_MS),
    arrivalCooldownMs: parsePositiveInteger(normalized.arrivalCooldownMs, DEFAULT_ARRIVAL_COOLDOWN_MS),
    prompt: normalizeMultilineText(normalized.prompt || 'The user has just arrived home. Greet them warmly and briefly, then be ready for one immediate spoken follow-up request.'),
  }
}

function defaultTriggerList() {
  return [normalizeTrigger({})]
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = await readJsonFile(configPath, {})
  const normalized = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const triggers = Array.isArray(normalized.triggers) && normalized.triggers.length > 0
    ? normalized.triggers.map((entry) => normalizeTrigger(entry)).filter((entry) => entry.enabled)
    : defaultTriggerList()

  return {
    storageDir: resolveHomePath(normalized.storageDir, DEFAULT_STORAGE_DIR),
    statePath: resolveHomePath(normalized.statePath, DEFAULT_STATE_PATH),
    eventsLogPath: resolveHomePath(normalized.eventsLogPath, DEFAULT_EVENTS_LOG_PATH),
    connectorId: sanitizeIdPart(normalized.connectorId, 'home-observer'),
    roomName: trimString(normalized.roomName || 'Home') || 'Home',
    chatBaseUrl: normalizeBaseUrl(normalized.chatBaseUrl),
    sessionFolder: resolveHomePath(normalized.sessionFolder, '~'),
    sessionTool: trimString(normalized.sessionTool || DEFAULT_SESSION_TOOL) || DEFAULT_SESSION_TOOL,
    model: trimString(normalized.model),
    effort: trimString(normalized.effort),
    thinking: normalizeBoolean(normalized.thinking, false),
    appId: trimString(normalized.appId || DEFAULT_APP_ID) || DEFAULT_APP_ID,
    appName: trimString(normalized.appName || DEFAULT_APP_NAME) || DEFAULT_APP_NAME,
    group: trimString(normalized.group || DEFAULT_GROUP) || DEFAULT_GROUP,
    systemPrompt: normalizeSystemPrompt(normalized.systemPrompt),
    maxImageBytes: parsePositiveInteger(normalized.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES),
    camera: normalizeCameraConfig(normalized.camera),
    vision: normalizeVisionConfig(normalized.vision),
    speech: normalizeSpeechConfig(normalized.speech),
    tts: normalizeTtsConfig(normalized.tts),
    http: normalizeHttpConfig(normalized.http),
    triggers,
  }
}

function printUsage(exitCode = 0) {
  const message = `Usage:
  node scripts/proactive-observer.mjs [options]

Options:
  --config <path>         Config path (default: ${DEFAULT_CONFIG_PATH})
  --print-config          Print a starter config template and exit
  --event <type>          Trigger one manual event (for example: arrival)
  --transcript <text>     Optional follow-up transcript for manual arrival testing
  --image <path>          Optional image path for manual events
  --once-camera           Capture one snapshot and run presence analysis once
  --no-speak              Disable TTS for this process
  -h, --help              Show this help

Normal mode:
  - runs a standalone local observer service
  - optionally polls a configured camera for person-presence changes
  - exposes a tiny local HTTP API for manual event injection and status

Manual smoke example:
  node scripts/proactive-observer.mjs --event arrival --transcript "我今天情绪挺好，给我放首歌"
`
  console.log(message)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    printConfig: false,
    eventType: '',
    transcript: '',
    imagePath: '',
    onceCamera: false,
    noSpeak: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      options.configPath = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--print-config') {
      options.printConfig = true
      continue
    }
    if (arg === '--event') {
      options.eventType = trimString(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--transcript') {
      options.transcript = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--image') {
      options.imagePath = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--once-camera') {
      options.onceCamera = true
      continue
    }
    if (arg === '--no-speak') {
      options.noSpeak = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function isMainModule() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

export function normalizeObserverEvent(value, defaults = {}) {
  let normalized = value
  if (typeof normalized === 'string') {
    const parsed = parseJsonIfPossible(normalized)
    normalized = parsed || { type: normalized }
  }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return null
  }

  const type = trimString(normalized.type || normalized.eventType).toLowerCase() || 'arrival'
  const transcript = normalizeMultilineText(normalized.transcript || normalized.text)
  const imagePath = resolveHomePath(normalized.imagePath)

  return {
    eventId: trimString(normalized.eventId || normalized.id) || `${type}-${randomUUID()}`,
    type,
    source: trimString(normalized.source || defaults.source || 'manual') || 'manual',
    detectedAt: trimString(normalized.detectedAt || normalized.ts) || nowIso(),
    connectorId: sanitizeIdPart(normalized.connectorId || defaults.connectorId || 'home-observer'),
    roomName: trimString(normalized.roomName || defaults.roomName || 'Home') || 'Home',
    transcript,
    imagePath,
    summary: normalizeMultilineText(normalized.summary),
    metadata: normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? normalized.metadata
      : {},
  }
}

export function buildEpisodeExternalTriggerId(runtimeConfig, trigger, episode) {
  return `observer:${sanitizeIdPart(runtimeConfig.connectorId)}:${sanitizeIdPart(trigger.id)}:${sanitizeIdPart(episode.episodeId)}`
}

export function buildSessionName(trigger, detectedAt) {
  return `${trimString(trigger.sessionNamePrefix) || 'Episode'} · ${localTimestampLabel(detectedAt)}`
}

function buildSessionDescription(runtimeConfig, trigger, event) {
  const pieces = [
    trimString(trigger.sessionDescription),
    `Source room: ${runtimeConfig.roomName}`,
    `Connector: ${runtimeConfig.connectorId}`,
    `Trigger: ${trigger.id}`,
    `Initial event: ${event.type}`,
  ].filter(Boolean)
  return pieces.join(' ')
}

export function buildRemoteLabMessage(runtimeConfig, trigger, episode, event) {
  const lines = [
    'Inbound proactive observer event from a standalone local service.',
    `Episode ID: ${episode.episodeId}`,
    `Trigger ID: ${trigger.id}`,
    `Event type: ${event.type}`,
    `Source: ${event.source}`,
    `Detected at: ${event.detectedAt}`,
    `Room: ${event.roomName}`,
  ]

  if (event.summary) {
    lines.push('', 'Observer summary:', event.summary)
  }

  if (event.imagePath) {
    lines.push('', `Snapshot path: ${event.imagePath}`)
  }

  if (event.type === 'arrival') {
    lines.push('', 'Current task:', trimString(trigger.prompt))
  }

  if (event.type === 'transcript') {
    lines.push('', 'User speech:', event.transcript || '(empty)')
  }

  if (Object.keys(event.metadata || {}).length > 0) {
    lines.push('', `Metadata: ${JSON.stringify(event.metadata)}`)
  }

  return lines.join('\n')
}

function buildRequestId(runtimeConfig, episode, event) {
  return `observer:${sanitizeIdPart(runtimeConfig.connectorId)}:${sanitizeIdPart(episode.episodeId)}:${sanitizeIdPart(event.eventId)}`
}

function buildProcessEnv(runtime, event = {}, extra = {}) {
  return {
    REMOTELAB_OBSERVER_CONNECTOR_ID: runtime.config.connectorId,
    REMOTELAB_OBSERVER_ROOM_NAME: runtime.config.roomName,
    REMOTELAB_OBSERVER_STORAGE_DIR: runtime.storagePaths.storageDir,
    REMOTELAB_OBSERVER_EVENT_ID: trimString(event.eventId),
    REMOTELAB_OBSERVER_EVENT_TYPE: trimString(event.type),
    REMOTELAB_OBSERVER_IMAGE_PATH: trimString(event.imagePath),
    REMOTELAB_OBSERVER_TRANSCRIPT: normalizeMultilineText(event.transcript),
    REMOTELAB_OBSERVER_SPEECH_TIMEOUT_MS: String(runtime.config.speech.timeoutMs || DEFAULT_SPEECH_TIMEOUT_MS),
    ...(extra.replyText ? { REMOTELAB_OBSERVER_REPLY_TEXT: String(extra.replyText) } : {}),
  }
}

export function createRuntimeContext(config, overrides = {}) {
  const storageDir = resolveHomePath(config.storageDir, DEFAULT_STORAGE_DIR)
  const runtime = {
    config,
    storagePaths: {
      storageDir,
      statePath: resolveHomePath(config.statePath, DEFAULT_STATE_PATH),
      eventsLogPath: resolveHomePath(config.eventsLogPath, DEFAULT_EVENTS_LOG_PATH),
      captureDir: resolveHomePath(config.camera.captureDir, DEFAULT_CAPTURE_DIR),
    },
    authToken: '',
    authCookie: '',
    queue: Promise.resolve(),
    shuttingDown: false,
    server: null,
    cameraLoopPromise: null,
    state: {
      presentStreak: 0,
      absentStreak: 0,
      isPresent: false,
      lastArrivalAt: '',
      lastPresenceAnalysisAt: '',
      activeEpisode: null,
    },
    ...overrides,
  }
  return runtime
}

async function loadRuntimeState(runtime) {
  const state = await readJsonFile(runtime.storagePaths.statePath, null)
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  runtime.state = {
    ...runtime.state,
    ...state,
  }
}

async function saveRuntimeState(runtime) {
  await mkdir(dirname(runtime.storagePaths.statePath), { recursive: true })
  const payload = JSON.stringify(runtime.state, null, 2)
  await writeFile(runtime.storagePaths.statePath, `${payload}\n`, 'utf8')
}

async function logObserverEvent(runtime, type, payload = {}) {
  await appendJsonLine(runtime.storagePaths.eventsLogPath, {
    ts: nowIso(),
    type,
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
    ...payload,
  })
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

  return await selectAssistantReplyEvent(eventsResult.json.events, {
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

async function createEpisodeSession(runtime, trigger, episode, event) {
  const payload = {
    folder: runtime.config.sessionFolder,
    tool: runtime.config.sessionTool,
    name: buildSessionName(trigger, event.detectedAt),
    sourceId: 'observer',
    sourceName: runtime.config.appName,
    group: runtime.config.group,
    description: buildSessionDescription(runtime.config, trigger, event),
    systemPrompt: runtime.config.systemPrompt,
    externalTriggerId: buildEpisodeExternalTriggerId(runtime.config, trigger, episode),
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

async function readImageAsAttachment(imagePath, maxBytes) {
  if (!trimString(imagePath)) return []
  try {
    const imageStat = await stat(imagePath)
    if (imageStat.size > maxBytes) {
      return []
    }
    const { readFile: readImageFile } = await import('fs/promises')
    const buffer = await readImageFile(imagePath)
    return [{
      data: buffer.toString('base64'),
      originalName: basename(imagePath),
      mimeType: mimeTypeFromPath(imagePath),
    }]
  } catch {
    return []
  }
}

async function submitEpisodeMessage(runtime, sessionId, trigger, episode, event) {
  const payload = {
    requestId: buildRequestId(runtime.config, episode, event),
    text: buildRemoteLabMessage(runtime.config, trigger, episode, event),
    tool: runtime.config.sessionTool,
    thinking: runtime.config.thinking === true,
  }
  if (runtime.config.model) payload.model = runtime.config.model
  if (runtime.config.effort) payload.effort = runtime.config.effort
  if (event.imagePath) {
    payload.images = await readImageAsAttachment(event.imagePath, runtime.config.maxImageBytes)
  }

  const result = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: payload,
  })
  if (![200, 202].includes(result.response.status) || !result.json?.run?.id) {
    throw new Error(result.json?.error || result.text || `Failed to submit session message (${result.response.status})`)
  }
  return {
    requestId: payload.requestId,
    runId: result.json.run.id,
    duplicate: result.json?.duplicate === true,
  }
}

async function waitForRunCompletion(runtime, runId) {
  const deadline = Date.now() + DEFAULT_RUN_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await requestRemoteLab(runtime, `/api/runs/${runId}`)
    if (!result.response.ok || !result.json?.run) {
      throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`)
    }
    const run = result.json.run
    if (run.state === 'completed') return run
    if (['failed', 'cancelled'].includes(run.state)) {
      throw new Error(`run ${run.state}`)
    }
    await delay(DEFAULT_RUN_POLL_INTERVAL_MS)
  }
  throw new Error(`run timed out after ${DEFAULT_RUN_POLL_TIMEOUT_MS}ms`)
}

function normalizeSpokenReplyText(value) {
  return stripHiddenBlocks(value || '').replace(/\s+/g, ' ').trim()
}

async function generateRemoteLabReply(runtime, trigger, episode, event) {
  if (!episode.sessionId) {
    const session = await createEpisodeSession(runtime, trigger, episode, event)
    episode.sessionId = session.id
    runtime.state.activeEpisode = episode
    await saveRuntimeState(runtime)
  }
  const submission = await submitEpisodeMessage(runtime, episode.sessionId, trigger, episode, event)
  await waitForRunCompletion(runtime, submission.runId)
  const replyEvent = await loadAssistantReply(
    (path) => requestRemoteLab(runtime, path),
    episode.sessionId,
    submission.runId,
    submission.requestId,
  )
  return {
    sessionId: episode.sessionId,
    runId: submission.runId,
    requestId: submission.requestId,
    duplicate: submission.duplicate,
    replyText: normalizeSpokenReplyText([
      replyEvent?.content || '',
      buildAssistantReplyAttachmentFallbackText(replyEvent),
    ].filter(Boolean).join('\n\n')),
  }
}

async function runShellCommand(command, options = {}) {
  const normalizedCommand = trimString(command)
  if (!normalizedCommand) {
    throw new Error('Command is required')
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['-lc', normalizedCommand], {
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutHandle = null

    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise(value)
    }

    if (options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM')
        settle(new Error(`Command timed out after ${options.timeoutMs}ms: ${normalizedCommand}`))
      }, options.timeoutMs)
    }

    child.on('error', (error) => {
      settle(error)
    })

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settle(new Error(`Command failed (${code}${signal ? `/${signal}` : ''}): ${trimString(stderr) || trimString(stdout) || normalizedCommand}`))
        return
      }
      settle(null, { stdout, stderr, code, signal })
    })

    if (options.stdin !== undefined && options.stdin !== null) {
      child.stdin.end(String(options.stdin))
    } else {
      child.stdin.end()
    }
  })
}

async function runSay(text, ttsConfig) {
  if (!trimString(text)) return
  await new Promise((resolvePromise, rejectPromise) => {
    const args = []
    if (trimString(ttsConfig.voice)) {
      args.push('-v', trimString(ttsConfig.voice))
    }
    if (ttsConfig.rate) {
      args.push('-r', String(ttsConfig.rate))
    }
    args.push(text)

    const child = spawn('say', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    let stderr = ''
    let settled = false
    let timeoutHandle = null

    const settle = (error) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise()
    }

    if (ttsConfig.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM')
        settle(new Error(`say timed out after ${ttsConfig.timeoutMs}ms`))
      }, ttsConfig.timeoutMs)
    }

    child.on('error', (error) => {
      settle(error)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settle(new Error(`say failed (${code}${signal ? `/${signal}` : ''}): ${trimString(stderr) || 'unknown error'}`))
        return
      }
      settle(null)
    })
  })
}

async function speakReply(runtime, replyText, event) {
  if (!runtime.config.tts.enabled || !trimString(replyText)) return
  if (runtime.config.tts.mode === 'say') {
    await runSay(replyText, runtime.config.tts)
    return
  }
  if (runtime.config.tts.mode === 'command' && trimString(runtime.config.tts.command)) {
    await runShellCommand(runtime.config.tts.command, {
      env: {
        ...runtime.config.tts.env,
        ...buildProcessEnv(runtime, event, { replyText }),
      },
      stdin: replyText,
      timeoutMs: runtime.config.tts.timeoutMs,
    })
  }
}

function parseCommandPayload(text) {
  const parsed = parseJsonIfPossible(text)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed
  }
  return null
}

async function listenForSpeech(runtime, episode, trigger, seedEvent, overrideText = '') {
  const directTranscript = normalizeMultilineText(overrideText)
  if (directTranscript) return directTranscript
  if (!runtime.config.speech.enabled || !trimString(runtime.config.speech.listenCommand)) return ''
  if (typeof runtime.listenForSpeech === 'function') {
    return normalizeMultilineText(await runtime.listenForSpeech(runtime, episode, trigger, seedEvent))
  }
  const result = await runShellCommand(runtime.config.speech.listenCommand, {
    env: {
      ...runtime.config.speech.env,
      ...buildProcessEnv(runtime, seedEvent),
    },
    timeoutMs: runtime.config.speech.timeoutMs,
  })
  const payload = parseCommandPayload(result.stdout)
  if (payload) {
    return normalizeMultilineText(payload.transcript || payload.text)
  }
  return normalizeMultilineText(result.stdout)
}

function getTriggerById(runtime, triggerId) {
  return runtime.config.triggers.find((entry) => entry.id === triggerId) || null
}

function getMatchingTriggers(runtime, eventType) {
  return runtime.config.triggers.filter((entry) => entry.enabled && entry.eventType === eventType)
}

function currentEpisode(runtime) {
  const episode = runtime.state.activeEpisode
  if (!episode) return null
  if (episode.expiresAt && Date.now() > new Date(episode.expiresAt).getTime()) {
    runtime.state.activeEpisode = null
    return null
  }
  return episode
}

function createEpisode(trigger, detectedAt = nowIso()) {
  const episodeId = `${sanitizeIdPart(trigger.id)}-${isoIdLabel(detectedAt)}`
  return {
    episodeId,
    triggerId: trigger.id,
    startedAt: trimString(detectedAt) || nowIso(),
    expiresAt: new Date(Date.now() + trigger.followUpWindowMs).toISOString(),
    sessionId: '',
  }
}

async function processTranscriptEvent(runtime, transcriptEvent) {
  const episode = currentEpisode(runtime)
  if (!episode) {
    await logObserverEvent(runtime, 'transcript_ignored', {
      eventId: transcriptEvent.eventId,
      reason: 'no_active_episode',
    })
    return { ignored: true, reason: 'no_active_episode' }
  }

  const trigger = getTriggerById(runtime, episode.triggerId)
  if (!trigger) {
    return { ignored: true, reason: 'missing_trigger' }
  }

  const reply = await generateRemoteLabReply(runtime, trigger, episode, transcriptEvent)
  if (reply.replyText) {
    await speakReply(runtime, reply.replyText, transcriptEvent)
  }
  episode.expiresAt = new Date(Date.now() + trigger.followUpWindowMs).toISOString()
  runtime.state.activeEpisode = episode
  await saveRuntimeState(runtime)
  await logObserverEvent(runtime, 'transcript_processed', {
    eventId: transcriptEvent.eventId,
    episodeId: episode.episodeId,
    sessionId: episode.sessionId,
    transcript: transcriptEvent.transcript,
    replyText: reply.replyText,
  })
  return { ignored: false, episodeId: episode.episodeId, reply }
}

export async function processArrivalEvent(runtime, arrivalEvent, options = {}) {
  const triggers = getMatchingTriggers(runtime, 'arrival')
  if (triggers.length === 0) {
    return { ignored: true, reason: 'no_matching_trigger' }
  }

  const results = []
  for (const trigger of triggers) {
    const lastArrivalAt = trimString(runtime.state.lastArrivalAt)
    if (lastArrivalAt && Date.now() - new Date(lastArrivalAt).getTime() < trigger.arrivalCooldownMs) {
      results.push({ ignored: true, reason: 'arrival_cooldown', triggerId: trigger.id })
      continue
    }

    const episode = createEpisode(trigger, arrivalEvent.detectedAt)
    runtime.state.lastArrivalAt = arrivalEvent.detectedAt || nowIso()
    runtime.state.activeEpisode = episode
    await saveRuntimeState(runtime)
    await logObserverEvent(runtime, 'arrival_triggered', {
      eventId: arrivalEvent.eventId,
      triggerId: trigger.id,
      episodeId: episode.episodeId,
      imagePath: arrivalEvent.imagePath,
    })

    const reply = await generateRemoteLabReply(runtime, trigger, episode, arrivalEvent)
    if (reply.replyText) {
      await speakReply(runtime, reply.replyText, arrivalEvent)
    }

    let followUpTranscript = ''
    if (trigger.speechFollowUp && trigger.followUpTurns > 0) {
      try {
        followUpTranscript = await listenForSpeech(runtime, episode, trigger, arrivalEvent, options.followUpTranscript || '')
      } catch (error) {
        await logObserverEvent(runtime, 'speech_capture_failed', {
          episodeId: episode.episodeId,
          error: error.message,
        })
      }
    }

    if (followUpTranscript) {
      const followUpEvent = normalizeObserverEvent({
        type: 'transcript',
        source: 'speech',
        transcript: followUpTranscript,
        connectorId: arrivalEvent.connectorId,
        roomName: arrivalEvent.roomName,
        metadata: {
          seedEventId: arrivalEvent.eventId,
        },
      }, {
        connectorId: runtime.config.connectorId,
        roomName: runtime.config.roomName,
      })
      results.push(await processTranscriptEvent(runtime, followUpEvent))
    }

    results.push({ ignored: false, triggerId: trigger.id, episodeId: episode.episodeId, reply })
  }
  return { ignored: false, results }
}

async function captureSnapshot(runtime) {
  const seedEvent = normalizeObserverEvent({ type: 'camera_check', source: 'camera' }, {
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
  })
  if (trimString(runtime.config.camera.captureCommand)) {
    const result = await runShellCommand(runtime.config.camera.captureCommand, {
      env: {
        ...runtime.config.camera.env,
        ...buildProcessEnv(runtime, seedEvent),
      },
      timeoutMs: runtime.config.camera.intervalMs,
    })
    const payload = parseCommandPayload(result.stdout)
    if (payload) {
      return resolveHomePath(payload.imagePath || payload.path)
    }
    return resolveHomePath(result.stdout)
  }

  if (!trimString(runtime.config.camera.avfoundationDevice)) {
    throw new Error('camera.avfoundationDevice or camera.captureCommand is required')
  }

  await mkdir(runtime.storagePaths.captureDir, { recursive: true })
  const imagePath = join(runtime.storagePaths.captureDir, `snapshot-${Date.now()}.jpg`)
  const device = runtime.config.camera.avfoundationDevice
  const ffmpegCommand = `${runtime.config.camera.ffmpegPath} -loglevel error -f avfoundation -video_size ${runtime.config.camera.width}x${runtime.config.camera.height} -framerate 1 -i "${device}:none" -frames:v 1 -q:v 4 -y "${imagePath}"`
  await runShellCommand(ffmpegCommand, {
    env: runtime.config.camera.env,
    timeoutMs: Math.max(runtime.config.camera.intervalMs, 5000),
  })
  return imagePath
}

function normalizePresenceAnalysis(payload, imagePath = '') {
  const normalized = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const confidence = Number.isFinite(Number(normalized.confidence)) ? Number(normalized.confidence) : 0
  return {
    personPresent: normalizeBoolean(normalized.personPresent, false),
    confidence,
    summary: normalizeMultilineText(normalized.summary),
    imagePath: resolveHomePath(normalized.imagePath || imagePath),
    observationCount: Number.isFinite(Number(normalized.observationCount)) ? Number(normalized.observationCount) : 0,
    raw: normalized,
  }
}

async function analyzeSnapshot(runtime, imagePath) {
  if (typeof runtime.analyzeSnapshot === 'function') {
    return await runtime.analyzeSnapshot(runtime, imagePath)
  }
  if (!runtime.config.vision.enabled || !trimString(runtime.config.vision.detectorCommand)) {
    return normalizePresenceAnalysis({ personPresent: false, summary: 'vision disabled' }, imagePath)
  }
  const result = await runShellCommand(runtime.config.vision.detectorCommand, {
    env: {
      ...runtime.config.vision.env,
      REMOTELAB_OBSERVER_IMAGE_PATH: imagePath,
    },
    timeoutMs: Math.max(runtime.config.camera.intervalMs, 10000),
  })
  const payload = parseCommandPayload(result.stdout)
  if (!payload) {
    throw new Error(`Vision detector did not return JSON: ${trimString(result.stdout)}`)
  }
  return normalizePresenceAnalysis(payload, imagePath)
}

async function handlePresenceAnalysis(runtime, analysis) {
  runtime.state.lastPresenceAnalysisAt = nowIso()
  if (analysis.personPresent) {
    runtime.state.presentStreak += 1
    runtime.state.absentStreak = 0
  } else {
    runtime.state.absentStreak += 1
    runtime.state.presentStreak = 0
  }

  await saveRuntimeState(runtime)

  if (!runtime.state.isPresent && analysis.personPresent && runtime.state.presentStreak >= runtime.config.vision.presentStreak) {
    runtime.state.isPresent = true
    await saveRuntimeState(runtime)
    const arrivalEvent = normalizeObserverEvent({
      type: 'arrival',
      source: 'vision',
      imagePath: analysis.imagePath,
      summary: analysis.summary || `Person detected with confidence ${analysis.confidence.toFixed(2)}`,
      metadata: {
        confidence: analysis.confidence,
        observationCount: analysis.observationCount,
      },
    }, {
      connectorId: runtime.config.connectorId,
      roomName: runtime.config.roomName,
    })
    return await processArrivalEvent(runtime, arrivalEvent)
  }

  if (runtime.state.isPresent && !analysis.personPresent && runtime.state.absentStreak >= runtime.config.vision.absentStreak) {
    runtime.state.isPresent = false
    await saveRuntimeState(runtime)
    await logObserverEvent(runtime, 'presence_cleared', {
      summary: analysis.summary,
      confidence: analysis.confidence,
    })
  }

  return { ignored: true, reason: 'no_transition' }
}

async function cameraLoop(runtime) {
  while (!runtime.shuttingDown) {
    try {
      const imagePath = await captureSnapshot(runtime)
      const analysis = await analyzeSnapshot(runtime, imagePath)
      await logObserverEvent(runtime, 'camera_presence_analysis', {
        imagePath,
        personPresent: analysis.personPresent,
        confidence: analysis.confidence,
        summary: analysis.summary,
      })
      await enqueueRuntimeTask(runtime, 'camera_presence', () => handlePresenceAnalysis(runtime, analysis))
    } catch (error) {
      await logObserverEvent(runtime, 'camera_poll_failed', {
        error: error.message,
      })
    }
    await delay(runtime.config.camera.intervalMs)
  }
}

function enqueueRuntimeTask(runtime, label, work) {
  const task = runtime.queue.then(async () => await work())
  runtime.queue = task.catch(async (error) => {
    await logObserverEvent(runtime, 'task_failed', {
      label,
      error: error.message,
    })
  })
  return task
}

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function handleHttpEvent(runtime, payload) {
  const event = normalizeObserverEvent(payload, {
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
  })
  if (!event) {
    return { status: 400, body: { error: 'invalid_event' } }
  }

  if (event.type === 'arrival') {
    enqueueRuntimeTask(runtime, 'manual_arrival', () => processArrivalEvent(runtime, event))
    return { status: 202, body: { accepted: true, queued: true, eventId: event.eventId, type: event.type } }
  }

  if (event.type === 'transcript') {
    enqueueRuntimeTask(runtime, 'manual_transcript', () => processTranscriptEvent(runtime, event))
    return { status: 202, body: { accepted: true, queued: true, eventId: event.eventId, type: event.type } }
  }

  return { status: 400, body: { error: 'unsupported_event_type' } }
}

async function startHttpServer(runtime) {
  runtime.server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true, connectorId: runtime.config.connectorId })
        return
      }

      if (req.method === 'GET' && req.url === '/state') {
        writeJson(res, 200, {
          ok: true,
          state: runtime.state,
          cameraEnabled: runtime.config.camera.enabled,
          http: runtime.config.http,
        })
        return
      }

      if (req.method === 'POST' && req.url === '/events') {
        let body
        try {
          body = await readRequestBody(req)
        } catch {
          writeJson(res, 400, { error: 'invalid_json' })
          return
        }
        const result = await handleHttpEvent(runtime, body)
        writeJson(res, result.status, result.body)
        return
      }

      writeJson(res, 404, { error: 'not_found' })
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'internal_error' })
    }
  })

  await new Promise((resolvePromise, rejectPromise) => {
    runtime.server.once('error', rejectPromise)
    runtime.server.listen(runtime.config.http.port, runtime.config.http.host, resolvePromise)
  })
  await logObserverEvent(runtime, 'http_server_started', {
    host: runtime.config.http.host,
    port: runtime.config.http.port,
  })
}

async function stopHttpServer(runtime) {
  if (!runtime.server) return
  await new Promise((resolve) => runtime.server.close(resolve))
  runtime.server = null
}

export async function runOnceCameraCheck(runtime) {
  const imagePath = await captureSnapshot(runtime)
  const analysis = await analyzeSnapshot(runtime, imagePath)
  return {
    imagePath,
    ...analysis,
  }
}

async function startRuntime(runtime) {
  await mkdir(runtime.storagePaths.storageDir, { recursive: true })
  await mkdir(runtime.storagePaths.captureDir, { recursive: true })
  await loadRuntimeState(runtime)

  if (runtime.config.http.enabled) {
    await startHttpServer(runtime)
  }
  if (runtime.config.camera.enabled) {
    runtime.cameraLoopPromise = cameraLoop(runtime)
  }
}

async function stopRuntime(runtime) {
  runtime.shuttingDown = true
  await stopHttpServer(runtime)
}

function printConfigTemplate() {
  const detectorCommand = `swift \"${join(PROJECT_ROOT, 'scripts', 'proactive-observer-human-detect.swift')}\" --image \"$REMOTELAB_OBSERVER_IMAGE_PATH\"`
  const listenCommand = `swift \"${join(PROJECT_ROOT, 'scripts', 'proactive-observer-listen-once.swift')}\" --timeout-ms \"$REMOTELAB_OBSERVER_SPEECH_TIMEOUT_MS\"`
  console.log(`{
  "connectorId": "home-observer",
  "roomName": "Living Room",
  "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
  "sessionFolder": "~",
  "sessionTool": "codex",
  "model": "",
  "effort": "",
  "thinking": false,
  "appId": "observer-home",
  "appName": "Home Coach",
  "group": "Observer",
  "systemPrompt": ${JSON.stringify(DEFAULT_SYSTEM_PROMPT)},
  "camera": {
    "enabled": false,
    "avfoundationDevice": "0",
    "intervalMs": ${DEFAULT_CAPTURE_INTERVAL_MS}
  },
  "vision": {
    "enabled": true,
    "detectorCommand": ${JSON.stringify(detectorCommand)},
    "presentStreak": ${DEFAULT_PRESENT_STREAK},
    "absentStreak": ${DEFAULT_ABSENT_STREAK}
  },
  "speech": {
    "enabled": true,
    "listenCommand": ${JSON.stringify(listenCommand)},
    "timeoutMs": ${DEFAULT_SPEECH_TIMEOUT_MS}
  },
  "tts": {
    "enabled": true,
    "mode": "say",
    "voice": "Tingting",
    "rate": ${DEFAULT_TTS_RATE}
  },
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": ${DEFAULT_HTTP_PORT}
  },
  "triggers": [
    {
      "id": "home-arrival",
      "eventType": "arrival",
      "sessionNamePrefix": "Home Arrival",
      "speechFollowUp": true,
      "followUpTurns": 1,
      "followUpWindowMs": ${DEFAULT_FOLLOW_UP_WINDOW_MS},
      "arrivalCooldownMs": ${DEFAULT_ARRIVAL_COOLDOWN_MS},
      "prompt": "The user has just arrived home. Greet them warmly and briefly, then be ready for one immediate spoken follow-up request."
    }
  ]
}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.printConfig) {
    printConfigTemplate()
    return
  }

  const config = await loadConfig(options.configPath)
  if (options.noSpeak) {
    config.tts.enabled = false
  }
  const runtime = createRuntimeContext(config)

  await mkdir(runtime.storagePaths.storageDir, { recursive: true })
  await mkdir(runtime.storagePaths.captureDir, { recursive: true })
  await loadRuntimeState(runtime)

  if (options.onceCamera) {
    const result = await runOnceCameraCheck(runtime)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (options.eventType) {
    const event = normalizeObserverEvent({
      type: options.eventType,
      transcript: options.transcript,
      imagePath: options.imagePath,
      source: 'manual-cli',
    }, {
      connectorId: config.connectorId,
      roomName: config.roomName,
    })
    if (!event) {
      throw new Error('Invalid event payload')
    }
    if (event.type === 'arrival') {
      const result = await processArrivalEvent(runtime, event, { followUpTranscript: options.transcript })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (event.type === 'transcript') {
      const result = await processTranscriptEvent(runtime, event)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    throw new Error(`Unsupported event type: ${event.type}`)
  }

  await startRuntime(runtime)
  console.log(`[observer] running on http://${config.http.host}:${config.http.port}`)
  console.log(`[observer] connector=${config.connectorId} room=${config.roomName}`)
  console.log(`[observer] camera=${config.camera.enabled ? 'enabled' : 'disabled'} triggers=${config.triggers.length}`)

  const stop = async () => {
    await stopRuntime(runtime)
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await new Promise(() => {})
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[observer] ${error.message}`)
    process.exit(1)
  })
}

export {
  DEFAULT_CONFIG_PATH,
  DEFAULT_SYSTEM_PROMPT,
  buildRequestId,
  normalizeSpokenReplyText,
  processTranscriptEvent,
  runShellCommand,
  speakReply,
  startRuntime,
  stopRuntime,
}

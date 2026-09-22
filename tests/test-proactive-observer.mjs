#!/usr/bin/env node
import assert from 'assert/strict'
import http from 'http'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const repoRoot = process.cwd()

const {
  DEFAULT_SYSTEM_PROMPT,
  buildEpisodeExternalTriggerId,
  buildRemoteLabMessage,
  buildSessionName,
  createRuntimeContext,
  loadConfig,
  normalizeObserverEvent,
  processArrivalEvent,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'proactive-observer.mjs')).href)

const tempConfigDir = await mkdtemp(join(tmpdir(), 'remotelab-observer-config-'))
const tempConfigPath = join(tempConfigDir, 'config.json')

await writeFile(tempConfigPath, `${JSON.stringify({
  connectorId: 'home-observer',
  roomName: 'Living Room',
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  camera: {
    enabled: false,
  },
  http: {
    enabled: false,
  },
  tts: {
    enabled: false,
  },
}, null, 2)}\n`, 'utf8')

const loadedConfig = await loadConfig(tempConfigPath)
assert.equal(loadedConfig.connectorId, 'home-observer')
assert.equal(loadedConfig.roomName, 'Living Room')
assert.equal(loadedConfig.sessionTool, 'codex')
assert.equal(loadedConfig.appId, 'observer-home')
assert.equal(loadedConfig.triggers[0].id, 'home-arrival')
assert.equal(loadedConfig.systemPrompt, '')
assert.match(DEFAULT_SYSTEM_PROMPT, /Keep connector-specific overrides minimal/i)

const manualArrival = normalizeObserverEvent({
  type: 'arrival',
  source: 'manual',
  summary: 'Person just entered the room.',
}, {
  connectorId: 'home-observer',
  roomName: 'Living Room',
})
assert.equal(manualArrival.type, 'arrival')
assert.equal(manualArrival.source, 'manual')
assert.equal(manualArrival.roomName, 'Living Room')
assert.match(manualArrival.eventId, /^arrival-/)

const trigger = loadedConfig.triggers[0]
const episode = {
  episodeId: 'home-arrival-20260316t180000',
}

assert.equal(
  buildEpisodeExternalTriggerId(loadedConfig, trigger, episode),
  'observer:home-observer:home-arrival:home-arrival-20260316t180000'
)
assert.match(buildSessionName(trigger, '2026-03-16T18:00:00.000Z'), /^Home Arrival · /)

const renderedPrompt = buildRemoteLabMessage(loadedConfig, trigger, episode, {
  type: 'arrival',
  source: 'vision',
  detectedAt: '2026-03-16T18:00:00.000Z',
  roomName: 'Living Room',
  imagePath: '/tmp/snapshot.jpg',
  summary: 'Person detected near the entry.',
  metadata: { confidence: 0.87 },
})
assert.match(renderedPrompt, /Inbound proactive observer event/i)
assert.match(renderedPrompt, /Current task:/)
assert.match(renderedPrompt, /Snapshot path: \/tmp\/snapshot.jpg/)
assert.doesNotMatch(renderedPrompt, /Reply as speech only/i)

let createPayload = null
const submittedPayloads = []
const eventReplies = new Map()
const server = http.createServer(async (req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk.toString()
  })
  await new Promise((resolve) => req.on('end', resolve))

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createPayload = JSON.parse(body || '{}')
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ session: { id: 'sess_observer_1' } }))
    return
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_observer_1/messages') {
    const payload = JSON.parse(body || '{}')
    submittedPayloads.push(payload)
    if (submittedPayloads.length === 1) {
      eventReplies.set(payload.requestId, '你好，欢迎回来。')
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ run: { id: 'run_observer_1' } }))
      return
    }
    eventReplies.set(payload.requestId, '好的，给你放点轻松的歌。')
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ run: { id: 'run_observer_2' } }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_observer_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ run: { id: 'run_observer_1', state: 'completed' } }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_observer_2') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ run: { id: 'run_observer_2', state: 'completed' } }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_observer_1/events') {
    const events = Array.from(eventReplies.entries()).map(([requestId, content], index) => ({
      seq: index + 1,
      type: 'message',
      role: 'assistant',
      runId: index === 0 ? 'run_observer_1' : 'run_observer_2',
      requestId,
      content,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ events }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

try {
  const address = server.address()
  const spokenReplies = []
  const runtime = createRuntimeContext({
    ...loadedConfig,
    chatBaseUrl: `http://127.0.0.1:${address.port}`,
    tts: {
      ...loadedConfig.tts,
      enabled: false,
    },
  }, {
    readServiceToken: async () => 'service-token',
    loginWithToken: async () => 'session_token=ok',
    listenForSpeech: async () => '我今天情绪挺好，给我放首歌',
    speakReply: async (_runtime, text) => {
      spokenReplies.push(text)
    },
  })

  const originalSpeakReply = runtime.speakReply
  runtime.speakReply = originalSpeakReply

  const arrivalResult = await processArrivalEvent(runtime, normalizeObserverEvent({
    type: 'arrival',
    source: 'vision',
    detectedAt: '2026-03-16T18:00:00.000Z',
    summary: 'Person entered the room.',
  }, {
    connectorId: 'home-observer',
    roomName: 'Living Room',
  }))

  assert.equal(createPayload?.sourceId, 'observer')
  assert.equal(createPayload?.sourceName, 'Home Coach')
  assert.equal(createPayload?.group, 'Observer')
  assert.match(createPayload?.externalTriggerId || '', /^observer:home-observer:home-arrival:/)

  assert.equal(submittedPayloads.length, 2)
  assert.match(submittedPayloads[0].text || '', /Current task:/)
  assert.match(submittedPayloads[1].text || '', /User speech:/)
  assert.match(submittedPayloads[1].text || '', /给我放首歌/)
  assert.equal(arrivalResult.ignored, false)
} finally {
  await new Promise((resolve) => server.close(resolve))
}

console.log('ok - proactive observer config defaults load correctly')
console.log('ok - proactive observer event normalization and prompts look correct')
console.log('ok - proactive observer arrival flow reuses one episode session')

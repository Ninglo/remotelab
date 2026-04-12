#!/usr/bin/env node
import assert from 'assert/strict'
import http from 'http'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const repoRoot = process.cwd()

const {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildExternalTriggerId,
  buildRemoteLabMessage,
  createRuntimeContext,
  generateRemoteLabReply,
  loadConfig,
  normalizeIngressEvent,
  normalizeSpokenReplyText,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'voice-connector.mjs')).href)

const tempConfigDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-config-'))
const tempConfigPath = join(tempConfigDir, 'config.json')

await writeFile(tempConfigPath, `${JSON.stringify({
  connectorId: 'living-room-speaker',
  roomName: 'Living Room',
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  wake: {
    mode: 'stdin',
    keyword: 'Hey Rowan',
  },
  tts: {
    enabled: false,
  },
}, null, 2)}\n`, 'utf8')

const loadedConfig = await loadConfig(tempConfigPath)
assert.equal(loadedConfig.connectorId, 'living-room-speaker')
assert.equal(loadedConfig.roomName, 'Living Room')
assert.equal(loadedConfig.sessionTool, 'codex')
assert.equal(loadedConfig.wake.mode, 'stdin')
assert.equal(loadedConfig.systemPrompt, '')
assert.match(DEFAULT_SESSION_SYSTEM_PROMPT, /Keep connector-specific overrides minimal/i)

await writeFile(tempConfigPath, `${JSON.stringify({
  connectorId: 'living-room-speaker',
  roomName: 'Living Room',
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  systemPrompt: '',
  wake: {
    mode: 'stdin',
    keyword: 'Hey Rowan',
  },
  tts: {
    enabled: false,
  },
}, null, 2)}\n`, 'utf8')
const explicitEmptyPromptConfig = await loadConfig(tempConfigPath)
assert.equal(explicitEmptyPromptConfig.systemPrompt, '')

await writeFile(tempConfigPath, `${JSON.stringify({
  connectorId: 'living-room-speaker',
  roomName: 'Living Room',
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  wake: {
    mode: 'stdin',
    keyword: 'Hey Rowan',
  },
  tts: {
    enabled: false,
  },
}, null, 2)}\n`, 'utf8')

const jsonIngress = normalizeIngressEvent('{"eventId":"wake_1","wakeWord":"Hey Rowan","transcript":"今天天气怎么样？"}', {
  connectorId: 'desk-speaker',
  roomName: 'Office',
})
assert.equal(jsonIngress.eventId, 'wake_1')
assert.equal(jsonIngress.connectorId, 'desk-speaker')
assert.equal(jsonIngress.roomName, 'Office')
assert.equal(jsonIngress.wakeWord, 'Hey Rowan')
assert.equal(jsonIngress.transcript, '今天天气怎么样？')

const plainIngress = normalizeIngressEvent('hello there', {
  connectorId: 'desk-speaker',
  roomName: 'Office',
})
assert.equal(plainIngress.transcript, 'hello there')
assert.equal(plainIngress.connectorId, 'desk-speaker')
assert.ok(plainIngress.eventId.startsWith('voice-'))

assert.equal(buildExternalTriggerId({ connectorId: 'Living Room Speaker' }), 'voice:living-room-speaker')
assert.equal(buildExternalTriggerId({ connectorId: 'Living Room Speaker', eventId: 'wake_1' }, { sessionMode: 'per-wake' }), 'voice:living-room-speaker:wake_1')

const renderedPrompt = buildRemoteLabMessage({
  connectorId: 'living-room-speaker',
  roomName: 'Living Room',
  wakeWord: 'Hey Rowan',
  detectedAt: '2026-03-13T00:00:00.000Z',
  source: 'voice',
  transcript: 'Give me a quick status update.',
  metadata: { microphone: 'usb' },
})
assert.equal(renderedPrompt, 'Give me a quick status update.')

assert.equal(normalizeSpokenReplyText('  <private>hidden</private>  Spoken reply.  '), 'Spoken reply.')

let createPayload = null
let submitPayload = null
const server = http.createServer(async (req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk.toString()
  })
  await new Promise((resolve) => req.on('end', resolve))

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createPayload = JSON.parse(body || '{}')
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ session: { id: 'sess_voice_1' } }))
    return
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_voice_1/messages') {
    submitPayload = JSON.parse(body || '{}')
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ run: { id: 'run_voice_1' } }))
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/sessions/sess_voice_1/responses/')) {
    const prefix = '/api/sessions/sess_voice_1/responses/'
    const responseId = decodeURIComponent(req.url.slice(prefix.length))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      replyPublication: {
        id: responseId,
        responseIds: [responseId],
        state: 'ready',
        ready: true,
        rootRunId: 'run_voice_1',
        finalRunId: 'run_voice_1',
        continuationRunIds: [],
        payload: {
          text: '<private>internal</private> 你好，我在线。',
        },
      },
    }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_voice_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ run: { id: 'run_voice_1', state: 'completed' } }))
    return
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_voice_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'assistant',
        runId: 'run_voice_1',
        requestId: 'voice:living-room-speaker:wake_1',
        content: '<private>internal</private> 你好，我在线。',
      }],
    }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

try {
  const address = server.address()
  const runtime = createRuntimeContext({
    ...loadedConfig,
    chatBaseUrl: `http://127.0.0.1:${address.port}`,
    connectorId: 'living-room-speaker',
    roomName: 'Living Room',
    appId: 'voice',
    appName: 'Voice',
    group: 'Voice',
    wake: {
      mode: 'stdin',
      command: '',
      keyword: 'Hey Rowan',
      env: {},
    },
  }, {
    eventsLogPath: join(tempConfigDir, 'events.jsonl'),
  })
  runtime.authCookie = 'session_token=test-cookie'

  const reply = await generateRemoteLabReply(runtime, {
    eventId: 'wake_1',
    connectorId: 'living-room-speaker',
    roomName: 'Living Room',
    wakeWord: 'Hey Rowan',
    detectedAt: '2026-03-13T00:00:00.000Z',
    source: 'voice',
    transcript: '你好，介绍一下你自己。',
    metadata: { microphone: 'usb' },
  })

  assert.equal(createPayload?.sourceId, 'voice')
  assert.equal(createPayload?.sourceName, 'Voice')
  assert.equal(createPayload?.systemPrompt, '')
  assert.equal(createPayload?.group, 'Voice')
  assert.equal(createPayload?.externalTriggerId, 'voice:living-room-speaker')
  assert.match(createPayload?.description || '', /Wake-word voice connector/i)

  assert.match(submitPayload?.requestId || '', /^voice:living-room-speaker:wake_1$/)
  assert.equal(submitPayload?.tool, 'codex')
  assert.equal(submitPayload?.text || '', '你好，介绍一下你自己。')

  assert.equal(reply.sessionId, 'sess_voice_1')
  assert.equal(reply.runId, 'run_voice_1')
  assert.equal(reply.requestId, 'voice:living-room-speaker:wake_1')
  assert.equal(reply.replyText, '你好，我在线。')
} finally {
  await new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

console.log('ok - voice connector config defaults load correctly')
console.log('ok - voice ingress normalization handles JSON and plain text')
console.log('ok - voice messages stay transcript-first')
console.log('ok - RemoteLab roundtrip uses the voice app scope')

/**
 * Tests for connector-sdk HTTP server endpoints.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDispatchTable } from '../lib/connector-sdk/dispatch-table.mjs'
import { createConnectorServer } from '../lib/connector-sdk/server.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'test-server-'))
const cleanup = () => rmSync(tmp, { recursive: true, force: true })

const CALLBACK_TOKEN = 'test-callback-secret'
let baseUrl
let server

try {
  // Setup
  const dt = createDispatchTable(tmp)
  const replies = []
  server = createConnectorServer({
    dispatchTable: dt,
    channel: 'email',
    callbackToken: CALLBACK_TOKEN,
    onReply: async (body) => {
      replies.push(body)
      return { externalId: 'ext_123', channel: 'email' }
    },
  })

  const httpServer = await server.start(0, '127.0.0.1')
  const port = httpServer.address().port
  baseUrl = `http://127.0.0.1:${port}`
  console.log(`  Test server on port ${port}`)

  // --- Health check ---
  {
    const res = await fetch(`${baseUrl}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.channel, 'email')
    console.log('  ✓ GET /healthz returns ok')
  }

  // --- Register ---
  let registrationId
  {
    const res = await fetch(`${baseUrl}/dispatch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'test-inst',
        instanceUrl: 'http://localhost:9999',
        token: 'inst-token',
        rules: [{ pattern: '*@test.dev', priority: 100 }],
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.registrationId)
    assert.equal(body.channel, 'email')
    assert.ok(body.callback.replyUrl)
    assert.equal(body.callback.token, CALLBACK_TOKEN)
    registrationId = body.registrationId
    console.log('  ✓ POST /dispatch/register creates registration')
  }

  // --- Register validation ---
  {
    const res = await fetch(`${baseUrl}/dispatch/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: 'incomplete' }),
    })
    assert.equal(res.status, 400)
    console.log('  ✓ POST /dispatch/register rejects incomplete payload')
  }

  // --- Heartbeat ---
  {
    const res = await fetch(`${baseUrl}/dispatch/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationId }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'active')
    console.log('  ✓ POST /dispatch/heartbeat succeeds')
  }

  // --- Heartbeat unknown ---
  {
    const res = await fetch(`${baseUrl}/dispatch/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationId: 'reg_nonexistent' }),
    })
    assert.equal(res.status, 404)
    console.log('  ✓ POST /dispatch/heartbeat returns 404 for unknown')
  }

  // --- Reply callback with valid token ---
  {
    const res = await fetch(`${baseUrl}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CALLBACK_TOKEN}`,
      },
      body: JSON.stringify({
        instanceId: 'test-inst',
        sessionId: 'sess_1',
        externalTriggerId: 'email:msg-1',
        sourceContext: { channel: 'email', from: { address: 'user@test.dev' } },
        reply: { body: 'AI response here' },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.delivered, true)
    assert.equal(body.externalId, 'ext_123')
    assert.equal(replies.length, 1)
    assert.equal(replies[0].reply.body, 'AI response here')
    console.log('  ✓ POST /reply with valid token delivers reply')
  }

  // --- Reply callback with invalid token ---
  {
    const res = await fetch(`${baseUrl}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({
        sourceContext: {},
        reply: { body: 'should fail' },
      }),
    })
    assert.equal(res.status, 401)
    console.log('  ✓ POST /reply rejects invalid callback token')
  }

  // --- Reply callback missing fields ---
  {
    const res = await fetch(`${baseUrl}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CALLBACK_TOKEN}`,
      },
      body: JSON.stringify({ sourceContext: {} }),
    })
    assert.equal(res.status, 400)
    console.log('  ✓ POST /reply rejects missing reply.body')
  }

  // --- Custom route ---
  {
    server.addRoute('POST', '/custom-webhook', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ custom: true }))
    })
    const res = await fetch(`${baseUrl}/custom-webhook`, { method: 'POST' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.custom, true)
    console.log('  ✓ custom route works')
  }

  // --- 404 ---
  {
    const res = await fetch(`${baseUrl}/nonexistent`)
    assert.equal(res.status, 404)
    console.log('  ✓ unknown path returns 404')
  }

  // --- Deregister ---
  {
    const res = await fetch(`${baseUrl}/dispatch/register/${registrationId}`, {
      method: 'DELETE',
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'removed')
    assert.equal(dt.getEntries().length, 0)
    console.log('  ✓ DELETE /dispatch/register/:id removes registration')
  }

  console.log('\n✓ All server tests passed')
} finally {
  if (server) await server.stop()
  cleanup()
}

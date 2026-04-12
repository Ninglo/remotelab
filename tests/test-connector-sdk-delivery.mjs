/**
 * Tests for connector-sdk delivery (message delivery to instances).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { deliverToInstance, deliverWithRetry, writeDeadLetter } from '../lib/connector-sdk/delivery.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'test-delivery-'))
const cleanup = () => rmSync(tmp, { recursive: true, force: true })

// Mock instance HTTP server
function createMockInstance(behavior = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {}
      calls.push({ method: req.method, url: req.url, body, headers: req.headers })

      if (behavior.failSession && req.url === '/api/sessions') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'mock_session_fail' }))
      }

      if (req.url === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ id: 'sess_mock_1' }))
      }

      if (req.url.includes('/messages')) {
        if (behavior.failMessage) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'mock_message_fail' }))
        }
        res.writeHead(202, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ run: { id: 'run_mock_1' }, duplicate: false }))
      }

      res.writeHead(404)
      res.end()
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

try {
  // --- Successful delivery ---
  {
    const mock = await createMockInstance()
    try {
      const result = await deliverToInstance(
        { instanceUrl: mock.url, token: 'test-token' },
        {
          id: 'cmsg_test_1',
          from: { address: 'user@test.dev', name: 'User' },
          to: { address: 'rowan@test.dev' },
          content: { subject: 'Hello', body: 'Test message' },
          thread: { externalId: 'email:msg-1' },
          sourceContext: { channel: 'email' },
          createdAt: '2026-04-10T12:00:00Z',
        },
        { channel: 'email' }
      )

      assert.equal(result.delivered, true)
      assert.equal(result.sessionId, 'sess_mock_1')
      assert.equal(result.runId, 'run_mock_1')

      // Verify session creation call
      const sessionCall = mock.calls.find(c => c.url === '/api/sessions')
      assert.ok(sessionCall)
      assert.equal(sessionCall.body.sourceId, 'email')
      assert.equal(sessionCall.body.externalTriggerId, 'email:msg-1')
      assert.equal(sessionCall.headers.authorization, 'Bearer test-token')

      // Verify message submission call
      const msgCall = mock.calls.find(c => c.url.includes('/messages'))
      assert.ok(msgCall)
      assert.equal(msgCall.body.requestId, 'cmsg_test_1')
      assert.ok(msgCall.body.text.includes('Test message'))
      assert.deepEqual(msgCall.body.sourceContext, { channel: 'email' })

      console.log('  ✓ successful delivery creates session and submits message')
    } finally {
      await mock.close()
    }
  }

  // --- Session creation failure ---
  {
    const mock = await createMockInstance({ failSession: true })
    try {
      const result = await deliverToInstance(
        { instanceUrl: mock.url, token: 'test-token' },
        {
          id: 'cmsg_test_2',
          from: { address: 'user@test.dev' },
          to: { address: 'rowan@test.dev' },
          content: { body: 'Test' },
        },
        { channel: 'email' }
      )
      assert.equal(result.delivered, false)
      assert.equal(result.error, 'session_create_failed')
      console.log('  ✓ delivery fails gracefully on session creation error')
    } finally {
      await mock.close()
    }
  }

  // --- Message submission failure ---
  {
    const mock = await createMockInstance({ failMessage: true })
    try {
      const result = await deliverToInstance(
        { instanceUrl: mock.url, token: 'test-token' },
        {
          id: 'cmsg_test_3',
          from: { address: 'user@test.dev' },
          to: { address: 'rowan@test.dev' },
          content: { body: 'Test' },
        },
        { channel: 'email' }
      )
      assert.equal(result.delivered, false)
      assert.equal(result.error, 'message_submit_failed')
      console.log('  ✓ delivery fails gracefully on message submission error')
    } finally {
      await mock.close()
    }
  }

  // --- Network error (no server) ---
  {
    const result = await deliverToInstance(
      { instanceUrl: 'http://127.0.0.1:59999', token: 'test-token' },
      {
        id: 'cmsg_test_4',
        from: { address: 'user@test.dev' },
        to: { address: 'rowan@test.dev' },
        content: { body: 'Test' },
      },
      { channel: 'email' }
    )
    assert.equal(result.delivered, false)
    console.log('  ✓ delivery handles network errors')
  }

  // --- Dead letter writing ---
  {
    const dlPath = writeDeadLetter(
      tmp,
      { id: 'cmsg_dead_1', content: { body: 'undeliverable' } },
      { instanceId: 'inst-a' },
      { error: 'all_retries_exhausted', message: 'connection refused' }
    )

    assert.ok(existsSync(dlPath))
    const entry = JSON.parse(readFileSync(dlPath, 'utf8'))
    assert.equal(entry.targetInstanceId, 'inst-a')
    assert.equal(entry.failureReason, 'all_retries_exhausted')
    assert.ok(entry.failedAt)

    const dlDir = join(tmp, 'dead_letter')
    assert.ok(readdirSync(dlDir).length >= 1)
    console.log('  ✓ dead letter queue writes failed messages')
  }

  // --- deliverWithRetry on permanent 4xx ---
  {
    let callCount = 0
    const server = createServer((req, res) => {
      callCount++
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad_request' }))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    try {
      const result = await deliverWithRetry(
        { instanceUrl: `http://127.0.0.1:${port}`, token: 'test' },
        {
          id: 'cmsg_test_5',
          from: { address: 'user@test.dev' },
          to: { address: 'rowan@test.dev' },
          content: { body: 'Test' },
        },
        { channel: 'email' }
      )
      assert.equal(result.delivered, false)
      // Should NOT retry on 4xx (only 1 attempt)
      assert.equal(callCount, 1)
      console.log('  ✓ deliverWithRetry does not retry on 4xx')
    } finally {
      await new Promise(r => server.close(r))
    }
  }

  console.log('\n✓ All delivery tests passed')
} finally {
  cleanup()
}

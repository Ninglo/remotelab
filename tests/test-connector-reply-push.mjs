/**
 * Tests for instance-side connector reply push.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import {
  initCallbackRegistry,
  registerCallback,
  getCallback,
  pushReplyToConnector,
  savePendingReply,
  flushPendingReplies,
} from '../lib/connector-reply-push.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'test-reply-push-'))
const cleanup = () => rmSync(tmp, { recursive: true, force: true })

try {
  // --- Callback registry ---
  {
    initCallbackRegistry(tmp)
    registerCallback('email', { replyUrl: 'http://localhost:1234/reply', token: 'tok-email' })
    registerCallback('feishu', { replyUrl: 'http://localhost:5678/reply', token: 'tok-feishu' })

    assert.deepEqual(getCallback('email'), { replyUrl: 'http://localhost:1234/reply', token: 'tok-email' })
    assert.deepEqual(getCallback('feishu'), { replyUrl: 'http://localhost:5678/reply', token: 'tok-feishu' })
    assert.equal(getCallback('unknown'), null)

    // Persisted to disk
    const filePath = join(tmp, 'connector-callbacks.json')
    assert.ok(existsSync(filePath))
    const saved = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.ok(saved.email)
    assert.ok(saved.feishu)

    console.log('  ✓ callback registry CRUD and persistence')
  }

  // --- Push reply to connector (success) ---
  {
    const receivedReplies = []
    const mockConnector = createServer((req, res) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => {
        receivedReplies.push({ body: JSON.parse(data), auth: req.headers.authorization })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ delivered: true, externalId: 'ext_001' }))
      })
    })
    await new Promise(r => mockConnector.listen(0, '127.0.0.1', r))
    const port = mockConnector.address().port

    try {
      registerCallback('email', { replyUrl: `http://127.0.0.1:${port}/reply`, token: 'test-secret' })

      const result = await pushReplyToConnector(
        {
          id: 'sess_1',
          sourceId: 'email',
          externalTriggerId: 'email:msg-1',
          sourceContext: { channel: 'email', from: { address: 'user@test.dev' }, subject: 'Test' },
        },
        { body: 'AI response text', attachments: [] }
      )

      assert.equal(result.pushed, true)
      assert.equal(result.externalId, 'ext_001')
      assert.equal(receivedReplies.length, 1)
      assert.equal(receivedReplies[0].body.reply.body, 'AI response text')
      assert.equal(receivedReplies[0].body.sessionId, 'sess_1')
      assert.equal(receivedReplies[0].body.sourceContext.from.address, 'user@test.dev')
      assert.equal(receivedReplies[0].auth, 'Bearer test-secret')

      console.log('  ✓ pushReplyToConnector delivers reply with correct payload and auth')
    } finally {
      await new Promise(r => mockConnector.close(r))
    }
  }

  // --- Push reply with no sourceId ---
  {
    const result = await pushReplyToConnector(
      { id: 'sess_2' },
      { body: 'Should not push' }
    )
    assert.equal(result.pushed, false)
    assert.equal(result.error, 'no_sourceId')
    console.log('  ✓ pushReplyToConnector skips sessions without sourceId')
  }

  // --- Push reply with unregistered connector ---
  {
    const result = await pushReplyToConnector(
      { id: 'sess_3', sourceId: 'slack' },
      { body: 'No callback' }
    )
    assert.equal(result.pushed, false)
    assert.equal(result.error, 'no_callback_registered')
    console.log('  ✓ pushReplyToConnector fails for unregistered connector')
  }

  // --- Push reply to unreachable connector ---
  {
    registerCallback('broken', { replyUrl: 'http://127.0.0.1:1/reply', token: 'tok' })
    const result = await pushReplyToConnector(
      { id: 'sess_4', sourceId: 'broken', sourceContext: {} },
      { body: 'Unreachable' }
    )
    assert.equal(result.pushed, false)
    assert.equal(result.error, 'reply_push_failed')
    console.log('  ✓ pushReplyToConnector handles network errors')
  }

  // --- Save pending reply ---
  {
    const path = savePendingReply(tmp,
      { id: 'sess_5', sourceId: 'email', externalTriggerId: 'email:msg-5', sourceContext: { from: { address: 'test@test.dev' } } },
      { body: 'Pending reply' }
    )
    assert.ok(existsSync(path))
    const entry = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(entry.sessionId, 'sess_5')
    assert.equal(entry.sourceId, 'email')
    assert.equal(entry.reply.body, 'Pending reply')
    console.log('  ✓ savePendingReply writes to pending queue')
  }

  // --- Flush pending replies ---
  {
    const flushedReplies = []
    const mockConnector = createServer((req, res) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => {
        flushedReplies.push(JSON.parse(data))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ delivered: true }))
      })
    })
    await new Promise(r => mockConnector.listen(0, '127.0.0.1', r))
    const port = mockConnector.address().port

    try {
      registerCallback('email', { replyUrl: `http://127.0.0.1:${port}/reply`, token: 'tok' })

      const results = await flushPendingReplies(tmp, 'email')
      assert.ok(results.length >= 1)
      assert.equal(results[0].pushed, true)
      assert.equal(flushedReplies.length, 1)
      assert.equal(flushedReplies[0].reply.body, 'Pending reply')

      // Pending file should be deleted
      const pendingDir = join(tmp, 'connector-pending-replies')
      const remaining = readdirSync(pendingDir).filter(f => f.endsWith('.json'))
      assert.equal(remaining.length, 0)

      console.log('  ✓ flushPendingReplies delivers and cleans up')
    } finally {
      await new Promise(r => mockConnector.close(r))
    }
  }

  console.log('\n✓ All reply push tests passed')
} finally {
  cleanup()
}

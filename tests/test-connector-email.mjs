/**
 * Tests for the email connector (normalization, matching, admission).
 */
import assert from 'node:assert/strict'
import { emailMatchFn, checkAdmission, normalizeCloudflareEmail, EMAIL_SKILLS } from '../connectors/email/index.mjs'

// --- emailMatchFn ---
{
  // Exact match
  assert.equal(emailMatchFn('alice@test.dev', { to: { address: 'alice@test.dev' } }), true)
  assert.equal(emailMatchFn('alice@test.dev', { to: { address: 'bob@test.dev' } }), false)

  // Case insensitive
  assert.equal(emailMatchFn('Alice@Test.Dev', { to: { address: 'alice@test.dev' } }), true)

  // Wildcard domain
  assert.equal(emailMatchFn('*@test.dev', { to: { address: 'anyone@test.dev' } }), true)
  assert.equal(emailMatchFn('*@test.dev', { to: { address: 'anyone@other.dev' } }), false)

  // Catch-all
  assert.equal(emailMatchFn('*', { to: { address: 'anyone@anywhere.dev' } }), true)

  // Prefix wildcard
  assert.equal(emailMatchFn('support-*@test.dev', { to: { address: 'support-123@test.dev' } }), true)
  assert.equal(emailMatchFn('support-*@test.dev', { to: { address: 'sales-123@test.dev' } }), false)

  // Missing address
  assert.equal(emailMatchFn('*@test.dev', { to: {} }), false)
  assert.equal(emailMatchFn('*@test.dev', {}), false)

  console.log('  ✓ emailMatchFn handles exact, wildcard, prefix, case-insensitive, missing')
}

// --- checkAdmission ---
{
  // No allowlist → allow all
  assert.equal(checkAdmission({ from: { address: 'anyone@any.dev' } }, null), true)
  assert.equal(checkAdmission({ from: { address: 'anyone@any.dev' } }, {}), true)
  assert.equal(checkAdmission({ from: { address: 'anyone@any.dev' } }, { allowedEmails: [], allowedDomains: [] }), true)

  // Email allowlist
  const allowlist = { allowedEmails: ['alice@test.dev'], allowedDomains: ['trusted.com'] }
  assert.equal(checkAdmission({ from: { address: 'alice@test.dev' } }, allowlist), true)
  assert.equal(checkAdmission({ from: { address: 'bob@test.dev' } }, allowlist), false)

  // Domain allowlist
  assert.equal(checkAdmission({ from: { address: 'anyone@trusted.com' } }, allowlist), true)
  assert.equal(checkAdmission({ from: { address: 'anyone@untrusted.com' } }, allowlist), false)

  // Case insensitive
  assert.equal(checkAdmission({ from: { address: 'Alice@Test.Dev' } }, allowlist), true)

  console.log('  ✓ checkAdmission handles allowlist, domain list, empty list, case')
}

// --- normalizeCloudflareEmail ---
{
  // JSON payload
  const msg1 = normalizeCloudflareEmail({
    envelope: { mailFrom: 'alice@test.dev', rcptTo: 'rowan@target.dev' },
    headers: { subject: 'Hello World', messageId: '<msg-1@test.dev>', inReplyTo: '<msg-0@test.dev>' },
    text: 'This is the email body',
    html: '<p>This is the email body</p>',
  })

  assert.ok(msg1.id.startsWith('cmsg_'))
  assert.equal(msg1.channel, 'email')
  assert.equal(msg1.direction, 'inbound')
  assert.equal(msg1.from.address, 'alice@test.dev')
  assert.equal(msg1.to.address, 'rowan@target.dev')
  assert.equal(msg1.content.subject, 'Hello World')
  assert.equal(msg1.content.body, 'This is the email body')
  assert.equal(msg1.content.html, '<p>This is the email body</p>')
  assert.equal(msg1.thread.externalId, 'email:<msg-1@test.dev>')
  assert.equal(msg1.sourceContext.inReplyTo, '<msg-0@test.dev>')
  assert.ok(msg1.createdAt)

  console.log('  ✓ normalizeCloudflareEmail parses JSON payload')

  // Header-based payload (Cloudflare Worker style)
  const msg2 = normalizeCloudflareEmail(
    { text: 'Body from worker' },
    {
      'x-envelope-from': 'sender@ext.dev',
      'x-envelope-to': 'rowan@target.dev',
      'x-email-subject': 'Worker Subject',
      'x-email-message-id': '<msg-2@ext.dev>',
    }
  )

  assert.equal(msg2.from.address, 'sender@ext.dev')
  assert.equal(msg2.to.address, 'rowan@target.dev')
  assert.equal(msg2.content.subject, 'Worker Subject')
  assert.equal(msg2.content.body, 'Body from worker')

  console.log('  ✓ normalizeCloudflareEmail parses header-based payload')

  // Minimal payload
  const msg3 = normalizeCloudflareEmail({})
  assert.ok(msg3.id)
  assert.equal(msg3.content.body, '')
  assert.equal(msg3.from.address, '')

  console.log('  ✓ normalizeCloudflareEmail handles minimal/empty payload')
}

// --- EMAIL_SKILLS ---
{
  assert.ok(Array.isArray(EMAIL_SKILLS))
  assert.equal(EMAIL_SKILLS.length, 2)

  const send = EMAIL_SKILLS.find(s => s.name === 'send')
  assert.ok(send, 'Should have a send skill')
  assert.ok(send.schema.to.required, 'send.to should be required')
  assert.ok(send.schema.subject.required, 'send.subject should be required')
  assert.ok(send.schema.body.required, 'send.body should be required')
  assert.ok(send.schema.cc, 'send should have optional cc')
  assert.ok(send.schema.html, 'send should have optional html')

  const bulk = EMAIL_SKILLS.find(s => s.name === 'send_bulk')
  assert.ok(bulk, 'Should have a send_bulk skill')
  assert.ok(bulk.schema.recipients.required, 'send_bulk.recipients should be required')

  console.log('  ✓ EMAIL_SKILLS declares send and send_bulk with correct schemas')
}

console.log('\n✓ All email connector tests passed')

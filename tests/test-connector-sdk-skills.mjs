/**
 * Tests for Connector SDK skill infrastructure:
 * - Skill declaration in Register response
 * - Skill execution via /skill/:name endpoint
 * - Auth validation on skill calls
 * - Error handling for unknown skills, missing params
 */

import assert from 'node:assert/strict'
import { createDispatchTable } from '../lib/connector-sdk/dispatch-table.mjs'
import { createConnectorServer } from '../lib/connector-sdk/server.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpDir = mkdtempSync(join(tmpdir(), 'test-sdk-skills-'))

const TEST_SKILLS = [
  {
    name: 'send',
    description: 'Send an email',
    schema: {
      to: { type: 'string', required: true },
      subject: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
  },
  {
    name: 'send_bulk',
    description: 'Bulk send',
    schema: {
      recipients: { type: 'array', required: true },
      subject: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
  },
]

let lastSkillCall = null
const dispatchTable = createDispatchTable(tmpDir)
const server = createConnectorServer({
  dispatchTable,
  channel: 'email',
  callbackToken: 'test-cb-token',
  skills: TEST_SKILLS,
  onReply: async () => ({}),
  onSkill: async (skillName, body) => {
    lastSkillCall = { skillName, ...body }
    if (body.parameters?.to === 'fail@test.dev') throw new Error('simulated send failure')
    return { externalId: 'msg-123', channel: 'email' }
  },
})

let serverPort
let baseUrl

async function setup() {
  const s = await server.start(0, '127.0.0.1')
  serverPort = s.address().port
  baseUrl = `http://127.0.0.1:${serverPort}`
}

async function teardown() {
  await server.stop()
  rmSync(tmpDir, { recursive: true, force: true })
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = await res.json()
  return { status: res.status, body: json }
}

// --- Tests ---

await setup()

// 1. Register response includes skills and skillUrl
{
  const res = await post('/dispatch/register', {
    instanceId: 'inst-a',
    instanceUrl: 'http://localhost:7690',
    token: 'inst-token',
    rules: [{ pattern: '*', priority: 100 }],
  })

  assert.equal(res.status, 200)
  assert.ok(res.body.callback.skillUrl, 'Register response should include skillUrl')
  assert.ok(res.body.callback.skillUrl.endsWith('/skill'), `skillUrl should end with /skill, got ${res.body.callback.skillUrl}`)
  assert.ok(Array.isArray(res.body.skills), 'Register response should include skills array')
  assert.equal(res.body.skills.length, 2)
  assert.equal(res.body.skills[0].name, 'send')
  assert.equal(res.body.skills[1].name, 'send_bulk')
  assert.ok(res.body.skills[0].schema.to, 'Skill schema should include fields')
  console.log('  ✓ Register response includes skills and skillUrl')
}

// 2. Skill execution succeeds with valid token and parameters
{
  lastSkillCall = null
  const res = await post('/skill/send', {
    instanceId: 'inst-a',
    sessionId: 'session-1',
    parameters: { to: 'alice@test.dev', subject: 'Hello', body: 'Hi there' },
  }, 'test-cb-token')

  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.result.externalId, 'msg-123')
  assert.equal(lastSkillCall.skillName, 'send')
  assert.equal(lastSkillCall.parameters.to, 'alice@test.dev')
  assert.equal(lastSkillCall.instanceId, 'inst-a')
  console.log('  ✓ Skill execution succeeds with valid token and parameters')
}

// 3. Skill execution rejects invalid token
{
  const res = await post('/skill/send', {
    instanceId: 'inst-a',
    sessionId: 'session-1',
    parameters: { to: 'alice@test.dev', subject: 'Hello', body: 'Hi' },
  }, 'wrong-token')

  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'invalid_callback_token')
  console.log('  ✓ Skill execution rejects invalid token')
}

// 4. Skill execution returns 404 for unknown skill
{
  const res = await post('/skill/nonexistent', {
    instanceId: 'inst-a',
    sessionId: 'session-1',
    parameters: { foo: 'bar' },
  }, 'test-cb-token')

  assert.equal(res.status, 404)
  assert.equal(res.body.error, 'skill_not_found')
  assert.equal(res.body.skill, 'nonexistent')
  assert.ok(Array.isArray(res.body.available))
  console.log('  ✓ Skill execution returns 404 for unknown skill')
}

// 5. Skill execution returns 400 for missing parameters
{
  const res = await post('/skill/send', {
    instanceId: 'inst-a',
    sessionId: 'session-1',
    // no parameters field
  }, 'test-cb-token')

  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'missing_parameters')
  console.log('  ✓ Skill execution returns 400 for missing parameters')
}

// 6. Skill execution handles onSkill errors (502)
{
  const res = await post('/skill/send', {
    instanceId: 'inst-a',
    sessionId: 'session-1',
    parameters: { to: 'fail@test.dev', subject: 'Fail', body: 'This should fail' },
  }, 'test-cb-token')

  assert.equal(res.status, 502)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error, 'skill_execution_failed')
  assert.ok(res.body.message.includes('simulated send failure'))
  console.log('  ✓ Skill execution handles onSkill errors (502)')
}

// 7. Second skill (send_bulk) works too
{
  lastSkillCall = null
  const res = await post('/skill/send_bulk', {
    instanceId: 'inst-a',
    sessionId: 'session-2',
    parameters: { recipients: ['a@test.dev', 'b@test.dev'], subject: 'Bulk', body: 'Hello all' },
  }, 'test-cb-token')

  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.equal(lastSkillCall.skillName, 'send_bulk')
  assert.deepEqual(lastSkillCall.parameters.recipients, ['a@test.dev', 'b@test.dev'])
  console.log('  ✓ Second skill (send_bulk) works')
}

// 8. Register without skills omits skillUrl and skills from response
{
  const noSkillDispatch = createDispatchTable(mkdtempSync(join(tmpdir(), 'test-noskill-')))
  const noSkillServer = createConnectorServer({
    dispatchTable: noSkillDispatch,
    channel: 'webhook',
    callbackToken: 'test-token',
    skills: [],  // no skills
    onReply: async () => ({}),
  })
  const s = await noSkillServer.start(0, '127.0.0.1')
  const noSkillPort = s.address().port

  const res = await fetch(`http://127.0.0.1:${noSkillPort}/dispatch/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId: 'inst-b',
      instanceUrl: 'http://localhost:7690',
      token: 'tok',
      rules: [{ pattern: '*', priority: 100 }],
    }),
  })
  const body = await res.json()

  assert.equal(body.callback.skillUrl, undefined, 'No skillUrl when no skills')
  assert.equal(body.skills, undefined, 'No skills array when no skills')
  await noSkillServer.stop()
  console.log('  ✓ Register without skills omits skillUrl and skills from response')
}

await teardown()

console.log('\n✓ All SDK skill tests passed')

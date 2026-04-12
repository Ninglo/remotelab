/**
 * Tests for Instance-side connector-skill-registry:
 * - registerConnectorSkills / deregisterConnectorSkills
 * - getToolDefinitions / getAllToolDefinitions
 * - executeConnectorSkill (with mock connector)
 * - Persistence across init cycles
 * - Error handling: unknown channel, unknown skill, network error
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initSkillRegistry,
  registerConnectorSkills,
  deregisterConnectorSkills,
  getToolDefinitions,
  getAllToolDefinitions,
  getRegisteredChannels,
  executeConnectorSkill,
} from '../lib/connector-skill-registry.mjs'

const tmpDir = mkdtempSync(join(tmpdir(), 'test-skill-reg-'))

// --- Mock connector skill server ---

function createMockSkillServer(handler) {
  return new Promise(resolve => {
    const s = createServer(async (req, res) => {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', async () => {
        const json = body ? JSON.parse(body) : {}
        const result = await handler(req, json)
        res.writeHead(result.status || 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body || {}))
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

// --- Tests ---

// 1. Init and register
{
  initSkillRegistry(tmpDir)

  const tools = registerConnectorSkills('email', {
    callback: {
      replyUrl: 'http://localhost:1234/reply',
      skillUrl: 'http://localhost:1234/skill',
      token: 'email-token',
    },
    skills: [
      { name: 'send', description: 'Send an email', schema: { to: { type: 'string', required: true }, body: { type: 'string', required: true } } },
      { name: 'send_bulk', description: 'Bulk send', schema: { recipients: { type: 'array', required: true } } },
    ],
  })

  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'email:send')
  assert.equal(tools[1].name, 'email:send_bulk')
  assert.equal(tools[0].description, 'Send an email')
  assert.ok(tools[0].parameters.to)
  assert.deepEqual(tools[0]._source, { channel: 'email', skillName: 'send' })
  console.log('  ✓ registerConnectorSkills returns tool definitions')
}

// 2. Register a second channel
{
  registerConnectorSkills('feishu', {
    callback: {
      replyUrl: 'http://localhost:5678/reply',
      skillUrl: 'http://localhost:5678/skill',
      token: 'feishu-token',
    },
    skills: [
      { name: 'send', description: 'Send Feishu message', schema: { to: {}, body: {} } },
      { name: 'create_group', description: 'Create group chat', schema: { name: {}, members: {} } },
    ],
  })

  const channels = getRegisteredChannels()
  assert.deepEqual(channels.sort(), ['email', 'feishu'])
  console.log('  ✓ Multiple channels register independently')
}

// 3. getToolDefinitions for specific channel
{
  const emailTools = getToolDefinitions('email')
  assert.equal(emailTools.length, 2)
  assert.equal(emailTools[0].name, 'email:send')

  const feishuTools = getToolDefinitions('feishu')
  assert.equal(feishuTools.length, 2)
  assert.equal(feishuTools[1].name, 'feishu:create_group')

  const noTools = getToolDefinitions('slack')
  assert.equal(noTools.length, 0)
  console.log('  ✓ getToolDefinitions returns correct tools per channel')
}

// 4. getAllToolDefinitions
{
  const all = getAllToolDefinitions()
  assert.equal(all.length, 4)
  const names = all.map(t => t.name).sort()
  assert.deepEqual(names, ['email:send', 'email:send_bulk', 'feishu:create_group', 'feishu:send'])
  console.log('  ✓ getAllToolDefinitions returns all tools from all channels')
}

// 5. Persistence: re-init and verify
{
  initSkillRegistry(tmpDir) // re-read from disk
  const all = getAllToolDefinitions()
  assert.equal(all.length, 4, 'Should persist across re-init')
  console.log('  ✓ Skill registry persists to disk and reloads')
}

// 6. Deregister a channel
{
  const removed = deregisterConnectorSkills('feishu')
  assert.equal(removed, true)
  assert.equal(getAllToolDefinitions().length, 2)
  assert.deepEqual(getRegisteredChannels(), ['email'])

  const removedAgain = deregisterConnectorSkills('feishu')
  assert.equal(removedAgain, false)
  console.log('  ✓ deregisterConnectorSkills removes channel and is idempotent')
}

// 7. Register with empty skills removes stale entry
{
  registerConnectorSkills('email', {
    callback: { replyUrl: '', skillUrl: '', token: '' },
    skills: [],
  })
  assert.equal(getAllToolDefinitions().length, 0)
  assert.deepEqual(getRegisteredChannels(), [])
  console.log('  ✓ Register with empty skills clears the channel entry')
}

// 8. executeConnectorSkill — success
{
  const mockServer = await createMockSkillServer((req, body) => {
    assert.ok(req.url.endsWith('/send'))
    assert.equal(req.headers.authorization, 'Bearer mock-token')
    assert.equal(body.parameters.to, 'alice@test.dev')
    return { status: 200, body: { success: true, result: { externalId: 'msg-456' } } }
  })
  const port = mockServer.address().port

  registerConnectorSkills('email', {
    callback: { skillUrl: `http://127.0.0.1:${port}/skill`, token: 'mock-token' },
    skills: [{ name: 'send', description: 'Send', schema: { to: {} } }],
  })

  const result = await executeConnectorSkill('email:send', { to: 'alice@test.dev' }, { instanceId: 'inst-a', sessionId: 's1' })
  assert.equal(result.success, true)
  assert.equal(result.result.externalId, 'msg-456')
  mockServer.close()
  console.log('  ✓ executeConnectorSkill routes to connector and returns result')
}

// 9. executeConnectorSkill — invalid tool name format
{
  const result = await executeConnectorSkill('bad_name', {}, {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'invalid_tool_name')
  console.log('  ✓ executeConnectorSkill rejects invalid tool name format')
}

// 10. executeConnectorSkill — unregistered channel
{
  const result = await executeConnectorSkill('slack:send', {}, {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'channel_not_registered')
  console.log('  ✓ executeConnectorSkill returns error for unregistered channel')
}

// 11. executeConnectorSkill — unknown skill on registered channel
{
  const result = await executeConnectorSkill('email:nonexistent', {}, {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'skill_not_found')
  console.log('  ✓ executeConnectorSkill returns error for unknown skill')
}

// 12. executeConnectorSkill — network error
{
  deregisterConnectorSkills('email')
  registerConnectorSkills('email', {
    callback: { skillUrl: 'http://127.0.0.1:59999/skill', token: 'tok' },
    skills: [{ name: 'send', description: 'Send', schema: {} }],
  })

  const result = await executeConnectorSkill('email:send', { to: 'test@test.dev' }, {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'network_error')
  console.log('  ✓ executeConnectorSkill handles network errors')
}

// 13. executeConnectorSkill — connector returns error status
{
  const errServer = await createMockSkillServer(() => ({
    status: 422,
    body: { error: 'invalid_recipient', message: 'Address bounced' },
  }))
  const port = errServer.address().port

  deregisterConnectorSkills('email')
  registerConnectorSkills('email', {
    callback: { skillUrl: `http://127.0.0.1:${port}/skill`, token: 'tok' },
    skills: [{ name: 'send', description: 'Send', schema: {} }],
  })

  const result = await executeConnectorSkill('email:send', { to: 'bad@test.dev' }, {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'invalid_recipient')
  assert.equal(result.status, 422)
  errServer.close()
  console.log('  ✓ executeConnectorSkill surfaces connector error responses')
}

// Cleanup
rmSync(tmpDir, { recursive: true, force: true })

console.log('\n✓ All connector skill registry tests passed')

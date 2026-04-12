/**
 * Tests for connector-sdk dispatch table.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDispatchTable } from '../lib/connector-sdk/dispatch-table.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'test-dispatch-'))
const cleanup = () => rmSync(tmp, { recursive: true, force: true })

try {
  // --- Register ---
  {
    const dt = createDispatchTable(tmp)

    const entry = dt.register({
      instanceId: 'inst-a',
      instanceUrl: 'http://localhost:7690',
      token: 'tok-a',
      rules: [
        { pattern: 'alice@test.dev', priority: 10 },
        { pattern: '*@test.dev', priority: 100 },
      ],
    })

    assert.ok(entry.registrationId.startsWith('reg_inst-a_'))
    assert.equal(entry.instanceId, 'inst-a')
    assert.equal(entry.status, 'active')
    assert.equal(entry.rules.length, 2)
    console.log('  ✓ register creates entry with correct fields')
  }

  // --- Persistence ---
  {
    const dt2 = createDispatchTable(tmp)
    const entries = dt2.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].instanceId, 'inst-a')
    console.log('  ✓ dispatch table persists to disk and reloads')
  }

  // --- Idempotent re-register ---
  {
    const dt = createDispatchTable(tmp)
    dt.register({
      instanceId: 'inst-a',
      instanceUrl: 'http://localhost:7691',
      token: 'tok-a-new',
      rules: [
        { pattern: 'alice@test.dev', priority: 5 },
        { pattern: '*@test.dev', priority: 100 },
      ],
    })
    assert.equal(dt.getEntries().length, 1)
    assert.equal(dt.getEntries()[0].instanceUrl, 'http://localhost:7691')
    assert.equal(dt.getEntries()[0].rules.length, 2)
    console.log('  ✓ re-register same instanceId updates in place')
  }

  // --- Multiple instances ---
  {
    const dt = createDispatchTable(tmp)
    dt.register({
      instanceId: 'inst-b',
      instanceUrl: 'http://localhost:7692',
      token: 'tok-b',
      rules: [{ pattern: 'bob@test.dev', priority: 10 }],
    })
    assert.equal(dt.getEntries().length, 2)
    console.log('  ✓ register multiple instances')
  }

  // --- Match ---
  {
    const dt = createDispatchTable(tmp)
    const matchFn = (pattern, msg) => {
      const addr = msg.to?.address?.toLowerCase() || ''
      const pat = pattern.toLowerCase()
      if (pat === '*') return true
      if (pat.startsWith('*@')) return addr.endsWith(pat.slice(1))
      return addr === pat
    }

    // Exact match
    const hit1 = dt.match({ to: { address: 'alice@test.dev' } }, matchFn)
    assert.equal(hit1.instanceId, 'inst-a')

    const hit2 = dt.match({ to: { address: 'bob@test.dev' } }, matchFn)
    assert.equal(hit2.instanceId, 'inst-b')

    // Wildcard fallback
    const hit3 = dt.match({ to: { address: 'unknown@test.dev' } }, matchFn)
    assert.equal(hit3.instanceId, 'inst-a') // *@test.dev, priority 100

    // No match
    const hit4 = dt.match({ to: { address: 'x@other.dev' } }, matchFn)
    assert.equal(hit4, null)

    console.log('  ✓ match routes to correct instance (exact, wildcard, no-match)')
  }

  // --- Priority ordering ---
  {
    const dt = createDispatchTable(tmp)
    // inst-a has alice@test.dev at priority 5
    // Add inst-c with alice@test.dev at priority 1 (higher priority)
    dt.register({
      instanceId: 'inst-c',
      instanceUrl: 'http://localhost:7693',
      token: 'tok-c',
      rules: [{ pattern: 'alice@test.dev', priority: 1 }],
    })
    const matchFn = (pat, msg) => msg.to?.address?.toLowerCase() === pat.toLowerCase()
    const hit = dt.match({ to: { address: 'alice@test.dev' } }, matchFn)
    assert.equal(hit.instanceId, 'inst-c')
    console.log('  ✓ lower priority number wins')
  }

  // --- Heartbeat ---
  {
    const dt = createDispatchTable(tmp)
    const entry = dt.getEntries()[0]
    const before = entry.lastHeartbeat
    // Small delay to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10))
    const result = dt.heartbeat(entry.registrationId)
    assert.ok(result)
    assert.equal(result.status, 'active')
    assert.notEqual(result.lastHeartbeat, before)
    console.log('  ✓ heartbeat updates timestamp')
  }

  // --- Heartbeat unknown registration ---
  {
    const dt = createDispatchTable(tmp)
    const result = dt.heartbeat('reg_nonexistent')
    assert.equal(result, null)
    console.log('  ✓ heartbeat returns null for unknown registration')
  }

  // --- Stale detection ---
  {
    const dt = createDispatchTable(tmp)
    // Force a stale heartbeat
    const entry = dt.getEntries().find(e => e.instanceId === 'inst-b')
    entry.lastHeartbeat = new Date(Date.now() - 120000).toISOString()
    dt.save()

    const changed = dt.checkStale(60000)
    assert.ok(changed)

    const updated = dt.getEntry(entry.registrationId)
    assert.equal(updated.status, 'stale')

    // Stale entries should not match
    const matchFn = (pat, msg) => msg.to?.address?.toLowerCase() === pat.toLowerCase()
    const hit = dt.match({ to: { address: 'bob@test.dev' } }, matchFn)
    assert.equal(hit, null)
    console.log('  ✓ stale entries are excluded from matching')
  }

  // --- Heartbeat restores stale ---
  {
    const dt = createDispatchTable(tmp)
    const entry = dt.getEntries().find(e => e.instanceId === 'inst-b')
    dt.heartbeat(entry.registrationId)
    assert.equal(dt.getEntry(entry.registrationId).status, 'active')
    console.log('  ✓ heartbeat restores stale entry to active')
  }

  // --- Deregister ---
  {
    const dt = createDispatchTable(tmp)
    const entry = dt.getEntries().find(e => e.instanceId === 'inst-c')
    const result = dt.deregister(entry.registrationId)
    assert.equal(result.status, 'removed')
    assert.equal(result.rulesRemoved, 1)
    assert.equal(dt.getEntry(entry.registrationId), null)
    console.log('  ✓ deregister removes entry')
  }

  // --- Deregister unknown ---
  {
    const dt = createDispatchTable(tmp)
    const result = dt.deregister('reg_nonexistent')
    assert.equal(result, null)
    console.log('  ✓ deregister returns null for unknown registration')
  }

  // --- Atomic write (file should exist and be valid JSON) ---
  {
    const filePath = join(tmp, 'dispatch-table.json')
    assert.ok(existsSync(filePath))
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.equal(data.version, 1)
    assert.ok(Array.isArray(data.entries))
    console.log('  ✓ dispatch table file is valid JSON')
  }

  console.log('\n✓ All dispatch table tests passed')
} finally {
  cleanup()
}

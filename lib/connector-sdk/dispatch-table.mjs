/**
 * Dispatch Table — maps incoming messages to target instances.
 *
 * The table is built from instance registrations. Each entry has:
 * - instanceId, instanceUrl, token (how to reach the instance)
 * - rules: array of { pattern, priority } (channel-specific match conditions)
 *
 * Matching: all rules from all active entries are sorted by priority (ascending),
 * first match wins. The connector provides a matchFn that knows its channel's
 * pattern syntax.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function createDispatchTable(stateDir) {
  const filePath = join(stateDir, 'dispatch-table.json')
  let table = { version: 1, entries: [] }

  function load() {
    try {
      if (existsSync(filePath)) {
        table = JSON.parse(readFileSync(filePath, 'utf8'))
      }
    } catch {
      table = { version: 1, entries: [] }
    }
    return table
  }

  function save() {
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(table, null, 2))
    renameSync(tmp, filePath)
  }

  /**
   * Register or re-register an instance. Idempotent on instanceId.
   * Returns the created/updated entry.
   */
  function register({ instanceId, instanceUrl, token, rules }) {
    const existing = table.entries.find(e => e.instanceId === instanceId)
    if (existing) {
      existing.instanceUrl = instanceUrl
      existing.token = token
      existing.rules = rules.map(r => ({ ...r }))
      existing.lastHeartbeat = new Date().toISOString()
      existing.status = 'active'
      save()
      return existing
    }

    const registrationId = `reg_${instanceId}_${Date.now().toString(36)}`
    const entry = {
      registrationId,
      instanceId,
      instanceUrl,
      token,
      rules: rules.map(r => ({ ...r })),
      status: 'active',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    }
    table.entries.push(entry)
    save()
    return entry
  }

  /**
   * Remove an instance by registrationId.
   * Returns removal summary or null if not found.
   */
  function deregister(registrationId) {
    const entry = table.entries.find(e => e.registrationId === registrationId)
    if (!entry) return null
    const rulesRemoved = entry.rules.length
    table.entries = table.entries.filter(e => e.registrationId !== registrationId)
    save()
    return { registrationId, status: 'removed', rulesRemoved }
  }

  /**
   * Update heartbeat timestamp and restore active status.
   */
  function heartbeat(registrationId) {
    const entry = table.entries.find(e => e.registrationId === registrationId)
    if (!entry) return null
    entry.lastHeartbeat = new Date().toISOString()
    entry.status = 'active'
    save()
    return { status: entry.status, lastHeartbeat: entry.lastHeartbeat }
  }

  /**
   * Mark entries as stale if heartbeat is older than timeoutMs.
   */
  function checkStale(timeoutMs = 60000) {
    const now = Date.now()
    let changed = false
    for (const entry of table.entries) {
      if (entry.status === 'active') {
        const elapsed = now - new Date(entry.lastHeartbeat).getTime()
        if (elapsed > timeoutMs) {
          entry.status = 'stale'
          changed = true
        }
      }
    }
    if (changed) save()
    return changed
  }

  /**
   * Find the best matching active entry for a message.
   * matchFn(pattern, message) → boolean is channel-specific.
   */
  function match(message, matchFn) {
    const candidates = []
    for (const entry of table.entries) {
      if (entry.status !== 'active') continue
      for (const rule of entry.rules) {
        if (matchFn(rule.pattern, message)) {
          candidates.push({ priority: rule.priority, registeredAt: entry.registeredAt, entry })
        }
      }
    }
    if (candidates.length === 0) return null

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return new Date(a.registeredAt).getTime() - new Date(b.registeredAt).getTime()
    })
    return candidates[0].entry
  }

  function getEntries() { return table.entries }
  function getEntry(registrationId) { return table.entries.find(e => e.registrationId === registrationId) || null }

  load()

  return { load, save, register, deregister, heartbeat, checkStale, match, getEntries, getEntry }
}

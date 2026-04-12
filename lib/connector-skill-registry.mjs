/**
 * Connector Skill Registry — instance-side module that tracks skills
 * provided by registered connectors and executes them on behalf of the model.
 *
 * When an Instance registers with a Connector and receives a skills array
 * in the response, it calls registerConnectorSkills() to make those skills
 * available as model tools.
 *
 * When the model invokes a tool like "email:send", the Instance calls
 * executeConnectorSkill() which routes the call to the correct Connector.
 *
 * Integration: called during connector registration (startup) and during
 * tool execution in the session runner.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * In-memory registry: channel → { skillUrl, token, skills[] }
 */
let registry = {}
let registryPath = null

/**
 * Initialize the skill registry with a persistence path.
 *
 * @param {string} configDir - Directory for persisting the registry
 */
export function initSkillRegistry(configDir) {
  registryPath = join(configDir, 'connector-skill-registry.json')
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf8'))
    } catch { registry = {} }
  }
}

function persist() {
  if (!registryPath) return
  const tmp = registryPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(registry, null, 2))
  renameSync(tmp, registryPath)
}

/**
 * Register skills from a connector's Register response.
 *
 * @param {string} channel - Connector channel (e.g. 'email', 'feishu')
 * @param {object} registration - The Register response from the Connector
 * @param {object} registration.callback - { replyUrl, skillUrl, token }
 * @param {Array} registration.skills - [{ name, description, schema }]
 */
export function registerConnectorSkills(channel, registration) {
  const { callback, skills } = registration
  if (!skills || skills.length === 0) {
    // Connector has no skills — remove any stale entry
    if (registry[channel]) {
      delete registry[channel]
      persist()
    }
    return []
  }

  registry[channel] = {
    skillUrl: callback.skillUrl,
    token: callback.token,
    skills: skills.map(s => ({
      name: s.name,
      description: s.description || '',
      schema: s.schema || {},
    })),
  }
  persist()

  return getToolDefinitions(channel)
}

/**
 * Remove all skills for a connector channel.
 *
 * @param {string} channel
 */
export function deregisterConnectorSkills(channel) {
  if (!registry[channel]) return false
  delete registry[channel]
  persist()
  return true
}

/**
 * Get tool definitions for the model from a specific channel.
 * Returns an array of tool objects compatible with model tool schemas.
 *
 * @param {string} channel
 * @returns {Array} - [{ name: "email:send", description, parameters }]
 */
export function getToolDefinitions(channel) {
  const entry = registry[channel]
  if (!entry) return []

  return entry.skills.map(skill => ({
    name: `${channel}:${skill.name}`,
    description: skill.description,
    parameters: skill.schema,
    _source: { channel, skillName: skill.name },
  }))
}

/**
 * Get ALL tool definitions from ALL registered connectors.
 *
 * @returns {Array} - all connector tools across all channels
 */
export function getAllToolDefinitions() {
  return Object.keys(registry).flatMap(ch => getToolDefinitions(ch))
}

/**
 * Get registered channels.
 *
 * @returns {string[]}
 */
export function getRegisteredChannels() {
  return Object.keys(registry)
}

/**
 * Execute a connector skill.
 *
 * @param {string} toolName - Full tool name, e.g. "email:send"
 * @param {object} parameters - Skill parameters from the model
 * @param {object} context - { instanceId, sessionId }
 * @returns {object} - Skill execution result
 */
export async function executeConnectorSkill(toolName, parameters, context = {}) {
  const colonIdx = toolName.indexOf(':')
  if (colonIdx === -1) {
    return { success: false, error: 'invalid_tool_name', message: `Expected format "channel:skill", got "${toolName}"` }
  }

  const channel = toolName.slice(0, colonIdx)
  const skillName = toolName.slice(colonIdx + 1)

  const entry = registry[channel]
  if (!entry) {
    return { success: false, error: 'channel_not_registered', channel }
  }

  const skill = entry.skills.find(s => s.name === skillName)
  if (!skill) {
    return { success: false, error: 'skill_not_found', channel, skill: skillName, available: entry.skills.map(s => s.name) }
  }

  const url = `${entry.skillUrl}/${encodeURIComponent(skillName)}`
  const payload = {
    instanceId: context.instanceId || 'default',
    sessionId: context.sessionId || '',
    parameters,
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    })

    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      return {
        success: false,
        error: body.error || 'connector_error',
        message: body.message || `HTTP ${res.status}`,
        status: res.status,
      }
    }

    return body
  } catch (err) {
    return { success: false, error: 'network_error', message: err.message }
  }
}

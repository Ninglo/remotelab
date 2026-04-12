/**
 * Connector SDK — create a connector runtime that handles the full protocol.
 *
 * Usage:
 *   import { createConnectorRuntime } from 'remotelab/connector-sdk'
 *
 *   const connector = createConnectorRuntime({
 *     channel: 'email',
 *     port: 7694,
 *     stateDir: '/path/to/state',
 *     callbackToken: 'secret',
 *     matchFn: (pattern, message) => { ... },
 *     onReply: async (reply) => { ... },
 *   })
 *
 *   connector.route('POST', '/my-webhook', handler)
 *   await connector.start()
 *   await connector.deliver(message)
 */

import { mkdirSync, existsSync } from 'node:fs'
import { createDispatchTable } from './dispatch-table.mjs'
import { createConnectorServer, readBody, sendJson } from './server.mjs'
import { deliverWithRetry, writeDeadLetter } from './delivery.mjs'

export { createDispatchTable } from './dispatch-table.mjs'
export { deliverToInstance, deliverWithRetry, writeDeadLetter } from './delivery.mjs'
export { createConnectorServer, readBody, sendJson } from './server.mjs'
export {
  getConnectorSurfaceNonce,
  getConnectorSurfaceMountPrefix,
  loadConnectorSurfaceTemplate,
  normalizeConnectorSurfacePath,
  renderConnectorSurfaceTemplate,
  sendConnectorSurfaceJson,
  startConnectorSurfaceServer,
} from './surface.mjs'

/**
 * Create a full connector runtime.
 *
 * @param {object} config
 * @param {string} config.channel - Channel identifier (e.g. 'email', 'feishu')
 * @param {number} config.port - Port to listen on
 * @param {string} config.stateDir - Directory for persistent state (dispatch table, dead letters)
 * @param {string} config.callbackToken - Token instances use when pushing replies
 * @param {function} config.matchFn - (pattern, message) => boolean, channel-specific matching
 * @param {function} config.onReply - async (reply) => result, called when instance pushes a reply
 * @param {Array} [config.skills=[]] - Skill declarations [{name, description, schema}]
 * @param {function} [config.onSkill] - async (skillName, {instanceId, sessionId, parameters}) => result
 * @param {string} [config.host='127.0.0.1'] - Host to bind to
 * @param {number} [config.staleCheckIntervalMs=15000] - How often to check for stale entries
 * @param {string} [config.tool='claude'] - Default tool for session creation
 * @param {string} [config.sourceName] - Human-friendly source name
 * @param {string} [config.group] - Session group label
 */
export function createConnectorRuntime(config) {
  const {
    channel,
    port,
    stateDir,
    callbackToken,
    matchFn,
    onReply,
    skills = [],
    onSkill,
    host = '127.0.0.1',
    staleCheckIntervalMs = 15000,
    tool = 'claude',
    sourceName,
    group,
  } = config

  if (!channel) throw new Error('channel is required')
  if (!stateDir) throw new Error('stateDir is required')
  if (!matchFn) throw new Error('matchFn is required')

  // Ensure state directory exists
  for (const sub of ['', 'dead_letter']) {
    const dir = sub ? `${stateDir}/${sub}` : stateDir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  const dispatchTable = createDispatchTable(stateDir)
  const server = createConnectorServer({ dispatchTable, channel, onReply, callbackToken, skills, onSkill })

  let staleTimer = null

  /**
   * Deliver a message to the correct instance based on dispatch table.
   *
   * @param {object} message - Normalized message object
   * @param {object} message.from - { address, name }
   * @param {object} message.to - { address, name }
   * @param {object} message.content - { body, subject, ... }
   * @param {object} [message.sourceContext] - Opaque context passed through to reply
   * @param {object} [message.thread] - { externalId }
   * @param {string} [message.id] - Message ID (auto-generated if missing)
   * @returns {object} - Delivery result
   */
  async function deliver(message) {
    if (!message.id) {
      message.id = `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    }
    message.channel = channel
    message.direction = 'inbound'
    if (!message.createdAt) message.createdAt = new Date().toISOString()

    const target = dispatchTable.match(message, matchFn)
    if (!target) {
      writeDeadLetter(stateDir, message, { instanceId: 'none' }, { error: 'no_matching_rule' })
      return { delivered: false, error: 'no_matching_rule' }
    }

    const result = await deliverWithRetry(target, message, {
      channel,
      tool,
      sourceName: sourceName || channel,
      group: group || channel,
    })

    if (!result.delivered) {
      writeDeadLetter(stateDir, message, target, result)
    }

    return result
  }

  async function start() {
    await server.start(port, host)
    staleTimer = setInterval(() => dispatchTable.checkStale(), staleCheckIntervalMs)
    return { port, host, channel }
  }

  async function stop() {
    if (staleTimer) clearInterval(staleTimer)
    await server.stop()
  }

  return {
    // Core actions
    deliver,
    start,
    stop,

    // Server extension
    route: server.addRoute,

    // Direct access (for testing or advanced usage)
    dispatchTable,
    server,
    channel,
    stateDir,
  }
}

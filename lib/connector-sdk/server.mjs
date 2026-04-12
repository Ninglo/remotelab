/**
 * Connector HTTP Server — handles protocol endpoints and custom routes.
 *
 * Protocol endpoints:
 *   POST /dispatch/register      — instance registration
 *   POST /dispatch/heartbeat     — instance liveness
 *   DELETE /dispatch/register/:id — instance deregistration
 *   POST /reply                  — receive reply from instance
 *   GET /healthz                 — connector health check
 *
 * Connectors add their own routes for external webhooks (e.g. /cloudflare-email/webhook).
 */

import { createServer } from 'node:http'

export function createConnectorServer({ dispatchTable, channel, onReply, callbackToken, skills, onSkill }) {
  const customRoutes = []
  const registeredSkills = skills || []
  let server = null

  function addRoute(method, path, handler) {
    customRoutes.push({ method: method.toUpperCase(), path, handler })
  }

  function findCustomRoute(method, url) {
    const pathname = new URL(url, 'http://localhost').pathname
    return customRoutes.find(r => r.method === method && r.path === pathname)
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    const method = req.method

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' })
      return res.end()
    }

    try {
      // Health check
      if (method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          service: `connector-${channel}`,
          channel,
          entries: dispatchTable.getEntries().length,
          time: new Date().toISOString(),
        })
      }

      // Register
      if (method === 'POST' && pathname === '/dispatch/register') {
        const body = await readBody(req)
        if (!body.instanceId || !body.instanceUrl || !body.token || !body.rules) {
          return sendJson(res, 400, { error: 'missing_fields', required: ['instanceId', 'instanceUrl', 'token', 'rules'] })
        }
        const entry = dispatchTable.register(body)
        const publicUrl = getPublicUrl(req)
        const response = {
          registrationId: entry.registrationId,
          connectorId: channel,
          channel,
          callback: {
            replyUrl: `${publicUrl}/reply`,
            token: callbackToken,
          },
          status: entry.status,
        }
        if (registeredSkills.length > 0) {
          response.callback.skillUrl = `${publicUrl}/skill`
          response.skills = registeredSkills
        }
        return sendJson(res, 200, response)
      }

      // Heartbeat
      if (method === 'POST' && pathname === '/dispatch/heartbeat') {
        const body = await readBody(req)
        if (!body.registrationId) {
          return sendJson(res, 400, { error: 'missing_registrationId' })
        }
        const result = dispatchTable.heartbeat(body.registrationId)
        if (!result) {
          return sendJson(res, 404, { error: 'registration_not_found' })
        }
        return sendJson(res, 200, result)
      }

      // Deregister
      if (method === 'DELETE' && pathname.startsWith('/dispatch/register/')) {
        const registrationId = pathname.split('/dispatch/register/')[1]
        if (!registrationId) {
          return sendJson(res, 400, { error: 'missing_registrationId' })
        }
        const result = dispatchTable.deregister(decodeURIComponent(registrationId))
        if (!result) {
          return sendJson(res, 404, { error: 'registration_not_found' })
        }
        return sendJson(res, 200, result)
      }

      // Reply callback
      if (method === 'POST' && pathname === '/reply') {
        // Validate callback token
        const authHeader = req.headers.authorization || ''
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
        if (callbackToken && bearerToken !== callbackToken) {
          return sendJson(res, 401, { error: 'invalid_callback_token' })
        }

        const body = await readBody(req)
        if (!body.sourceContext || !body.reply?.body) {
          return sendJson(res, 400, { error: 'missing_fields', required: ['sourceContext', 'reply.body'] })
        }

        if (onReply) {
          try {
            const result = await onReply(body)
            return sendJson(res, 200, { delivered: true, ...result })
          } catch (err) {
            return sendJson(res, 502, { delivered: false, error: 'reply_send_failed', message: err.message })
          }
        }
        return sendJson(res, 200, { delivered: false, error: 'no_reply_handler' })
      }

      // Skill execution: POST /skill/:skillName
      if (method === 'POST' && pathname.startsWith('/skill/')) {
        const authHeader = req.headers.authorization || ''
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
        if (callbackToken && bearerToken !== callbackToken) {
          return sendJson(res, 401, { error: 'invalid_callback_token' })
        }

        const skillName = decodeURIComponent(pathname.slice('/skill/'.length))
        if (!skillName) {
          return sendJson(res, 400, { error: 'missing_skill_name' })
        }

        const skillDef = registeredSkills.find(s => s.name === skillName)
        if (!skillDef) {
          return sendJson(res, 404, { error: 'skill_not_found', skill: skillName, available: registeredSkills.map(s => s.name) })
        }

        const body = await readBody(req)
        if (!body.parameters) {
          return sendJson(res, 400, { error: 'missing_parameters' })
        }

        if (onSkill) {
          try {
            const result = await onSkill(skillName, body)
            return sendJson(res, 200, { success: true, result })
          } catch (err) {
            return sendJson(res, 502, { success: false, error: 'skill_execution_failed', message: err.message })
          }
        }
        return sendJson(res, 501, { success: false, error: 'no_skill_handler' })
      }

      // Custom routes
      const customRoute = findCustomRoute(method, req.url)
      if (customRoute) {
        return await customRoute.handler(req, res)
      }

      // 404
      sendJson(res, 404, { error: 'not_found', path: pathname })
    } catch (err) {
      sendJson(res, 500, { error: 'internal', message: err.message })
    }
  }

  function start(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server = createServer(handleRequest)
      server.on('error', reject)
      server.listen(port, host, () => resolve(server))
    })
  }

  function stop() {
    return new Promise(resolve => {
      if (server) server.close(resolve)
      else resolve()
    })
  }

  return { addRoute, start, stop, handleRequest }
}

// Helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => data += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(data)) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(json)
}

function getPublicUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  return `${proto}://${host}`
}

export { readBody, sendJson }

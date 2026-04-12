import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { clearConnectorSurface, registerConnectorSurface } from '../connector-surface-registry.mjs'

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeConnectorSurfacePath(value, fallback = '/') {
  const normalized = `/${trimString(value || fallback).replace(/^\/+/, '')}`.replace(/\/+$/, '')
  return normalized || '/'
}

export function getConnectorSurfaceMountPrefix(req) {
  const explicit = normalizeConnectorSurfacePath(req.headers?.['x-remotelab-connector-mount'], '/')
  if (explicit && explicit !== '/') return explicit
  const forwarded = normalizeConnectorSurfacePath(req.headers?.['x-forwarded-prefix'], '/')
  return forwarded && forwarded !== '/' ? forwarded : ''
}

export function getConnectorSurfaceNonce(req) {
  return trimString(req.headers?.['x-remotelab-csp-nonce'])
}

export function renderConnectorSurfaceTemplate(template, replacements = {}) {
  return Object.entries(replacements).reduce(
    (output, [key, value]) => output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => String(value ?? '')),
    template,
  )
}

export async function loadConnectorSurfaceTemplate({
  templatePath = '',
  fallbackTemplate = '',
  logLabel = 'connector-surface',
} = {}) {
  const customPath = trimString(templatePath)
  if (customPath) {
    try {
      return await readFile(customPath, 'utf8')
    } catch (error) {
      console.warn(`[${logLabel}] failed to load custom surface template ${customPath}: ${error?.message || error}`)
    }
  }
  return typeof fallbackTemplate === 'function' ? fallbackTemplate() : String(fallbackTemplate ?? '')
}

export function sendConnectorSurfaceJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
  })
  res.end(JSON.stringify(payload))
}

function resolveSurfaceBaseHost(host, address) {
  const normalized = trimString(address?.address || host || '')
  if (!normalized || normalized === '::' || normalized === '0.0.0.0') {
    return '127.0.0.1'
  }
  const unwrapped = normalized.replace(/^\[|\]$/g, '')
  return unwrapped.includes(':') ? `[${unwrapped}]` : unwrapped
}

export async function startConnectorSurfaceServer(options = {}) {
  const connectorId = trimString(options.connectorId).toLowerCase()
  if (!connectorId) {
    throw new Error('connectorId is required for connector surface server')
  }

  const title = trimString(options.title) || connectorId
  const host = trimString(options.host) || '127.0.0.1'
  const requestedPort = Number.isInteger(options.port) && options.port >= 0 ? options.port : 0
  const entryPath = normalizeConnectorSurfacePath(options.entryPath, '/')
  const allowEmbed = options.allowEmbed !== false
  const describeSurface = typeof options.describeSurface === 'function' ? options.describeSurface : null
  const handleRequest = typeof options.handleRequest === 'function' ? options.handleRequest : null
  let baseUrl = ''

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const mountPrefix = getConnectorSurfaceMountPrefix(req)
    const nonce = getConnectorSurfaceNonce(req)

    if (req.method === 'GET' && url.pathname === '/healthz') {
      const extra = typeof options.describeHealth === 'function'
        ? await options.describeHealth({ req, res, url, mountPrefix, nonce, baseUrl, entryPath, title, allowEmbed })
        : {}
      sendConnectorSurfaceJson(res, 200, {
        ok: true,
        connectorId,
        title,
        baseUrl,
        updatedAt: new Date().toISOString(),
        ...(extra && typeof extra === 'object' ? extra : {}),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/surface') {
      const described = describeSurface
        ? await describeSurface({ req, res, url, mountPrefix, nonce, baseUrl, entryPath, title, allowEmbed })
        : {}
      const payload = described && typeof described === 'object' ? described : {}
      const {
        connectorId: ignoredConnectorId,
        baseUrl: ignoredBaseUrl,
        title: describedTitle,
        entryPath: describedEntryPath,
        allowEmbed: describedAllowEmbed,
        ...rest
      } = payload
      void ignoredConnectorId
      void ignoredBaseUrl

      sendConnectorSurfaceJson(res, 200, {
        connectorId,
        title: trimString(describedTitle) || title,
        entryPath: normalizeConnectorSurfacePath(describedEntryPath, entryPath),
        allowEmbed: describedAllowEmbed !== false && allowEmbed,
        baseUrl,
        ...rest,
      })
      return
    }

    if (handleRequest) {
      const handled = await handleRequest({
        req,
        res,
        url,
        mountPrefix,
        nonce,
        baseUrl,
        entryPath,
        title,
        allowEmbed,
        sendJson: sendConnectorSurfaceJson,
      })
      if (handled) return
    }

    sendConnectorSurfaceJson(res, 404, { error: 'not_found', path: url.pathname })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort
  baseUrl = `http://${resolveSurfaceBaseHost(host, address)}:${port}`

  await registerConnectorSurface({
    connectorId,
    title,
    baseUrl,
    entryPath,
    allowEmbed,
  })

  return {
    baseUrl,
    async stop() {
      await clearConnectorSurface(connectorId)
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

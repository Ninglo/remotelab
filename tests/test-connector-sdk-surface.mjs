import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'remotelab-connector-surface-'))
const configDir = join(home, '.config', 'remotelab')
process.env.HOME = home
process.env.REMOTELAB_CONFIG_DIR = configDir

const {
  getConnectorSurfaceNonce,
  getConnectorSurfaceMountPrefix,
  loadConnectorSurfaceTemplate,
  renderConnectorSurfaceTemplate,
  startConnectorSurfaceServer,
} = await import('../lib/connector-sdk/surface.mjs')
const { getConnectorSurface } = await import('../lib/connector-surface-registry.mjs')

let server

try {
  const templatePath = join(home, 'surface-template.html')
  writeFileSync(
    templatePath,
    '<!doctype html><html><head><script nonce="{{NONCE}}"></script></head><body><h1>{{TITLE}}</h1><p>{{STATUS_PATH}}</p></body></html>',
    'utf8',
  )

  const template = await loadConnectorSurfaceTemplate({
    templatePath,
    fallbackTemplate: '<html>fallback</html>',
    logLabel: 'test-connector-surface',
  })

  server = await startConnectorSurfaceServer({
    connectorId: 'demo',
    title: 'Demo Connector',
    host: '127.0.0.1',
    port: 0,
    entryPath: '/login',
    allowEmbed: true,
    describeSurface: async ({ mountPrefix, entryPath }) => ({
      surfaceType: 'login',
      description: 'Demo connector login surface',
      surface: {
        mountPrefix,
        entryPath,
      },
    }),
    handleRequest: async ({ req, res, url, entryPath, title, mountPrefix, nonce, sendJson }) => {
      if (req.method === 'GET' && url.pathname === entryPath) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderConnectorSurfaceTemplate(template, {
          NONCE: nonce,
          TITLE: title,
          STATUS_PATH: `${mountPrefix}${entryPath}/status`,
        }))
        return true
      }

      if (req.method === 'GET' && url.pathname === `${entryPath}/status`) {
        sendJson(res, 200, {
          ok: true,
          mountPrefix: getConnectorSurfaceMountPrefix(req),
          nonce: getConnectorSurfaceNonce(req),
        })
        return true
      }

      return false
    },
  })

  const manifest = await getConnectorSurface('demo')
  assert.equal(manifest.connectorId, 'demo')
  assert.equal(manifest.entryPath, '/login')
  assert.equal(manifest.allowEmbed, true)
  console.log('  ✓ connector surface server registers a reusable manifest')

  const mountHeaders = {
    'x-forwarded-prefix': '/connectors/demo',
    'x-remotelab-connector-mount': '/connectors/demo',
    'x-remotelab-csp-nonce': 'nonce-test-123',
  }

  const descriptorRes = await fetch(`${server.baseUrl}/surface`, { headers: mountHeaders })
  assert.equal(descriptorRes.status, 200)
  const descriptor = await descriptorRes.json()
  assert.equal(descriptor.connectorId, 'demo')
  assert.equal(descriptor.surfaceType, 'login')
  assert.equal(descriptor.surface.mountPrefix, '/connectors/demo')
  console.log('  ✓ connector surface descriptor carries connector-owned metadata')

  const pageRes = await fetch(`${server.baseUrl}/login`, { headers: mountHeaders })
  assert.equal(pageRes.status, 200)
  const page = await pageRes.text()
  assert.match(page, /Demo Connector/)
  assert.match(page, /\/connectors\/demo\/login\/status/)
  assert.match(page, /nonce-test-123/)
  console.log('  ✓ connector surface HTML rendering respects proxy mount metadata')

  const statusRes = await fetch(`${server.baseUrl}/login/status`, { headers: mountHeaders })
  assert.equal(statusRes.status, 200)
  const status = await statusRes.json()
  assert.deepEqual(status, {
    ok: true,
    mountPrefix: '/connectors/demo',
    nonce: 'nonce-test-123',
  })
  console.log('  ✓ connector surface handlers receive mount prefix and nonce context')
} finally {
  await server?.stop?.()
  rmSync(home, { recursive: true, force: true })
}

console.log('\n✓ connector-sdk surface helper tests passed')

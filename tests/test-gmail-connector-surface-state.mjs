#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-gmail-surface-state-'));
const tempConfigDir = join(tempHome, '.config', 'remotelab');

process.env.HOME = tempHome;
process.env.REMOTELAB_SYSTEM_HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = tempConfigDir;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://trial70.example.com';
process.env.SECURE_COOKIES = '0';
process.env.REMOTELAB_GOOGLE_OAUTH_CLIENT_JSON = JSON.stringify({
  installed: {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    redirect_uris: ['https://owner.example.com/api/connectors/gmail/google/callback'],
  },
});

await mkdir(tempConfigDir, { recursive: true });
await writeFile(join(tempConfigDir, 'auth.json'), JSON.stringify({ token: 'owner_token_1' }, null, 2));

const {
  handleConnectorSurfaceRoutes,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'router-connector-routes.mjs')).href);

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(payload = '') {
      this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

try {
  const res = createMockResponse();
  const handled = await handleConnectorSurfaceRoutes({
    req: {
      method: 'GET',
      url: '/api/connectors/surfaces',
      headers: {},
      socket: {},
    },
    res,
    pathname: '/api/connectors/surfaces',
    authSession: { role: 'owner' },
    writeJson,
    buildHeaders: (headers) => headers,
    nonce: 'nonce',
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);

  const payload = JSON.parse(res.body.toString('utf8'));
  const gmailSurface = payload.surfaces.find((surface) => surface.connectorId === 'gmail');

  assert.ok(gmailSurface, 'gmail surface should be exposed');
  assert.equal(gmailSurface.allowEmbed, false, 'gmail surface should not be embeddable');
  assert.equal(gmailSurface.surface?.capabilityState, 'authorization_required');
  assert.equal(gmailSurface.surface?.credentialsPresent, true);
  assert.match(gmailSurface.surface?.message || '', /Authorize Gmail once in a new page/);

  console.log('test-gmail-connector-surface-state: ok');
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

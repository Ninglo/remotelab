#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

async function main() {
  const configDir = await mkdtemp(join(tmpdir(), 'remotelab-connector-surface-health-'));
  process.env.REMOTELAB_CONFIG_DIR = configDir;

  const moduleUrl = pathToFileURL(join(repoRoot, 'lib', 'connector-surface-registry.mjs')).href + `?t=${Date.now()}`;
  const {
    clearConnectorSurface,
    getConnectorSurface,
    getReachableConnectorSurface,
    registerConnectorSurface,
  } = await import(moduleUrl);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });

  try {
    const port = await listen(server);
    await registerConnectorSurface({
      connectorId: 'demo',
      title: 'Demo',
      baseUrl: `http://127.0.0.1:${port}`,
      entryPath: '/login',
    });

    const reachable = await getReachableConnectorSurface('demo', { clearStale: true, timeoutMs: 500 });
    assert.ok(reachable, 'expected live surface to resolve');
    assert.equal(reachable.baseUrl, `http://127.0.0.1:${port}`);

    await new Promise((resolve) => server.close(resolve));

    const stale = await getReachableConnectorSurface('demo', { clearStale: true, timeoutMs: 500 });
    assert.equal(stale, null, 'expected stale surface to be treated as unavailable');
    assert.equal(await getConnectorSurface('demo'), null, 'expected stale surface manifest to be cleared');

    console.log('ok - stale connector surfaces are cleared when their port is unreachable');
  } finally {
    await clearConnectorSurface('demo').catch(() => {});
    await rm(configDir, { recursive: true, force: true });
  }
}

await main();

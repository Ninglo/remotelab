import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configurePersonStudio } from '../display/configure-person-studio.mjs';

const root = await mkdtemp(join(tmpdir(), 'person-studio-test-'));
const source = join(root, 'source/concept-v14');
const configDir = join(root, 'config');
await mkdir(join(source, 'private/browser-libs'), { recursive: true });
await mkdir(join(root, 'source/concept-v21'), { recursive: true });
await writeFile(join(root, 'source/concept-v21/index.html'), 'test');
await mkdir(configDir);
await writeFile(join(configDir, 'display-admin-token'), 'test-administrator');
await writeFile(join(source, 'private/pairing.json'), '{"personId":"someone-else","token":"do-not-copy"}');
for (const file of ['preview-server.mjs', 'operation-gate.mjs', 'weather-source.mjs', 'index.html', 'styles.css',
  'studio-v8.css', 'studio-v9.css', 'studio-v10.css', 'studio-v11.css', 'studio-v12.css', 'studio-v14.css',
  'app.js', 'theme-presets.js', 'device-sync.js', 'device-endpoint.json']) await writeFile(join(source, file), 'test');
for (const directory of ['fonts', 'assets', 'node_modules']) await mkdir(join(source, directory));
const legacy = { baseUrl: 'http://127.0.0.1:8794', tokenFile: 'existing-token', personId: 'person_old' };
await writeFile(join(configDir, 'display-studio-preview.json'), JSON.stringify(legacy));
let inventory = [{ id: 'display-aaaaaaaaaaaaaaaa', personId: 'person_test', revokedAt: null }];
const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer test-administrator');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ devices: inventory }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const portProbe = createPortProbe();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
const freePort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const options = { personId: 'person_test', deviceId: 'display-aaaaaaaaaaaaaaaa', port: freePort,
  sourceRoot: source, configDir, displayBaseUrl: `http://127.0.0.1:${server.address().port}` };
try {
  await assert.rejects(configurePersonStudio({ ...options, personId: 'person_other' }), /does not belong/);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'display-studio-preview.json'), 'utf8')), legacy);
  await assert.rejects(configurePersonStudio({ ...options, port: server.address().port }), /EADDRINUSE/);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'display-studio-preview.json'), 'utf8')), legacy);
  const result = await configurePersonStudio(options);
  const registry = JSON.parse(await readFile(result.registryFile, 'utf8'));
  assert.deepEqual({ ...registry, people: undefined }, { ...legacy, people: undefined });
  assert.equal(registry.people.person_test.personId, 'person_test');
  const pairing = JSON.parse(await readFile(join(result.runtime, 'private/pairing.json'), 'utf8'));
  assert.equal(pairing.personId, 'person_test');
  assert.equal(pairing.deviceId, options.deviceId);
  assert.match(pairing.token, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(result.tokenFile, 'utf8')).trim(), pairing.token);
  assert.equal((await stat(result.tokenFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(result.runtime, 'private'))).sort(), ['browser-libs', 'pairing.json']);
  assert.equal(await readlink(join(result.runtime, 'private/browser-libs')), join(source, 'private/browser-libs'));
  assert.equal((await configurePersonStudio(options)).runtime, result.runtime);
  assert.equal(JSON.parse(await readFile(join(result.runtime, 'private/pairing.json'), 'utf8')).token, pairing.token);
  await assert.rejects(configurePersonStudio({ ...options, port: 8797 }), /review it/);
  inventory.push({ id: 'display-bbbbbbbbbbbbbbbb', personId: 'person_test' });
  await assert.rejects(configurePersonStudio({ ...options, deviceId: 'display-bbbbbbbbbbbbbbbb' }), /pairing differs/);
  assert.equal(JSON.parse(await readFile(join(source, 'private/pairing.json'), 'utf8')).token, 'do-not-copy');
  console.log('ok - isolated studio setup validates ownership, preserves legacy channels and credentials');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

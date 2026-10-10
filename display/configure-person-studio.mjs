import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const codeFiles = ['preview-server.mjs', 'operation-gate.mjs', 'weather-source.mjs'];
const sharedFiles = ['index.html', 'styles.css', 'studio-v8.css', 'studio-v9.css', 'studio-v10.css',
  'studio-v11.css', 'studio-v12.css', 'studio-v14.css', 'app.js', 'theme-presets.js',
  'device-sync.js', 'device-endpoint.json', 'fonts', 'assets', 'node_modules'];

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function sharedLink(target, link) {
  try {
    if (await readlink(link) !== target) throw Error(`Refusing to replace existing asset: ${link}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(target, link);
  }
}

async function verifyFreePort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

// Adapter for the existing instance-local studio, not a new device enrollment.
// Copy only executable source; private state and credentials never come from
// another Person. No provider refresh or model invocation is performed.
export async function configurePersonStudio({ personId, deviceId, port, sourceRoot,
  configDir = process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config/remotelab'),
  displayBaseUrl = 'http://127.0.0.1:8792', adminTokenFile = join(configDir, 'display-admin-token') }) {
  if (!/^person_[A-Za-z0-9_-]+$/.test(personId || '')) throw Error('Invalid Person ID');
  if (!/^display-[a-f0-9]{16}$/.test(deviceId || '')) throw Error('Invalid device ID');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid renderer port');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(displayBaseUrl)) throw Error('Display service must be loopback');
  const source = resolve(sourceRoot);
  const config = resolve(configDir);
  const home = join(config, 'display-studios', personId);
  const runtime = join(home, 'concept-v14');
  if (source === runtime) throw Error('Source and runtime must differ');
  const administrator = (await readFile(adminTokenFile, 'utf8')).trim();
  const response = await fetch(`${displayBaseUrl}/v1/devices?personId=${encodeURIComponent(personId)}`, {
    headers: { Authorization: `Bearer ${administrator}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error(`Device inventory returned HTTP ${response.status}`);
  const inventory = await response.json();
  if (!inventory.devices?.some((device) => device.id === deviceId && device.personId === personId && !device.revokedAt)) {
    throw Error('Device does not belong to this Person');
  }
  for (const file of [...codeFiles, ...sharedFiles, 'private/browser-libs']) await stat(join(source, file));
  await stat(join(source, '../concept-v21/index.html'));
  await mkdir(config, { recursive: true, mode: 0o700 });
  const lockFile = join(config, 'display-studio-preview.json.lock');
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    const registryFile = join(config, 'display-studio-preview.json');
    const registry = await readJson(registryFile, {});
    const tokenFile = join(home, 'preview-token');
    const entry = { baseUrl: `http://127.0.0.1:${port}`, tokenFile, personId };
    const previous = registry.people?.[personId];
    if (previous && (previous.baseUrl !== entry.baseUrl || previous.tokenFile !== entry.tokenFile || previous.personId !== personId)) {
      throw Error('Existing personal channel differs; review it before replacing');
    }
    if (registry.baseUrl === entry.baseUrl || Object.entries(registry.people || {}).some(([key, value]) => key !== personId && value.baseUrl === entry.baseUrl)) {
      throw Error('Renderer port already belongs to another channel');
    }
    if (!previous) await verifyFreePort(port);
    const privateDir = join(runtime, 'private');
    const pairingFile = join(privateDir, 'pairing.json');
    const pairing = await readJson(pairingFile, null);
    if (pairing && (pairing.personId !== personId || pairing.deviceId !== deviceId || !/^[a-f0-9]{64}$/.test(pairing.token))) {
      throw Error('Existing runtime pairing differs; refusing to overwrite it');
    }
    const token = pairing?.token || randomBytes(32).toString('hex');
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    for (const file of codeFiles) await copyFile(join(source, file), join(runtime, file));
    for (const file of sharedFiles) await sharedLink(join(source, file), join(runtime, file));
    await sharedLink(join(source, 'private/browser-libs'), join(privateDir, 'browser-libs'));
    await sharedLink(resolve(source, '../concept-v21'), join(home, 'concept-v21'));
    await atomicWrite(pairingFile, JSON.stringify({ personId, deviceId, token }) + '\n');
    await atomicWrite(tokenFile, `${token}\n`);
    await atomicWrite(registryFile, JSON.stringify({ ...registry, people: { ...registry.people, [personId]: entry } }, null, 2) + '\n');
    return { personId, deviceId, port, runtime, registryFile, tokenFile };
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argumentsByName = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = process.argv[index];
      if (!['--person', '--device', '--port', '--source', '--config-dir', '--display-base-url', '--admin-token-file'].includes(name) || !process.argv[index + 1]) {
        throw Error('Expected --person ID --device ID --port N --source /absolute/concept-v14 [--config-dir DIR]');
      }
      argumentsByName[name] = process.argv[index + 1];
    }
    const result = await configurePersonStudio({ personId: argumentsByName['--person'], deviceId: argumentsByName['--device'],
      port: Number(argumentsByName['--port']), sourceRoot: argumentsByName['--source'],
      ...(argumentsByName['--config-dir'] ? { configDir: argumentsByName['--config-dir'] } : {}),
      ...(argumentsByName['--display-base-url'] ? { displayBaseUrl: argumentsByName['--display-base-url'] } : {}),
      ...(argumentsByName['--admin-token-file'] ? { adminTokenFile: argumentsByName['--admin-token-file'] } : {}),
    });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

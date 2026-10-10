import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-service-access-'));
process.env.HOME = root;
process.env.REMOTELAB_CONFIG_DIR = path.join(root, 'config');
process.env.REMOTELAB_MEMORY_DIR = path.join(root, 'memory');
process.env.REMOTELAB_INSTANCE_ROOT = root;
await fs.mkdir(process.env.REMOTELAB_CONFIG_DIR);
const { inspectServiceAccess, readServiceAccessConfig } = await import('../lib/service-access.mjs');
const configPath = path.join(process.env.REMOTELAB_CONFIG_DIR, 'service-access.json');
const machineIdFile = path.join(root, 'machine-id');
const machineId = 'a'.repeat(32);
await fs.writeFile(machineIdFile, `${machineId}\n`);
const units = ['remotelab-example.service', 'remotelab-example-feishu.service'];
const config = { version: 1, units, localRootSsh: { host: '127.0.0.1', identityFile: path.join(root, 'existing-key') } };
const calls = [];
let sshMode = 'ok';
let unloaded = false;
const probe = async (command, args) => {
  calls.push({ command, args });
  if (command === '/usr/bin/systemctl') return { ok: true, stdout: `Id=${args[1]}\nLoadState=${unloaded ? 'not-found' : 'loaded'}\nActiveState=active\nMainPID=42\nWorkingDirectory=/known-source\n` };
  if (command === '/usr/bin/sudo') return args.at(-1) === units[0] ? { ok: true } : { ok: false, error: 'sudo: a password is required' };
  if (sshMode === 'denied') return { ok: false, error: 'Permission denied (publickey)' };
  return { ok: true, stdout: `Name:\tcat\nUid:\t${sshMode === 'nonroot' ? '1008\t1008\t1008\t1008' : '0\t0\t0\t0'}\n${sshMode === 'wrong-host' ? 'b'.repeat(32) : machineId}\n` };
};
const check = () => inspectServiceAccess({ configPath, machineIdFile, uid: 1008, platform: 'linux', probe });
try {
  assert.equal((await check()).state, 'unconfigured');
  assert.equal(calls.length, 0, 'missing configuration must not guess root access');
  await fs.writeFile(configPath, JSON.stringify(config));
  const result = await check();
  assert.equal(result.state, 'available');
  assert.equal(result.units[0].route, 'sudo');
  assert.equal(result.units[1].route, 'local-root-ssh', 'sudo failure must not become a false blocker when registered SSH works');
  assert.match(result.units[1].sudoError, /password/);
  assert.deepEqual(result.units[0].restartArgv, ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', units[0]]);
  assert.equal(result.units[1].restartArgv.at(-1), `/usr/bin/systemctl restart ${units[1]}`);
  const sshCall = calls.find((call) => call.command === '/usr/bin/ssh');
  assert.ok(sshCall.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(sshCall.args.includes('BatchMode=yes'));
  assert.ok(sshCall.args.includes(config.localRootSsh.identityFile));
  assert.ok(calls.every((call) => call.command !== '/usr/bin/systemctl' || call.args[0] === 'show'), 'inspection must never restart');
  assert.ok(calls.filter((call) => call.command === '/usr/bin/sudo').every((call) => call.args[1] === '-l'), 'sudo probes must be permission listings');
  assert.ok(calls.filter((call) => call.command === '/usr/bin/ssh').every((call) => call.args.at(-1) === 'cat /proc/self/status /etc/machine-id'));
  for (const mode of ['denied', 'nonroot', 'wrong-host']) {
    sshMode = mode;
    const denied = await check();
    assert.equal(denied.state, 'incomplete');
    assert.equal(denied.units[0].route, 'sudo', 'one unavailable alternative must not erase a viable sudo route');
    assert.equal(denied.units[1].restartArgv, null);
  }
  sshMode = 'ok';
  unloaded = true;
  assert.equal((await check()).units[0].route, null, 'root transport does not prove the named unit exists');
  unloaded = false;
  await fs.writeFile(configPath, JSON.stringify({ version: 1, units }));
  const noSsh = await check();
  assert.equal(noSsh.localRootSsh.state, 'unconfigured');
  assert.equal(noSsh.units[1].route, null);
  assert.equal((await inspectServiceAccess({ configPath, machineIdFile, uid: 0, platform: 'linux', probe })).units[1].route, 'local-root');
  for (const bad of [
    { ...config, units: ['x.service;touch /tmp/bad'] },
    { ...config, units: ['-x.service'] },
    { ...config, units: [units[0], units[0]] },
    { ...config, localRootSsh: { host: 'other-host', identityFile: '/key' } },
    { ...config, localRootSsh: { host: '127.0.0.1', identityFile: 'relative-key' } },
  ]) {
    await fs.writeFile(configPath, JSON.stringify(bad));
    const before = calls.length;
    await assert.rejects(check);
    assert.equal(calls.length, before, 'invalid input must be rejected before any subprocess');
  }
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.equal((await readServiceAccessConfig()).units.length, 2);
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  for (const query of ['部署时需要重启', '继续']) {
    const hook = await buildTurnContextHook({}, { query });
    assert.doesNotMatch(hook, /service-access|Configured instance services/,
      'service discovery is available on demand, not repeated on ordinary turns');
  }
  console.log('test-service-access: ok');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

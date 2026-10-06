import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const execFileAsync = promisify(execFile);
export const SERVICE_ACCESS_PATH = join(CONFIG_DIR, 'service-access.json');
const boundary = 'Read-only capability evidence, not authorization to restart. Check the current task, exact services, source and concurrent work before any mutation.';

export async function readServiceAccessConfig(file = SERVICE_ACCESS_PATH) {
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (config.version !== 1 || !Array.isArray(config.units) || !config.units.length
      || config.units.length > 20 || config.units.some((unit) => !/^[a-zA-Z0-9_@.-]+\.service$/.test(unit) || unit.startsWith('-'))
      || new Set(config.units).size !== config.units.length) {
    throw new Error('Invalid service-access.json: version 1 and 1–20 unique systemd service names required');
  }
  if (config.localRootSsh && (!['127.0.0.1', '::1'].includes(config.localRootSsh.host)
      || !isAbsolute(config.localRootSsh.identityFile || ''))) {
    throw new Error('localRootSsh requires an explicit loopback host and absolute identityFile');
  }
  return config;
}

function sshArgs(config) {
  return ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'IdentitiesOnly=yes',
    '-i', config.identityFile, `root@${config.host}`];
}

async function runProbe(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 7000, maxBuffer: 128 * 1024 });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 1000) };
  }
}

function parseProperties(text) {
  return Object.fromEntries(text.trim().split('\n').filter((line) => line.includes('='))
    .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}

export async function inspectServiceAccess({ configPath = SERVICE_ACCESS_PATH, probe = runProbe,
  uid = process.getuid?.(), machineIdFile = '/etc/machine-id', platform = process.platform } = {}) {
  const config = await readServiceAccessConfig(configPath);
  if (!config) return { state: 'unconfigured', configPath, boundary,
    nextStep: 'Read docs/platform-skills/service-access.md and the instance bootstrap Host Access pointer. Missing configuration is not proof that no management route exists.' };
  if (platform !== 'linux') return { state: 'unsupported', configPath, boundary, nextStep: 'Use the registered platform service manager; this probe supports Linux systemd only.' };
  const unitsPromise = Promise.all(config.units.map(async (unit) => {
    const [state, sudo] = await Promise.all([
      probe('/usr/bin/systemctl', ['show', unit, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'WorkingDirectory']),
      uid === 0 ? { ok: true } : probe('/usr/bin/sudo', ['-n', '-l', '/usr/bin/systemctl', 'restart', unit]),
    ]);
    return { unit, properties: state.ok ? parseProperties(state.stdout) : {},
      stateError: state.error || '', sudoAllowed: sudo.ok, sudoError: sudo.error || '' };
  }));
  let ssh = { state: 'unconfigured' };
  if (config.localRootSsh) {
    const result = await probe('/usr/bin/ssh', [...sshArgs(config.localRootSsh), 'cat /proc/self/status /etc/machine-id']);
    const localMachineId = (await readFile(machineIdFile, 'utf8')).trim();
    const remoteMachineId = result.stdout?.trim().split('\n').at(-1);
    const rootUid = /^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(result.stdout || '');
    ssh = result.ok && rootUid && /^[a-f0-9]{32}$/.test(localMachineId) && remoteMachineId === localMachineId
      ? { state: 'available', host: config.localRootSsh.host, sameMachine: true, rootUid: true }
      : { state: 'unavailable', error: result.error || 'SSH did not verify root identity on this exact machine' };
  }
  const units = (await unitsPromise).map((entry) => {
    const loaded = entry.properties.LoadState === 'loaded';
    const route = !loaded ? null : uid === 0 ? 'local-root' : entry.sudoAllowed ? 'sudo' : ssh.state === 'available' ? 'local-root-ssh' : null;
    const restartArgv = route === 'sudo' ? ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', entry.unit]
      : route === 'local-root' ? ['/usr/bin/systemctl', 'restart', entry.unit]
        : route === 'local-root-ssh' ? ['/usr/bin/ssh', ...sshArgs(config.localRootSsh), `/usr/bin/systemctl restart ${entry.unit}`] : null;
    return { ...entry, route, restartArgv };
  });
  return { state: units.every((entry) => entry.route) ? 'available' : 'incomplete',
    checkedAt: new Date().toISOString(), configPath, localRootSsh: ssh, units, boundary };
}

export async function buildServiceAccessPromptBlock(query = '') {
  if (!/重启|restart|systemctl|sudo|部署|上线|ssh/i.test(query)) return '';
  const config = await readServiceAccessConfig();
  return [
    '## Service management capability lookup',
    'Workflow: `$REMOTELAB_PROJECT_ROOT/docs/platform-skills/service-access.md`. Read-only live check: `remotelab service-access check --json`.',
    config ? `Configured instance services: ${config.units.join(', ')}. Local root SSH fallback: ${config.localRootSsh ? config.localRootSsh.host : 'not configured'}. Configuration is not a live permission check.`
      : 'No instance service-access configuration is registered. The instance bootstrap Host Access pointer may identify an existing route.',
    'A failed sudo check only rules out that route. The check covers the configured local SSH fallback too; older blocked reports and handbook entries are not current capability evidence.',
    boundary,
  ].join('\n');
}

export async function runServiceAccessCommand(args = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    stdout.write('Usage: remotelab service-access check [--json]\nRead-only systemd/sudo/registered local SSH capability check. Does not restart, change permissions or install keys.\nWorkflow: docs/platform-skills/service-access.md\n');
    return 0;
  }
  if (args[0] !== 'check' || args.slice(1).some((arg) => arg !== '--json')) throw new Error('Use service-access check [--json]');
  const result = await inspectServiceAccess();
  stdout.write(`${JSON.stringify(result, null, args.includes('--json') ? 0 : 2)}\n`);
  return result.state === 'available' ? 0 : 1;
}

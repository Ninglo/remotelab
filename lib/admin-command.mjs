import { execFile as execFileCallback } from 'child_process';
import { homedir, hostname as osHostname } from 'os';
import { dirname, join, resolve } from 'path';
import { mkdir, readFile, readdir, rm } from 'fs/promises';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import { pathExists, writeJsonAtomic } from '../chat/fs-utils.mjs';

const execFileAsync = promisify(execFileCallback);
const HOME_DIR = homedir();
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'cli.js');
const REMOTELAB_CONFIG_DIR = join(HOME_DIR, '.config', 'remotelab');
const FLEET_HOSTS_DIR = join(REMOTELAB_CONFIG_DIR, 'fleet', 'hosts');
const LOCAL_GUEST_REGISTRY_FILE = join(REMOTELAB_CONFIG_DIR, 'guest-instances.json');
const LOCAL_GUEST_ENV_DIR = '/etc/remotelab/guest-instances';
const REMOTE_PROJECT_ROOT = '/opt/remotelab';
const HOST_SCHEMA_VERSION = 1;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeName(value) {
  return trimString(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function normalizeRole(value) {
  const normalized = trimString(value).toLowerCase();
  return new Set(['control', 'dedicated']).has(normalized) ? normalized : 'dedicated';
}

function normalizeRuntime(value, { local = false } = {}) {
  if (local) return 'local';
  const normalized = trimString(value).toLowerCase();
  return new Set(['local', 'ssh']).has(normalized) ? normalized : 'ssh';
}

function normalizeInstanceSource(value, { local = false } = {}) {
  if (local) return 'local_registry';
  const normalized = trimString(value).toLowerCase();
  return new Set(['local_registry', 'snapshot']).has(normalized) ? normalized : 'snapshot';
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function parseJsonOutput(text) {
  const trimmed = trimString(text);
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const startIndex = trimmed.search(/[\[{]/);
    if (startIndex >= 0) {
      return JSON.parse(trimmed.slice(startIndex));
    }
    throw new Error('Command did not return JSON output');
  }
}

function printHelp(stdout = process.stdout) {
  stdout.write([
    'Usage:',
    '  remotelab admin [summary] [options]',
    '  remotelab admin hosts <list|add|show|remove|sync-local|sync-remote|sync-all|import-snapshot> [options]',
    '  remotelab admin instances <list|create|create-trial|start|stop|restart|delete|converge> --host <name> [options]',
    '',
    'Admin plane:',
    '  summary                 Show the host -> guest-instance fleet view',
    '  hosts list              List registered hosts',
    '  hosts add <name>        Register a managed host in the fleet registry',
    '  hosts show <name>       Show one host record and its effective instance view',
    '  hosts remove <name>     Remove a host record from the fleet registry',
    '  hosts sync-local <name> Refresh one local host from this machine guest registry',
    '  hosts sync-remote <name>',
    '                          Refresh one remote host over SSH via its stored sshHost',
    '  hosts sync-all          Refresh every registered host',
    '  hosts import-snapshot <name> --file <path>',
    '                          Attach a guest-instance snapshot for a non-local host',
    '  instances list         List instances on one managed host',
    '  instances create       Create one named instance on the target host',
    '  instances create-trial Create standard trial instance(s) on the target host',
    '  instances start        Start one instance service on the target host',
    '  instances stop         Stop one instance service on the target host',
    '  instances restart      Restart one instance service on the target host',
    '  instances delete       Delete one instance from the target host',
    '  instances converge     Repoint one or all target-host instances to the current source tree',
    '',
    'Host add options:',
    '  --local                 Mark host as the current machine and use the local guest registry',
    '  --role <control|dedicated>',
    '  --ssh-host <host>       SSH hostname or IP for future remote admin actions',
    '  --ssh-user <user>       SSH user (default: root)',
    '  --manifest <path>       Host manifest path',
    '  --env <path>            Install-profile env path',
    '  --ring <name>           Rollout ring label such as dev/canary/stable',
    '  --label <value>         Repeatable host label',
    '  --notes <text>          Free-form note',
    '  --sync-local            Capture the current local guest-instance snapshot after add',
    '',
    'General options:',
    '  --host <name>          Target host for admin instances actions',
    '  --count <n>            Batch size for instances create/create-trial',
    '  --local-only           For create/create-trial, skip public hostname+tunnel updates',
    '  --all                  For instances converge, target every guest instance on the host',
    '  --dry-run              For instances converge, print the plan without changes',
    '  --no-restart           For instances converge, rewrite targets but skip service restarts',
    '  --file <path>           Snapshot file used by import-snapshot',
    '  --sync                  For summary, sync every registered host before returning',
    '  --json                  Print machine-readable JSON',
    '  --help                  Show this help',
    '',
    'Examples:',
    '  remotelab admin summary --json',
    '  remotelab admin summary --sync --json',
    '  remotelab admin hosts add control --local --role control --ring dev --sync-local',
    '  remotelab admin hosts add miglab-sfo3-01 --ssh-host 164.92.123.246 --manifest ./host.manifest.jsonc --env ./install.env --role dedicated --ring canary',
    '  remotelab admin hosts sync-all --json',
    '  remotelab admin hosts import-snapshot miglab-sfo3-01 --file ./guest-list.json',
    '  remotelab admin instances list --host control --json',
    '  remotelab admin instances create-trial --host control --count 5 --json',
    '  remotelab admin instances create share --host factory-a --count 3 --local-only --json',
    '  remotelab admin instances delete share-2 --host factory-a --json',
    '  remotelab admin instances converge --host control --all --json',
    '  remotelab admin hosts list',
    '',
  ].join('\n'));
}

function parseArgs(argv = []) {
  const options = {
    command: 'summary',
    section: '',
    action: '',
    name: '',
    host: '',
    local: false,
    role: 'dedicated',
    runtime: '',
    sshHost: '',
    sshUser: 'root',
    manifestPath: '',
    installEnvPath: '',
    ring: '',
    labels: [],
    notes: '',
    syncLocal: false,
    file: '',
    count: 0,
    localOnly: false,
    all: false,
    dryRun: false,
    noRestart: false,
    sync: false,
    json: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--local':
        options.local = true;
        break;
      case '--role':
        options.role = argv[index + 1] || '';
        index += 1;
        break;
      case '--runtime':
        options.runtime = argv[index + 1] || '';
        index += 1;
        break;
      case '--ssh-host':
        options.sshHost = argv[index + 1] || '';
        index += 1;
        break;
      case '--ssh-user':
        options.sshUser = argv[index + 1] || '';
        index += 1;
        break;
      case '--manifest':
        options.manifestPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--env':
        options.installEnvPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--ring':
        options.ring = argv[index + 1] || '';
        index += 1;
        break;
      case '--label':
        options.labels.push(argv[index + 1] || '');
        index += 1;
        break;
      case '--notes':
        options.notes = argv[index + 1] || '';
        index += 1;
        break;
      case '--host':
        options.host = argv[index + 1] || '';
        index += 1;
        break;
      case '--count':
        options.count = Number.parseInt(argv[index + 1] || '', 10) || 0;
        index += 1;
        break;
      case '--local-only':
        options.localOnly = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-restart':
        options.noRestart = true;
        break;
      case '--sync-local':
        options.syncLocal = true;
        break;
      case '--file':
        options.file = argv[index + 1] || '';
        index += 1;
        break;
      case '--sync':
        options.sync = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  const first = trimString(positional[0]).toLowerCase();
  if (!first || first === 'summary' || first === 'status') {
    options.command = 'summary';
  } else if (first === 'hosts' || first === 'host') {
    options.command = 'hosts';
    options.section = 'hosts';
    options.action = trimString(positional[1]).toLowerCase();
    options.name = trimString(positional[2]);
  } else if (first === 'instances' || first === 'instance') {
    options.command = 'instances';
    options.section = 'instances';
    options.action = trimString(positional[1]).toLowerCase();
    options.name = trimString(positional[2]);
  } else {
    throw new Error(`Unknown admin command: ${first}`);
  }

  options.role = normalizeRole(options.role);
  options.runtime = normalizeRuntime(options.runtime, { local: options.local });
  options.host = sanitizeName(options.host);
  options.sshHost = trimString(options.sshHost);
  options.sshUser = trimString(options.sshUser) || 'root';
  options.manifestPath = trimString(options.manifestPath) ? resolve(options.manifestPath) : '';
  options.installEnvPath = trimString(options.installEnvPath) ? resolve(options.installEnvPath) : '';
  options.ring = trimString(options.ring);
  options.labels = [...new Set(options.labels.map((value) => trimString(value)).filter(Boolean))];
  options.notes = trimString(options.notes);
  options.file = trimString(options.file) ? resolve(options.file) : '';
  options.name = sanitizeName(options.name);

  if (options.command === 'hosts') {
    if (!options.action) {
      throw new Error('hosts requires <list|add|show|remove|sync-local|sync-remote|sync-all|import-snapshot>');
    }
    if (new Set(['add', 'show', 'remove', 'sync-local', 'sync-remote', 'import-snapshot']).has(options.action) && !options.name) {
      throw new Error(`${options.action} requires <name>`);
    }
    if (options.action === 'add' && options.local && options.sshHost) {
      throw new Error('--local cannot be combined with --ssh-host');
    }
    if (options.action === 'add' && options.syncLocal && !options.local) {
      throw new Error('--sync-local requires --local on hosts add');
    }
    if (options.action === 'add' && options.runtime === 'ssh' && !options.local && !options.sshHost) {
      throw new Error('hosts add requires --ssh-host unless --local is set');
    }
    if (options.action === 'sync-local' && !options.name) {
      throw new Error('sync-local requires <name>');
    }
    if (options.action === 'sync-remote' && !options.name) {
      throw new Error('sync-remote requires <name>');
    }
    if (options.action === 'sync-all' && options.name) {
      throw new Error('sync-all does not take <name>');
    }
    if (options.action === 'import-snapshot' && !options.file) {
      throw new Error('import-snapshot requires --file <path>');
    }
  } else if (options.command === 'instances') {
    if (!options.action) {
      throw new Error('instances requires <list|create|create-trial|start|stop|restart|delete|converge>');
    }
    if (!options.host) {
      throw new Error('instances requires --host <name>');
    }
    if (new Set(['create', 'start', 'stop', 'restart', 'delete']).has(options.action) && !options.name) {
      throw new Error(`${options.action} requires <name>`);
    }
    if (options.action === 'converge' && !options.all && !options.name) {
      throw new Error('converge requires <name> or --all');
    }
    if (options.action !== 'converge' && options.all) {
      throw new Error('--all is only supported by instances converge');
    }
    if (options.action !== 'converge' && options.dryRun) {
      throw new Error('--dry-run is only supported by instances converge');
    }
    if (options.action !== 'converge' && options.noRestart) {
      throw new Error('--no-restart is only supported by instances converge');
    }
    if (!new Set(['create', 'create-trial']).has(options.action) && options.count) {
      throw new Error('--count is only supported by instances create/create-trial');
    }
    if (!new Set(['create', 'create-trial']).has(options.action) && options.localOnly) {
      throw new Error('--local-only is only supported by instances create/create-trial');
    }
    if (options.count < 0) {
      throw new Error('--count must be a positive integer');
    }
  } else {
    if (options.local || options.host || options.sshHost || options.manifestPath || options.installEnvPath || options.ring || options.labels.length > 0 || options.notes || options.syncLocal || options.file || options.count || options.localOnly || options.all || options.dryRun || options.noRestart) {
      throw new Error('summary does not accept host mutation options');
    }
  }

  return options;
}

async function readJsonFile(path, fallbackValue) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

function hostRecordPath(name) {
  return join(FLEET_HOSTS_DIR, `${sanitizeName(name)}.json`);
}

function normalizeInstanceRecord(record = {}) {
  const name = sanitizeName(record?.name);
  if (!name) return null;
  const port = Number.parseInt(record?.port, 10) || 0;
  const hostname = trimString(record?.hostname);
  const publicBaseUrl = trimString(record?.publicBaseUrl) || (hostname ? `https://${hostname}` : '');
  return {
    name,
    port,
    hostname,
    publicBaseUrl,
    localBaseUrl: trimString(record?.localBaseUrl),
    createdAt: trimString(record?.createdAt),
  };
}

function normalizeInstanceSnapshot(snapshot = {}, fallbackSource = 'snapshot') {
  const instances = Array.isArray(snapshot?.instances)
    ? snapshot.instances.map((entry) => normalizeInstanceRecord(entry)).filter(Boolean)
    : [];
  return {
    collectedAt: trimString(snapshot?.collectedAt),
    source: trimString(snapshot?.source) || fallbackSource,
    instances,
  };
}

function normalizeHostRecord(record = {}) {
  const name = sanitizeName(record?.name);
  const local = record?.local === true;
  return {
    schemaVersion: HOST_SCHEMA_VERSION,
    name,
    displayName: trimString(record?.displayName),
    role: normalizeRole(record?.role),
    runtime: normalizeRuntime(record?.runtime, { local }),
    local,
    sshHost: trimString(record?.sshHost),
    sshUser: trimString(record?.sshUser) || 'root',
    ring: trimString(record?.ring),
    manifestPath: trimString(record?.manifestPath),
    installEnvPath: trimString(record?.installEnvPath),
    labels: [...new Set((Array.isArray(record?.labels) ? record.labels : []).map((value) => trimString(value)).filter(Boolean))],
    notes: trimString(record?.notes),
    createdAt: trimString(record?.createdAt),
    updatedAt: trimString(record?.updatedAt),
    lastSyncAt: trimString(record?.lastSyncAt),
    lastSyncStatus: trimString(record?.lastSyncStatus),
    lastSyncError: trimString(record?.lastSyncError),
    instanceSource: normalizeInstanceSource(record?.instanceSource, { local }),
    instanceSnapshot: normalizeInstanceSnapshot(record?.instanceSnapshot, local ? 'local_guest_registry' : 'snapshot'),
  };
}

async function listHostRecords() {
  if (!await pathExists(FLEET_HOSTS_DIR)) return [];
  const fileNames = (await readdir(FLEET_HOSTS_DIR)).filter((entry) => entry.endsWith('.json'));
  const results = [];
  for (const fileName of fileNames.sort()) {
    const record = normalizeHostRecord(await readJsonFile(join(FLEET_HOSTS_DIR, fileName), {}));
    if (record.name) results.push(record);
  }
  return results;
}

async function loadHostRecord(name) {
  const normalizedName = sanitizeName(name);
  if (!normalizedName) return null;
  const record = normalizeHostRecord(await readJsonFile(hostRecordPath(normalizedName), {}));
  return record.name ? record : null;
}

async function saveHostRecord(record) {
  const normalized = normalizeHostRecord(record);
  if (!normalized.name) {
    throw new Error('Host record requires a valid name');
  }
  await mkdir(dirname(hostRecordPath(normalized.name)), { recursive: true });
  await writeJsonAtomic(hostRecordPath(normalized.name), normalized);
  return normalized;
}

async function removeHostRecord(name) {
  await rm(hostRecordPath(name), { force: true });
}

async function loadLocalGuestInstances() {
  const records = await readJsonFile(LOCAL_GUEST_REGISTRY_FILE, []);
  if (!Array.isArray(records)) return [];
  return records
    .map((entry) => normalizeInstanceRecord(entry))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function writeLocalGuestInstances(records = []) {
  await mkdir(dirname(LOCAL_GUEST_REGISTRY_FILE), { recursive: true });
  await writeJsonAtomic(LOCAL_GUEST_REGISTRY_FILE, records);
}

async function loadSnapshotFile(path) {
  const payload = await readJsonFile(path, null);
  if (Array.isArray(payload)) {
    return payload.map((entry) => normalizeInstanceRecord(entry)).filter(Boolean);
  }
  if (Array.isArray(payload?.instances)) {
    return payload.instances.map((entry) => normalizeInstanceRecord(entry)).filter(Boolean);
  }
  if (Array.isArray(payload?.rows)) {
    return payload.rows.map((entry) => normalizeInstanceRecord(entry)).filter(Boolean);
  }
  throw new Error('Snapshot file must be a guest-instance array or an object with instances');
}

async function fetchRemoteGuestInstances(record) {
  if (record.local || record.runtime === 'local') {
    throw new Error(`Host ${record.name} is local; use sync-local instead`);
  }
  if (!record.sshHost) {
    throw new Error(`Host ${record.name} is missing sshHost`);
  }
  const remoteCommand = 'cd /opt/remotelab && node ./cli.js guest-instance list --json';
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=8',
    `${record.sshUser}@${record.sshHost}`,
    remoteCommand,
  ], {
    timeout: 45_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  const payload = JSON.parse(trimString(stdout) || '[]');
  if (!Array.isArray(payload)) {
    throw new Error(`Remote guest-instance list for ${record.name} did not return an array`);
  }
  return payload.map((entry) => normalizeInstanceRecord(entry)).filter(Boolean);
}

async function runLocalCliCommand(args = [], {
  timeout = 120_000,
  expectJson = false,
} = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return expectJson ? parseJsonOutput(stdout) : trimString(stdout);
}

function buildRemoteCliCommand(args = []) {
  return `cd ${shellQuote(REMOTE_PROJECT_ROOT)} && node ./cli.js ${args.map((value) => shellQuote(value)).join(' ')}`;
}

async function runRemoteShellCommand(record, command, {
  timeout = 120_000,
  expectJson = false,
} = {}) {
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=8',
    `${record.sshUser}@${record.sshHost}`,
    command,
  ], {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return expectJson ? parseJsonOutput(stdout) : trimString(stdout);
}

async function runGuestInstanceCommand(record, guestArgs = [], {
  timeout = 120_000,
  expectJson = false,
} = {}) {
  if (record.local || record.runtime === 'local') {
    return runLocalCliCommand(['guest-instance', ...guestArgs], { timeout, expectJson });
  }
  if (!record.sshHost) {
    throw new Error(`Host ${record.name} is missing sshHost`);
  }
  return runRemoteShellCommand(record, buildRemoteCliCommand(['guest-instance', ...guestArgs]), { timeout, expectJson });
}

async function requireHostRecord(name) {
  const record = await loadHostRecord(name);
  if (!record) {
    throw new Error(`Admin host not found: ${name}`);
  }
  return record;
}

async function buildHostView(record) {
  let instances = [];
  let source = record.instanceSource;
  let collectedAt = record.instanceSnapshot?.collectedAt || '';
  if (record.local || record.runtime === 'local' || record.instanceSource === 'local_registry') {
    instances = await loadLocalGuestInstances();
    source = 'local_registry';
    collectedAt = new Date().toISOString();
  } else {
    instances = Array.isArray(record.instanceSnapshot?.instances) ? record.instanceSnapshot.instances : [];
    source = trimString(record.instanceSnapshot?.source) || record.instanceSource || 'snapshot';
    collectedAt = trimString(record.instanceSnapshot?.collectedAt);
  }
  return {
    ...record,
    effectiveInstanceSource: source,
    effectiveCollectedAt: collectedAt,
    instances,
    instanceCount: instances.length,
  };
}

async function syncHostRecord(record) {
  if (record.local || record.runtime === 'local' || record.instanceSource === 'local_registry') {
    return syncLocalHostSnapshot(record.name);
  }
  return syncRemoteHostSnapshot(record.name);
}

async function syncRemoteHostSnapshot(name) {
  const record = await loadHostRecord(name);
  if (!record) {
    throw new Error(`Admin host not found: ${name}`);
  }
  if (record.local || record.runtime === 'local') {
    throw new Error(`Host ${name} is marked local; use sync-local`);
  }
  const now = new Date().toISOString();
  try {
    const instances = await fetchRemoteGuestInstances(record);
    return saveHostRecord({
      ...record,
      updatedAt: now,
      lastSyncAt: now,
      lastSyncStatus: 'ok',
      lastSyncError: '',
      instanceSource: 'snapshot',
      instanceSnapshot: {
        collectedAt: now,
        source: 'remote_guest_registry',
        instances,
      },
    });
  } catch (error) {
    return saveHostRecord({
      ...record,
      updatedAt: now,
      lastSyncAt: now,
      lastSyncStatus: 'error',
      lastSyncError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function syncAllHosts() {
  const records = await listHostRecords();
  const synced = [];
  for (const record of records) {
    synced.push(await syncHostRecord(record));
  }
  return synced;
}

function buildInstancesPayload(hostView) {
  return {
    host: hostView.name,
    hostView,
    instanceCount: hostView.instanceCount,
    instances: hostView.instances,
  };
}

async function listHostInstances(hostName, { sync = false } = {}) {
  const record = await requireHostRecord(hostName);
  const effectiveRecord = sync ? await syncHostRecord(record) : record;
  return buildInstancesPayload(await buildHostView(effectiveRecord));
}

function guestServiceName(name) {
  const safeName = sanitizeName(name);
  if (!safeName) throw new Error('Instance name is required');
  return safeName === 'owner' ? 'remotelab.service' : `remotelab-guest@${safeName}.service`;
}

async function runLocalInstanceServiceAction(name, action) {
  await execFileAsync('systemctl', [action, guestServiceName(name)], {
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
}

async function runRemoteInstanceServiceAction(record, name, action) {
  await runRemoteShellCommand(record, `systemctl ${action} ${shellQuote(guestServiceName(name))}`, {
    timeout: 45_000,
  });
}

async function deleteLocalInstance(name) {
  const safeName = sanitizeName(name);
  if (!safeName) throw new Error('Instance name is required');
  if (safeName === 'owner') throw new Error('Owner instance cannot be deleted');
  await execFileAsync('systemctl', ['disable', '--now', guestServiceName(safeName)], {
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  }).catch(() => {});
  await rm(join(LOCAL_GUEST_ENV_DIR, `${safeName}.env`), { force: true }).catch(() => {});
  const records = await readJsonFile(LOCAL_GUEST_REGISTRY_FILE, []);
  const filtered = (Array.isArray(records) ? records : []).filter((record) => sanitizeName(record?.name) !== safeName);
  await writeLocalGuestInstances(filtered);
  return {
    ok: true,
    action: 'delete',
    name: safeName,
  };
}

async function deleteRemoteInstance(record, name) {
  const safeName = sanitizeName(name);
  if (!safeName) throw new Error('Instance name is required');
  if (safeName === 'owner') throw new Error('Owner instance cannot be deleted');
  const registryScript = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const file = process.argv[1];',
    'const target = process.argv[2];',
    'let records = [];',
    'try { records = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error && error.code !== "ENOENT") throw error; }',
    'if (!Array.isArray(records)) records = [];',
    'records = records.filter((entry) => String((entry && entry.name) || "").trim() !== target);',
    'fs.mkdirSync(path.dirname(file), { recursive: true });',
    'fs.writeFileSync(file, JSON.stringify(records, null, 2) + "\\n");',
  ].join(' ');
  const command = [
    `systemctl disable --now ${shellQuote(guestServiceName(safeName))} >/dev/null 2>&1 || true`,
    `rm -f ${shellQuote(join(LOCAL_GUEST_ENV_DIR, `${safeName}.env`))}`,
    `node -e ${shellQuote(registryScript)} "$HOME/.config/remotelab/guest-instances.json" ${shellQuote(safeName)}`,
  ].join(' && ');
  await runRemoteShellCommand(record, command, {
    timeout: 45_000,
  });
  return {
    ok: true,
    action: 'delete',
    name: safeName,
  };
}

async function createHostInstances(options) {
  const record = await requireHostRecord(options.host);
  const guestArgs = options.action === 'create-trial'
    ? ['create-trial']
    : ['create', options.name];
  if (options.count > 1) guestArgs.push('--count', String(options.count));
  if (options.localOnly) guestArgs.push('--local-only');
  guestArgs.push('--json');
  const result = await runGuestInstanceCommand(record, guestArgs, {
    timeout: 180_000,
    expectJson: true,
  });
  const hostView = await buildHostView(await syncHostRecord(record));
  return {
    action: options.action,
    host: record.name,
    hostView,
    result,
  };
}

async function convergeHostInstances(options) {
  const record = await requireHostRecord(options.host);
  const guestArgs = ['converge'];
  if (options.all) guestArgs.push('--all');
  else guestArgs.push(options.name);
  if (options.dryRun) guestArgs.push('--dry-run');
  if (options.noRestart) guestArgs.push('--no-restart');
  guestArgs.push('--json');
  const result = await runGuestInstanceCommand(record, guestArgs, {
    timeout: 180_000,
    expectJson: true,
  });
  const hostView = options.dryRun
    ? await buildHostView(record)
    : await buildHostView(await syncHostRecord(record));
  return {
    action: 'converge',
    host: record.name,
    hostView,
    result,
  };
}

async function mutateHostInstance(options) {
  const record = await requireHostRecord(options.host);
  const safeName = sanitizeName(options.name);
  if (!safeName) throw new Error('Instance name is required');

  let result = null;
  if (options.action === 'delete') {
    result = record.local || record.runtime === 'local'
      ? await deleteLocalInstance(safeName)
      : await deleteRemoteInstance(record, safeName);
  } else if (record.local || record.runtime === 'local') {
    await runLocalInstanceServiceAction(safeName, options.action);
    result = { ok: true, action: options.action, name: safeName };
  } else {
    await runRemoteInstanceServiceAction(record, safeName, options.action);
    result = { ok: true, action: options.action, name: safeName };
  }

  const hostView = options.action === 'delete'
    ? await buildHostView(await syncHostRecord(record))
    : await buildHostView(record);
  return {
    action: options.action,
    host: record.name,
    hostView,
    result,
  };
}

async function buildFleetSummary({ sync = false } = {}) {
  const records = sync ? await syncAllHosts() : await listHostRecords();
  const baseRecords = records.length > 0
    ? records
    : [normalizeHostRecord({
      name: osHostname(),
      displayName: osHostname(),
      role: 'control',
      runtime: 'local',
      local: true,
      ring: 'dev',
      instanceSource: 'local_registry',
    })];
  const hosts = [];
  for (const record of baseRecords) {
    hosts.push(await buildHostView(record));
  }
  hosts.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    generatedAt: new Date().toISOString(),
    hostCount: hosts.length,
    instanceCount: hosts.reduce((sum, host) => sum + host.instanceCount, 0),
    hosts,
  };
}

function formatHostsList(records = []) {
  if (records.length === 0) return 'No admin hosts registered.';
  return records.map((record) => {
    const location = record.local ? 'local' : `${record.sshUser}@${record.sshHost}`;
    return [
      record.name,
      record.role,
      record.ring || '-',
      location,
      record.instanceSource,
    ].join('\t');
  }).join('\n');
}

function formatHostView(record) {
  const lines = [
    `name: ${record.name}`,
    `role: ${record.role}`,
    `runtime: ${record.runtime}`,
    `ring: ${record.ring || '-'}`,
    `location: ${record.local ? 'local' : `${record.sshUser}@${record.sshHost}`}`,
    `instanceSource: ${record.effectiveInstanceSource || record.instanceSource}`,
    `instances: ${record.instanceCount ?? record.instances?.length ?? 0}`,
  ];
  if (record.manifestPath) lines.push(`manifest: ${record.manifestPath}`);
  if (record.installEnvPath) lines.push(`env: ${record.installEnvPath}`);
  if (record.labels?.length) lines.push(`labels: ${record.labels.join(', ')}`);
  if (record.notes) lines.push(`notes: ${record.notes}`);
  if (record.lastSyncStatus) lines.push(`lastSync: ${record.lastSyncStatus}${record.lastSyncAt ? ` @ ${record.lastSyncAt}` : ''}`);
  if (record.lastSyncError) lines.push(`syncError: ${record.lastSyncError}`);
  if (record.effectiveCollectedAt || record.instanceSnapshot?.collectedAt) {
    lines.push(`collectedAt: ${record.effectiveCollectedAt || record.instanceSnapshot?.collectedAt}`);
  }
  for (const instance of record.instances || []) {
    lines.push(`instance: ${instance.name}${instance.publicBaseUrl ? ` (${instance.publicBaseUrl})` : instance.localBaseUrl ? ` (${instance.localBaseUrl})` : ''}`);
  }
  return lines.join('\n');
}

function formatFleetSummary(summary) {
  const lines = [
    `hosts: ${summary.hostCount}`,
    `instances: ${summary.instanceCount}`,
  ];
  for (const host of summary.hosts) {
    lines.push('');
    lines.push(`host: ${host.name} [${host.role}/${host.runtime}] ring=${host.ring || '-'} instances=${host.instanceCount} source=${host.effectiveInstanceSource}`);
    if (host.instances.length === 0) {
      lines.push('  - (no instances)');
      continue;
    }
    for (const instance of host.instances) {
      const target = instance.publicBaseUrl || instance.localBaseUrl || '-';
      lines.push(`  - ${instance.name} ${target}`);
    }
  }
  return lines.join('\n');
}

function formatInstancesPayload(payload) {
  const hostView = payload.hostView || {};
  const lines = [
    `host: ${payload.host}`,
    `instances: ${payload.instanceCount}`,
  ];
  for (const instance of payload.instances || []) {
    lines.push(`- ${instance.name} ${instance.publicBaseUrl || instance.localBaseUrl || '-'}`);
  }
  if (hostView.lastSyncStatus) {
    lines.push(`lastSync: ${hostView.lastSyncStatus}${hostView.lastSyncAt ? ` @ ${hostView.lastSyncAt}` : ''}`);
  }
  return lines.join('\n');
}

function formatInstanceMutation(payload) {
  const lines = [
    `host: ${payload.host}`,
    `action: ${payload.action}`,
  ];
  if (payload.result?.name) lines.push(`instance: ${payload.result.name}`);
  if (Array.isArray(payload.result)) lines.push(`created: ${payload.result.length}`);
  if (payload.hostView) lines.push(`instances: ${payload.hostView.instanceCount}`);
  return lines.join('\n');
}

async function addHost(options) {
  if (await loadHostRecord(options.name)) {
    throw new Error(`Admin host already exists: ${options.name}`);
  }
  const now = new Date().toISOString();
  let record = await saveHostRecord({
    schemaVersion: HOST_SCHEMA_VERSION,
    name: options.name,
    displayName: options.name,
    role: options.role,
    runtime: options.runtime,
    local: options.local,
    sshHost: options.local ? '' : options.sshHost,
    sshUser: options.local ? 'root' : options.sshUser,
    ring: options.ring,
    manifestPath: options.manifestPath,
    installEnvPath: options.installEnvPath,
    labels: options.labels,
    notes: options.notes,
    createdAt: now,
    updatedAt: now,
    lastSyncAt: '',
    lastSyncStatus: '',
    lastSyncError: '',
    instanceSource: normalizeInstanceSource('', { local: options.local }),
    instanceSnapshot: {
      collectedAt: '',
      source: options.local ? 'local_guest_registry' : 'snapshot',
      instances: [],
    },
  });

  if (options.syncLocal) {
    record = await syncLocalHostSnapshot(options.name);
  }

  return buildHostView(record);
}

async function syncLocalHostSnapshot(name) {
  const record = await loadHostRecord(name);
  if (!record) {
    throw new Error(`Admin host not found: ${name}`);
  }
  if (!record.local && record.runtime !== 'local') {
    throw new Error(`Host ${name} is not marked local`);
  }
  const now = new Date().toISOString();
  const instances = await loadLocalGuestInstances();
  return saveHostRecord({
    ...record,
    local: true,
    runtime: 'local',
    instanceSource: 'local_registry',
    updatedAt: now,
    lastSyncAt: now,
    lastSyncStatus: 'ok',
    lastSyncError: '',
    instanceSnapshot: {
      collectedAt: now,
      source: 'local_guest_registry',
      instances,
    },
  });
}

async function importHostSnapshot(name, filePath) {
  const record = await loadHostRecord(name);
  if (!record) {
    throw new Error(`Admin host not found: ${name}`);
  }
  const instances = await loadSnapshotFile(filePath);
  const now = new Date().toISOString();
  const updated = await saveHostRecord({
    ...record,
    updatedAt: now,
    lastSyncAt: now,
    lastSyncStatus: 'ok',
    lastSyncError: '',
    instanceSource: record.local ? 'local_registry' : 'snapshot',
    instanceSnapshot: {
      collectedAt: now,
      source: 'imported_snapshot',
      instances,
    },
  });
  return buildHostView(updated);
}

async function showHost(name) {
  const record = await loadHostRecord(name);
  if (!record) {
    throw new Error(`Admin host not found: ${name}`);
  }
  return buildHostView(record);
}

export async function runAdminCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);

  if (options.help) {
    printHelp(stdout);
    return 0;
  }

  if (options.command === 'summary') {
    const summary = await buildFleetSummary({ sync: options.sync });
    stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatFleetSummary(summary)}\n`);
    return 0;
  }

  if (options.command === 'hosts') {
    if (options.action === 'list') {
      const records = await listHostRecords();
      stdout.write(options.json ? `${JSON.stringify(records, null, 2)}\n` : `${formatHostsList(records)}\n`);
      return 0;
    }
    if (options.action === 'add') {
      const record = await addHost(options);
      stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatHostView(record)}\n`);
      return 0;
    }
    if (options.action === 'show') {
      const record = await showHost(options.name);
      stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatHostView(record)}\n`);
      return 0;
    }
    if (options.action === 'remove') {
      await removeHostRecord(options.name);
      stdout.write(options.json ? `${JSON.stringify({ removed: options.name }, null, 2)}\n` : `removed: ${options.name}\n`);
      return 0;
    }
    if (options.action === 'sync-local') {
      const record = await buildHostView(await syncLocalHostSnapshot(options.name));
      stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatHostView(record)}\n`);
      return 0;
    }
    if (options.action === 'sync-remote') {
      const record = await buildHostView(await syncRemoteHostSnapshot(options.name));
      stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatHostView(record)}\n`);
      return 0;
    }
    if (options.action === 'sync-all') {
      const summary = await buildFleetSummary({ sync: true });
      stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatFleetSummary(summary)}\n`);
      return 0;
    }
    if (options.action === 'import-snapshot') {
      const record = await importHostSnapshot(options.name, options.file);
      stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatHostView(record)}\n`);
      return 0;
    }
    throw new Error(`Unknown hosts action: ${options.action}`);
  }

  if (options.command === 'instances') {
    if (options.action === 'list') {
      const payload = await listHostInstances(options.host, { sync: options.sync });
      stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatInstancesPayload(payload)}\n`);
      return 0;
    }
    if (options.action === 'create' || options.action === 'create-trial') {
      const payload = await createHostInstances(options);
      stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatInstanceMutation(payload)}\n`);
      return 0;
    }
    if (new Set(['start', 'stop', 'restart', 'delete']).has(options.action)) {
      const payload = await mutateHostInstance(options);
      stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatInstanceMutation(payload)}\n`);
      return 0;
    }
    if (options.action === 'converge') {
      const payload = await convergeHostInstances(options);
      stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatInstanceMutation(payload)}\n`);
      return 0;
    }
    throw new Error(`Unknown instances action: ${options.action}`);
  }

  throw new Error(`Unknown admin command: ${options.command}`);
}

export {
  buildFleetSummary,
  parseArgs,
};

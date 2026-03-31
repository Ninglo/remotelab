import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { parseCloudflaredIngress } from './cloudflared-config.mjs';

const HOME_DIR = homedir();
const DEFAULT_OWNER_CONFIG_DIR = join(HOME_DIR, '.config', 'remotelab');
const DEFAULT_REGISTRY_FILE = join(DEFAULT_OWNER_CONFIG_DIR, 'guest-instances.json');
const DEFAULT_LAUNCH_AGENTS_DIR = join(HOME_DIR, 'Library', 'LaunchAgents');
const DEFAULT_CLOUDFLARED_CONFIG_FILE = join(HOME_DIR, '.cloudflared', 'config.yml');
const DEFAULT_INSTANCES_ROOT = join(HOME_DIR, '.remotelab', 'instances');
const TRIAL_RUNTIME_RE = /^trial\d*$/i;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function naturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeMailboxName(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dedupeSorted(values = []) {
  return [...new Set(values.map((value) => trimString(value)).filter(Boolean))].sort((left, right) => naturalCompare(left, right));
}

function dedupeNormalizedMailboxNames(values = []) {
  return [...new Set(values.map((value) => normalizeMailboxName(value)).filter(Boolean))].sort((left, right) => naturalCompare(left, right));
}

function normalizeEmailAddress(value) {
  return trimString(value).toLowerCase();
}

function normalizeDomain(value) {
  return normalizeEmailAddress(value).replace(/^@+/, '');
}

function normalizeInstanceAddressMode(value) {
  const normalized = trimString(value).toLowerCase().replace(/-/g, '_');
  if (normalized === 'local_part' || normalized === 'direct' || normalized === 'instance') {
    return 'local_part';
  }
  return 'plus';
}

function buildMailboxAddress(mailboxName, identity) {
  const normalizedName = normalizeMailboxName(mailboxName);
  const localPart = trimString(identity?.localPart).toLowerCase();
  const domain = normalizeDomain(identity?.domain);
  if (!normalizedName || !localPart || !domain) {
    return '';
  }
  if (normalizeInstanceAddressMode(identity?.instanceAddressMode) === 'local_part') {
    return `${normalizedName}@${domain}`;
  }
  return `${localPart}+${normalizedName}@${domain}`;
}

function safeReadJson(filePath, fallbackValue = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function safeReadText(filePath, fallbackValue = '') {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return fallbackValue;
  }
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractPlistString(content, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return decodeXmlEntities(match?.[1] || '');
}

function parseLaunchAgentPlist(content) {
  return {
    label: extractPlistString(content, 'Label'),
    port: Number.parseInt(extractPlistString(content, 'CHAT_PORT'), 10) || 0,
    instanceRoot: extractPlistString(content, 'REMOTELAB_INSTANCE_ROOT'),
    standardOutPath: extractPlistString(content, 'StandardOutPath'),
    standardErrorPath: extractPlistString(content, 'StandardErrorPath'),
  };
}

function extractServicePort(service) {
  const normalizedService = trimString(service);
  if (!normalizedService) return 0;
  try {
    const url = new URL(normalizedService);
    const normalizedPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return Number.parseInt(normalizedPort, 10) || 0;
  } catch {
    return 0;
  }
}

function buildCloudflaredPortMap(cloudflaredConfigFile = DEFAULT_CLOUDFLARED_CONFIG_FILE) {
  const configContent = safeReadText(cloudflaredConfigFile, '');
  const portMap = new Map();
  for (const entry of parseCloudflaredIngress(configContent)) {
    const port = extractServicePort(entry.service);
    if (!port) continue;
    const hostname = trimString(entry.hostname);
    if (hostname && !portMap.has(port)) {
      portMap.set(port, hostname);
    }
  }
  return portMap;
}

function normalizePublicBaseUrl(hostname) {
  const normalizedHostname = trimString(hostname);
  return normalizedHostname ? `https://${normalizedHostname}` : '';
}

function normalizeAuthFile({ authFile = '', configDir = '' } = {}) {
  const normalizedAuthFile = trimString(authFile);
  if (normalizedAuthFile) return normalizedAuthFile;
  const normalizedConfigDir = trimString(configDir);
  return normalizedConfigDir ? join(normalizedConfigDir, 'auth.json') : '';
}

function buildMailboxNames(name, mailboxAliases = []) {
  const normalizedName = normalizeMailboxName(name);
  const aliases = dedupeNormalizedMailboxNames(mailboxAliases);
  const mailboxNames = [normalizedName, ...aliases];
  if (normalizedName === 'trial') {
    mailboxNames.push('trial1');
  }
  return dedupeNormalizedMailboxNames(mailboxNames);
}

function normalizeRuntimeRecord(record = {}) {
  const name = normalizeMailboxName(record?.name);
  if (!name) return null;

  const port = Number.parseInt(`${record?.port || 0}`, 10) || 0;
  const instanceRoot = trimString(record?.instanceRoot);
  const configDir = trimString(record?.configDir) || (instanceRoot ? join(instanceRoot, 'config') : '');
  const memoryDir = trimString(record?.memoryDir) || (instanceRoot ? join(instanceRoot, 'memory') : '');
  const mailboxAliases = dedupeNormalizedMailboxNames([
    ...(Array.isArray(record?.mailboxAliases) ? record.mailboxAliases : []),
    trimString(record?.mailboxAlias),
  ]);
  const mailboxNames = buildMailboxNames(name, mailboxAliases);

  return {
    name,
    label: trimString(record?.label),
    port,
    hostname: trimString(record?.hostname),
    publicBaseUrl: trimString(record?.publicBaseUrl),
    localBaseUrl: trimString(record?.localBaseUrl),
    instanceRoot,
    configDir,
    memoryDir,
    mailboxRoot: trimString(record?.mailboxRoot) || (configDir ? join(configDir, 'agent-mailbox') : ''),
    authFile: normalizeAuthFile({ authFile: record?.authFile, configDir }),
    logPath: trimString(record?.logPath),
    errorLogPath: trimString(record?.errorLogPath),
    mailboxAliases,
    mailboxNames,
    mailboxAddress: trimString(record?.mailboxAddress),
    source: trimString(record?.source),
  };
}

function mergeRuntimeRecord(existingRecord, nextRecord, cloudflaredPortMap) {
  const existing = existingRecord || {};
  const next = nextRecord || {};
  const port = Number.parseInt(`${next.port || existing.port || 0}`, 10) || 0;
  const instanceRoot = trimString(next.instanceRoot) || trimString(existing.instanceRoot);
  const configDir = trimString(next.configDir) || trimString(existing.configDir) || (instanceRoot ? join(instanceRoot, 'config') : '');
  const memoryDir = trimString(next.memoryDir) || trimString(existing.memoryDir) || (instanceRoot ? join(instanceRoot, 'memory') : '');
  const hostname = trimString(next.hostname) || trimString(existing.hostname) || cloudflaredPortMap.get(port) || '';
  return normalizeRuntimeRecord({
    ...existing,
    ...next,
    name: trimString(next.name) || trimString(existing.name),
    port,
    instanceRoot,
    configDir,
    memoryDir,
    hostname,
    publicBaseUrl: trimString(next.publicBaseUrl) || trimString(existing.publicBaseUrl) || normalizePublicBaseUrl(hostname),
    localBaseUrl: trimString(next.localBaseUrl) || trimString(existing.localBaseUrl) || (port ? `http://127.0.0.1:${port}` : ''),
    authFile: trimString(next.authFile) || trimString(existing.authFile) || normalizeAuthFile({ configDir }),
    mailboxAliases: [
      ...(Array.isArray(existing.mailboxAliases) ? existing.mailboxAliases : []),
      ...(Array.isArray(next.mailboxAliases) ? next.mailboxAliases : []),
      trimString(next.mailboxAlias),
    ],
  });
}

function discoverLegacyTrialRuntimes({
  launchAgentsDir = DEFAULT_LAUNCH_AGENTS_DIR,
  cloudflaredConfigFile = DEFAULT_CLOUDFLARED_CONFIG_FILE,
  instancesRoot = DEFAULT_INSTANCES_ROOT,
} = {}) {
  const byName = new Map();
  const cloudflaredPortMap = buildCloudflaredPortMap(cloudflaredConfigFile);

  if (existsSync(launchAgentsDir)) {
    for (const fileName of readdirSync(launchAgentsDir).filter((entry) => /^com\.chatserver\..+\.plist$/.test(entry))) {
      if (fileName === 'com.chatserver.claude.plist') continue;
      const parsed = parseLaunchAgentPlist(safeReadText(join(launchAgentsDir, fileName), ''));
      const label = parsed.label || fileName.replace(/\.plist$/, '');
      const name = normalizeMailboxName(label.replace(/^com\.chatserver\./, ''));
      if (!TRIAL_RUNTIME_RE.test(name)) continue;
      byName.set(name, mergeRuntimeRecord(byName.get(name), {
        name,
        label,
        port: parsed.port,
        instanceRoot: parsed.instanceRoot,
        logPath: parsed.standardOutPath,
        errorLogPath: parsed.standardErrorPath,
        source: 'launchagent',
      }, cloudflaredPortMap));
    }
  }

  if (existsSync(instancesRoot)) {
    for (const directoryName of readdirSync(instancesRoot).filter((entry) => TRIAL_RUNTIME_RE.test(entry))) {
      const name = normalizeMailboxName(directoryName);
      const instanceRoot = join(instancesRoot, directoryName);
      byName.set(name, mergeRuntimeRecord(byName.get(name), {
        name,
        instanceRoot,
        source: trimString(byName.get(name)?.source) || 'instances_root',
      }, cloudflaredPortMap));
    }
  }

  return [...byName.values()].filter(Boolean).sort((left, right) => naturalCompare(left.name, right.name));
}

function defaultRegistryFileForHome(homeDir) {
  return join(homeDir, '.config', 'remotelab', 'guest-instances.json');
}

function defaultLaunchAgentsDirForHome(homeDir) {
  return join(homeDir, 'Library', 'LaunchAgents');
}

function defaultCloudflaredConfigFileForHome(homeDir) {
  return join(homeDir, '.cloudflared', 'config.yml');
}

function defaultInstancesRootForHome(homeDir) {
  return join(homeDir, '.remotelab', 'instances');
}

export function loadMailboxRuntimeRegistry({
  homeDir = HOME_DIR,
  registryFile = defaultRegistryFileForHome(homeDir),
  launchAgentsDir = defaultLaunchAgentsDirForHome(homeDir),
  cloudflaredConfigFile = defaultCloudflaredConfigFileForHome(homeDir),
  instancesRoot = defaultInstancesRootForHome(homeDir),
} = {}) {
  const byName = new Map();
  const cloudflaredPortMap = buildCloudflaredPortMap(cloudflaredConfigFile);

  for (const record of discoverLegacyTrialRuntimes({ launchAgentsDir, cloudflaredConfigFile, instancesRoot })) {
    byName.set(record.name, record);
  }

  const registry = safeReadJson(registryFile, []);
  if (Array.isArray(registry)) {
    for (const entry of registry) {
      const name = normalizeMailboxName(entry?.name);
      if (!name) continue;
      byName.set(name, mergeRuntimeRecord(byName.get(name), {
        ...entry,
        name,
        source: byName.has(name) ? 'discovered+registry' : 'registry',
      }, cloudflaredPortMap));
    }
  }

  return [...byName.values()].filter(Boolean).sort((left, right) => naturalCompare(left.name, right.name));
}

export function findMailboxRuntimeByName(name, registry = []) {
  const normalizedName = normalizeMailboxName(name);
  if (!normalizedName) return null;
  return registry.find((record) => record.name === normalizedName || record.mailboxNames.includes(normalizedName)) || null;
}

export function runtimeMailboxAddresses(record = {}, ownerIdentity = null) {
  return dedupeSorted([
    trimString(record?.mailboxAddress),
    ...(Array.isArray(record?.mailboxNames) ? record.mailboxNames : []).map((mailboxName) => buildMailboxAddress(mailboxName, ownerIdentity)),
  ].filter(Boolean).map((value) => normalizeEmailAddress(value)));
}

export function findMailboxRuntimeByAddress(address, { registry = [], ownerIdentity = null } = {}) {
  const normalizedAddress = normalizeEmailAddress(address);
  if (!normalizedAddress) return null;
  return registry.find((record) => runtimeMailboxAddresses(record, ownerIdentity).includes(normalizedAddress)) || null;
}

export {
  DEFAULT_REGISTRY_FILE,
  buildMailboxNames,
};

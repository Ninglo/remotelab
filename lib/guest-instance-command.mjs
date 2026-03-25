import { randomBytes, scrypt } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { parseCloudflaredIngress } from './cloudflared-config.mjs';
import { loadIdentity, normalizeInstanceAddressMode } from './agent-mailbox.mjs';
import {
  DEFAULT_GUEST_CHAT_BIND_HOST,
  DEFAULT_GUEST_INSTANCE_START_PORT,
  DEFAULT_GUEST_SESSION_EXPIRY_DAYS,
  buildGuestBootstrapText,
  buildLaunchAgentPlist,
  deriveGuestHostname,
  parseTunnelName,
  pickNextGuestPort,
  sanitizeGuestInstanceName,
  upsertCloudflaredIngress,
} from './guest-instance.mjs';
import { writeJsonAtomic } from '../chat/fs-utils.mjs';
import { normalizeUiRuntimeSelection } from './runtime-selection.mjs';
import { serializeUserShellEnvSnapshot } from './user-shell-env.mjs';

const scryptAsync = promisify(scrypt);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOME_DIR = homedir();
const OWNER_CONFIG_DIR = join(HOME_DIR, '.config', 'remotelab');
const DEFAULT_GUEST_INSTANCES_ROOT = join(HOME_DIR, '.remotelab', 'instances');
const GUEST_REGISTRY_FILE = join(OWNER_CONFIG_DIR, 'guest-instances.json');
const CLOUDFLARED_CONFIG_FILE = join(HOME_DIR, '.cloudflared', 'config.yml');
const LAUNCH_AGENTS_DIR = join(HOME_DIR, 'Library', 'LaunchAgents');
const LOG_DIR = join(HOME_DIR, 'Library', 'Logs');
const CLOUDFLARED_TUNNEL_PLIST = join(LAUNCH_AGENTS_DIR, 'com.cloudflared.tunnel.plist');
const CLOUDFLARED_TUNNEL_LABEL = 'com.cloudflared.tunnel';
const OWNER_PORT = 7690;
const BUILTIN_TOOL_IDS = new Set(['codex', 'claude', 'copilot', 'cline', 'kilo-code']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab guest-instance <command> [options]\n\nCommands:\n  create <name>            Create and start an isolated guest instance\n  list                     List guest instances created by this tool\n  show <name>              Show one guest instance and its current access URL\n  converge <name>          Repoint one isolated instance to the current source tree\n  converge --all           Repoint every isolated instance to the current source tree\n\nCreate options:\n  --port <port>            Explicit port (default: next free port from ${DEFAULT_GUEST_INSTANCE_START_PORT})\n  --hostname <fqdn>        Explicit public hostname\n  --subdomain <label>      Public subdomain label (default: <name>)\n  --domain <domain>        Public domain suffix (default: derive from the main ${OWNER_PORT} hostname)\n  --local-only             Skip Cloudflare hostname + tunnel updates\n  --instance-root <path>   Instance root (default: ~/.remotelab/instances/<name>)\n  --session-expiry-days <days>  Cookie lifetime in days (default: ${DEFAULT_GUEST_SESSION_EXPIRY_DAYS})\n  --username <name>        Optional password-login username (default: owner when --password is set)\n  --password <value>       Optional password-login password\n\nConverge options:\n  --all                    Target every non-owner chat-server launch agent\n  --dry-run                Print the convergence plan without rewriting plists\n  --no-restart             Rewrite plists but do not reload launchd services\n\nGeneral options:\n  --json                   Print machine-readable JSON\n  --help                   Show this help\n\nExamples:\n  remotelab guest-instance create trial4\n  remotelab guest-instance create demo --subdomain demo --domain example.com\n  remotelab guest-instance create local-demo --local-only --json\n  remotelab guest-instance list\n  remotelab guest-instance show trial4\n  remotelab guest-instance converge trial4\n  remotelab guest-instance converge --all --json\n`);
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value || '(missing)'}`);
  }
  return parsed;
}

function parsePort(value) {
  const port = parsePositiveInteger(value, '--port');
  if (port > 65535) {
    throw new Error(`Invalid value for --port: ${value || '(missing)'}`);
  }
  return port;
}

function parseArgs(argv = []) {
  const options = {
    command: trimString(argv[0]).toLowerCase(),
    name: trimString(argv[1]),
    port: null,
    hostname: '',
    subdomain: '',
    domain: '',
    localOnly: false,
    instanceRoot: '',
    sessionExpiryDays: DEFAULT_GUEST_SESSION_EXPIRY_DAYS,
    username: '',
    password: '',
    all: false,
    dryRun: false,
    noRestart: false,
    json: false,
    help: false,
  };

  if (options.command === '--help' || options.command === '-h' || options.command === 'help') {
    options.help = true;
    options.command = '';
    return options;
  }

  let startIndex = new Set(['create', 'show', 'status', 'converge']).has(options.command) ? 2 : 1;
  if (options.command === 'converge' && options.name.startsWith('-')) {
    options.name = '';
    startIndex = 1;
  }

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--port':
        options.port = parsePort(argv[index + 1]);
        index += 1;
        break;
      case '--hostname':
        options.hostname = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--subdomain':
        options.subdomain = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--domain':
        options.domain = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--local-only':
        options.localOnly = true;
        break;
      case '--instance-root':
        options.instanceRoot = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--session-expiry-days':
        options.sessionExpiryDays = parsePositiveInteger(argv[index + 1], '--session-expiry-days');
        index += 1;
        break;
      case '--username':
        options.username = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--password':
        options.password = argv[index + 1] || '';
        index += 1;
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
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.password && !options.username) {
    options.username = 'owner';
  }
  if (options.username && !options.password) {
    throw new Error('--username requires --password');
  }
  if (options.localOnly && options.hostname) {
    throw new Error('--local-only cannot be combined with --hostname');
  }
  if (options.command === 'converge' && !options.all && !sanitizeGuestInstanceName(options.name)) {
    throw new Error('converge requires <name> or --all');
  }
  if (options.command !== 'converge' && options.all) {
    throw new Error('--all is only supported by converge');
  }
  if (options.command !== 'converge' && options.dryRun) {
    throw new Error('--dry-run is only supported by converge');
  }
  if (options.command !== 'converge' && options.noRestart) {
    throw new Error('--no-restart is only supported by converge');
  }

  return options;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path, fallbackValue) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeTextAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, value, 'utf8');
  await rename(tempPath, path);
}

async function backupFile(path) {
  if (!await pathExists(path)) return '';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const backupPath = `${path}.bak.${timestamp}`;
  await copyFile(path, backupPath);
  return backupPath;
}

async function isDirectoryEmpty(path) {
  if (!await pathExists(path)) return true;
  const entries = await readdir(path);
  return entries.length === 0;
}

function generateAccessToken() {
  return randomBytes(32).toString('hex');
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPlistString(content, key) {
  const match = String(content || '').match(new RegExp(`<key>${escapeRegex(key)}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return decodeXmlEntities(match?.[1] || '');
}

function extractPlistArrayStrings(content, key) {
  const match = String(content || '').match(new RegExp(`<key>${escapeRegex(key)}</key>\\s*<array>([\\s\\S]*?)</array>`));
  if (!match) return [];
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((entry) => decodeXmlEntities(entry[1] || ''));
}

function extractPlistDictStrings(content, key) {
  const match = String(content || '').match(new RegExp(`<key>${escapeRegex(key)}</key>\\s*<dict>([\\s\\S]*?)</dict>`));
  if (!match) return {};
  const dict = {};
  for (const entry of match[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    const dictKey = decodeXmlEntities(entry[1] || '');
    if (!dictKey) continue;
    dict[dictKey] = decodeXmlEntities(entry[2] || '');
  }
  return dict;
}

function parseGuestLaunchAgentPlist(content = '') {
  const programArguments = extractPlistArrayStrings(content, 'ProgramArguments');
  const environmentVariables = extractPlistDictStrings(content, 'EnvironmentVariables');
  const port = Number.parseInt(trimString(environmentVariables.CHAT_PORT), 10) || 0;
  const label = trimString(extractPlistString(content, 'Label'));
  const name = sanitizeGuestInstanceName(label.replace(/^com\.chatserver\./, ''));
  const instanceRoot = trimString(environmentVariables.REMOTELAB_INSTANCE_ROOT)
    || (name ? join(DEFAULT_GUEST_INSTANCES_ROOT, name) : '');
  return {
    label,
    name,
    nodePath: trimString(programArguments[0]),
    chatServerPath: trimString(programArguments[1]),
    workingDirectory: trimString(extractPlistString(content, 'WorkingDirectory')),
    standardOutPath: trimString(extractPlistString(content, 'StandardOutPath')),
    standardErrorPath: trimString(extractPlistString(content, 'StandardErrorPath')),
    environmentVariables,
    port,
    instanceRoot,
  };
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${Buffer.from(hash).toString('hex')}`;
}

function normalizeGuestInstanceRecord(record = {}) {
  return {
    name: sanitizeGuestInstanceName(record.name),
    label: trimString(record.label),
    port: Number.parseInt(record.port, 10) || 0,
    hostname: trimString(record.hostname),
    instanceRoot: trimString(record.instanceRoot),
    configDir: trimString(record.configDir),
    memoryDir: trimString(record.memoryDir),
    authFile: trimString(record.authFile),
    launchAgentPath: trimString(record.launchAgentPath),
    logPath: trimString(record.logPath),
    errorLogPath: trimString(record.errorLogPath),
    publicBaseUrl: trimString(record.publicBaseUrl),
    localBaseUrl: trimString(record.localBaseUrl),
    sessionExpiryDays: Number.parseInt(record.sessionExpiryDays, 10) || DEFAULT_GUEST_SESSION_EXPIRY_DAYS,
    createdAt: trimString(record.createdAt) || new Date().toISOString(),
  };
}

function buildGuestMailboxAddress(name, identity = null) {
  const normalizedName = sanitizeGuestInstanceName(name);
  const localPart = trimString(identity?.localPart).toLowerCase();
  const domain = trimString(identity?.domain).toLowerCase();
  const instanceAddressMode = normalizeInstanceAddressMode(identity?.instanceAddressMode);
  if (!normalizedName || !localPart || !domain) return '';
  if (instanceAddressMode === 'local_part') {
    return `${normalizedName}@${domain}`;
  }
  return `${localPart}+${normalizedName}@${domain}`;
}

async function loadGuestRegistry() {
  const records = await readJsonFile(GUEST_REGISTRY_FILE, []);
  if (!Array.isArray(records)) return [];
  return records.map((record) => normalizeGuestInstanceRecord(record)).filter((record) => record.name && record.port > 0);
}

async function saveGuestRegistry(records) {
  const normalizedRecords = records
    .map((record) => normalizeGuestInstanceRecord(record))
    .filter((record) => record.name && record.port > 0)
    .sort((leftRecord, rightRecord) => leftRecord.name.localeCompare(rightRecord.name));
  await writeJsonAtomic(GUEST_REGISTRY_FILE, normalizedRecords);
}

function getLocalBaseUrl(port) {
  return `http://${DEFAULT_GUEST_CHAT_BIND_HOST}:${port}`;
}

function getPublicBaseUrl(hostname) {
  return trimString(hostname) ? `https://${trimString(hostname)}` : '';
}

function getAccessUrl(record, token) {
  const baseUrl = trimString(record.publicBaseUrl) || trimString(record.localBaseUrl);
  if (!baseUrl) return '';
  return token ? `${baseUrl}/?token=${token}` : baseUrl;
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

function isPortListening(port) {
  try {
    const output = execFileSync('lsof', ['-tiTCP:' + String(port), '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return trimString(output).length > 0;
  } catch {
    return false;
  }
}

function collectReservedPorts(registry, cloudflaredContent) {
  const reservedPorts = new Set([OWNER_PORT]);
  for (const record of registry) {
    if (record.port > 0) reservedPorts.add(record.port);
  }
  for (const entry of parseCloudflaredIngress(cloudflaredContent)) {
    const port = extractServicePort(entry.service);
    if (port > 0) reservedPorts.add(port);
  }
  return reservedPorts;
}

function chooseGuestPort(options, registry, cloudflaredContent) {
  const reservedPorts = collectReservedPorts(registry, cloudflaredContent);
  if (Number.isInteger(options.port) && options.port > 0) {
    if (reservedPorts.has(options.port) || isPortListening(options.port)) {
      throw new Error(`Port ${options.port} is already in use`);
    }
    return options.port;
  }

  let candidatePort = pickNextGuestPort(reservedPorts, { startPort: DEFAULT_GUEST_INSTANCE_START_PORT });
  while (isPortListening(candidatePort)) {
    reservedPorts.add(candidatePort);
    candidatePort = pickNextGuestPort(reservedPorts, { startPort: candidatePort + 1 });
  }
  return candidatePort;
}

function buildPortHostnameMap(content = '') {
  const hostnamesByPort = new Map();
  for (const entry of parseCloudflaredIngress(content)) {
    const port = extractServicePort(entry.service);
    const hostname = trimString(entry.hostname);
    if (port > 0 && hostname && !hostnamesByPort.has(port)) {
      hostnamesByPort.set(port, hostname);
    }
  }
  return hostnamesByPort;
}

async function discoverIsolatedLaunchAgents() {
  if (!await pathExists(LAUNCH_AGENTS_DIR)) return [];
  const cloudflaredContent = await readFile(CLOUDFLARED_CONFIG_FILE, 'utf8').catch(() => '');
  const hostnamesByPort = buildPortHostnameMap(cloudflaredContent);
  const fileNames = (await readdir(LAUNCH_AGENTS_DIR))
    .filter((entry) => /^com\.chatserver\..+\.plist$/.test(entry))
    .filter((entry) => entry !== 'com.chatserver.claude.plist')
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

  const agents = [];
  for (const fileName of fileNames) {
    const launchAgentPath = join(LAUNCH_AGENTS_DIR, fileName);
    const content = await readFile(launchAgentPath, 'utf8').catch(() => '');
    const parsed = parseGuestLaunchAgentPlist(content);
    const name = parsed.name || sanitizeGuestInstanceName(fileName.replace(/^com\.chatserver\./, '').replace(/\.plist$/, ''));
    const port = Number.parseInt(parsed.port, 10) || 0;
    if (!name || port <= 0) continue;
    const hostname = hostnamesByPort.get(port) || '';
    agents.push({
      ...parsed,
      name,
      launchAgentPath,
      hostname,
      localBaseUrl: getLocalBaseUrl(port),
      publicBaseUrl: getPublicBaseUrl(hostname),
    });
  }

  return agents;
}

function buildConvergedLaunchAgentSpec(agent = {}) {
  const name = sanitizeGuestInstanceName(agent.name || trimString(agent.label).replace(/^com\.chatserver\./, ''));
  const port = Number.parseInt(agent.port, 10)
    || Number.parseInt(trimString(agent.environmentVariables?.CHAT_PORT), 10)
    || 0;
  const environmentVariables = {
    ...(agent.environmentVariables && typeof agent.environmentVariables === 'object' ? agent.environmentVariables : {}),
  };

  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_FILE;
  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_ID;
  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_ROOT;
  delete environmentVariables.REMOTELAB_DISABLE_ACTIVE_RELEASE;

  environmentVariables.CHAT_BIND_HOST = trimString(environmentVariables.CHAT_BIND_HOST) || DEFAULT_GUEST_CHAT_BIND_HOST;
  if (port > 0) {
    environmentVariables.CHAT_PORT = String(port);
  }
  environmentVariables.HOME = trimString(environmentVariables.HOME) || HOME_DIR;
  environmentVariables.REMOTELAB_INSTANCE_ROOT = trimString(environmentVariables.REMOTELAB_INSTANCE_ROOT)
    || trimString(agent.instanceRoot)
    || (name ? join(DEFAULT_GUEST_INSTANCES_ROOT, name) : '');
  environmentVariables.REMOTELAB_USER_SHELL_ENV_B64 = trimString(environmentVariables.REMOTELAB_USER_SHELL_ENV_B64)
    || serializeUserShellEnvSnapshot();

  return {
    label: trimString(agent.label) || `com.chatserver.${name}`,
    name,
    nodePath: trimString(agent.nodePath) || process.execPath,
    chatServerPath: join(PROJECT_ROOT, 'chat-server.mjs'),
    workingDirectory: PROJECT_ROOT,
    standardOutPath: trimString(agent.standardOutPath) || join(LOG_DIR, `chat-server-${name || port}.log`),
    standardErrorPath: trimString(agent.standardErrorPath) || join(LOG_DIR, `chat-server-${name || port}.error.log`),
    environmentVariables,
    port,
  };
}

function detectLaunchAgentConvergence(agent = {}, next = buildConvergedLaunchAgentSpec(agent)) {
  const currentChatServerPath = trimString(agent.chatServerPath);
  const currentWorkingDirectory = trimString(agent.workingDirectory);
  const currentNodePath = trimString(agent.nodePath);
  const currentEnv = agent.environmentVariables && typeof agent.environmentVariables === 'object'
    ? agent.environmentVariables
    : {};
  const hasLegacyReleaseFlags = [
    currentEnv.REMOTELAB_ENABLE_ACTIVE_RELEASE,
    currentEnv.REMOTELAB_ACTIVE_RELEASE_FILE,
    currentEnv.REMOTELAB_ACTIVE_RELEASE_ID,
    currentEnv.REMOTELAB_ACTIVE_RELEASE_ROOT,
    currentEnv.REMOTELAB_DISABLE_ACTIVE_RELEASE,
  ].some((value) => trimString(value));

  const codePathChanged = resolve(currentChatServerPath || '.') !== resolve(next.chatServerPath);
  const workingDirectoryChanged = resolve(currentWorkingDirectory || '.') !== resolve(next.workingDirectory);
  const nodePathChanged = currentNodePath !== next.nodePath;
  const missingShellEnvSnapshot = !trimString(currentEnv.REMOTELAB_USER_SHELL_ENV_B64);
  const missingBindHost = !trimString(currentEnv.CHAT_BIND_HOST);
  const missingHome = !trimString(currentEnv.HOME);
  const missingInstanceRoot = !trimString(currentEnv.REMOTELAB_INSTANCE_ROOT);

  return {
    changed: codePathChanged
      || workingDirectoryChanged
      || nodePathChanged
      || hasLegacyReleaseFlags
      || missingShellEnvSnapshot
      || missingBindHost
      || missingHome
      || missingInstanceRoot,
    codePathChanged,
    workingDirectoryChanged,
    nodePathChanged,
    hasLegacyReleaseFlags,
    missingShellEnvSnapshot,
    missingBindHost,
    missingHome,
    missingInstanceRoot,
  };
}

async function detectOwnerCodexModel() {
  const codexConfigPath = join(HOME_DIR, '.codex', 'config.toml');
  if (!await pathExists(codexConfigPath)) return '';
  const content = await readFile(codexConfigPath, 'utf8');
  const match = content.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
  return trimString(match?.[1] || '');
}

function isSafeCopyableToolRecord(tool) {
  return trimString(tool?.command) === 'codex' && trimString(tool?.runtimeFamily) === 'codex-json';
}

async function seedGuestRuntimeDefaults(configDir) {
  const ownerSelection = await readJsonFile(join(OWNER_CONFIG_DIR, 'ui-runtime-selection.json'), null);
  const ownerTools = await readJsonFile(join(OWNER_CONFIG_DIR, 'tools.json'), []);
  const selectedTool = trimString(ownerSelection?.selectedTool);
  const selectedToolRecord = Array.isArray(ownerTools)
    ? ownerTools.find((tool) => trimString(tool?.id) === selectedTool)
    : null;
  const guestTools = isSafeCopyableToolRecord(selectedToolRecord) ? [selectedToolRecord] : [];

  if (guestTools.length > 0) {
    await writeJsonAtomic(join(configDir, 'tools.json'), guestTools);
  }

  let selection = null;
  if (selectedTool && (BUILTIN_TOOL_IDS.has(selectedTool) || guestTools.length > 0)) {
    selection = normalizeUiRuntimeSelection({
      ...ownerSelection,
      updatedAt: new Date().toISOString(),
    });
  } else {
    const detectedModel = await detectOwnerCodexModel();
    selection = normalizeUiRuntimeSelection({
      selectedTool: 'codex',
      selectedModel: trimString(ownerSelection?.selectedModel) || detectedModel || 'gpt-5.4',
      selectedEffort: trimString(ownerSelection?.selectedEffort) || 'high',
      thinkingEnabled: false,
      reasoningKind: 'enum',
      updatedAt: new Date().toISOString(),
    });
  }

  if (selection?.selectedTool) {
    await writeJsonAtomic(join(configDir, 'ui-runtime-selection.json'), selection);
  }
}

async function writeGuestAuthFile(authFile, { token, username = '', password = '' }) {
  const nextAuth = { token };
  if (trimString(username) && password) {
    nextAuth.username = trimString(username);
    nextAuth.passwordHash = await hashPassword(password);
  }
  await writeJsonAtomic(authFile, nextAuth);
}

async function ensureGuestLayout({ name, hostname, instanceRoot, configDir, memoryDir }) {
  await mkdir(instanceRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const bootstrapPath = join(memoryDir, 'bootstrap.md');
  if (!await pathExists(bootstrapPath)) {
    await writeTextAtomic(bootstrapPath, buildGuestBootstrapText({ name, hostname }));
  }
}

function execOrThrow(command, args, description) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = trimString(error?.stderr || '');
    const stdout = trimString(error?.stdout || '');
    const details = stderr || stdout || trimString(error?.message || '');
    throw new Error(`${description} failed: ${details || `${command} ${args.join(' ')}`}`);
  }
}

function unloadLaunchAgent(plistPath) {
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
  }
}

function loadLaunchAgent(plistPath, description) {
  execOrThrow('launchctl', ['load', plistPath], description);
}

function restartCloudflaredTunnelIfPresent() {
  if (!existsSync(CLOUDFLARED_TUNNEL_PLIST)) return false;

  if (typeof process.getuid === 'function') {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${CLOUDFLARED_TUNNEL_LABEL}`], {
        stdio: 'ignore',
      });
      return true;
    } catch {
    }
  }

  unloadLaunchAgent(CLOUDFLARED_TUNNEL_PLIST);
  loadLaunchAgent(CLOUDFLARED_TUNNEL_PLIST, 'Reloading cloudflared tunnel');
  return true;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function shouldUseCurlBuildInfoProbe(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return !new Set(['127.0.0.1', '::1', 'localhost']).has(url.hostname);
  } catch {
    return false;
  }
}

function fetchBuildInfoWithCurl(baseUrl, timeoutMs) {
  const statusMarker = '__REMOTELAB_HTTP_STATUS__:';
  try {
    const output = execFileSync('curl', [
      '-sS',
      '--max-time',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '-H',
      'Accept: application/json',
      '-w',
      `\n${statusMarker}%{http_code}`,
      `${baseUrl}/api/build-info`,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const markerIndex = output.lastIndexOf(`\n${statusMarker}`);
    const bodyText = markerIndex >= 0 ? output.slice(0, markerIndex) : output;
    const statusText = markerIndex >= 0
      ? output.slice(markerIndex + statusMarker.length + 1).trim()
      : '';
    const status = Number.parseInt(statusText, 10) || 0;
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    return {
      ok: false,
      status: 0,
      body: null,
      error: trimString(error?.stderr?.toString?.() || error?.message || String(error)),
    };
  }
}

async function fetchBuildInfo(baseUrl, timeoutMs) {
  if (shouldUseCurlBuildInfoProbe(baseUrl)) {
    const curlResult = fetchBuildInfoWithCurl(baseUrl, timeoutMs);
    if (curlResult) return curlResult;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/api/build-info`, {
      redirect: 'manual',
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: trimString(error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBuildInfo(baseUrl, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await fetchBuildInfo(baseUrl, Math.max(2000, intervalMs * 4));
    if (lastResult?.ok) {
      return lastResult;
    }
    await sleep(intervalMs);
  }
  return lastResult;
}

async function ensureCloudflareHostname(hostname, port) {
  if (!await pathExists(CLOUDFLARED_CONFIG_FILE)) {
    throw new Error(`Cloudflare config not found at ${CLOUDFLARED_CONFIG_FILE}`);
  }

  const originalContent = await readFile(CLOUDFLARED_CONFIG_FILE, 'utf8');
  const tunnelName = parseTunnelName(originalContent);
  if (!tunnelName) {
    throw new Error(`Could not parse tunnel name from ${CLOUDFLARED_CONFIG_FILE}`);
  }

  const nextContent = upsertCloudflaredIngress(originalContent, {
    hostname,
    service: `http://${DEFAULT_GUEST_CHAT_BIND_HOST}:${port}`,
  });
  let backupPath = '';
  if (nextContent !== originalContent) {
    backupPath = await backupFile(CLOUDFLARED_CONFIG_FILE);
    await writeTextAtomic(CLOUDFLARED_CONFIG_FILE, nextContent);
  }

  execOrThrow('cloudflared', ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelName, hostname], `Routing DNS for ${hostname}`);
  restartCloudflaredTunnelIfPresent();
  return {
    backupPath,
    tunnelName,
  };
}

async function readTokenFromAuthFile(authFile) {
  const auth = await readJsonFile(authFile, null);
  return trimString(auth?.token || '');
}

function formatGuestInstance(record, { token = '', localReachable = null, publicReachable = null, warnings = [] } = {}) {
  const lines = [
    `name: ${record.name}`,
    `port: ${record.port}`,
    `status: ${localReachable === true ? 'running' : localReachable === false ? 'stopped' : 'unknown'}`,
    `local: ${record.localBaseUrl}`,
  ];
  if (record.mailboxAddress) {
    lines.push(`mailbox: ${record.mailboxAddress}`);
  }
  if (record.publicBaseUrl) {
    lines.push(`public: ${record.publicBaseUrl}`);
    if (publicReachable !== null) {
      lines.push(`publicStatus: ${publicReachable ? 'reachable' : 'pending'}`);
    }
  }
  if (token) {
    lines.push(`access: ${getAccessUrl(record, token)}`);
    lines.push(`token: ${token}`);
  }
  lines.push(`instanceRoot: ${record.instanceRoot}`);
  lines.push(`config: ${record.configDir}`);
  lines.push(`memory: ${record.memoryDir}`);
  lines.push(`launchAgent: ${record.launchAgentPath}`);
  lines.push(`createdAt: ${record.createdAt}`);
  for (const warning of warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join('\n');
}

function formatGuestInstanceList(records = []) {
  if (records.length === 0) return 'No guest instances found.';
  return records.map((record) => [
    `${record.name}\t${record.port}\t${record.hostname || 'local-only'}\t${record.localReachable ? 'running' : 'stopped'}`,
  ].join('')).join('\n');
}

function formatConvergeResults(results = []) {
  if (results.length === 0) return 'No isolated instances matched.';
  return results.map((result) => {
    const changeStatus = result.changed
      ? result.dryRun
        ? 'planned'
        : result.restarted
          ? 'updated+restarted'
          : 'updated'
      : 'already-current';
    const lines = [
      `name: ${result.name}`,
      `status: ${changeStatus}`,
      `port: ${result.port}`,
      `local: ${result.localBaseUrl}`,
    ];
    if (result.publicBaseUrl) {
      lines.push(`public: ${result.publicBaseUrl}`);
    }
    lines.push(`from: ${result.previousChatServerPath}`);
    lines.push(`to: ${result.nextChatServerPath}`);
    if (result.backupPath) {
      lines.push(`backup: ${result.backupPath}`);
    }
    if (result.localReachable !== null) {
      lines.push(`localStatus: ${result.localReachable ? 'reachable' : 'failed'}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

async function enrichGuestRecord(record, { includeToken = false } = {}) {
  const localHealth = await fetchBuildInfo(record.localBaseUrl, 1500);
  const publicHealth = record.publicBaseUrl
    ? await fetchBuildInfo(record.publicBaseUrl, 4000)
    : null;
  const token = includeToken ? await readTokenFromAuthFile(record.authFile) : '';
  const mailboxIdentity = loadIdentity();
  return {
    ...record,
    mailboxAddress: buildGuestMailboxAddress(record.name, mailboxIdentity),
    localReachable: localHealth.ok,
    publicReachable: publicHealth ? publicHealth.ok : null,
    token,
    accessUrl: includeToken ? getAccessUrl(record, token) : '',
  };
}

async function createGuestInstance(options) {
  if (process.platform !== 'darwin') {
    throw new Error('guest-instance create currently supports macOS launchd only');
  }

  const requestedName = trimString(options.name);
  const name = sanitizeGuestInstanceName(requestedName);
  if (!name) {
    throw new Error('create requires a guest instance name');
  }

  const registry = await loadGuestRegistry();
  if (registry.some((record) => record.name === name)) {
    throw new Error(`Guest instance already exists: ${name}`);
  }

  const cloudflaredContent = options.localOnly || !await pathExists(CLOUDFLARED_CONFIG_FILE)
    ? ''
    : await readFile(CLOUDFLARED_CONFIG_FILE, 'utf8');
  const port = chooseGuestPort(options, registry, cloudflaredContent);
  const instanceRoot = resolve(trimString(options.instanceRoot) || join(DEFAULT_GUEST_INSTANCES_ROOT, name));
  const configDir = join(instanceRoot, 'config');
  const memoryDir = join(instanceRoot, 'memory');
  const authFile = join(configDir, 'auth.json');
  const existingRoot = await pathExists(instanceRoot);
  if (existingRoot && !await isDirectoryEmpty(instanceRoot)) {
    throw new Error(`Instance root already exists and is not empty: ${instanceRoot}`);
  }

  const hostname = options.localOnly
    ? ''
    : trimString(options.hostname)
      || deriveGuestHostname(cloudflaredContent, {
        name,
        subdomain: options.subdomain || name,
        domain: options.domain,
        ownerPort: OWNER_PORT,
      });
  if (!options.localOnly && !hostname) {
    throw new Error('Could not derive a public hostname; pass --hostname or --domain');
  }

  await ensureGuestLayout({ name, hostname, instanceRoot, configDir, memoryDir });
  await seedGuestRuntimeDefaults(configDir);

  const token = generateAccessToken();
  await writeGuestAuthFile(authFile, {
    token,
    username: options.username,
    password: options.password,
  });

  const label = `com.chatserver.${name}`;
  const launchAgentPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  const logPath = join(LOG_DIR, `chat-server-${name}.log`);
  const errorLogPath = join(LOG_DIR, `chat-server-${name}.error.log`);
  const localBaseUrl = getLocalBaseUrl(port);
  const publicBaseUrl = getPublicBaseUrl(hostname);
  const sessionExpiryMs = options.sessionExpiryDays * 24 * 60 * 60 * 1000;

  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });

  const plistContent = buildLaunchAgentPlist({
    label,
    nodePath: process.execPath,
    chatServerPath: join(PROJECT_ROOT, 'chat-server.mjs'),
    workingDirectory: PROJECT_ROOT,
    standardOutPath: logPath,
    standardErrorPath: errorLogPath,
    environmentVariables: {
      CHAT_BIND_HOST: DEFAULT_GUEST_CHAT_BIND_HOST,
      CHAT_PORT: String(port),
      HOME: HOME_DIR,
      REMOTELAB_INSTANCE_ROOT: instanceRoot,
      REMOTELAB_USER_SHELL_ENV_B64: serializeUserShellEnvSnapshot(),
      SECURE_COOKIES: '1',
      SESSION_EXPIRY: String(sessionExpiryMs),
    },
  });
  await writeTextAtomic(launchAgentPath, plistContent);

  unloadLaunchAgent(launchAgentPath);
  loadLaunchAgent(launchAgentPath, `Loading launch agent for ${name}`);

  const localHealth = await waitForBuildInfo(localBaseUrl, { timeoutMs: 30000, intervalMs: 750 });
  if (!localHealth?.ok) {
    throw new Error(`Guest instance ${name} failed local health check on ${localBaseUrl}`);
  }

  const record = normalizeGuestInstanceRecord({
    name,
    label,
    port,
    hostname,
    instanceRoot,
    configDir,
    memoryDir,
    authFile,
    launchAgentPath,
    logPath,
    errorLogPath,
    localBaseUrl,
    publicBaseUrl,
    sessionExpiryDays: options.sessionExpiryDays,
    createdAt: new Date().toISOString(),
  });

  const warnings = [];
  if (record.hostname) {
    await ensureCloudflareHostname(record.hostname, record.port);
  }

  await saveGuestRegistry([...registry, record]);

  let publicReachable = null;
  if (record.publicBaseUrl) {
    const publicHealth = await waitForBuildInfo(record.publicBaseUrl, { timeoutMs: 90000, intervalMs: 2500 });
    publicReachable = publicHealth?.ok === true;
    if (!publicReachable) {
      warnings.push(`Public hostname did not validate within timeout: ${record.hostname}`);
    }
  }

  return {
    ...record,
    mailboxAddress: buildGuestMailboxAddress(record.name, loadIdentity()),
    localReachable: true,
    publicReachable,
    token,
    accessUrl: getAccessUrl(record, token),
    warnings,
  };
}

async function listGuestInstances() {
  const registry = await loadGuestRegistry();
  return Promise.all(registry.map((record) => enrichGuestRecord(record)));
}

async function showGuestInstance(name) {
  const normalizedName = sanitizeGuestInstanceName(name);
  if (!normalizedName) {
    throw new Error('show requires a guest instance name');
  }
  const registry = await loadGuestRegistry();
  const record = registry.find((entry) => entry.name === normalizedName);
  if (!record) {
    throw new Error(`Guest instance not found: ${normalizedName}`);
  }
  return enrichGuestRecord(record, { includeToken: true });
}

async function convergeGuestInstances(options) {
  const targets = await discoverIsolatedLaunchAgents();
  const matchingTargets = options.all
    ? targets
    : targets.filter((record) => record.name === sanitizeGuestInstanceName(options.name));

  if (!options.all && matchingTargets.length === 0) {
    throw new Error(`Isolated instance not found: ${sanitizeGuestInstanceName(options.name)}`);
  }

  const results = [];
  for (const target of matchingTargets) {
    const next = buildConvergedLaunchAgentSpec(target);
    const drift = detectLaunchAgentConvergence(target, next);
    const result = {
      name: target.name,
      label: target.label,
      port: target.port,
      hostname: target.hostname,
      localBaseUrl: target.localBaseUrl,
      publicBaseUrl: target.publicBaseUrl,
      launchAgentPath: target.launchAgentPath,
      previousChatServerPath: target.chatServerPath,
      previousWorkingDirectory: target.workingDirectory,
      nextChatServerPath: next.chatServerPath,
      nextWorkingDirectory: next.workingDirectory,
      changed: drift.changed,
      drift,
      dryRun: options.dryRun,
      restarted: false,
      backupPath: '',
      localReachable: null,
    };

    if (drift.changed && !options.dryRun) {
      const plistContent = buildLaunchAgentPlist({
        label: next.label,
        nodePath: next.nodePath,
        chatServerPath: next.chatServerPath,
        workingDirectory: next.workingDirectory,
        standardOutPath: next.standardOutPath,
        standardErrorPath: next.standardErrorPath,
        environmentVariables: next.environmentVariables,
      });
      result.backupPath = await backupFile(target.launchAgentPath);
      await writeTextAtomic(target.launchAgentPath, plistContent);
      if (!options.noRestart) {
        unloadLaunchAgent(target.launchAgentPath);
        loadLaunchAgent(target.launchAgentPath, `Reloading launch agent for ${target.name}`);
        result.restarted = true;
        const localHealth = await waitForBuildInfo(target.localBaseUrl, { timeoutMs: 30000, intervalMs: 750 });
        result.localReachable = localHealth?.ok === true;
        if (!result.localReachable) {
          throw new Error(`Instance ${target.name} failed health check after converge on ${target.localBaseUrl}`);
        }
      }
    }

    if (result.localReachable === null) {
      const localHealth = await fetchBuildInfo(target.localBaseUrl, 1500);
      result.localReachable = localHealth?.ok === true;
    }

    results.push(result);
  }

  return results;
}

export async function runGuestInstanceCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);

  if (!options.command || options.help) {
    printHelp(stdout);
    return 0;
  }

  if (options.command === 'create') {
    const result = await createGuestInstance(options);
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatGuestInstance(result, {
      token: result.token,
      localReachable: result.localReachable,
      publicReachable: result.publicReachable,
      warnings: result.warnings,
    })}\n`);
    return 0;
  }

  if (options.command === 'list') {
    const result = await listGuestInstances();
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatGuestInstanceList(result)}\n`);
    return 0;
  }

  if (options.command === 'show' || options.command === 'status') {
    const result = await showGuestInstance(options.name);
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatGuestInstance(result, {
      token: result.token,
      localReachable: result.localReachable,
      publicReachable: result.publicReachable,
    })}\n`);
    return 0;
  }

  if (options.command === 'converge') {
    const result = await convergeGuestInstances(options);
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatConvergeResults(result)}\n`);
    return 0;
  }

  throw new Error(`Unknown guest-instance command: ${options.command}`);
}

export {
  buildGuestMailboxAddress,
  formatGuestInstance,
};

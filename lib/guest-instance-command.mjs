import { randomBytes, scrypt } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { parseCloudflaredIngress } from './cloudflared-config.mjs';
import {
  DEFAULT_ROOT_DIR,
  initializeMailbox,
  loadAllowlist,
  loadIdentity,
  loadMailboxAutomation,
  loadOutboundConfig,
  normalizeInstanceAddressMode,
  saveAllowlist,
  saveMailboxAutomation,
  saveOutboundConfig,
} from './agent-mailbox.mjs';
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
const GUEST_DEFAULTS_FILE = join(OWNER_CONFIG_DIR, 'guest-instance-defaults.json');
const GUEST_REGISTRY_FILE = join(OWNER_CONFIG_DIR, 'guest-instances.json');
const CLOUDFLARED_CONFIG_FILE = join(HOME_DIR, '.cloudflared', 'config.yml');
const LAUNCH_AGENTS_DIR = join(HOME_DIR, 'Library', 'LaunchAgents');
const OWNER_LAUNCH_AGENT_PATH = join(LAUNCH_AGENTS_DIR, 'com.chatserver.claude.plist');
const LOG_DIR = join(HOME_DIR, 'Library', 'Logs');
const CLOUDFLARED_TUNNEL_PLIST = join(LAUNCH_AGENTS_DIR, 'com.cloudflared.tunnel.plist');
const CLOUDFLARED_TUNNEL_LABEL = 'com.cloudflared.tunnel';
const OWNER_PORT = 7690;
const BUILTIN_TOOL_IDS = new Set(['codex', 'claude', 'copilot', 'cline', 'kilo-code']);
const PRODUCT_DEFAULT_GUEST_TOOL_ID = 'micro-agent';
const FALLBACK_GUEST_TOOL_ID = 'codex';
const DEFAULT_CODEX_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_MICRO_AGENT_REASONING_LEVEL = 'medium';
const FILE_ASSET_ENV_KEYS = Object.freeze([
  'REMOTELAB_ASSET_STORAGE_PROVIDER',
  'REMOTELAB_ASSET_STORAGE_BASE_URL',
  'REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL',
  'REMOTELAB_ASSET_STORAGE_REGION',
  'REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID',
  'REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY',
  'REMOTELAB_ASSET_STORAGE_KEY_PREFIX',
  'REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS',
  'REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function naturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
}

function normalizeGuestNameEntry(value) {
  if (typeof value === 'string') {
    return sanitizeGuestInstanceName(value);
  }
  return sanitizeGuestInstanceName(value?.name);
}

function extractTrialSlotNumber(value) {
  const normalizedName = normalizeGuestNameEntry(value);
  if (!normalizedName) return 0;
  if (normalizedName === 'trial') return 1;
  const match = normalizedName.match(/^trial(\d+)$/);
  return Number.parseInt(match?.[1] || '', 10) || 0;
}

function collectExistingGuestNames({ registry = [], isolatedAgents = [] } = {}) {
  return [...new Set([
    ...registry.map((record) => normalizeGuestNameEntry(record)),
    ...isolatedAgents.map((record) => normalizeGuestNameEntry(record)),
  ].filter(Boolean))];
}

function pickNextTrialInstanceName(values = []) {
  const occupiedSlots = values
    .map((value) => extractTrialSlotNumber(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const nextSlot = occupiedSlots.length > 0
    ? Math.max(...occupiedSlots) + 1
    : 1;
  return `trial${nextSlot}`;
}

function resolveRequestedGuestName(options, { registry = [], isolatedAgents = [] } = {}) {
  const explicitName = sanitizeGuestInstanceName(options?.name);
  if (explicitName) return explicitName;
  if (options?.trial === true) {
    return pickNextTrialInstanceName(collectExistingGuestNames({ registry, isolatedAgents }));
  }
  return '';
}

function printHelp(stdout = process.stdout) {
  stdout.write([
    'Usage:',
    '  remotelab guest-instance <command> [options]',
    '',
    'Commands:',
    '  create <name>            Create and start an isolated guest instance',
    '  create-trial             Create and start the next standard trial instance',
    '  list                     List guest instances created by this tool',
    '  links [name]             Print shareable access links for one or all guest instances',
    '  report [name]            Generate a structured usage + links report',
    '  show <name>              Show one guest instance and its current access URL',
    '  converge <name>          Repoint one isolated instance to the current source tree',
    '  converge --all           Repoint every isolated instance to the current source tree',
    '',
    'Create options:',
    '  --trial                  Auto-pick the next `trialN` name when <name> is omitted',
    `  --port <port>            Explicit port (default: next free port from ${DEFAULT_GUEST_INSTANCE_START_PORT})`,
    '  --hostname <fqdn>        Explicit public hostname',
    '  --subdomain <label>      Public subdomain label (default: <name>)',
    `  --domain <domain>        Public domain suffix (default: derive from the main ${OWNER_PORT} hostname)`,
    '  --local-only             Skip Cloudflare hostname + tunnel updates',
    '  --no-mailbox-sync        Skip automatic mailbox route sync for the instance address',
    '  --instance-root <path>   Instance root (default: ~/.remotelab/instances/<name>)',
    `  --session-expiry-days <days>  Cookie lifetime in days (default: ${DEFAULT_GUEST_SESSION_EXPIRY_DAYS})`,
    '  --username <name>        Optional password-login username (default: owner when --password is set)',
    '  --password <value>       Optional password-login password',
    '',
    'Converge options:',
    '  --all                    Target every non-owner chat-server launch agent',
    '  --dry-run                Print the convergence plan without rewriting plists',
    '  --no-restart             Rewrite plists but do not reload launchd services',
    '',
    'Links options:',
    '  --check                  Probe local/public reachability before printing links or reports',
    '',
    'Report options:',
    '  --output-dir <path>      Output directory (default: ~/.remotelab/reports/guest-instance)',
    '  --send                   Attach generated report files into the current RemoteLab session',
    '  --send-json              When sending, attach the JSON sidecar too',
    '  --message <text>         Custom attachment message text',
    '  --session <id>           Target session id for --send (default: $REMOTELAB_SESSION_ID)',
    '  --run-id <id>            Associate --send with a run (default: $REMOTELAB_RUN_ID)',
    '  --base-url <url>         RemoteLab base URL for --send (default: $REMOTELAB_CHAT_BASE_URL)',
    '',
    'General options:',
    '  --json                   Print machine-readable JSON',
    '  --help                   Show this help',
    '',
    'Examples:',
    '  remotelab guest-instance create-trial',
    '  remotelab guest-instance create --trial --json',
    '  remotelab guest-instance create trial4',
    '  remotelab guest-instance create demo --subdomain demo --domain example.com',
    '  remotelab guest-instance create local-demo --local-only --json',
    '  remotelab guest-instance list',
    '  remotelab guest-instance links',
    '  remotelab guest-instance links trial4 --json',
    '  remotelab guest-instance report --json',
    '  remotelab guest-instance report --send',
    '  remotelab guest-instance show trial4',
    '  remotelab guest-instance converge trial4',
    '  remotelab guest-instance converge --all --json',
    '',
  ].join('\n'));
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
    trial: false,
    port: null,
    hostname: '',
    subdomain: '',
    domain: '',
    localOnly: false,
    mailboxSync: true,
    instanceRoot: '',
    sessionExpiryDays: DEFAULT_GUEST_SESSION_EXPIRY_DAYS,
    username: '',
    password: '',
    all: false,
    dryRun: false,
    noRestart: false,
    check: false,
    outputDir: '',
    send: false,
    sendJson: false,
    message: '',
    sessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    runId: trimString(process.env.REMOTELAB_RUN_ID),
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL),
    json: false,
    help: false,
  };

  if (options.command === '--help' || options.command === '-h' || options.command === 'help') {
    options.help = true;
    options.command = '';
    return options;
  }

  if (options.command === 'create-trial') {
    options.command = 'create';
    options.name = '';
    options.trial = true;
  }

  let startIndex = new Set(['create', 'show', 'status', 'links', 'report', 'converge']).has(options.command)
    ? (trimString(options.name) ? 2 : 1)
    : 1;
  if (new Set(['create', 'show', 'status', 'links', 'report', 'converge']).has(options.command) && options.name.startsWith('-')) {
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
      case '--trial':
        options.trial = true;
        break;
      case '--no-mailbox-sync':
        options.mailboxSync = false;
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
      case '--check':
        options.check = true;
        break;
      case '--output-dir':
        options.outputDir = trimString(argv[index + 1]);
        index += 1;
        break;
      case '--send':
        options.send = true;
        break;
      case '--send-json':
        options.sendJson = true;
        break;
      case '--message':
        options.message = argv[index + 1] || '';
        index += 1;
        break;
      case '--session':
        options.sessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--run-id':
        options.runId = argv[index + 1] || '';
        index += 1;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
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
  if (options.command !== 'create' && options.trial) {
    throw new Error('--trial is only supported by create');
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
  if (!new Set(['links', 'report']).has(options.command) && options.check) {
    throw new Error('--check is only supported by links and report');
  }
  if (options.command !== 'create' && options.mailboxSync !== true) {
    throw new Error('--no-mailbox-sync is only supported by create');
  }
  if (options.command !== 'report' && options.outputDir) {
    throw new Error('--output-dir is only supported by report');
  }
  if (options.command !== 'report' && options.send) {
    throw new Error('--send is only supported by report');
  }
  if (options.command !== 'report' && options.sendJson) {
    throw new Error('--send-json is only supported by report');
  }
  if (options.command !== 'report' && trimString(options.message)) {
    throw new Error('--message is only supported by report');
  }
  if (options.command !== 'report' && trimString(options.sessionId) !== trimString(process.env.REMOTELAB_SESSION_ID)) {
    throw new Error('--session is only supported by report');
  }
  if (options.command !== 'report' && trimString(options.runId) !== trimString(process.env.REMOTELAB_RUN_ID)) {
    throw new Error('--run-id is only supported by report');
  }
  if (options.command !== 'report' && trimString(options.baseUrl) !== trimString(process.env.REMOTELAB_CHAT_BASE_URL)) {
    throw new Error('--base-url is only supported by report');
  }
  if (options.sendJson && !options.send) {
    throw new Error('--send-json requires --send');
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

async function loadGuestInstanceDefaults() {
  const persisted = await readJsonFile(GUEST_DEFAULTS_FILE, {});
  return {
    mainlandBaseUrl: normalizeBaseUrl(
      process.env.REMOTELAB_GUEST_MAINLAND_BASE_URL
      || persisted?.mainlandBaseUrl
      || persisted?.mainlandAccessBaseUrl
      || ''
    ),
  };
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

function pickFileAssetEnvironment(environmentVariables = {}) {
  const picked = {};
  for (const key of FILE_ASSET_ENV_KEYS) {
    const value = trimString(environmentVariables?.[key]);
    if (!value) continue;
    picked[key] = value;
  }
  return picked;
}

function applyInheritedFileAssetEnvironment(environmentVariables = {}, ownerFileAssetEnvironment = {}) {
  const next = {
    ...(environmentVariables && typeof environmentVariables === 'object' ? environmentVariables : {}),
  };
  for (const key of FILE_ASSET_ENV_KEYS) {
    delete next[key];
  }
  return {
    ...next,
    ...pickFileAssetEnvironment(ownerFileAssetEnvironment),
  };
}

async function readOwnerFileAssetEnvironment() {
  const ownerEnvironmentVariables = {};
  if (await pathExists(OWNER_LAUNCH_AGENT_PATH)) {
    const content = await readFile(OWNER_LAUNCH_AGENT_PATH, 'utf8').catch(() => '');
    Object.assign(ownerEnvironmentVariables, extractPlistDictStrings(content, 'EnvironmentVariables'));
  }
  return {
    ...pickFileAssetEnvironment(ownerEnvironmentVariables),
    ...pickFileAssetEnvironment(process.env),
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
    mailboxRoot: trimString(record.mailboxRoot),
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

function provisionGuestMailbox(record, ownerMailboxRoot = DEFAULT_ROOT_DIR) {
  const ownerIdentity = loadIdentity(ownerMailboxRoot);
  const mailboxAddress = buildGuestMailboxAddress(record?.name, ownerIdentity);
  if (!mailboxAddress) {
    return null;
  }

  const atIndex = mailboxAddress.lastIndexOf('@');
  if (atIndex === -1) {
    return null;
  }

  const mailboxRoot = trimString(record?.mailboxRoot) || join(trimString(record?.configDir), 'agent-mailbox');
  const initialized = initializeMailbox({
    rootDir: mailboxRoot,
    name: trimString(ownerIdentity?.name) ? `${trimString(ownerIdentity.name)} (${trimString(record?.name)})` : trimString(record?.name),
    localPart: mailboxAddress.slice(0, atIndex),
    domain: mailboxAddress.slice(atIndex + 1),
    description: `Agent-facing mailbox identity for RemoteLab instance ${trimString(record?.name)}.`,
    instanceAddressMode: ownerIdentity?.instanceAddressMode,
  });

  saveAllowlist(mailboxRoot, loadAllowlist(ownerMailboxRoot));
  saveOutboundConfig(mailboxRoot, loadOutboundConfig(ownerMailboxRoot));
  saveMailboxAutomation(mailboxRoot, loadMailboxAutomation(ownerMailboxRoot));

  return {
    rootDir: mailboxRoot,
    identity: initialized.identity,
  };
}

async function syncGuestMailboxProvisioning(record, {
  mailboxIdentity = loadIdentity(),
  mailboxSync = true,
  syncCloudflareRoutingFn = null,
} = {}) {
  const mailboxAddress = buildGuestMailboxAddress(record?.name, mailboxIdentity);
  if (!mailboxAddress) {
    return {
      mailboxAddress: '',
      status: 'unconfigured',
      detail: 'Owner mailbox is not initialized.',
      desiredRouteModel: '',
      operations: [],
    };
  }

  if (mailboxSync !== true) {
    return {
      mailboxAddress,
      status: 'skipped',
      detail: 'Disabled by --no-mailbox-sync.',
      desiredRouteModel: '',
      operations: [],
    };
  }

  let syncCloudflareRouting = syncCloudflareRoutingFn;
  if (typeof syncCloudflareRouting !== 'function') {
    ({ syncCloudflareRouting } = await import('../scripts/agent-mail-cloudflare-routing.mjs'));
  }

  try {
    const syncResult = await syncCloudflareRouting({});
    return {
      mailboxAddress,
      status: 'synced',
      detail: '',
      desiredRouteModel: trimString(syncResult?.desiredRouteModel),
      operations: Array.isArray(syncResult?.operations) ? syncResult.operations : [],
    };
  } catch (error) {
    return {
      mailboxAddress,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      desiredRouteModel: '',
      operations: [],
    };
  }
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

function buildMainlandBaseUrl(name, guestDefaults = null) {
  const mainlandBaseUrl = normalizeBaseUrl(guestDefaults?.mainlandBaseUrl);
  const normalizedName = sanitizeGuestInstanceName(name);
  if (!mainlandBaseUrl || !normalizedName) return '';
  return `${mainlandBaseUrl}/${normalizedName}`;
}

function buildAccessUrl(baseUrl, token = '') {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return '';
  return token ? `${normalizedBaseUrl}/?token=${token}` : normalizedBaseUrl;
}

function getAccessUrl(record, token) {
  return buildAccessUrl(trimString(record.publicBaseUrl) || trimString(record.localBaseUrl), token);
}

function attachDerivedAccess(record, { token = '', guestDefaults = null } = {}) {
  const mainlandBaseUrl = buildMainlandBaseUrl(record?.name, guestDefaults);
  const publicAccessUrl = buildAccessUrl(record?.publicBaseUrl, token);
  const localAccessUrl = buildAccessUrl(record?.localBaseUrl, token);
  return {
    ...record,
    publicAccessUrl,
    localAccessUrl,
    mainlandBaseUrl,
    mainlandAccessUrl: buildAccessUrl(mainlandBaseUrl, token),
    accessUrl: publicAccessUrl || localAccessUrl || getAccessUrl(record, token),
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

function collectReservedPorts(registry, cloudflaredContent, isolatedAgents = []) {
  const reservedPorts = new Set([OWNER_PORT]);
  for (const record of registry) {
    if (record.port > 0) reservedPorts.add(record.port);
  }
  for (const record of isolatedAgents) {
    if (record.port > 0) reservedPorts.add(record.port);
  }
  for (const entry of parseCloudflaredIngress(cloudflaredContent)) {
    const port = extractServicePort(entry.service);
    if (port > 0) reservedPorts.add(port);
  }
  return reservedPorts;
}

function chooseGuestPort(options, registry, cloudflaredContent, isolatedAgents = []) {
  const reservedPorts = collectReservedPorts(registry, cloudflaredContent, isolatedAgents);
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

function buildConvergedLaunchAgentSpec(agent = {}, options = {}) {
  const name = sanitizeGuestInstanceName(agent.name || trimString(agent.label).replace(/^com\.chatserver\./, ''));
  const port = Number.parseInt(agent.port, 10)
    || Number.parseInt(trimString(agent.environmentVariables?.CHAT_PORT), 10)
    || 0;
  const environmentVariables = applyInheritedFileAssetEnvironment(
    agent.environmentVariables,
    options.ownerFileAssetEnvironment,
  );

  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_FILE;
  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_ID;
  delete environmentVariables.REMOTELAB_ACTIVE_RELEASE_ROOT;
  delete environmentVariables.REMOTELAB_ENABLE_ACTIVE_RELEASE;
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
  const fileAssetEnvironmentChanged = FILE_ASSET_ENV_KEYS.some(
    (key) => trimString(currentEnv[key]) !== trimString(next.environmentVariables?.[key]),
  );

  return {
    changed: codePathChanged
      || workingDirectoryChanged
      || nodePathChanged
      || hasLegacyReleaseFlags
      || missingShellEnvSnapshot
      || missingBindHost
      || missingHome
      || missingInstanceRoot
      || fileAssetEnvironmentChanged,
    codePathChanged,
    workingDirectoryChanged,
    nodePathChanged,
    hasLegacyReleaseFlags,
    missingShellEnvSnapshot,
    missingBindHost,
    missingHome,
    missingInstanceRoot,
    fileAssetEnvironmentChanged,
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

function isMicroAgentToolRecord(toolId, tool = null) {
  return trimString(toolId) === PRODUCT_DEFAULT_GUEST_TOOL_ID || trimString(tool?.toolProfile) === 'micro-agent';
}

function normalizeGuestCopyableOwnerTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (!isSafeCopyableToolRecord(tool)) return null;
  if (!isMicroAgentToolRecord(tool?.id, tool)) {
    return { ...tool };
  }
  return {
    ...tool,
    models: Array.isArray(tool.models)
      ? tool.models.map((model) => {
        if (!model || typeof model !== 'object') return model;
        return {
          ...model,
          defaultReasoning: DEFAULT_MICRO_AGENT_REASONING_LEVEL,
        };
      })
      : tool.models,
    reasoning: {
      kind: 'enum',
      label: trimString(tool?.reasoning?.label) || 'Thinking',
      levels: DEFAULT_CODEX_REASONING_LEVELS,
      default: DEFAULT_MICRO_AGENT_REASONING_LEVEL,
    },
  };
}

function isToolIdAvailable(toolId, tools = []) {
  const normalizedToolId = trimString(toolId);
  if (!normalizedToolId) return false;
  if (BUILTIN_TOOL_IDS.has(normalizedToolId)) return true;
  return Array.isArray(tools)
    && tools.some((tool) => trimString(tool?.id) === normalizedToolId);
}

function sameRuntimeSelection(left, right) {
  const normalizedLeft = left && typeof left === 'object' ? normalizeUiRuntimeSelection(left) : null;
  const normalizedRight = right && typeof right === 'object' ? normalizeUiRuntimeSelection(right) : null;
  if (!normalizedLeft && !normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.selectedTool === normalizedRight.selectedTool
    && normalizedLeft.selectedModel === normalizedRight.selectedModel
    && normalizedLeft.selectedEffort === normalizedRight.selectedEffort
    && normalizedLeft.thinkingEnabled === normalizedRight.thinkingEnabled
    && normalizedLeft.reasoningKind === normalizedRight.reasoningKind;
}

function collectSafeCopyableOwnerTools(ownerTools = []) {
  if (!Array.isArray(ownerTools)) return [];
  const collected = [];
  const seenIds = new Set();

  for (const tool of ownerTools) {
    const normalizedTool = normalizeGuestCopyableOwnerTool(tool);
    if (!normalizedTool) continue;
    const toolId = trimString(normalizedTool?.id);
    if (!toolId || seenIds.has(toolId)) continue;
    seenIds.add(toolId);
    collected.push(normalizedTool);
  }

  return collected;
}

function buildGuestOwnerSelectionCandidate(selection, tool = null) {
  if (!selection || typeof selection !== 'object') return null;
  if (!isMicroAgentToolRecord(selection.selectedTool, tool)) {
    return selection;
  }
  return {
    ...selection,
    selectedEffort: '',
    thinkingEnabled: false,
  };
}

function findToolRecord(toolId, tools = []) {
  const normalizedToolId = trimString(toolId);
  if (!normalizedToolId || !Array.isArray(tools)) return null;
  return tools.find((tool) => trimString(tool?.id) === normalizedToolId) || null;
}

function resolveToolReasoningKind(toolId, tool = null) {
  const normalizedKind = trimString(tool?.reasoning?.kind).toLowerCase();
  if (normalizedKind === 'enum' || normalizedKind === 'toggle' || normalizedKind === 'none') {
    return normalizedKind;
  }
  const runtimeFamily = trimString(tool?.runtimeFamily);
  if (runtimeFamily === 'codex-json' || trimString(toolId) === 'codex') {
    return 'enum';
  }
  if (runtimeFamily === 'claude-stream-json' || trimString(toolId) === 'claude') {
    return 'toggle';
  }
  return 'none';
}

function resolveToolModelId(toolId, tool = null, candidateSelection = null, detectedModel = '') {
  const models = Array.isArray(tool?.models)
    ? tool.models.filter((model) => model && typeof model === 'object')
    : [];
  const candidateModel = trimString(candidateSelection?.selectedTool) === trimString(toolId)
    ? trimString(candidateSelection?.selectedModel)
    : '';

  if (candidateModel && (models.length === 0 || models.some((model) => trimString(model?.id) === candidateModel))) {
    return candidateModel;
  }

  if (trimString(toolId) === 'codex') {
    return trimString(detectedModel);
  }

  return trimString(models[0]?.id);
}

function resolveToolEffort({
  toolId,
  tool = null,
  candidateSelection = null,
  reasoningKind = 'none',
  selectedModel = '',
} = {}) {
  if (reasoningKind !== 'enum') return '';

  const normalizedToolId = trimString(toolId);
  const levels = Array.isArray(tool?.reasoning?.levels)
    ? tool.reasoning.levels.map((level) => trimString(level)).filter(Boolean)
    : [];
  const candidateEffort = trimString(candidateSelection?.selectedTool) === normalizedToolId
    ? trimString(candidateSelection?.selectedEffort)
    : '';
  if (candidateEffort && (levels.length === 0 || levels.includes(candidateEffort))) {
    return candidateEffort;
  }

  const selectedModelRecord = Array.isArray(tool?.models)
    ? tool.models.find((model) => trimString(model?.id) === trimString(selectedModel))
    : null;
  const modelDefaultEffort = trimString(
    selectedModelRecord?.defaultReasoning
    || selectedModelRecord?.defaultEffort,
  );
  if (modelDefaultEffort && (levels.length === 0 || levels.includes(modelDefaultEffort))) {
    return modelDefaultEffort;
  }

  const reasoningDefault = trimString(tool?.reasoning?.default);
  if (reasoningDefault && (levels.length === 0 || levels.includes(reasoningDefault))) {
    return reasoningDefault;
  }

  return levels[0] || '';
}

function resolveGuestRuntimeSelection(toolId, {
  tools = [],
  candidateSelection = null,
  detectedModel = '',
} = {}) {
  const normalizedToolId = trimString(toolId) || FALLBACK_GUEST_TOOL_ID;
  const tool = findToolRecord(normalizedToolId, tools);
  const reasoningKind = resolveToolReasoningKind(normalizedToolId, tool);
  const selectedModel = resolveToolModelId(normalizedToolId, tool, candidateSelection, detectedModel);
  return normalizeUiRuntimeSelection({
    selectedTool: normalizedToolId,
    selectedModel,
    selectedEffort: resolveToolEffort({
      toolId: normalizedToolId,
      tool,
      candidateSelection,
      reasoningKind,
      selectedModel,
    }),
    thinkingEnabled: reasoningKind === 'toggle' && candidateSelection?.selectedTool === normalizedToolId
      ? candidateSelection.thinkingEnabled === true
      : false,
    reasoningKind,
    updatedAt: new Date().toISOString(),
  });
}

function resolveDefaultGuestToolId(tools = []) {
  if (isToolIdAvailable(PRODUCT_DEFAULT_GUEST_TOOL_ID, tools)) {
    return PRODUCT_DEFAULT_GUEST_TOOL_ID;
  }
  return FALLBACK_GUEST_TOOL_ID;
}

export function planGuestRuntimeDefaults({
  ownerSelection = null,
  ownerTools = [],
  guestSelection = null,
  guestTools = [],
  detectedModel = '',
} = {}) {
  const normalizedGuestTools = Array.isArray(guestTools)
    ? guestTools.filter((tool) => tool && typeof tool === 'object')
    : [];
  const ownerSafeTools = collectSafeCopyableOwnerTools(ownerTools);
  const ownerSafeToolsById = new Map(
    ownerSafeTools.map((tool) => [trimString(tool?.id), tool]).filter(([toolId]) => !!toolId),
  );
  const nextTools = normalizedGuestTools.map((tool) => {
    const toolId = trimString(tool?.id);
    return ownerSafeToolsById.get(toolId) || tool;
  });
  const existingToolIds = new Set(
    normalizedGuestTools
      .map((tool) => trimString(tool?.id))
      .filter(Boolean),
  );

  for (const tool of ownerSafeTools) {
    const toolId = trimString(tool?.id);
    if (!toolId || existingToolIds.has(toolId)) continue;
    existingToolIds.add(toolId);
    nextTools.push(tool);
  }

  const normalizedGuestSelection = guestSelection && typeof guestSelection === 'object'
    ? normalizeUiRuntimeSelection(guestSelection)
    : null;
  const normalizedOwnerSelection = ownerSelection && typeof ownerSelection === 'object'
    ? normalizeUiRuntimeSelection(ownerSelection)
    : null;

  let selection = null;
  if (isToolIdAvailable(normalizedGuestSelection?.selectedTool, nextTools)) {
    selection = resolveGuestRuntimeSelection(normalizedGuestSelection.selectedTool, {
      tools: nextTools,
      candidateSelection: normalizedGuestSelection,
      detectedModel,
    });
  } else if (isToolIdAvailable(normalizedOwnerSelection?.selectedTool, nextTools)) {
    const ownerTool = findToolRecord(normalizedOwnerSelection.selectedTool, nextTools);
    selection = resolveGuestRuntimeSelection(normalizedOwnerSelection.selectedTool, {
      tools: nextTools,
      candidateSelection: buildGuestOwnerSelectionCandidate(normalizedOwnerSelection, ownerTool),
      detectedModel,
    });
  } else {
    selection = resolveGuestRuntimeSelection(resolveDefaultGuestToolId(nextTools), {
      tools: nextTools,
      detectedModel,
    });
  }

  return {
    tools: nextTools,
    selection,
  };
}

async function syncGuestRuntimeDefaults(configDir, options = {}) {
  const ownerSelection = await readJsonFile(join(OWNER_CONFIG_DIR, 'ui-runtime-selection.json'), null);
  const ownerTools = await readJsonFile(join(OWNER_CONFIG_DIR, 'tools.json'), []);
  const guestSelection = await readJsonFile(join(configDir, 'ui-runtime-selection.json'), null);
  const guestTools = await readJsonFile(join(configDir, 'tools.json'), []);
  const detectedModel = await detectOwnerCodexModel();
  const planned = planGuestRuntimeDefaults({
    ownerSelection,
    ownerTools,
    guestSelection,
    guestTools,
    detectedModel,
  });

  const normalizedGuestTools = Array.isArray(guestTools)
    ? guestTools.filter((tool) => tool && typeof tool === 'object')
    : [];
  const currentSelection = guestSelection && typeof guestSelection === 'object'
    ? normalizeUiRuntimeSelection(guestSelection)
    : null;
  const toolsChanged = JSON.stringify(normalizedGuestTools) !== JSON.stringify(planned.tools);
  const selectionChanged = !sameRuntimeSelection(currentSelection, planned.selection);

  if (options.dryRun !== true) {
    if (toolsChanged) {
      await writeJsonAtomic(join(configDir, 'tools.json'), planned.tools);
    }
    if (selectionChanged && planned.selection?.selectedTool) {
      await writeJsonAtomic(join(configDir, 'ui-runtime-selection.json'), planned.selection);
    }
  }

  return {
    changed: toolsChanged || selectionChanged,
    toolsChanged,
    selectionChanged,
    toolIds: planned.tools.map((tool) => trimString(tool?.id)).filter(Boolean),
    selectedTool: trimString(planned.selection?.selectedTool),
  };
}

async function seedGuestRuntimeDefaults(configDir) {
  await syncGuestRuntimeDefaults(configDir);
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
  if (trimString(record.mailboxRoutingStatus)) {
    const detail = trimString(record.mailboxRoutingDetail);
    lines.push(`mailboxRouting: ${record.mailboxRoutingStatus}${detail ? ` (${detail})` : ''}`);
  }
  if (record.publicBaseUrl) {
    lines.push(`public: ${record.publicBaseUrl}`);
    if (publicReachable !== null) {
      lines.push(`publicStatus: ${publicReachable ? 'reachable' : 'pending'}`);
    }
  }
  if (record.mainlandBaseUrl) {
    lines.push(`mainland: ${record.mainlandBaseUrl}`);
  }
  if (token) {
    lines.push(`access: ${getAccessUrl(record, token)}`);
    if (record.localAccessUrl || record.localBaseUrl) {
      lines.push(`localAccess: ${record.localAccessUrl || buildAccessUrl(record.localBaseUrl, token)}`);
    }
    if (record.mainlandAccessUrl || record.mainlandBaseUrl) {
      lines.push(`mainlandAccess: ${record.mainlandAccessUrl || buildAccessUrl(record.mainlandBaseUrl, token)}`);
    }
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

function formatGuestInstanceLinks(records = [], { check = false } = {}) {
  if (records.length === 0) return 'No guest instances found.';
  return records.map((record) => {
    const lines = [
      `name: ${record.name}`,
      `access: ${record.accessUrl || '(unavailable)'}`,
    ];
    if (record.mainlandAccessUrl) {
      lines.push(`mainlandAccess: ${record.mainlandAccessUrl}`);
    }
    if (record.localAccessUrl) {
      lines.push(`localAccess: ${record.localAccessUrl}`);
    }
    if (record.mailboxAddress) {
      lines.push(`mailbox: ${record.mailboxAddress}`);
    }
    if (check) {
      lines.push(`localStatus: ${record.localReachable === true ? 'reachable' : record.localReachable === false ? 'failed' : 'unknown'}`);
      if (record.publicBaseUrl) {
        lines.push(`publicStatus: ${record.publicReachable === true ? 'reachable' : record.publicReachable === false ? 'failed' : 'unknown'}`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
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
  const guestDefaults = await loadGuestInstanceDefaults();
  return attachDerivedAccess({
    ...record,
    mailboxAddress: buildGuestMailboxAddress(record.name, mailboxIdentity),
    localReachable: localHealth.ok,
    publicReachable: publicHealth ? publicHealth.ok : null,
    token,
  }, {
    token: includeToken ? token : '',
    guestDefaults,
  });
}

async function listGuestInstanceLinks(options = {}) {
  const normalizedName = sanitizeGuestInstanceName(options?.name);
  const registry = await loadGuestRegistry();
  const matchingRecords = normalizedName
    ? registry.filter((record) => record.name === normalizedName)
    : registry;

  if (normalizedName && matchingRecords.length === 0) {
    throw new Error(`Guest instance not found: ${normalizedName}`);
  }

  const guestDefaults = await loadGuestInstanceDefaults();
  const mailboxIdentity = loadIdentity();
  return Promise.all(matchingRecords.map(async (record) => {
    const token = await readTokenFromAuthFile(record.authFile);
    let localReachable = null;
    let publicReachable = null;
    if (options.check) {
      const [localHealth, publicHealth] = await Promise.all([
        fetchBuildInfo(record.localBaseUrl, 1500),
        record.publicBaseUrl ? fetchBuildInfo(record.publicBaseUrl, 4000) : Promise.resolve(null),
      ]);
      localReachable = localHealth?.ok === true;
      publicReachable = publicHealth ? publicHealth.ok === true : null;
    }
    return attachDerivedAccess({
      ...record,
      mailboxAddress: buildGuestMailboxAddress(record.name, mailboxIdentity),
      localReachable,
      publicReachable,
      token,
    }, {
      token,
      guestDefaults,
    });
  }));
}

function countCollection(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function normalizeGuestSessionRecords(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry && typeof entry === 'object');
  }
  if (value && Array.isArray(value.sessions)) {
    return value.sessions.filter((entry) => entry && typeof entry === 'object');
  }
  if (value && typeof value === 'object') {
    return Object.values(value).filter((entry) => entry && typeof entry === 'object');
  }
  return [];
}

function compareIsoTimestampsDesc(left, right) {
  return String(right || '').localeCompare(String(left || ''));
}

function formatCompactTimestamp(value) {
  const normalizedValue = trimString(value);
  if (!normalizedValue) return '—';
  const flattened = normalizedValue.replace('T', ' ');
  if (flattened.length >= 16) {
    return `${flattened.slice(0, 16)}${normalizedValue.endsWith('Z') ? 'Z' : ''}`;
  }
  return flattened;
}

function pickBestAccessUrl(record = {}) {
  return trimString(record.publicAccessUrl)
    || trimString(record.mainlandAccessUrl)
    || trimString(record.localAccessUrl)
    || trimString(record.accessUrl);
}

function resolveGuestUsageStatus(snapshot = {}, { nowMs = Date.now() } = {}) {
  const sessionCount = Number.parseInt(`${snapshot.sessionCount || 0}`, 10) || 0;
  const authSessionCount = Number.parseInt(`${snapshot.authSessionCount || 0}`, 10) || 0;
  if (sessionCount <= 0) {
    return authSessionCount > 0 ? 'opened' : 'empty';
  }

  const lastSessionMs = Date.parse(snapshot.lastSessionAt || '');
  if (!Number.isFinite(lastSessionMs)) {
    return 'occupied';
  }

  const ageMs = Math.max(0, nowMs - lastSessionMs);
  if (ageMs <= 2 * 24 * 60 * 60 * 1000) return 'active';
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return 'occupied';
  return 'stale';
}

function buildGuestUsageBrief(snapshot = {}, { nowMs = Date.now() } = {}) {
  const status = resolveGuestUsageStatus(snapshot, { nowMs });
  if (status === 'empty') {
    return 'unused';
  }
  if (status === 'opened') {
    return 'opened, no chat yet';
  }
  if (status === 'active') {
    return 'recent activity';
  }
  if (status === 'occupied') {
    return 'has chat history';
  }
  return 'stale but occupied';
}

function compareGuestUsageRows(left, right) {
  return (right.sessionCount - left.sessionCount)
    || (right.authSessionCount - left.authSessionCount)
    || compareIsoTimestampsDesc(left.lastSessionAt, right.lastSessionAt)
    || naturalCompare(left.name, right.name);
}

async function readGuestUsageSnapshot(record = {}) {
  const configDir = trimString(record.configDir)
    || (trimString(record.instanceRoot) ? join(trimString(record.instanceRoot), 'config') : '');
  const authSessions = configDir
    ? await readJsonFile(join(configDir, 'auth-sessions.json'), [])
    : [];
  const rawSessions = configDir
    ? await readJsonFile(join(configDir, 'chat-sessions.json'), [])
    : [];
  const sessions = normalizeGuestSessionRecords(rawSessions);
  const lastSessionAt = sessions
    .map((session) => trimString(
      session?.updatedAt
      || session?.lastMessageAt
      || session?.createdAt
      || session?.created
      || ''
    ))
    .filter(Boolean)
    .sort(compareIsoTimestampsDesc)[0] || '';

  return {
    configDir,
    sessionCount: sessions.length,
    authSessionCount: countCollection(authSessions),
    lastSessionAt,
  };
}

function escapeMarkdownTableCell(value) {
  return String(value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeCsvValue(value) {
  const normalizedValue = String(value ?? '');
  if (!/[",\n]/.test(normalizedValue)) {
    return normalizedValue;
  }
  return `"${normalizedValue.replace(/"/g, '""')}"`;
}

function buildGuestInstanceReportSummary(summary = {}) {
  return `Guest instance usage snapshot: ${summary.totalCount || 0} total, ${summary.occupiedCount || 0} occupied, ${summary.openedCount || 0} opened-no-chat, ${summary.emptyCount || 0} empty.`;
}

function buildGuestInstanceReportMessage(summary = {}) {
  const topNames = Array.isArray(summary.topActiveNames) ? summary.topActiveNames.slice(0, 5) : [];
  return `${buildGuestInstanceReportSummary(summary)}${topNames.length > 0 ? ` Top in use: ${topNames.join(', ')}.` : ''}`;
}

function renderGuestInstanceReportMarkdown(report = {}) {
  const lines = [
    `# Guest Instance Usage Report — ${report.scope === 'all' ? 'all instances' : report.scope}`,
    '',
    `Generated at ${report.generatedAt}.`,
    '',
    '## Overview',
    `- Total guest instances: **${report.summary.totalCount}**`,
    `- Occupied (chat history present): **${report.summary.occupiedCount}**`,
    `- Opened without chat yet: **${report.summary.openedCount}**`,
    `- Empty: **${report.summary.emptyCount}**`,
    `- Stale occupied: **${report.summary.staleCount}**`,
    `- Top in use: ${report.summary.topActiveNames.join(', ') || 'none'}`,
    `- Empty candidates: ${report.summary.emptyNames.join(', ') || 'none'}`,
    '',
    '## Instance Table',
    '| Name | Status | Brief | Chats | Access | Last Chat | Open | Mainland |',
    '| --- | --- | --- | ---: | ---: | --- | --- | --- |',
  ];

  for (const instance of Array.isArray(report.instances) ? report.instances : []) {
    const openCell = instance.bestAccessUrl ? `[open](${instance.bestAccessUrl})` : '—';
    const mainlandCell = instance.mainlandAccessUrl ? `[cn](${instance.mainlandAccessUrl})` : '—';
    lines.push(`| ${escapeMarkdownTableCell(instance.name)} | ${escapeMarkdownTableCell(instance.status)} | ${escapeMarkdownTableCell(instance.brief)} | ${escapeMarkdownTableCell(instance.sessionCount)} | ${escapeMarkdownTableCell(instance.authSessionCount)} | ${escapeMarkdownTableCell(formatCompactTimestamp(instance.lastSessionAt))} | ${openCell} | ${mainlandCell} |`);
  }

  return lines.join('\n');
}

function renderGuestInstanceReportCsv(report = {}) {
  const header = [
    'name',
    'status',
    'brief',
    'port',
    'sessionCount',
    'authSessionCount',
    'lastSessionAt',
    'createdAt',
    'localReachable',
    'publicReachable',
    'bestAccessUrl',
    'publicAccessUrl',
    'mainlandAccessUrl',
    'localAccessUrl',
  ];
  const rows = [header.join(',')];

  for (const instance of Array.isArray(report.instances) ? report.instances : []) {
    rows.push([
      instance.name,
      instance.status,
      instance.brief,
      instance.port,
      instance.sessionCount,
      instance.authSessionCount,
      trimString(instance.lastSessionAt),
      trimString(instance.createdAt),
      instance.localReachable === null ? '' : instance.localReachable,
      instance.publicReachable === null ? '' : instance.publicReachable,
      instance.bestAccessUrl,
      instance.publicAccessUrl,
      instance.mainlandAccessUrl,
      instance.localAccessUrl,
    ].map(escapeCsvValue).join(','));
  }

  return rows.join('\n');
}

function formatGuestInstanceReportResult(result = {}) {
  const lines = [
    buildGuestInstanceReportSummary(result.summary),
    `markdown: ${result.markdownPath}`,
    `csv: ${result.csvPath}`,
    `json: ${result.jsonPath}`,
  ];
  if (Array.isArray(result.summary?.topActiveNames) && result.summary.topActiveNames.length > 0) {
    lines.push(`top: ${result.summary.topActiveNames.slice(0, 5).join(', ')}`);
  }
  if (result.sent?.event?.seq) {
    lines.push(`sent: session ${trimString(result.sent?.session?.id)} event ${result.sent.event.seq}`);
  }
  return lines.join('\n');
}

async function sendGuestInstanceReport(result = {}, options = {}) {
  const { runAssistantMessageCommand } = await import('./assistant-message-command.mjs');
  const argv = [
    '--json',
    '--as-file',
    '--source', 'guest_instance_report',
    '--text', trimString(options.message) || buildGuestInstanceReportMessage(result.summary),
    '--file', result.markdownPath,
    '--file', result.csvPath,
  ];
  if (options.sendJson) {
    argv.push('--file', result.jsonPath);
  }
  if (trimString(options.sessionId)) {
    argv.push('--session', trimString(options.sessionId));
  }
  if (trimString(options.runId)) {
    argv.push('--run-id', trimString(options.runId));
  }
  if (trimString(options.baseUrl)) {
    argv.push('--base-url', trimString(options.baseUrl));
  }

  let output = '';
  const stdout = { write(chunk) { output += chunk; } };
  await runAssistantMessageCommand(argv, { stdout });
  return JSON.parse(output || '{}');
}

async function generateGuestInstanceReport(options = {}) {
  const normalizedName = sanitizeGuestInstanceName(options?.name);
  const nowMs = Date.now();
  const outputDir = resolve(trimString(options.outputDir) || join(HOME_DIR, '.remotelab', 'reports', 'guest-instance'));
  const discoveredLinks = await listGuestInstanceLinks(options);
  const instances = await Promise.all(discoveredLinks.map(async (record) => {
    const usageSnapshot = await readGuestUsageSnapshot(record);
    const snapshot = {
      ...record,
      ...usageSnapshot,
    };
    return {
      ...snapshot,
      bestAccessUrl: pickBestAccessUrl(snapshot),
      status: resolveGuestUsageStatus(snapshot, { nowMs }),
      brief: buildGuestUsageBrief(snapshot, { nowMs }),
    };
  }));

  instances.sort((left, right) => naturalCompare(left.name, right.name));
  const occupied = instances.filter((instance) => instance.sessionCount > 0).sort(compareGuestUsageRows);
  const opened = instances.filter((instance) => instance.status === 'opened');
  const empty = instances.filter((instance) => instance.status === 'empty');
  const stale = instances.filter((instance) => instance.status === 'stale');
  const summary = {
    totalCount: instances.length,
    occupiedCount: occupied.length,
    openedCount: opened.length,
    emptyCount: empty.length,
    staleCount: stale.length,
    topActiveNames: occupied.slice(0, 10).map((instance) => instance.name),
    emptyNames: empty.map((instance) => instance.name),
  };

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    scope: normalizedName || 'all',
    summary,
    instances,
  };

  await mkdir(outputDir, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'z');
  const baseName = `guest-instance-report-${report.scope}-${timestamp}`;
  const markdownPath = join(outputDir, `${baseName}.md`);
  const csvPath = join(outputDir, `${baseName}.csv`);
  const jsonPath = join(outputDir, `${baseName}.json`);

  await writeTextAtomic(markdownPath, `${renderGuestInstanceReportMarkdown(report)}\n`);
  await writeTextAtomic(csvPath, `${renderGuestInstanceReportCsv(report)}\n`);
  await writeTextAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const result = {
    ...report,
    markdownPath,
    csvPath,
    jsonPath,
    sent: null,
  };

  if (options.send) {
    result.sent = await sendGuestInstanceReport(result, options);
  }

  return result;
}

async function createGuestInstance(options) {
  if (process.platform !== 'darwin') {
    throw new Error('guest-instance create currently supports macOS launchd only');
  }

  const registry = await loadGuestRegistry();
  const isolatedAgents = await discoverIsolatedLaunchAgents();
  const name = resolveRequestedGuestName(options, { registry, isolatedAgents });
  if (!name) {
    throw new Error('create requires a guest instance name');
  }

  const existingNames = new Set(collectExistingGuestNames({ registry, isolatedAgents }));
  if (existingNames.has(name)) {
    throw new Error(`Guest instance already exists: ${name}`);
  }

  const cloudflaredContent = options.localOnly || !await pathExists(CLOUDFLARED_CONFIG_FILE)
    ? ''
    : await readFile(CLOUDFLARED_CONFIG_FILE, 'utf8');
  const port = chooseGuestPort(options, registry, cloudflaredContent, isolatedAgents);
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
  const ownerFileAssetEnvironment = await readOwnerFileAssetEnvironment();

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
      ...ownerFileAssetEnvironment,
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
    mailboxRoot: join(configDir, 'agent-mailbox'),
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
  const guestMailbox = provisionGuestMailbox(record);
  if (!guestMailbox) {
    warnings.push(`Guest mailbox provisioning skipped for ${name}; owner mailbox identity is not initialized.`);
  }
  if (record.hostname) {
    await ensureCloudflareHostname(record.hostname, record.port);
  }

  await saveGuestRegistry([...registry, record]);

  const mailboxProvisioning = await syncGuestMailboxProvisioning(record, {
    mailboxSync: options.mailboxSync,
  });
  if (mailboxProvisioning.status === 'unconfigured') {
    warnings.push('Mailbox not provisioned because the owner mailbox is not initialized.');
  }
  if (mailboxProvisioning.status === 'failed') {
    warnings.push(`Mailbox route sync failed for ${mailboxProvisioning.mailboxAddress}: ${mailboxProvisioning.detail}`);
  }

  let publicReachable = null;
  if (record.publicBaseUrl) {
    const publicHealth = await waitForBuildInfo(record.publicBaseUrl, { timeoutMs: 90000, intervalMs: 2500 });
    publicReachable = publicHealth?.ok === true;
    if (!publicReachable) {
      warnings.push(`Public hostname did not validate within timeout: ${record.hostname}`);
    }
  }

  const guestDefaults = await loadGuestInstanceDefaults();
  return attachDerivedAccess({
    ...record,
    mailboxAddress: mailboxProvisioning.mailboxAddress,
    mailboxRoutingStatus: mailboxProvisioning.status,
    mailboxRoutingDetail: mailboxProvisioning.detail,
    mailboxRouteModel: mailboxProvisioning.desiredRouteModel,
    mailboxRoutingOperations: mailboxProvisioning.operations,
    localReachable: true,
    publicReachable,
    token,
    warnings,
  }, {
    token,
    guestDefaults,
  });
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
  const ownerFileAssetEnvironment = await readOwnerFileAssetEnvironment();
  const matchingTargets = options.all
    ? targets
    : targets.filter((record) => record.name === sanitizeGuestInstanceName(options.name));

  if (!options.all && matchingTargets.length === 0) {
    throw new Error(`Isolated instance not found: ${sanitizeGuestInstanceName(options.name)}`);
  }

  const results = [];
  for (const target of matchingTargets) {
    const next = buildConvergedLaunchAgentSpec(target, { ownerFileAssetEnvironment });
    const drift = detectLaunchAgentConvergence(target, next);
    const configDir = trimString(next.environmentVariables?.REMOTELAB_INSTANCE_ROOT)
      ? join(trimString(next.environmentVariables.REMOTELAB_INSTANCE_ROOT), 'config')
      : '';
    const runtimeDefaults = configDir
      ? await syncGuestRuntimeDefaults(configDir, { dryRun: options.dryRun })
      : {
        changed: false,
        toolsChanged: false,
        selectionChanged: false,
        toolIds: [],
        selectedTool: '',
      };
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
      runtimeDefaultsChanged: runtimeDefaults.changed,
      runtimeToolsChanged: runtimeDefaults.toolsChanged,
      runtimeSelectionChanged: runtimeDefaults.selectionChanged,
      runtimeToolIds: runtimeDefaults.toolIds,
      runtimeSelectedTool: runtimeDefaults.selectedTool,
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

  if (options.command === 'links') {
    const result = await listGuestInstanceLinks(options);
    if (options.json) {
      const payload = sanitizeGuestInstanceName(options.name)
        ? (result[0] || null)
        : result;
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatGuestInstanceLinks(result, { check: options.check })}\n`);
    return 0;
  }

  if (options.command === 'report') {
    const result = await generateGuestInstanceReport(options);
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${formatGuestInstanceReportResult(result)}\n`);
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
  buildAccessUrl,
  buildMainlandBaseUrl,
  buildGuestMailboxAddress,
  formatGuestInstance,
  formatGuestInstanceLinks,
  parseArgs,
  pickNextTrialInstanceName,
  syncGuestMailboxProvisioning,
};

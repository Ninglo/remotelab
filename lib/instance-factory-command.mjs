import { execFile as execFileCallback } from 'child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const INSTANCE_FACTORY_ROOT = join(PROJECT_ROOT, 'automation', 'instance-factory');
const FEATURE_MAP_PATH = join(INSTANCE_FACTORY_ROOT, 'feature-map.json');
const SYSTEMD_TEMPLATE_ROOT = join(INSTANCE_FACTORY_ROOT, 'templates', 'systemd');
const SUPPORTED_COMMANDS = new Set(['provision-host', 'bootstrap-host', 'install-profile', 'validate-profile']);
const SUPPORTED_PROVIDERS = new Set(['digitalocean']);
const SUPPORTED_INGRESS = new Set(['cloudflare', 'cpolar']);
const DEFAULT_OUTPUT_FORMAT = 'text';
const DIGITALOCEAN_API_BASE_URL = 'https://api.digitalocean.com/v2';
const REQUIRED_HOST_MANIFEST_KEYS = [
  'host.provider',
  'host.hostname',
  'host.region',
  'host.repoCheckoutPath',
  'network.ownerDomain',
  'network.ingress.provider',
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMode(value, fallback = 'auto') {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') return normalized;
  return fallback;
}

function removeJsonComments(source) {
  let result = '';
  let inString = false;
  let stringQuote = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }

  return result;
}

export function parseEnvFileContent(source) {
  const env = {};
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command) {
  try {
    await execFileAsync('bash', ['-lc', 'command -v "$1" >/dev/null 2>&1', 'bash', command]);
    return true;
  } catch {
    return false;
  }
}

function getNestedValue(object, dottedKey) {
  return dottedKey.split('.').reduce((current, key) => current && current[key], object);
}

function validateManifestShape(manifest) {
  const missing = REQUIRED_HOST_MANIFEST_KEYS
    .filter((key) => !trimString(String(getNestedValue(manifest, key) ?? '')));
  if (missing.length > 0) {
    throw new Error(`Host manifest is missing required keys: ${missing.join(', ')}`);
  }
  const provider = trimString(manifest?.host?.provider).toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported provider "${manifest?.host?.provider}". v1 only supports: digitalocean`);
  }
  const ingressProvider = trimString(manifest?.network?.ingress?.provider).toLowerCase();
  if (!SUPPORTED_INGRESS.has(ingressProvider)) {
    throw new Error(`Unsupported ingress provider "${manifest?.network?.ingress?.provider}". v1 supports: cloudflare, cpolar`);
  }
}

async function loadJsoncFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(removeJsonComments(raw));
}

async function loadFeatureMap() {
  return loadJsoncFile(FEATURE_MAP_PATH);
}

async function loadManifest(filePath) {
  const manifest = await loadJsoncFile(filePath);
  validateManifestShape(manifest);
  return manifest;
}

async function loadInstallEnv(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return parseEnvFileContent(raw);
}

async function loadOptionalEnvFile(filePath) {
  if (!trimString(filePath)) return {};
  const raw = await readFile(filePath, 'utf8');
  return parseEnvFileContent(raw);
}

async function deriveRepoGitUrl(manifest) {
  const explicit = trimString(manifest?.host?.repoGitUrl);
  if (explicit) return explicit;
  try {
    const { stdout } = await execFileAsync('git', ['-C', PROJECT_ROOT, 'remote', 'get-url', 'origin']);
    const origin = trimString(stdout);
    if (origin) return origin;
  } catch {
    // ignore and fall back
  }
  return 'https://github.com/Ninglo/remotelab.git';
}

function defaultModeForFeature(feature, manifest, commandName = 'install-profile') {
  if (commandName === 'bootstrap-host') {
    if (feature.id === 'remotelab') return 'on';
    if (feature.kind === 'ingress') return 'auto';
    return 'off';
  }
  if (feature.id === 'remotelab') return 'on';
  if (feature.id === 'ingress.cloudflare') {
    return trimString(manifest?.network?.ingress?.provider).toLowerCase() === 'cloudflare' ? 'on' : 'off';
  }
  if (feature.id === 'ingress.cpolar') {
    return trimString(manifest?.network?.ingress?.provider).toLowerCase() === 'cpolar' ? 'on' : 'off';
  }
  return feature.defaultMode || 'auto';
}

function missingEnvKeys(requiredEnvKeys, installEnv) {
  return requiredEnvKeys.filter((key) => !trimString(installEnv[key]));
}

function buildOwnerPublicBaseUrl(manifest) {
  const ownerHostname = trimString(manifest?.network?.ingress?.ownerHostname || manifest?.network?.ownerDomain);
  return ownerHostname ? `https://${ownerHostname}` : '';
}

function buildManifestDerivedEnv(manifest) {
  return {
    REMOTELAB_HOSTNAME: trimString(manifest?.host?.hostname),
    REMOTELAB_PROVIDER: trimString(manifest?.host?.provider),
    REMOTELAB_REGION: trimString(manifest?.host?.region),
    REMOTELAB_OWNER_DOMAIN: trimString(manifest?.network?.ownerDomain),
    REMOTELAB_PUBLIC_BASE_URL: buildOwnerPublicBaseUrl(manifest),
    REMOTELAB_OWNER_PORT: String(manifest?.network?.listenPort || 7690),
    REMOTELAB_REPO_CHECKOUT_PATH: trimString(manifest?.host?.repoCheckoutPath || '/opt/remotelab'),
    REMOTELAB_SYSTEMD_OWNER_UNIT: trimString(manifest?.systemd?.ownerUnit || 'remotelab'),
  };
}

async function collectHostFacts(manifest) {
  const repoCheckoutPath = trimString(manifest?.host?.repoCheckoutPath || '/opt/remotelab');
  const ownerUnit = trimString(manifest?.systemd?.ownerUnit || 'remotelab');
  const ingressProvider = trimString(manifest?.network?.ingress?.provider).toLowerCase();
  const ingressUnit = trimString(manifest?.network?.ingress?.serviceUnit)
    || (ingressProvider === 'cloudflare' ? trimString(manifest?.network?.ingress?.serviceName || 'cloudflared-thelab') : 'cpolar');
  const commands = ['node', 'cloudflared', 'cpolar', 'systemctl'];
  const facts = {
    commands: {},
    files: {},
    services: {},
  };
  for (const command of commands) {
    facts.commands[command] = await commandExists(command);
  }
  const files = {
    repoCheckoutPath,
    chatServer: join(repoCheckoutPath, 'chat-server.mjs'),
    cloudflareCredentialsFile: trimString(manifest?.network?.ingress?.credentialsFile),
    cloudflareAuthFile: '/root/.config/remotelab/cloudflare-auth.json',
    googleCalendarCredentialsFile: trimString(manifest?.connectors?.calendar?.googleCredentialsFile),
    googleCalendarTokenFile: trimString(manifest?.connectors?.calendar?.googleTokenFile),
  };
  for (const [name, value] of Object.entries(files)) {
    if (!trimString(value)) {
      facts.files[name] = false;
      continue;
    }
    facts.files[name] = await pathExists(value);
  }

  if (facts.commands.systemctl) {
    for (const unit of [ownerUnit, ingressUnit, 'remotelab-agent-mail-http-bridge', 'remotelab-agent-mail-worker', 'remotelab-feishu-connector']) {
      if (!trimString(unit)) continue;
      try {
        await execFileAsync('systemctl', ['is-active', '--quiet', unit]);
        facts.services[unit] = 'active';
      } catch {
        facts.services[unit] = 'inactive';
      }
    }
  }

  return facts;
}

async function collectRemoteHostFacts(manifest, options) {
  const repoCheckoutPath = trimString(manifest?.host?.repoCheckoutPath || '/opt/remotelab');
  const ownerUnit = trimString(manifest?.systemd?.ownerUnit || 'remotelab');
  const ingressProvider = trimString(manifest?.network?.ingress?.provider).toLowerCase();
  const ingressUnit = trimString(manifest?.network?.ingress?.serviceUnit)
    || (ingressProvider === 'cloudflare' ? trimString(manifest?.network?.ingress?.serviceName || 'cloudflared-thelab') : 'cpolar');
  const remoteScript = `set -euo pipefail
for cmd in node cloudflared cpolar systemctl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "cmd:$cmd=1"
  else
    echo "cmd:$cmd=0"
  fi
done
for fileSpec in ${shellQuote(`repoCheckoutPath:${repoCheckoutPath}`)} ${shellQuote(`chatServer:${join(repoCheckoutPath, 'chat-server.mjs')}`)} ${shellQuote(`cloudflareCredentialsFile:${trimString(manifest?.network?.ingress?.credentialsFile)}`)} ${shellQuote(`cloudflareAuthFile:/root/.config/remotelab/cloudflare-auth.json`)} ${shellQuote(`googleCalendarCredentialsFile:${trimString(manifest?.connectors?.calendar?.googleCredentialsFile)}`)} ${shellQuote(`googleCalendarTokenFile:${trimString(manifest?.connectors?.calendar?.googleTokenFile)}`)}; do
  name="\${fileSpec%%:*}"
  path="\${fileSpec#*:}"
  if [ -n "$path" ] && [ -e "$path" ]; then
    echo "file:$name=1"
  else
    echo "file:$name=0"
  fi
done
for unit in ${shellQuote(ownerUnit)} ${shellQuote(ingressUnit)} remotelab-agent-mail-http-bridge remotelab-agent-mail-worker remotelab-feishu-connector; do
  if [ -n "$unit" ]; then
    if systemctl is-active --quiet "$unit"; then
      echo "svc:$unit=active"
    else
      echo "svc:$unit=inactive"
    fi
  fi
done`;
  const sshUser = trimString(options.sshUser || manifest?.host?.sshUser || 'root');
  const sshHost = trimString(options.sshHost);
  const { stdout } = await execFileAsync('ssh', [
    ...buildSshExecArgs(options),
    `${sshUser}@${sshHost}`,
    `bash -lc ${shellQuote(remoteScript)}`,
  ]);
  const facts = {
    commands: {},
    files: {},
    services: {},
  };
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(cmd|file|svc):([^=]+)=(.+)$/);
    if (!match) continue;
    const [, kind, key, value] = match;
    if (kind === 'cmd') facts.commands[key] = value === '1';
    if (kind === 'file') facts.files[key] = value === '1';
    if (kind === 'svc') facts.services[key] = value;
  }
  return facts;
}

async function inspectCurrentHost() {
  const facts = {
    host: {},
    commands: {},
    services: {},
    files: {},
  };
  try {
    const { stdout } = await execFileAsync('uname', ['-sr']);
    facts.host.kernel = trimString(stdout);
  } catch {
    facts.host.kernel = '';
  }
  try {
    const { stdout } = await execFileAsync('hostname', []);
    facts.host.hostname = trimString(stdout);
  } catch {
    facts.host.hostname = '';
  }
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', 'curl -fsS http://169.254.169.254/metadata/v1.json']);
    const metadata = JSON.parse(stdout);
    facts.host.digitalocean = {
      dropletId: metadata?.droplet_id ?? null,
      hostname: trimString(metadata?.hostname),
      region: trimString(metadata?.region),
      publicIPv4: trimString(metadata?.interfaces?.public?.[0]?.ipv4?.ip_address),
    };
  } catch {
    facts.host.digitalocean = null;
  }

  for (const command of ['node', 'cloudflared', 'cpolar', 'doctl', 'wrangler', 'tailscale', 'systemctl']) {
    facts.commands[command] = await commandExists(command);
  }
  for (const unit of [
    'remotelab',
    'remotelab-instance-admin',
    'remotelab-guest@.service',
    'cloudflared-thelab',
    'cpolar',
  ]) {
    if (!facts.commands.systemctl) {
      facts.services[unit] = 'unknown';
      continue;
    }
    try {
      await execFileAsync('systemctl', ['is-active', '--quiet', unit]);
      facts.services[unit] = 'active';
    } catch {
      facts.services[unit] = 'inactive';
    }
  }
  for (const [name, targetPath] of Object.entries({
    repoRoot: PROJECT_ROOT,
    ownerConfigRoot: '/root/.config/remotelab',
    cloudflareAuthFile: '/root/.config/remotelab/cloudflare-auth.json',
    cloudflaredUserConfig: '/root/.cloudflared/config.yml',
    cloudflaredSystemConfig: '/etc/cloudflared/config.yml',
    guestDefaults: '/root/.config/remotelab/guest-instance-defaults.json',
  })) {
    facts.files[name] = await pathExists(targetPath);
  }
  return facts;
}

function createState(value, reasons = [], source = 'derived') {
  return {
    value: Boolean(value),
    reasons: reasons.filter(Boolean),
    source,
  };
}

function resolveObservedUnit(feature, manifest) {
  if (feature.id === 'ingress.cloudflare') {
    return trimString(manifest?.network?.ingress?.serviceUnit)
      || trimString(manifest?.network?.ingress?.serviceName)
      || trimString(feature.systemdUnit || '');
  }
  if (feature.id === 'ingress.cpolar') {
    return trimString(feature.systemdUnit || 'cpolar');
  }
  return trimString(feature.systemdUnit || '');
}

function resolveCloudflareInputs(manifest, installEnv) {
  const ingress = manifest?.network?.ingress || {};
  const tunnelId = trimString(installEnv.CLOUDFLARE_TUNNEL_ID || ingress.tunnelId);
  const tunnelName = trimString(installEnv.CLOUDFLARE_TUNNEL_NAME || ingress.tunnelName);
  const credentialsFile = trimString(ingress.credentialsFile);
  const localCredentialsFile = trimString(ingress.localCredentialsFile);
  const apiToken = trimString(installEnv.CLOUDFLARE_API_TOKEN);
  const accountId = trimString(installEnv.CLOUDFLARE_ACCOUNT_ID);
  const hasExistingTunnelConvergeInputs = Boolean(tunnelId && tunnelName && credentialsFile);
  const hasApiProvisionInputs = Boolean(apiToken && accountId && tunnelId && tunnelName);
  return {
    tunnelId,
    tunnelName,
    credentialsFile,
    localCredentialsFile,
    apiToken,
    accountId,
    hasExistingTunnelConvergeInputs,
    hasApiProvisionInputs,
  };
}

function deriveFeatureState(feature, context) {
  const {
    manifest,
    installEnv,
    manifestEnv,
    hostFacts,
    resolvedById,
    commandName,
    options = {},
  } = context;
  const desiredMode = normalizeMode(installEnv[feature.modeKey], defaultModeForFeature(feature, manifest, commandName));
  let missingInputs = missingEnvKeys(feature.requiredEnv || [], installEnv);
  const dependencyIds = Array.isArray(feature.dependsOn) ? feature.dependsOn : [];
  const dependencyIssues = dependencyIds
    .map((dependencyId) => resolvedById.get(dependencyId))
    .filter((dependency) => dependency && dependency.states.runnable.value !== true)
    .map((dependency) => `${dependency.id} is not runnable`);
  const missingCommands = (feature.requiredCommands || []).filter((command) => !hostFacts.commands[command]);
  const missingFiles = [];

  if (feature.id === 'ingress.cloudflare') {
    const cloudflareInputs = resolveCloudflareInputs(manifest, installEnv);
    if (cloudflareInputs.hasExistingTunnelConvergeInputs || cloudflareInputs.hasApiProvisionInputs) {
      missingInputs = [];
    } else {
      missingInputs = [];
      if (!cloudflareInputs.tunnelId) missingInputs.push('CLOUDFLARE_TUNNEL_ID|network.ingress.tunnelId');
      if (!cloudflareInputs.tunnelName) missingInputs.push('CLOUDFLARE_TUNNEL_NAME|network.ingress.tunnelName');
      if (!cloudflareInputs.credentialsFile && !cloudflareInputs.apiToken) {
      missingInputs.push('network.ingress.credentialsFile or CLOUDFLARE_API_TOKEN');
      }
      if (!cloudflareInputs.credentialsFile && !cloudflareInputs.accountId) {
        missingInputs.push('CLOUDFLARE_ACCOUNT_ID');
      }
      if (
        cloudflareInputs.credentialsFile
        && !hostFacts.files.cloudflareCredentialsFile
        && !(commandName === 'install-profile' && options.execute && cloudflareInputs.localCredentialsFile)
      ) {
        missingFiles.push(cloudflareInputs.credentialsFile);
      }
    }
  }

  if (feature.repoCheckoutRequired) {
    const repoFilePath = join(manifestEnv.REMOTELAB_REPO_CHECKOUT_PATH || '/opt/remotelab', 'chat-server.mjs');
    if (!hostFacts.files.chatServer) {
      missingFiles.push(repoFilePath);
    }
  }
  for (const dottedPath of feature.requiredManifestPaths || []) {
    if (!trimString(String(getNestedValue(manifest, dottedPath) ?? ''))) {
      missingFiles.push(`manifest:${dottedPath}`);
    }
  }

  const installed = missingCommands.length === 0 && missingFiles.length === 0;
  const configured = missingInputs.length === 0;
  const enabled = desiredMode === 'on' || (desiredMode === 'auto' && configured);
  const runnable = enabled && installed && configured && dependencyIssues.length === 0;
  const observedUnit = resolveObservedUnit(feature, manifest);
  const observedServiceState = observedUnit ? hostFacts.services[observedUnit] : '';
  const started = observedServiceState ? observedServiceState === 'active' : false;
  const healthy = observedServiceState ? observedServiceState === 'active' && runnable : false;

  const blocking = [];
  const warnings = [];
  if (commandName !== 'bootstrap-host' && desiredMode === 'on' && missingInputs.length > 0) {
    blocking.push(`missing env: ${missingInputs.join(', ')}`);
  }
  if (desiredMode === 'on' && missingCommands.length > 0) {
    blocking.push(`missing commands: ${missingCommands.join(', ')}`);
  }
  if (desiredMode === 'on' && missingFiles.length > 0) {
    blocking.push(`missing files: ${missingFiles.join(', ')}`);
  }
  if (commandName !== 'bootstrap-host' && desiredMode === 'auto' && missingInputs.length > 0) {
    warnings.push(`auto skipped; missing env: ${missingInputs.join(', ')}`);
  }
  if (desiredMode === 'auto' && missingCommands.length > 0) {
    warnings.push(`auto skipped; missing commands: ${missingCommands.join(', ')}`);
  }
  if (dependencyIssues.length > 0 && enabled) {
    warnings.push(`dependency chain incomplete: ${dependencyIssues.join('; ')}`);
  }

  const stateSource = commandName === 'validate-profile' ? 'observed' : 'derived';
  return {
    id: feature.id,
    title: feature.title,
    kind: feature.kind,
    desiredMode,
    blocking,
    warnings,
    dependsOn: dependencyIds,
    startAfter: feature.startAfter || [],
    env: {
      modeKey: feature.modeKey,
      required: feature.requiredEnv || [],
      manifestDerived: feature.manifestEnv || [],
    },
    runtime: {
      systemdUnit: observedUnit || null,
      healthCheck: feature.healthCheck || null,
    },
    states: {
      installed: createState(installed, [
        missingCommands.length > 0 ? `missing commands: ${missingCommands.join(', ')}` : '',
        missingFiles.length > 0 ? `missing files: ${missingFiles.join(', ')}` : '',
      ], stateSource),
      configured: createState(configured, [
        missingInputs.length > 0 ? `missing env: ${missingInputs.join(', ')}` : '',
      ], stateSource),
      enabled: createState(enabled, [
        desiredMode === 'off' ? 'desired mode is off' : '',
        desiredMode === 'auto' && !configured ? 'auto disabled due to missing inputs' : '',
      ], stateSource),
      runnable: createState(runnable, [
        dependencyIssues.join('; '),
      ], stateSource),
      started: createState(started, [
        observedUnit && observedServiceState !== 'active' ? `${observedUnit} is not active` : (observedUnit ? '' : 'no dedicated service to observe'),
        commandName !== 'validate-profile' && !observedUnit ? 'runtime start not observed during planning' : '',
      ], observedUnit ? 'observed' : stateSource),
      healthy: createState(healthy, [
        observedUnit && observedServiceState !== 'active' ? `${observedUnit} health not observed` : '',
        !observedUnit && runnable ? 'health piggybacks on core runtime or later validation' : '',
      ], observedUnit ? 'observed' : stateSource),
    },
  };
}

export async function deriveProfilePlan({
  manifest,
  installEnv = {},
  commandName = 'install-profile',
  hostFacts: hostFactsOverride = null,
  options = {},
}) {
  const featureMap = await loadFeatureMap();
  const manifestEnv = buildManifestDerivedEnv(manifest);
  const hostFacts = hostFactsOverride || await collectHostFacts(manifest);
  const resolvedById = new Map();
  const modules = [];

  for (const feature of featureMap.modules || []) {
    const resolved = deriveFeatureState(feature, {
      manifest,
      installEnv,
      manifestEnv,
      hostFacts,
      resolvedById,
      commandName,
      options,
    });
    resolvedById.set(feature.id, resolved);
    modules.push(resolved);
  }

  const blockingModules = modules.filter((module) => module.blocking.length > 0);
  const enabledModules = modules.filter((module) => module.states.enabled.value);
  const degradedModules = enabledModules.filter((module) => !module.states.runnable.value || (!module.states.healthy.value && module.runtime.systemdUnit));
  const core = modules.find((module) => module.id === 'remotelab');
  const overallStatus = blockingModules.length > 0
    ? 'blocked'
    : (core?.states.runnable.value && degradedModules.length > 0 ? 'degraded' : 'ready');

  return {
    schemaVersion: 1,
    command: commandName,
    manifestSummary: {
      hostname: manifestEnv.REMOTELAB_HOSTNAME,
      provider: manifestEnv.REMOTELAB_PROVIDER,
      region: manifestEnv.REMOTELAB_REGION,
      ownerDomain: manifestEnv.REMOTELAB_OWNER_DOMAIN,
      repoCheckoutPath: manifestEnv.REMOTELAB_REPO_CHECKOUT_PATH,
      ingressProvider: trimString(manifest?.network?.ingress?.provider),
    },
    manifestEnv,
    orchestration: {
      startupOrder: [
        'remotelab',
        'connector.email',
        'worker.mailbox',
        'connector.feishu',
        'connector.calendar',
        'ingress.cloudflare',
        'ingress.cpolar',
      ],
      degradeRule: 'If remotelab is runnable but any enabled connector or sidecar is not runnable or healthy, overall status is degraded.',
      blockRule: 'If desired mode is on and required env, commands, files, or dependencies are missing, the profile is blocked.',
      autoRule: 'If desired mode is auto and prerequisites are incomplete, the module is skipped with warnings.',
    },
    modules,
    summary: {
      overallStatus,
      blockingModules: blockingModules.map((module) => ({ id: module.id, reasons: module.blocking })),
      degradedModules: degradedModules.map((module) => module.id),
      warnings: modules.flatMap((module) => module.warnings.map((warning) => `${module.id}: ${warning}`)),
    },
  };
}

function formatPlanText(plan) {
  const lines = [
    `command: ${plan.command}`,
    `host: ${plan.manifestSummary.hostname} (${plan.manifestSummary.provider}/${plan.manifestSummary.region})`,
    `ownerDomain: ${plan.manifestSummary.ownerDomain}`,
    `repoCheckoutPath: ${plan.manifestSummary.repoCheckoutPath}`,
    `ingress: ${plan.manifestSummary.ingressProvider}`,
    `overallStatus: ${plan.summary.overallStatus}`,
    '',
    'modules:',
  ];
  for (const module of plan.modules) {
    lines.push(
      `- ${module.id}: mode=${module.desiredMode} installed=${module.states.installed.value} configured=${module.states.configured.value} enabled=${module.states.enabled.value} runnable=${module.states.runnable.value} started=${module.states.started.value} healthy=${module.states.healthy.value}`,
    );
    if (module.blocking.length > 0) lines.push(`  blocking: ${module.blocking.join(' | ')}`);
    if (module.warnings.length > 0) lines.push(`  warnings: ${module.warnings.join(' | ')}`);
  }
  if (plan.summary.blockingModules.length > 0) {
    lines.push('', 'blockingModules:');
    for (const module of plan.summary.blockingModules) {
      lines.push(`- ${module.id}: ${module.reasons.join(' | ')}`);
    }
  }
  if (plan.summary.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of plan.summary.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(commandName, args) {
  const options = {
    commandName,
    manifestPath: '',
    envPath: '',
    providerEnvPath: '',
    sshHost: '',
    sshUser: '',
    sshPort: '',
    sshKeyPath: '',
    output: DEFAULT_OUTPUT_FORMAT,
    writePlan: '',
    renderDir: '',
    execute: false,
    wait: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--manifest':
        options.manifestPath = args[++index] || '';
        break;
      case '--env':
      case '--install-env':
        options.envPath = args[++index] || '';
        break;
      case '--provider-env':
        options.providerEnvPath = args[++index] || '';
        break;
      case '--ssh-host':
        options.sshHost = args[++index] || '';
        break;
      case '--ssh-user':
        options.sshUser = args[++index] || '';
        break;
      case '--ssh-port':
        options.sshPort = args[++index] || '';
        break;
      case '--ssh-key':
        options.sshKeyPath = args[++index] || '';
        break;
      case '--write-plan':
        options.writePlan = args[++index] || '';
        break;
      case '--render-dir':
        options.renderDir = args[++index] || '';
        break;
      case '--execute':
        options.execute = true;
        break;
      case '--wait':
        options.wait = true;
        break;
      case '--json':
        options.json = true;
        options.output = 'json';
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option for ${commandName}: ${arg}`);
    }
  }
  return options;
}

function printCommandHelp(commandName, stdout = process.stdout) {
  const envRequirement = commandName === 'bootstrap-host' ? '[optional]' : '[required for install/validate]';
  stdout.write([
    `Usage: remotelab ${commandName} --manifest <host.manifest.jsonc> ${commandName === 'bootstrap-host' ? '' : '--env <install.env> '}[options]`,
    '',
    'Options:',
    '  --manifest <path>     Path to host.manifest.jsonc',
    `  --env <path>          Path to install.env ${envRequirement}`,
    '  --provider-env <path> Path to provider env file (used by provision-host)',
    '  --ssh-host <host>     Remote SSH target host for bootstrap/install execution',
    '  --ssh-user <user>     Remote SSH user (defaults to manifest host.sshUser or root)',
    '  --ssh-port <port>     Remote SSH port',
    '  --ssh-key <path>      SSH private key for scp/ssh execution',
    '  --write-plan <path>   Write the resolved plan JSON to a file',
    '  --render-dir <path>   Render generated v1 scaffolding outputs into a directory',
    '  --execute             Execute provider provisioning when supported',
    '  --wait                Wait for provider host to reach active state when supported',
    '  --json                Print machine-readable JSON',
    '  --help                Show this help',
    '',
  ].join('\n'));
}

async function writePlanArtifact(plan, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

async function renderScaffolding(commandName, plan, renderDir) {
  const targetDir = resolve(renderDir);
  await mkdir(targetDir, { recursive: true });
  const artifacts = {
    plan: join(targetDir, `${commandName}.plan.json`),
    env: join(targetDir, 'derived-profile.env'),
    modules: join(targetDir, 'enabled-modules.txt'),
  };
  await writePlanArtifact(plan, artifacts.plan);
  const envBody = Object.entries(plan.manifestEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(artifacts.env, `${envBody}\n`, 'utf8');
  const enabledModules = plan.modules
    .filter((module) => module.states.enabled.value)
    .map((module) => module.id)
    .join('\n');
  await writeFile(artifacts.modules, `${enabledModules}\n`, 'utf8');
  return artifacts;
}

function renderTemplate(template, replacements = {}) {
  let output = String(template || '');
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  return output;
}

async function loadSystemdTemplate(fileName) {
  return readFile(join(SYSTEMD_TEMPLATE_ROOT, fileName), 'utf8');
}

function buildRemoteInstallProfileEnv(plan, installEnv) {
  return Object.entries({
    ...plan.manifestEnv,
    ...installEnv,
  }).map(([key, value]) => `${key}=${value}`).join('\n');
}

async function buildInstallProfileArtifacts(manifest, plan, installEnv, targetDir) {
  const repoCheckoutPath = plan.manifestEnv.REMOTELAB_REPO_CHECKOUT_PATH || '/opt/remotelab';
  const ingress = manifest?.network?.ingress || {};
  const ownerPublicBaseUrl = buildOwnerPublicBaseUrl(manifest);
  const artifacts = await renderScaffolding('install-profile', plan, targetDir);
  const installProfileEnvPath = join(targetDir, 'install-profile.env');
  await writeFile(installProfileEnvPath, `${buildRemoteInstallProfileEnv(plan, installEnv)}\n`, 'utf8');
  artifacts.installProfileEnv = installProfileEnvPath;

  const renderedServiceFiles = new Map();
  const unitTemplateByModuleId = new Map([
    ['remotelab', 'remotelab.service'],
    ['connector.email', 'agent-mail-http-bridge.service'],
    ['worker.mailbox', 'agent-mail-worker.service'],
    ['connector.feishu', 'feishu-connector.service'],
  ]);

  for (const module of plan.modules) {
    if (!module?.states.enabled.value) continue;
    const templateName = unitTemplateByModuleId.get(module.id);
    const systemdUnit = trimString(module.runtime.systemdUnit);
    if (!templateName || !systemdUnit) continue;
    const template = await loadSystemdTemplate(templateName);
    const unitFileName = `${systemdUnit}.service`;
    const unitPath = join(targetDir, unitFileName);
    await writeFile(unitPath, renderTemplate(template, { repoCheckoutPath }), 'utf8');
    renderedServiceFiles.set(unitFileName, unitPath);
    if (module.id === 'remotelab') {
      artifacts.ownerUnit = unitPath;
    }
  }
  const cloudflareModule = plan.modules.find((module) => module.id === 'ingress.cloudflare');
  if (cloudflareModule?.states.enabled.value) {
    const tunnelId = trimString(installEnv.CLOUDFLARE_TUNNEL_ID || ingress.tunnelId);
    const tunnelName = trimString(installEnv.CLOUDFLARE_TUNNEL_NAME || ingress.tunnelName || 'thelab');
    const serviceName = trimString(ingress.serviceName || ingress.serviceUnit || cloudflareModule.runtime.systemdUnit || 'cloudflared-thelab');
    const credentialsFile = trimString(ingress.credentialsFile || `/etc/cloudflared/${tunnelId || tunnelName}.json`);
    const ownerHostname = trimString(ingress.ownerHostname || manifest?.network?.ownerDomain);
    const listenPort = String(manifest?.network?.listenPort || 7690);
    const cloudflareConfigPath = join(targetDir, 'cloudflared-config.yml');
    await writeFile(cloudflareConfigPath, [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${credentialsFile}`,
      'ingress:',
      `  - hostname: ${ownerHostname}`,
      `    service: http://127.0.0.1:${listenPort}`,
      '  - service: http_status:404',
      '',
    ].join('\n'), 'utf8');
    artifacts.cloudflareConfig = cloudflareConfigPath;
    const cloudflareServicePath = join(targetDir, `${serviceName}.service`);
    const cloudflareTemplate = await loadSystemdTemplate('cloudflared.service');
    await writeFile(cloudflareServicePath, renderTemplate(cloudflareTemplate, { tunnelName }), 'utf8');
    artifacts.cloudflareService = cloudflareServicePath;
    renderedServiceFiles.set(`${serviceName}.service`, cloudflareServicePath);
    const localCredentialsFile = trimString(ingress.localCredentialsFile);
    if (localCredentialsFile) {
      artifacts.cloudflareCredentialsSource = localCredentialsFile;
      artifacts.cloudflareCredentialsTarget = credentialsFile;
      artifacts.cloudflareCredentialsFileName = basename(localCredentialsFile);
    }
  }
  artifacts.serviceFiles = Array.from(renderedServiceFiles.values());

  const orderedUnits = plan.orchestration.startupOrder
    .map((moduleId) => plan.modules.find((module) => module.id === moduleId))
    .filter((module) => module?.states.enabled.value && trimString(module.runtime.systemdUnit))
    .map((module) => `${trimString(module.runtime.systemdUnit)}.service`);
  const installScriptPath = join(targetDir, 'apply-install-profile.sh');
  const installCommands = Array.from(renderedServiceFiles.entries())
    .map(([unitFileName]) => `install -m 0644 ${unitFileName} /etc/systemd/system/${unitFileName}`)
    .join('\n');
  await writeFile(installScriptPath, `#!/usr/bin/env bash
set -euo pipefail

mkdir -p /etc/remotelab /etc/cloudflared
install -m 0644 install-profile.env /etc/remotelab/install-profile.env
${installCommands}
${artifacts.cloudflareConfig ? `${artifacts.cloudflareCredentialsSource ? `install -m 0600 ${shellQuote(artifacts.cloudflareCredentialsFileName)} ${shellQuote(artifacts.cloudflareCredentialsTarget)}
` : ''}install -m 0644 cloudflared-config.yml /etc/cloudflared/config.yml
` : ''}set -a
. /etc/remotelab/install-profile.env
set +a

OWNER_PUBLIC_BASE_URL=${shellQuote(ownerPublicBaseUrl)}
OWNER_AUTH_INFO="$(node --input-type=module <<'NODE'
import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

const configDir = (process.env.REMOTELAB_CONFIG_DIR || '').trim() || join(homedir(), '.config', 'remotelab');
const authFile = join(configDir, 'auth.json');
let auth = {};
try {
  auth = JSON.parse(await readFile(authFile, 'utf8')) || {};
} catch (error) {
  if (error?.code !== 'ENOENT') {
    auth = {};
  }
}
let status = 'existing';
let token = typeof auth.token === 'string' ? auth.token.trim() : '';
if (!/^[0-9a-f]{64}$/i.test(token)) {
  token = randomBytes(32).toString('hex');
  status = 'created';
}
auth.token = token;
await mkdir(dirname(authFile), { recursive: true });
await writeFile(authFile, \`\${JSON.stringify(auth, null, 2)}\\n\`, 'utf8');
process.stdout.write(\`\${status}\\n\${authFile}\\n\${token}\\n\`);
NODE
)"
OWNER_AUTH_STATUS="$(printf '%s\\n' "$OWNER_AUTH_INFO" | sed -n '1p')"
OWNER_AUTH_FILE="$(printf '%s\\n' "$OWNER_AUTH_INFO" | sed -n '2p')"
OWNER_TOKEN="$(printf '%s\\n' "$OWNER_AUTH_INFO" | sed -n '3p')"
printf 'REMOTELAB_OWNER_AUTH_STATUS=%s\\n' "$OWNER_AUTH_STATUS"
printf 'REMOTELAB_OWNER_AUTH_FILE=%s\\n' "$OWNER_AUTH_FILE"
if [ -n "$OWNER_PUBLIC_BASE_URL" ] && [ -n "$OWNER_TOKEN" ]; then
  printf 'REMOTELAB_OWNER_ACCESS_URL=%s/?token=%s\\n' "$OWNER_PUBLIC_BASE_URL" "$OWNER_TOKEN"
fi

systemctl daemon-reload
${orderedUnits.map((unit) => `systemctl enable ${shellQuote(unit.replace(/\.service$/, ''))}`).join('\n')}
${orderedUnits.map((unit) => `systemctl restart ${shellQuote(unit.replace(/\.service$/, ''))}`).join('\n')}
`, { encoding: 'utf8', mode: 0o755 });
  artifacts.applyScript = installScriptPath;
  return artifacts;
}

function buildScpArgs(options) {
  const args = [];
  if (trimString(options.sshPort)) {
    args.push('-P', trimString(options.sshPort));
  }
  if (trimString(options.sshKeyPath)) {
    args.push('-i', trimString(options.sshKeyPath));
  }
  args.push('-o', 'StrictHostKeyChecking=no');
  return args;
}

function buildSshExecArgs(options) {
  const args = [];
  if (trimString(options.sshPort)) {
    args.push('-p', trimString(options.sshPort));
  }
  if (trimString(options.sshKeyPath)) {
    args.push('-i', trimString(options.sshKeyPath));
  }
  args.push('-o', 'StrictHostKeyChecking=no');
  return args;
}

async function executeRemoteBootstrap(options, artifacts) {
  const sshUser = trimString(options.sshUser || 'root');
  const sshHost = trimString(options.sshHost);
  if (!sshHost) {
    throw new Error('bootstrap-host --execute requires --ssh-host');
  }
  const remoteScriptPath = '/root/bootstrap-host.sh';
  const scpArgs = [...buildScpArgs(options), artifacts.bootstrapScript, `${sshUser}@${sshHost}:${remoteScriptPath}`];
  await execFileAsync('scp', scpArgs);
  const sshArgs = [
    ...buildSshExecArgs(options),
    `${sshUser}@${sshHost}`,
    `bash ${shellQuote(remoteScriptPath)}`,
  ];
  await execFileAsync('ssh', sshArgs);
  return {
    host: sshHost,
    user: sshUser,
    remoteScriptPath,
  };
}

async function executeRemoteInstallProfile(options, artifacts) {
  const sshUser = trimString(options.sshUser || 'root');
  const sshHost = trimString(options.sshHost);
  if (!sshHost) {
    throw new Error('install-profile --execute requires --ssh-host');
  }
  const remoteDir = '/root/remotelab-install-profile';
  const scpArgs = buildScpArgs(options);
  const sshArgs = buildSshExecArgs(options);
  await execFileAsync('ssh', [...sshArgs, `${sshUser}@${sshHost}`, `mkdir -p ${shellQuote(remoteDir)}`]);
  const filesToCopy = [artifacts.installProfileEnv, artifacts.ownerUnit, artifacts.applyScript];
  for (const serviceFile of artifacts.serviceFiles || []) {
    if (!filesToCopy.includes(serviceFile)) filesToCopy.push(serviceFile);
  }
  if (artifacts.cloudflareConfig) filesToCopy.push(artifacts.cloudflareConfig);
  if (artifacts.cloudflareService) filesToCopy.push(artifacts.cloudflareService);
  if (artifacts.cloudflareCredentialsSource) filesToCopy.push(artifacts.cloudflareCredentialsSource);
  await execFileAsync('scp', [...scpArgs, ...filesToCopy, `${sshUser}@${sshHost}:${remoteDir}/`]);
  const { stdout } = await execFileAsync('ssh', [...sshArgs, `${sshUser}@${sshHost}`, `cd ${shellQuote(remoteDir)} && bash ./apply-install-profile.sh`]);
  const parsedOutput = parseExecutionAssignments(stdout);
  return {
    host: sshHost,
    user: sshUser,
    remoteDir,
    ownerAuthStatus: trimString(parsedOutput.assignments.REMOTELAB_OWNER_AUTH_STATUS) || null,
    ownerAuthFile: trimString(parsedOutput.assignments.REMOTELAB_OWNER_AUTH_FILE) || null,
    ownerAccessUrl: trimString(parsedOutput.assignments.REMOTELAB_OWNER_ACCESS_URL) || null,
    stdout: trimString(parsedOutput.stdout) || null,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll('\'', `'\\''`)}'`;
}

function parseExecutionAssignments(stdout) {
  const assignments = {};
  const remainingLines = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && match[1].startsWith('REMOTELAB_')) {
      assignments[match[1]] = match[2];
      continue;
    }
    if (trimString(rawLine)) remainingLines.push(rawLine);
  }
  return {
    assignments,
    stdout: remainingLines.join('\n'),
  };
}

function buildDigitalOceanDropletPayload(manifest) {
  const host = manifest?.host || {};
  const network = manifest?.network || {};
  const sshKeys = Array.isArray(host.sshKeys) ? host.sshKeys.filter(Boolean) : [];
  const tags = Array.isArray(host.tags) ? host.tags.filter(Boolean) : [];
  const payload = {
    name: trimString(host.hostname),
    region: trimString(host.region),
    size: trimString(host.size || 's-2vcpu-4gb'),
    image: trimString(host.image || 'ubuntu-24-04-x64'),
    monitoring: host.monitoring !== false,
  };
  if (sshKeys.length > 0) payload.ssh_keys = sshKeys;
  if (tags.length > 0) payload.tags = tags;
  if (trimString(host.vpcUuid)) payload.vpc_uuid = trimString(host.vpcUuid);
  if (trimString(host.projectId)) payload.project_id = trimString(host.projectId);
  if (trimString(host.userData)) payload.user_data = host.userData;
  if (network?.ipv6 === true) payload.ipv6 = true;
  if (host.backups === true) payload.backups = true;
  return payload;
}

async function buildBootstrapScript(manifest) {
  const repoCheckoutPath = trimString(manifest?.host?.repoCheckoutPath || '/opt/remotelab');
  const repoGitUrl = await deriveRepoGitUrl(manifest);
  const repoGitRef = trimString(manifest?.host?.repoGitRef || '');
  const ownerUnit = trimString(manifest?.systemd?.ownerUnit || 'remotelab');
  const logDir = trimString(manifest?.systemd?.logDir || '/var/log/remotelab');
  const ownerPort = String(manifest?.network?.listenPort || 7690);
  const ingressProvider = trimString(manifest?.network?.ingress?.provider).toLowerCase();
  return `#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if command -v cloud-init >/dev/null 2>&1; then
  cloud-init status --wait || true
fi

if command -v fuser >/dev/null 2>&1; then
  while fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
    || fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
    || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
    || fuser /var/cache/apt/archives/lock >/dev/null 2>&1; do
    sleep 5
  done
else
  while pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; do
    sleep 5
  done
fi

apt-get update
apt-get install -y curl git ca-certificates jq build-essential

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

${ingressProvider === 'cloudflare' ? `if ! command -v cloudflared >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${arch}.deb" -o /tmp/cloudflared.deb
  apt-get install -y /tmp/cloudflared.deb
fi
` : ''}

mkdir -p ${shellQuote(dirname(repoCheckoutPath))}
if [ ! -d ${shellQuote(repoCheckoutPath)} ]; then
  git clone ${shellQuote(repoGitUrl)} ${shellQuote(repoCheckoutPath)}
fi

if [ -d ${shellQuote(join(repoCheckoutPath, '.git'))} ]; then
  git -C ${shellQuote(repoCheckoutPath)} fetch --all --tags --prune
${repoGitRef ? `  git -C ${shellQuote(repoCheckoutPath)} checkout ${shellQuote(repoGitRef)}\n` : ''}fi

npm --prefix ${shellQuote(repoCheckoutPath)} install

mkdir -p /etc/remotelab ${shellQuote(logDir)}
cat >/etc/remotelab/remotelab.env <<'EOF'
REMOTELAB_PORT=${ownerPort}
REMOTELAB_INSTANCE_NAME=${trimString(manifest?.host?.hostname)}
REMOTELAB_SESSION_DISPATCH=on
EOF

cat >/etc/systemd/system/${ownerUnit}.service <<'EOF'
[Unit]
Description=RemoteLab Owner Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${repoCheckoutPath}
EnvironmentFile=/etc/remotelab/remotelab.env
ExecStart=/usr/bin/env node ${repoCheckoutPath}/chat-server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ${shellQuote(ownerUnit)}
`;
}

function buildBootstrapHandoff(manifest) {
  const hostname = trimString(manifest?.host?.hostname);
  const sshUser = trimString(manifest?.host?.sshUser || 'root');
  return [
    `scp bootstrap-host.sh ${sshUser}@${hostname}:/root/bootstrap-host.sh`,
    `ssh ${sshUser}@${hostname} 'bash /root/bootstrap-host.sh'`,
    `ssh ${sshUser}@${hostname} 'systemctl is-active ${trimString(manifest?.systemd?.ownerUnit || 'remotelab')}'`,
  ];
}

async function digitalOceanRequest(pathname, token, method = 'GET', body = null) {
  const response = await fetch(`${DIGITALOCEAN_API_BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json?.message || text || `DigitalOcean API request failed with status ${response.status}`;
    throw new Error(message);
  }
  return json;
}

async function waitForDigitalOceanDroplet(token, dropletId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await digitalOceanRequest(`/droplets/${dropletId}`, token);
    const droplet = response?.droplet || {};
    if (trimString(droplet.status) === 'active') {
      return droplet;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
  }
  throw new Error(`Timed out waiting for DigitalOcean droplet ${dropletId} to become active`);
}

function findDigitalOceanToken(providerEnv = {}) {
  return trimString(
    providerEnv.DIGITALOCEAN_ACCESS_TOKEN
    || providerEnv.DIGITALOCEAN_TOKEN
    || process.env.DIGITALOCEAN_ACCESS_TOKEN
    || process.env.DIGITALOCEAN_TOKEN,
  );
}

async function buildProvisionResult(manifest, options = {}) {
  const provider = trimString(manifest?.host?.provider).toLowerCase();
  const ingressProvider = trimString(manifest?.network?.ingress?.provider).toLowerCase();
  const payload = buildDigitalOceanDropletPayload(manifest);
  const providerEnv = await loadOptionalEnvFile(options.providerEnvPath);
  const token = findDigitalOceanToken(providerEnv);
  const result = {
    schemaVersion: 1,
    command: 'provision-host',
    supported: provider === 'digitalocean',
    provider,
    ingressProvider,
    executeRequested: Boolean(options.execute),
    waitedForActive: Boolean(options.execute && options.wait),
    providerEnvPath: trimString(options.providerEnvPath) || null,
    note: options.execute
      ? 'Creates the DigitalOcean Droplet when provider credentials are available.'
      : 'Dry-run plan. Re-run with --execute and a provider token to create the Droplet.',
    request: {
      endpoint: `${DIGITALOCEAN_API_BASE_URL}/droplets`,
      method: 'POST',
      body: payload,
    },
    plan: [
      `create droplet ${payload.name} in ${payload.region}`,
      `size=${payload.size}`,
      `image=${payload.image}`,
      `bootstrap via remotelab bootstrap-host`,
      `install profile via remotelab install-profile`,
      `validate via remotelab validate-profile`,
    ],
    bootstrap: {
      handoff: buildBootstrapHandoff(manifest),
    },
  };
  if (options.execute) {
    if (!token) {
      throw new Error('provision-host --execute requires DIGITALOCEAN_ACCESS_TOKEN or DIGITALOCEAN_TOKEN (via --provider-env or environment)');
    }
    const createResponse = await digitalOceanRequest('/droplets', token, 'POST', payload);
    let droplet = createResponse?.droplet || null;
    if (options.wait && droplet?.id) {
      droplet = await waitForDigitalOceanDroplet(token, droplet.id);
    }
    result.execution = {
      created: true,
      dropletId: droplet?.id ?? null,
      status: trimString(droplet?.status) || 'new',
      name: trimString(droplet?.name || payload.name),
      publicIPv4: trimString(droplet?.networks?.v4?.find((entry) => entry.type === 'public')?.ip_address),
    };
  }
  return result;
}

function formatProvisionText(result, manifest) {
  const lines = [
    `command: ${result.command}`,
    `host: ${trimString(manifest?.host?.hostname)} (${trimString(manifest?.host?.provider)}/${trimString(manifest?.host?.region)})`,
    `ownerDomain: ${trimString(manifest?.network?.ownerDomain)}`,
    `ingress: ${trimString(manifest?.network?.ingress?.provider)}`,
    `status: ${result.execution?.created ? result.execution.status : 'planned'}`,
    '',
    'plan:',
    ...result.plan.map((step) => `- ${step}`),
    '',
    'bootstrap handoff:',
    ...result.bootstrap.handoff.map((step) => `- ${step}`),
  ];
  if (result.execution?.dropletId) {
    lines.push('', `dropletId: ${result.execution.dropletId}`);
  }
  if (result.execution?.publicIPv4) {
    lines.push(`publicIPv4: ${result.execution.publicIPv4}`);
  }
  return `${lines.join('\n')}\n`;
}

async function renderProvisionArtifacts(result, renderDir) {
  const targetDir = resolve(renderDir);
  await mkdir(targetDir, { recursive: true });
  const artifacts = {
    request: join(targetDir, 'digitalocean-droplet-request.json'),
    handoff: join(targetDir, 'bootstrap-handoff.txt'),
  };
  await writeFile(artifacts.request, `${JSON.stringify(result.request, null, 2)}\n`, 'utf8');
  await writeFile(artifacts.handoff, `${result.bootstrap.handoff.join('\n')}\n`, 'utf8');
  return artifacts;
}

async function renderBootstrapArtifacts(manifest, plan, renderDir) {
  const targetDir = resolve(renderDir);
  await mkdir(targetDir, { recursive: true });
  const bootstrapScript = await buildBootstrapScript(manifest);
  const artifacts = await renderScaffolding('bootstrap-host', plan, targetDir);
  const scriptPath = join(targetDir, 'bootstrap-host.sh');
  await writeFile(scriptPath, bootstrapScript, { encoding: 'utf8', mode: 0o755 });
  return {
    ...artifacts,
    bootstrapScript: scriptPath,
  };
}

export async function inspectRemoteLabHost() {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    facts: await inspectCurrentHost(),
  };
}

export async function runInstanceFactoryCommand(commandName, args = []) {
  if (!SUPPORTED_COMMANDS.has(commandName)) {
    throw new Error(`Unsupported instance factory command: ${commandName}`);
  }
  const options = parseArgs(commandName, args);
  if (options.help) {
    printCommandHelp(commandName);
    return 0;
  }
  if (!options.manifestPath) {
    throw new Error(`${commandName} requires --manifest <host.manifest.jsonc>`);
  }
  const manifest = await loadManifest(resolve(options.manifestPath));

  if (commandName === 'provision-host') {
    const result = await buildProvisionResult(manifest, options);
    if (options.writePlan) {
      await writePlanArtifact(result, resolve(options.writePlan));
    }
    if (options.renderDir) {
      result.artifacts = await renderProvisionArtifacts(result, options.renderDir);
    }
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatProvisionText(result, manifest));
    return result.supported ? 0 : 1;
  }

  let installEnv = {};
  if (options.envPath) {
    installEnv = await loadInstallEnv(resolve(options.envPath));
  } else if (commandName !== 'bootstrap-host') {
    throw new Error(`${commandName} requires --env <install.env>`);
  }

  const hostFacts = trimString(options.sshHost)
    ? await collectRemoteHostFacts(manifest, {
      ...options,
      sshUser: trimString(options.sshUser || manifest?.host?.sshUser || 'root'),
    })
    : null;
  const plan = await deriveProfilePlan({ manifest, installEnv, commandName, hostFacts, options });
  if (options.writePlan) {
    await writePlanArtifact(plan, resolve(options.writePlan));
  }
  let artifacts = null;
  const renderDir = trimString(options.renderDir)
    || ((options.execute && (commandName === 'bootstrap-host' || commandName === 'install-profile'))
      ? await mkdtemp(join(tmpdir(), `remotelab-${commandName}-`))
      : '');
  if (renderDir) {
    if (commandName === 'bootstrap-host') {
      artifacts = await renderBootstrapArtifacts(manifest, plan, renderDir);
    } else if (commandName === 'install-profile') {
      artifacts = await buildInstallProfileArtifacts(manifest, plan, installEnv, renderDir);
    } else {
      artifacts = await renderScaffolding(commandName, plan, renderDir);
    }
  }
  let execution = null;
  if (options.execute && commandName === 'bootstrap-host') {
    execution = await executeRemoteBootstrap({
      ...options,
      sshUser: trimString(options.sshUser || manifest?.host?.sshUser || 'root'),
    }, artifacts || await renderBootstrapArtifacts(manifest, plan, await mkdtemp(join(tmpdir(), 'remotelab-bootstrap-host-'))));
  }
  if (options.execute && commandName === 'install-profile') {
    execution = await executeRemoteInstallProfile({
      ...options,
      sshUser: trimString(options.sshUser || manifest?.host?.sshUser || 'root'),
    }, artifacts || await buildInstallProfileArtifacts(manifest, plan, installEnv, await mkdtemp(join(tmpdir(), 'remotelab-install-profile-'))));
  }

  const output = {
    ...plan,
    artifacts,
    execution,
  };
  process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : formatPlanText(output));
  if (options.execute && (commandName === 'bootstrap-host' || commandName === 'install-profile')) {
    return execution ? 0 : 1;
  }
  return plan.summary.overallStatus === 'blocked' ? 1 : 0;
}

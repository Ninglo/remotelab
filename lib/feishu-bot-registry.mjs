import { execFile as execFileCallback } from 'child_process';
import { createHash } from 'crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);

const REGISTRY_VERSION = 1;
const DEFAULT_REGISTRY_FILENAME = 'feishu-bots.json';
const DEFAULT_BOTS_DIRECTORY = 'feishu-connectors';
const DEFAULT_CONFIG_DIRECTORY = join(homedir(), '.config', 'remotelab');
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIRECTORY, 'feishu-connector', 'config.json');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePid(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseConfigArgument(command) {
  const source = String(command || '');
  const match = source.match(/--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;}\]]+))/);
  return trimString(match?.[1] || match?.[2] || match?.[3]);
}

function parseSystemdEnvironment(value) {
  const entries = {};
  const source = String(value || '');
  const matcher = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of source.matchAll(matcher)) {
    entries[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return entries;
}

function systemdDefaultConfigPath(environment = {}, fallbackPath = DEFAULT_CONFIG_PATH) {
  const explicitPath = trimString(
    environment.REMOTELAB_FEISHU_CONFIG_PATH
      || environment.FEISHU_CONNECTOR_CONFIG_PATH,
  );
  if (explicitPath) return resolve(explicitPath);

  const configDir = trimString(environment.REMOTELAB_CONFIG_DIR);
  if (configDir) return join(resolve(configDir), 'feishu-connector', 'config.json');

  const home = trimString(environment.HOME);
  if (home) return join(resolve(home), '.config', 'remotelab', 'feishu-connector', 'config.json');
  return fallbackPath;
}

async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(pathname, fallback = null) {
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomically(pathname, value) {
  const directory = dirname(pathname);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(pathname)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, pathname);
}

function normalizeConfigPath(pathname) {
  const normalized = trimString(pathname);
  return normalized ? resolve(normalized) : '';
}

function sanitizeBotId(value) {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'bot';
}

function appIdFingerprint(appId) {
  const normalized = trimString(appId);
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function chooseBotId({
  config,
  configPath,
  defaultConfigPath,
  priorId,
  usedIds,
}) {
  let baseId = trimString(priorId)
    || trimString(config?.botId)
    || (configPath === defaultConfigPath ? 'default' : basename(dirname(configPath)));
  baseId = sanitizeBotId(baseId);
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) suffix += 1;
  const id = `${baseId}-${suffix}`;
  usedIds.add(id);
  return id;
}

export function parseFeishuConnectorProcessRows(raw, options = {}) {
  const defaultConfigPath = normalizeConfigPath(options.defaultConfigPath || DEFAULT_CONFIG_PATH);
  const facts = [];
  for (const rawLine of String(raw || '').split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (!/(?:^|\s)(?:\S*\/)?scripts\/feishu-connector\.mjs(?:\s|$)/.test(command)) continue;
    facts.push({
      kind: 'process',
      pid: parsePid(match[1]),
      command,
      configPath: normalizeConfigPath(parseConfigArgument(command) || defaultConfigPath),
    });
  }
  return facts;
}

export function parseFeishuSystemdShow(raw, options = {}) {
  const properties = {};
  for (const line of String(raw || '').split('\n')) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 1) continue;
    properties[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }

  const environment = parseSystemdEnvironment(properties.Environment);
  const defaultConfigPath = normalizeConfigPath(
    options.defaultConfigPath
      || systemdDefaultConfigPath(environment, DEFAULT_CONFIG_PATH),
  );
  return {
    kind: 'systemd',
    unit: trimString(properties.Id),
    activeState: trimString(properties.ActiveState) || 'unknown',
    subState: trimString(properties.SubState) || 'unknown',
    pid: parsePid(properties.MainPID),
    command: trimString(properties.ExecStart),
    configPath: normalizeConfigPath(
      parseConfigArgument(properties.ExecStart)
        || systemdDefaultConfigPath(environment, defaultConfigPath),
    ),
  };
}

async function collectProcessFacts(defaultConfigPath) {
  try {
    const { stdout } = await execFile('ps', ['-eo', 'pid=,args='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseFeishuConnectorProcessRows(stdout, { defaultConfigPath });
  } catch {
    return [];
  }
}

async function collectSystemdFacts(defaultConfigPath) {
  if (process.platform !== 'linux') return [];
  try {
    const listings = await Promise.allSettled([
      execFile('systemctl', [
        'list-units',
        '--type=service',
        '--all',
        '--plain',
        '--no-legend',
        '--no-pager',
      ], {
        maxBuffer: 4 * 1024 * 1024,
      }),
      execFile('systemctl', [
        'list-unit-files',
        '--type=service',
        '--no-legend',
        '--no-pager',
      ], {
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);
    const units = [...new Set(
      listings
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value.stdout.split('\n'))
        .map((line) => trimString(line).split(/\s+/, 1)[0])
        .filter((unit) => unit.endsWith('.service') && /feishu/i.test(unit)),
    )];
    const facts = [];
    for (const unit of units) {
      try {
        const result = await execFile('systemctl', [
          'show',
          unit,
          '--property=Id,ActiveState,SubState,MainPID,ExecStart,Environment',
          '--no-pager',
        ], {
          maxBuffer: 1024 * 1024,
        });
        const fact = parseFeishuSystemdShow(result.stdout, { defaultConfigPath });
        if (fact.unit && /scripts\/feishu-connector\.mjs/.test(fact.command)) {
          facts.push(fact);
        }
      } catch {
        // A unit can disappear between list-units and systemctl show.
      }
    }
    return facts;
  } catch {
    return [];
  }
}

async function collectStandardConfigPaths(botsRoot) {
  try {
    const entries = await readdir(botsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(botsRoot, entry.name, 'config.json'));
  } catch {
    return [];
  }
}

function buildRuntime(configPath, processFacts, systemdFacts) {
  const matchingSystemd = systemdFacts.filter((fact) => fact.configPath === configPath);
  const systemdPids = new Set(matchingSystemd.map((fact) => fact.pid).filter(Boolean));
  const matchingProcesses = processFacts.filter(
    (fact) => fact.configPath === configPath && !systemdPids.has(fact.pid),
  );
  const owners = [...matchingSystemd, ...matchingProcesses];

  if (owners.length > 1) {
    return {
      status: 'ambiguous',
      runtime: {
        kind: 'ambiguous',
        owners: owners.map((owner) => ({
          kind: owner.kind,
          ...(owner.unit ? { unit: owner.unit } : {}),
          ...(owner.pid ? { pid: owner.pid } : {}),
        })),
      },
      issues: ['multiple_runtime_owners'],
    };
  }

  if (matchingSystemd.length === 1) {
    const fact = matchingSystemd[0];
    const running = fact.activeState === 'active' && fact.pid > 0;
    return {
      status: running ? 'running' : 'stopped',
      runtime: {
        kind: 'systemd',
        unit: fact.unit,
        pid: fact.pid || null,
        activeState: fact.activeState,
        subState: fact.subState,
      },
      issues: [],
    };
  }

  if (matchingProcesses.length === 1) {
    return {
      status: 'running',
      runtime: {
        kind: 'process',
        pid: matchingProcesses[0].pid,
      },
      issues: [],
    };
  }

  return {
    status: 'configured',
    runtime: { kind: 'none', pid: null },
    issues: [],
  };
}

export async function discoverFeishuBots(options = {}) {
  const configDir = normalizeConfigPath(options.configDir || DEFAULT_CONFIG_DIRECTORY);
  const defaultConfigPath = normalizeConfigPath(
    options.defaultConfigPath || join(configDir, 'feishu-connector', 'config.json'),
  );
  const botsRoot = normalizeConfigPath(options.botsRoot || join(configDir, DEFAULT_BOTS_DIRECTORY));
  const registryPath = normalizeConfigPath(
    options.registryPath
      || process.env.REMOTELAB_FEISHU_BOT_REGISTRY_PATH
      || join(configDir, DEFAULT_REGISTRY_FILENAME),
  );
  const discoveredAt = trimString(options.discoveredAt) || new Date().toISOString();

  const previousRegistry = await readJsonIfExists(registryPath, { bots: [] });
  const previousBots = Array.isArray(previousRegistry?.bots) ? previousRegistry.bots : [];
  const priorByConfig = new Map(
    previousBots
      .filter((bot) => trimString(bot?.configPath))
      .map((bot) => [normalizeConfigPath(bot.configPath), bot]),
  );
  const processFacts = Array.isArray(options.processFacts)
    ? options.processFacts
    : await collectProcessFacts(defaultConfigPath);
  const systemdFacts = Array.isArray(options.systemdFacts)
    ? options.systemdFacts
    : await collectSystemdFacts(defaultConfigPath);

  const configPaths = new Set([
    ...priorByConfig.keys(),
    ...(Array.isArray(options.configPaths)
      ? options.configPaths.map((pathname) => normalizeConfigPath(pathname))
      : []),
    ...(await pathExists(defaultConfigPath) ? [defaultConfigPath] : []),
    ...(await collectStandardConfigPaths(botsRoot)),
    ...processFacts.map((fact) => normalizeConfigPath(fact.configPath)),
    ...systemdFacts.map((fact) => normalizeConfigPath(fact.configPath)),
  ].filter(Boolean));

  const usedIds = new Set();
  const bots = [];
  for (const configPath of [...configPaths].sort()) {
    const prior = priorByConfig.get(configPath);
    const exists = await pathExists(configPath);
    let config = null;
    let configError = '';
    if (exists) {
      try {
        config = JSON.parse(await readFile(configPath, 'utf8'));
      } catch (error) {
        configError = error?.message || 'invalid JSON';
      }
    }
    const runtimeState = buildRuntime(configPath, processFacts, systemdFacts);
    const issues = [...runtimeState.issues];
    if (!exists) issues.push('config_missing');
    if (configError) issues.push('config_invalid');

    bots.push({
      id: chooseBotId({
        config,
        configPath,
        defaultConfigPath,
        priorId: prior?.id,
        usedIds,
      }),
      configPath,
      storageDir: trimString(config?.storageDir) || dirname(configPath),
      appIdFingerprint: appIdFingerprint(config?.appId),
      region: trimString(config?.region) || '',
      chatBaseUrl: trimString(config?.chatBaseUrl) || '',
      status: issues.length > runtimeState.issues.length && runtimeState.status !== 'running'
        ? 'invalid'
        : runtimeState.status,
      runtime: runtimeState.runtime,
      issues,
      discoveredAt,
    });
  }

  const registry = {
    version: REGISTRY_VERSION,
    discoveredAt,
    registryPath,
    bots,
  };
  await writeJsonAtomically(registryPath, registry);
  return registry;
}

export function findFeishuBot(registry, idOrConfigPath) {
  const target = trimString(idOrConfigPath);
  if (!target) return null;
  const bots = Array.isArray(registry?.bots) ? registry.bots : [];
  const normalizedPath = target.includes('/') ? normalizeConfigPath(target) : '';
  return bots.find(
    (bot) => bot?.id === target
      || (normalizedPath && normalizeConfigPath(bot?.configPath) === normalizedPath),
  ) || null;
}

export function buildFeishuBotRestartPlan(bot, options = {}) {
  if (!bot) throw new Error('Feishu Bot is not registered');
  if (bot.status === 'ambiguous' || bot.runtime?.kind === 'ambiguous') {
    throw new Error(`Feishu Bot "${bot.id}" has an ambiguous runtime binding`);
  }
  if (bot.issues?.includes('config_missing') || bot.issues?.includes('config_invalid')) {
    throw new Error(`Feishu Bot "${bot.id}" does not have a valid config`);
  }
  if (bot.runtime?.kind === 'systemd' && trimString(bot.runtime.unit)) {
    return {
      kind: 'systemd',
      command: 'systemctl',
      args: ['restart', bot.runtime.unit],
    };
  }

  const helperPath = trimString(options.helperPath);
  if (!helperPath) throw new Error('Missing Feishu connector instance helper path');
  return {
    kind: 'process',
    command: helperPath,
    args: ['restart', '--config', bot.configPath],
  };
}

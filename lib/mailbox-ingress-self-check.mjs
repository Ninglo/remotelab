import { access, readFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RECENT_EVENT_WINDOW_DAYS = 14;
const TRIAL_RUNTIME_RE = /^trial\d*$/i;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMailboxName(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, fallbackValue = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

async function readJsonlFile(filePath) {
  try {
    return (await readFile(filePath, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function extractPublicHealthUrl(bridge = {}) {
  const publicWebhook = trimString(bridge?.publicWebhook);
  if (publicWebhook) {
    try {
      const url = new URL(publicWebhook);
      url.pathname = '/healthz';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // ignore and fall through
    }
  }
  const publicWebhookHost = trimString(bridge?.publicWebhookHost);
  if (!publicWebhookHost) return '';
  return `https://${publicWebhookHost}/healthz`;
}

function parseCloudflaredIngressConfig(source = '') {
  const result = {
    tunnelId: '',
    credentialsFile: '',
    hostnames: [],
  };
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!result.tunnelId && line.startsWith('tunnel:')) {
      result.tunnelId = trimString(line.slice('tunnel:'.length));
      continue;
    }
    if (!result.credentialsFile && line.startsWith('credentials-file:')) {
      result.credentialsFile = trimString(line.slice('credentials-file:'.length));
      continue;
    }
    if (line.startsWith('- hostname:')) {
      result.hostnames.push(trimString(line.slice('- hostname:'.length)));
      continue;
    }
    if (line.startsWith('hostname:')) {
      result.hostnames.push(trimString(line.slice('hostname:'.length)));
    }
  }
  result.hostnames = [...new Set(result.hostnames.filter(Boolean))];
  return result;
}

async function fetchJsonHealth(url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const normalizedUrl = trimString(url);
  if (!normalizedUrl) {
    return {
      status: 'skip',
      url: '',
      httpStatus: 0,
      ok: false,
      summary: 'health URL not configured',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(normalizedUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      status: response.ok ? 'pass' : 'fail',
      url: normalizedUrl,
      httpStatus: response.status,
      ok: response.ok,
      payload,
      summary: response.ok
        ? `health returned ${response.status}`
        : `health returned ${response.status}`,
    };
  } catch (error) {
    return {
      status: 'fail',
      url: normalizedUrl,
      httpStatus: 0,
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function collectSystemdServiceStates(unitNames = []) {
  const entries = {};
  for (const unit of unitNames.filter(Boolean)) {
    try {
      await execFileAsync('systemctl', ['is-active', '--quiet', unit]);
      entries[unit] = 'active';
    } catch {
      entries[unit] = 'inactive';
    }
  }
  return entries;
}

function summarizeHistoricRegistryDrift(events = [], registryNames = new Set(), {
  now = new Date(),
  recentWindowDays = DEFAULT_RECENT_EVENT_WINDOW_DAYS,
} = {}) {
  const cutoff = now.getTime() - (recentWindowDays * 24 * 60 * 60 * 1000);
  const byRuntime = new Map();

  for (const event of events) {
    if (trimString(event?.event) !== 'accepted_cloudflare_email_webhook') continue;
    const routedInstance = normalizeMailboxName(event?.routedInstance);
    if (!routedInstance) continue;
    if (TRIAL_RUNTIME_RE.test(routedInstance)) continue;
    const createdAt = trimString(event?.createdAt);
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs < cutoff) continue;
    const existing = byRuntime.get(routedInstance);
    if (!existing || createdAtMs > existing.createdAtMs) {
      byRuntime.set(routedInstance, {
        runtimeName: routedInstance,
        createdAt,
        createdAtMs,
        recipient: trimString(event?.mailboxItem?.to || event?.payload?.recipient),
        routeSource: trimString(event?.routeSource),
      });
    }
  }

  return [...byRuntime.values()]
    .filter((entry) => !registryNames.has(entry.runtimeName))
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
}

function finalizeOverallStatus(checks = []) {
  if (checks.some((check) => check.status === 'fail')) return 'blocked';
  if (checks.some((check) => check.status === 'warn')) return 'degraded';
  return 'ready';
}

export async function runMailboxIngressSelfCheck({
  configDir = join(homedir(), '.config', 'remotelab'),
  cloudflaredConfigPath = join(homedir(), '.cloudflared', 'agent-mailbox-config.yml'),
  localHealthUrl = 'http://127.0.0.1:7694/healthz',
  publicHealthUrl = '',
  fetchImpl = globalThis.fetch,
  serviceStates = null,
  now = new Date(),
  recentWindowDays = DEFAULT_RECENT_EVENT_WINDOW_DAYS,
} = {}) {
  const mailboxRoot = join(configDir, 'agent-mailbox');
  const bridgeFile = join(mailboxRoot, 'bridge.json');
  const bridgeEventsFile = join(mailboxRoot, 'bridge-events.jsonl');
  const registryFile = join(configDir, 'guest-instances.json');

  const bridge = await readJsonFile(bridgeFile, {}) || {};
  const registry = await readJsonFile(registryFile, []) || [];
  const bridgeEvents = await readJsonlFile(bridgeEventsFile);
  const cloudflaredConfigSource = await readFile(cloudflaredConfigPath, 'utf8').catch(() => '');
  const cloudflaredConfig = parseCloudflaredIngressConfig(cloudflaredConfigSource);
  const resolvedPublicHealthUrl = trimString(publicHealthUrl) || extractPublicHealthUrl(bridge);
  const resolvedServiceStates = serviceStates || await collectSystemdServiceStates([
    'cloudflared-agent-mailbox',
    'remotelab-agent-mail-bridge',
    'remotelab-agent-mail-worker',
  ]);
  const registryNames = new Set(
    Array.isArray(registry)
      ? registry.map((entry) => normalizeMailboxName(entry?.name)).filter(Boolean)
      : [],
  );
  const registryDrift = summarizeHistoricRegistryDrift(bridgeEvents, registryNames, {
    now,
    recentWindowDays,
  });

  const localHealth = await fetchJsonHealth(localHealthUrl, fetchImpl);
  const publicHealth = await fetchJsonHealth(resolvedPublicHealthUrl, fetchImpl);
  const credentialsFile = trimString(cloudflaredConfig.credentialsFile);
  const credentialsFileExists = credentialsFile ? await pathExists(credentialsFile) : false;

  const checks = [
    {
      id: 'mail-bridge-local-health',
      title: 'Local Mail Bridge',
      status: localHealth.status,
      summary: localHealth.summary,
      details: {
        url: localHealth.url,
        httpStatus: localHealth.httpStatus,
        payload: localHealth.payload || null,
      },
    },
    {
      id: 'mailhook-public-health',
      title: 'Public Mailhook',
      status: publicHealth.status,
      summary: publicHealth.summary,
      details: {
        url: publicHealth.url,
        httpStatus: publicHealth.httpStatus,
        payload: publicHealth.payload || null,
      },
    },
    {
      id: 'mailhook-tunnel-service',
      title: 'Mailhook Tunnel Service',
      status: trimString(resolvedServiceStates['cloudflared-agent-mailbox']) === 'active' ? 'pass' : 'fail',
      summary: trimString(resolvedServiceStates['cloudflared-agent-mailbox']) === 'active'
        ? 'cloudflared-agent-mailbox is active'
        : 'cloudflared-agent-mailbox is not active',
      details: {
        service: 'cloudflared-agent-mailbox',
        state: trimString(resolvedServiceStates['cloudflared-agent-mailbox']) || 'unknown',
      },
    },
    {
      id: 'mailhook-tunnel-credentials',
      title: 'Mailhook Tunnel Credentials',
      status: credentialsFile && credentialsFileExists ? 'pass' : 'fail',
      summary: credentialsFile
        ? (credentialsFileExists ? 'configured credentials file exists' : 'configured credentials file is missing')
        : 'credentials-file is not configured',
      details: {
        configPath: cloudflaredConfigPath,
        tunnelId: cloudflaredConfig.tunnelId,
        credentialsFile,
        configuredHostnames: cloudflaredConfig.hostnames,
      },
    },
  ];

  if (registryDrift.length > 0) {
    checks.push({
      id: 'mail-runtime-registry-drift',
      title: 'Mailbox Runtime Registry Drift',
      status: 'warn',
      summary: `recent mailhook traffic references ${registryDrift.length} runtime(s) missing from guest-instances.json`,
      details: {
        registryFile,
        missingRuntimes: registryDrift.map((entry) => ({
          runtimeName: entry.runtimeName,
          recipient: entry.recipient,
          routeSource: entry.routeSource,
          lastSeenAt: entry.createdAt,
        })),
      },
    });
  } else {
    checks.push({
      id: 'mail-runtime-registry-drift',
      title: 'Mailbox Runtime Registry Drift',
      status: 'pass',
      summary: 'recent mailhook traffic is represented in guest-instances.json',
      details: {
        registryFile,
        recentWindowDays,
      },
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    overallStatus: finalizeOverallStatus(checks),
    mailboxRoot,
    paths: {
      configDir,
      bridgeFile,
      bridgeEventsFile,
      registryFile,
      cloudflaredConfigPath,
    },
    checks,
  };
}

export function formatMailboxIngressSelfCheckText(result = {}) {
  const lines = [
    `overallStatus: ${trimString(result?.overallStatus) || 'unknown'}`,
    `generatedAt: ${trimString(result?.generatedAt) || ''}`,
    '',
    'checks:',
  ];
  for (const check of Array.isArray(result?.checks) ? result.checks : []) {
    lines.push(`- ${trimString(check.id)}: ${trimString(check.status)} — ${trimString(check.summary)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Instance-scoped connector capability registry.
 *
 * Connectors keep provider credentials in their own process and register a
 * loopback skill endpoint here. Runtime adapters can load this registry and
 * invoke only explicitly registered capabilities. Each connector channel has
 * one active registration; account-specific routing belongs to the connector.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

let registryPath = '';
let mutationTail = Promise.resolve();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChannel(value) {
  return trimString(value).toLowerCase();
}

function normalizeSkill(value = {}) {
  const name = trimString(value?.name);
  if (!name) return null;
  return {
    name,
    description: trimString(value?.description),
    schema: value?.schema && typeof value.schema === 'object' && !Array.isArray(value.schema)
      ? value.schema
      : {},
  };
}

function resolveRegistryPath(configDir = '') {
  const normalizedConfigDir = trimString(configDir);
  if (normalizedConfigDir) {
    registryPath = join(normalizedConfigDir, 'connector-skill-registry.json');
  }
  if (!registryPath) {
    throw new Error('Connector skill registry has not been initialized');
  }
  return registryPath;
}

async function loadRegistry() {
  const pathname = resolveRegistryPath();
  try {
    const parsed = JSON.parse(await readFile(pathname, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function persistRegistry(registry) {
  const pathname = resolveRegistryPath();
  await mkdir(dirname(pathname), { recursive: true });
  const temporaryPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, pathname);
  await chmod(pathname, 0o600).catch(() => {});
}

async function acquireRegistryLock() {
  const lockPath = `${resolveRegistryPath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30000) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await delay(25);
    }
  }
  throw new Error('Timed out waiting for connector skill registry lock');
}

async function mutateRegistry(mutator) {
  const operation = mutationTail.then(async () => {
    const releaseLock = await acquireRegistryLock();
    try {
      const registry = await loadRegistry();
      const result = await mutator(registry);
      if (result?.changed) {
        await persistRegistry(registry);
      }
      return result?.value;
    } finally {
      await releaseLock();
    }
  });
  mutationTail = operation.catch(() => {});
  return await operation;
}

function toolDefinitionsForRegistry(registry, channel) {
  const normalizedChannel = normalizeChannel(channel);
  const entry = registry?.[normalizedChannel];
  if (!entry || !Array.isArray(entry.skills)) return [];
  return entry.skills.map((skill) => ({
    name: `${normalizedChannel}:${skill.name}`,
    description: trimString(skill.description),
    parameters: skill.schema && typeof skill.schema === 'object' ? skill.schema : {},
    _source: { channel: normalizedChannel, skillName: skill.name },
  }));
}

function parseToolName(toolName) {
  const normalized = trimString(toolName);
  const colonIndex = normalized.indexOf(':');
  if (colonIndex <= 0 || colonIndex === normalized.length - 1) return null;
  return {
    channel: normalizeChannel(normalized.slice(0, colonIndex)),
    skillName: trimString(normalized.slice(colonIndex + 1)),
  };
}

function buildHealthUrl(skillUrl) {
  try {
    const parsed = new URL(trimString(skillUrl));
    parsed.pathname = '/healthz';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export async function initSkillRegistry(configDir) {
  resolveRegistryPath(configDir);
  return await loadRegistry();
}

export async function registerConnectorSkills(channel, registration = {}) {
  const normalizedChannel = normalizeChannel(channel);
  if (!normalizedChannel) throw new Error('connector channel is required');
  const skills = Array.isArray(registration?.skills)
    ? registration.skills.map(normalizeSkill).filter(Boolean)
    : [];

  return await mutateRegistry(async (registry) => {
    if (skills.length === 0) {
      if (!registry[normalizedChannel]) return { changed: false, value: [] };
      delete registry[normalizedChannel];
      return { changed: true, value: [] };
    }

    const skillUrl = trimString(registration?.callback?.skillUrl).replace(/\/+$/, '');
    const token = trimString(registration?.callback?.token);
    if (!skillUrl || !token) {
      throw new Error('connector registration requires callback.skillUrl and callback.token');
    }

    registry[normalizedChannel] = {
      skillUrl,
      token,
      skills,
      updatedAt: new Date().toISOString(),
    };
    return {
      changed: true,
      value: toolDefinitionsForRegistry(registry, normalizedChannel),
    };
  });
}

export async function deregisterConnectorSkills(channel, options = {}) {
  const normalizedChannel = normalizeChannel(channel);
  if (!normalizedChannel) return false;
  return await mutateRegistry(async (registry) => {
    const existing = registry[normalizedChannel];
    if (!existing) return { changed: false, value: false };

    const expectedSkillUrl = trimString(options?.skillUrl).replace(/\/+$/, '');
    if (expectedSkillUrl && trimString(existing.skillUrl).replace(/\/+$/, '') !== expectedSkillUrl) {
      return { changed: false, value: false };
    }
    delete registry[normalizedChannel];
    return { changed: true, value: true };
  });
}

export async function getToolDefinitions(channel) {
  return toolDefinitionsForRegistry(await loadRegistry(), channel);
}

export async function getAllToolDefinitions() {
  const registry = await loadRegistry();
  return Object.keys(registry).flatMap((channel) => toolDefinitionsForRegistry(registry, channel));
}

export async function getRegisteredChannels() {
  return Object.keys(await loadRegistry());
}

export async function isConnectorSkillReady(toolName, options = {}) {
  const parsed = parseToolName(toolName);
  if (!parsed) return false;
  const registry = await loadRegistry();
  const entry = registry[parsed.channel];
  if (!entry?.skills?.some((skill) => skill.name === parsed.skillName)) return false;
  const healthUrl = buildHealthUrl(entry.skillUrl);
  if (!healthUrl) return false;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(Number.isInteger(options.timeoutMs) ? options.timeoutMs : 750),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return body?.ok === true
      && (!Array.isArray(body.skills) || body.skills.includes(parsed.skillName));
  } catch {
    return false;
  }
}

export async function executeConnectorSkill(toolName, parameters, context = {}) {
  const parsed = parseToolName(toolName);
  if (!parsed) {
    return {
      success: false,
      error: 'invalid_tool_name',
      message: `Expected format "channel:skill", got "${toolName}"`,
    };
  }

  const registry = await loadRegistry();
  const entry = registry[parsed.channel];
  if (!entry) {
    return { success: false, error: 'channel_not_registered', channel: parsed.channel };
  }
  const skill = Array.isArray(entry.skills)
    ? entry.skills.find((candidate) => candidate.name === parsed.skillName)
    : null;
  if (!skill) {
    return {
      success: false,
      error: 'skill_not_found',
      channel: parsed.channel,
      skill: parsed.skillName,
      available: Array.isArray(entry.skills) ? entry.skills.map((candidate) => candidate.name) : [],
    };
  }

  try {
    const response = await fetch(`${trimString(entry.skillUrl).replace(/\/+$/, '')}/${encodeURIComponent(parsed.skillName)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify({
        instanceId: trimString(context.instanceId) || 'default',
        sessionId: trimString(context.sessionId),
        parameters: parameters && typeof parameters === 'object' ? parameters : {},
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        error: body.error || 'connector_error',
        message: body.message || `HTTP ${response.status}`,
        status: response.status,
        ...(body.details ? { details: body.details } : {}),
      };
    }
    return body;
  } catch (error) {
    return { success: false, error: 'network_error', message: error.message };
  }
}

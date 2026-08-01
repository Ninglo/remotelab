/**
 * Instance-scoped connector capability registry.
 *
 * Connectors keep provider credentials in their own process and register a
 * loopback skill endpoint here. Agent-facing commands load this registry and
 * invoke only explicitly registered capabilities. Multiple connector routes
 * can coexist under one channel without sharing credentials.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_SOURCE_ROUTE_ID = 'default';

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

function normalizeSourceRouteId(value) {
  return trimString(value) || DEFAULT_SOURCE_ROUTE_ID;
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

function normalizeRegistration(value = {}, sourceRouteId = '') {
  const skillUrl = trimString(value?.skillUrl).replace(/\/+$/, '');
  const token = trimString(value?.token);
  const skills = Array.isArray(value?.skills)
    ? value.skills.map(normalizeSkill).filter(Boolean)
    : [];
  if (!skillUrl || !token || skills.length === 0) return null;
  return {
    sourceRouteId: normalizeSourceRouteId(value?.sourceRouteId || sourceRouteId),
    skillUrl,
    token,
    skills,
    updatedAt: trimString(value?.updatedAt),
  };
}

function registrationsForEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  if (entry.registrations && typeof entry.registrations === 'object' && !Array.isArray(entry.registrations)) {
    return Object.fromEntries(Object.entries(entry.registrations)
      .map(([sourceRouteId, registration]) => {
        const normalized = normalizeRegistration(registration, sourceRouteId);
        return normalized ? [normalized.sourceRouteId, normalized] : null;
      })
      .filter(Boolean));
  }

  const legacy = normalizeRegistration(entry, entry.sourceRouteId);
  return legacy ? { [legacy.sourceRouteId]: legacy } : {};
}

function canonicalEntry(registrations) {
  return { registrations };
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
  const registrations = registrationsForEntry(registry?.[normalizedChannel]);
  const skillsByName = new Map();
  for (const registration of Object.values(registrations)) {
    for (const skill of registration.skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  return [...skillsByName.values()].map((skill) => ({
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

function selectRegistration(registrations, sourceRouteId) {
  const requestedRoute = trimString(sourceRouteId);
  if (requestedRoute) {
    return registrations[requestedRoute] || null;
  }
  const available = Object.values(registrations);
  return available.length === 1 ? available[0] : null;
}

export async function initSkillRegistry(configDir) {
  resolveRegistryPath(configDir);
  return await loadRegistry();
}

export async function registerConnectorSkills(channel, registration = {}) {
  const normalizedChannel = normalizeChannel(channel);
  if (!normalizedChannel) throw new Error('connector channel is required');
  const explicitSourceRouteId = trimString(registration?.sourceRouteId);
  const sourceRouteId = normalizeSourceRouteId(explicitSourceRouteId);
  const skills = Array.isArray(registration?.skills)
    ? registration.skills.map(normalizeSkill).filter(Boolean)
    : [];

  return await mutateRegistry(async (registry) => {
    if (skills.length === 0) {
      if (!registry[normalizedChannel]) return { changed: false, value: [] };
      if (!explicitSourceRouteId) {
        delete registry[normalizedChannel];
        return { changed: true, value: [] };
      }
      const registrations = registrationsForEntry(registry[normalizedChannel]);
      if (!registrations[sourceRouteId]) return { changed: false, value: [] };
      delete registrations[sourceRouteId];
      if (Object.keys(registrations).length === 0) delete registry[normalizedChannel];
      else registry[normalizedChannel] = canonicalEntry(registrations);
      return { changed: true, value: toolDefinitionsForRegistry(registry, normalizedChannel) };
    }

    const skillUrl = trimString(registration?.callback?.skillUrl).replace(/\/+$/, '');
    const token = trimString(registration?.callback?.token);
    if (!skillUrl || !token) {
      throw new Error('connector registration requires callback.skillUrl and callback.token');
    }

    const existingEntry = registry[normalizedChannel];
    const registrations = existingEntry?.registrations
      ? registrationsForEntry(existingEntry)
      : {};
    registrations[sourceRouteId] = {
      sourceRouteId,
      skillUrl,
      token,
      skills,
      updatedAt: new Date().toISOString(),
    };
    registry[normalizedChannel] = canonicalEntry(registrations);
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

    const explicitSourceRouteId = trimString(options?.sourceRouteId);
    const expectedSkillUrl = trimString(options?.skillUrl).replace(/\/+$/, '');
    if (!explicitSourceRouteId && !expectedSkillUrl) {
      delete registry[normalizedChannel];
      return { changed: true, value: true };
    }

    const registrations = registrationsForEntry(existing);
    const matchingRoutes = explicitSourceRouteId
      ? [explicitSourceRouteId]
      : Object.entries(registrations)
        .filter(([, registration]) => registration.skillUrl === expectedSkillUrl)
        .map(([sourceRouteId]) => sourceRouteId);
    let changed = false;
    for (const sourceRouteId of matchingRoutes) {
      const registration = registrations[sourceRouteId];
      if (!registration) continue;
      if (expectedSkillUrl && registration.skillUrl !== expectedSkillUrl) continue;
      delete registrations[sourceRouteId];
      changed = true;
    }
    if (!changed) return { changed: false, value: false };
    if (Object.keys(registrations).length === 0) delete registry[normalizedChannel];
    else registry[normalizedChannel] = canonicalEntry(registrations);
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
  const registrations = registrationsForEntry(registry[parsed.channel]);
  const sourceRouteId = trimString(options?.sourceRouteId);
  const candidates = sourceRouteId
    ? [registrations[sourceRouteId]].filter(Boolean)
    : Object.values(registrations);
  for (const registration of candidates) {
    if (!registration.skills.some((skill) => skill.name === parsed.skillName)) continue;
    const healthUrl = buildHealthUrl(registration.skillUrl);
    if (!healthUrl) continue;
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(Number.isInteger(options.timeoutMs) ? options.timeoutMs : 750),
      });
      if (!response.ok) continue;
      const body = await response.json().catch(() => ({}));
      if (body?.ok === true && (!Array.isArray(body.skills) || body.skills.includes(parsed.skillName))) {
        return true;
      }
    } catch {
    }
  }
  return false;
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
  const channelEntry = registry[parsed.channel];
  if (!channelEntry) {
    return { success: false, error: 'channel_not_registered', channel: parsed.channel };
  }
  const registrations = registrationsForEntry(channelEntry);
  const sourceRouteId = trimString(context?.sourceRouteId);
  const entry = selectRegistration(registrations, sourceRouteId);
  if (!entry) {
    if (sourceRouteId) {
      return {
        success: false,
        error: 'source_route_not_registered',
        channel: parsed.channel,
        sourceRouteId,
      };
    }
    return {
      success: false,
      error: 'source_route_required',
      channel: parsed.channel,
      routes: Object.keys(registrations).length,
    };
  }
  const skill = entry.skills.find((candidate) => candidate.name === parsed.skillName);
  if (!skill) {
    return {
      success: false,
      error: 'skill_not_found',
      channel: parsed.channel,
      skill: parsed.skillName,
      available: entry.skills.map((candidate) => candidate.name),
    };
  }

  try {
    const response = await fetch(`${entry.skillUrl}/${encodeURIComponent(parsed.skillName)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify({
        instanceId: trimString(context.instanceId) || 'default',
        sessionId: trimString(context.sessionId),
        sourceRouteId: entry.sourceRouteId,
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

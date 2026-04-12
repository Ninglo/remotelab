import { randomBytes } from 'crypto';

import { CHAT_LOCAL_BRIDGE_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_ONLINE_WINDOW_MS = 60 * 1000;
const COMMAND_STALE_AFTER_MS = 2 * 60 * 1000;
const runLocalBridgeMutation = createSerialTaskQueue();

let localBridgeCache = null;
let localBridgeCacheMtimeMs = null;

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseIsoMs(value) {
  const parsed = Date.parse(trimString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAllowedRoots(input) {
  if (!input || typeof input !== 'object') return [];
  const entries = Array.isArray(input)
    ? input
      .map((entry) => ({
        alias: trimString(entry?.alias),
        path: trimString(entry?.path),
      }))
    : Object.entries(input).map(([alias, path]) => ({
      alias: trimString(alias),
      path: trimString(path),
    }));
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry.alias || !entry.path) return false;
    if (seen.has(entry.alias)) return false;
    seen.add(entry.alias);
    return true;
  });
}

function normalizeState(state) {
  const normalized = state && typeof state === 'object' && !Array.isArray(state)
    ? { ...state }
    : {};
  const pairingCodes = Array.isArray(normalized.pairingCodes) ? normalized.pairingCodes : [];
  const bootstrapTokens = Array.isArray(normalized.bootstrapTokens) ? normalized.bootstrapTokens : [];
  const devices = Array.isArray(normalized.devices) ? normalized.devices : [];
  const commands = Array.isArray(normalized.commands) ? normalized.commands : [];
  return {
    pairingCodes: pairingCodes.map((entry) => ({
      id: trimString(entry?.id),
      code: trimString(entry?.code),
      sessionId: trimString(entry?.sessionId),
      createdAt: trimString(entry?.createdAt),
      expiresAt: trimString(entry?.expiresAt),
      usedAt: trimString(entry?.usedAt),
      deviceId: trimString(entry?.deviceId),
    })).filter((entry) => entry.id && entry.code && entry.sessionId),
    bootstrapTokens: bootstrapTokens.map((entry) => ({
      id: trimString(entry?.id),
      token: trimString(entry?.token),
      sessionId: trimString(entry?.sessionId),
      createdAt: trimString(entry?.createdAt),
      expiresAt: trimString(entry?.expiresAt),
      usedAt: trimString(entry?.usedAt),
      deviceId: trimString(entry?.deviceId),
      allowedRoots: normalizeAllowedRoots(entry?.allowedRoots),
    })).filter((entry) => entry.id && entry.token && entry.sessionId),
    devices: devices.map((entry) => ({
      id: trimString(entry?.id),
      token: trimString(entry?.token),
      sessionId: trimString(entry?.sessionId),
      createdAt: trimString(entry?.createdAt),
      lastSeenAt: trimString(entry?.lastSeenAt),
      platform: trimString(entry?.platform),
      deviceName: trimString(entry?.deviceName),
      helperVersion: trimString(entry?.helperVersion),
      allowedRoots: normalizeAllowedRoots(entry?.allowedRoots),
    })).filter((entry) => entry.id && entry.token && entry.sessionId),
    commands: commands.map((entry) => ({
      id: trimString(entry?.id),
      sessionId: trimString(entry?.sessionId),
      deviceId: trimString(entry?.deviceId),
      name: trimString(entry?.name),
      state: trimString(entry?.state) || 'queued',
      createdAt: trimString(entry?.createdAt),
      claimedAt: trimString(entry?.claimedAt),
      completedAt: trimString(entry?.completedAt),
      stageAssetId: trimString(entry?.stageAssetId),
      args: entry?.args && typeof entry.args === 'object' && !Array.isArray(entry.args) ? entry.args : {},
      result: entry?.result && typeof entry.result === 'object' ? entry.result : null,
      error: trimString(entry?.error),
    })).filter((entry) => entry.id && entry.sessionId && entry.deviceId && entry.name),
  };
}

function isDeviceOnline(device, nowMs = Date.now()) {
  const lastSeenAtMs = parseIsoMs(device?.lastSeenAt);
  return lastSeenAtMs > 0 && (nowMs - lastSeenAtMs) <= DEVICE_ONLINE_WINDOW_MS;
}

function failStaleInProgressCommands(draft, deviceId, nowMs = Date.now()) {
  const device = draft.devices.find((entry) => entry.id === deviceId);
  if (isDeviceOnline(device, nowMs)) return [];

  const referenceLastSeenAtMs = parseIsoMs(device?.lastSeenAt);
  const completedAt = nowIso();
  const failed = [];
  for (const command of draft.commands) {
    if (command.deviceId !== deviceId || command.state !== 'in_progress') continue;
    const claimedAtMs = parseIsoMs(command.claimedAt) || parseIsoMs(command.createdAt);
    const referenceMs = Math.max(claimedAtMs, referenceLastSeenAtMs);
    if (!referenceMs || (nowMs - referenceMs) < COMMAND_STALE_AFTER_MS) continue;
    command.state = 'failed';
    command.completedAt = completedAt;
    command.error = 'Local helper went offline before completing the command';
    failed.push(command);
  }
  return failed;
}

async function saveStateUnlocked(state) {
  const normalized = normalizeState(state);
  await writeJsonAtomic(CHAT_LOCAL_BRIDGE_FILE, normalized);
  localBridgeCache = normalized;
  localBridgeCacheMtimeMs = (await statOrNull(CHAT_LOCAL_BRIDGE_FILE))?.mtimeMs ?? null;
  return normalized;
}

export async function loadLocalBridgeState() {
  const stats = await statOrNull(CHAT_LOCAL_BRIDGE_FILE);
  if (!stats) {
    localBridgeCache = normalizeState(null);
    localBridgeCacheMtimeMs = null;
    return localBridgeCache;
  }
  const mtimeMs = stats.mtimeMs;
  if (localBridgeCache && localBridgeCacheMtimeMs === mtimeMs) {
    return localBridgeCache;
  }
  localBridgeCache = normalizeState(await readJson(CHAT_LOCAL_BRIDGE_FILE, null));
  localBridgeCacheMtimeMs = mtimeMs;
  return localBridgeCache;
}

async function mutateState(mutator) {
  return runLocalBridgeMutation(async () => {
    const current = await loadLocalBridgeState();
    const draft = normalizeState(current);
    const result = await mutator(draft);
    const saved = await saveStateUnlocked(draft);
    return { state: saved, result };
  });
}

function createId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export async function createLocalBridgePairingCode(sessionId) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) throw new Error('sessionId is required');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  const pairing = {
    id: createId('lpair'),
    code: randomBytes(4).toString('hex'),
    sessionId: normalizedSessionId,
    createdAt,
    expiresAt,
    usedAt: '',
    deviceId: '',
  };
  await mutateState((draft) => {
    draft.pairingCodes = draft.pairingCodes.filter((entry) => Date.parse(entry.expiresAt || 0) > Date.now());
    draft.pairingCodes.push(pairing);
  });
  return pairing;
}

export async function createLocalBridgeBootstrapToken(sessionId, extra = {}) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) throw new Error('sessionId is required');
  const ttlMs = Number.isFinite(Number(extra?.ttlMs)) ? Number(extra.ttlMs) : BOOTSTRAP_TOKEN_TTL_MS;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + Math.max(60 * 1000, Math.floor(ttlMs))).toISOString();
  const bootstrapToken = {
    id: createId('lboot'),
    token: `lbt_${randomBytes(24).toString('hex')}`,
    sessionId: normalizedSessionId,
    createdAt,
    expiresAt,
    usedAt: '',
    deviceId: '',
    allowedRoots: normalizeAllowedRoots(extra?.allowedRoots),
  };
  await mutateState((draft) => {
    draft.bootstrapTokens = draft.bootstrapTokens.filter((entry) => Date.parse(entry.expiresAt || 0) > Date.now());
    draft.bootstrapTokens.push(bootstrapToken);
  });
  return bootstrapToken;
}

export async function redeemLocalBridgePairingCode(code, extra = {}) {
  const normalizedCode = trimString(code).toLowerCase();
  if (!normalizedCode) throw new Error('code is required');
  const platform = trimString(extra?.platform);
  const deviceName = trimString(extra?.deviceName);
  const helperVersion = trimString(extra?.helperVersion);
  const allowedRoots = normalizeAllowedRoots(extra?.allowedRoots);
  const { result } = await mutateState((draft) => {
    const entry = draft.pairingCodes.find((candidate) => candidate.code.toLowerCase() === normalizedCode);
    if (!entry) {
      throw new Error('Pairing code not found');
    }
    if (entry.usedAt) {
      throw new Error('Pairing code already used');
    }
    const expiresAt = Date.parse(entry.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Pairing code expired');
    }
    const device = {
      id: createId('ldev'),
      token: randomBytes(24).toString('hex'),
      sessionId: entry.sessionId,
      createdAt: nowIso(),
      lastSeenAt: '',
      platform,
      deviceName,
      helperVersion,
      allowedRoots,
    };
    draft.devices.push(device);
    entry.usedAt = nowIso();
    entry.deviceId = device.id;
    return { pairing: entry, device };
  });
  return result;
}

export async function redeemLocalBridgeBootstrapToken(token, extra = {}) {
  const normalizedToken = trimString(token);
  if (!normalizedToken) throw new Error('token is required');
  const platform = trimString(extra?.platform);
  const deviceName = trimString(extra?.deviceName);
  const helperVersion = trimString(extra?.helperVersion);
  const allowedRootsInput = normalizeAllowedRoots(extra?.allowedRoots);
  const { result } = await mutateState((draft) => {
    const entry = draft.bootstrapTokens.find((candidate) => candidate.token === normalizedToken);
    if (!entry) {
      throw new Error('Bootstrap token not found');
    }
    if (entry.usedAt) {
      throw new Error('Bootstrap token already used');
    }
    const expiresAt = Date.parse(entry.expiresAt || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('Bootstrap token expired');
    }
    const allowedRoots = allowedRootsInput.length > 0 ? allowedRootsInput : normalizeAllowedRoots(entry.allowedRoots);
    const device = {
      id: createId('ldev'),
      token: randomBytes(24).toString('hex'),
      sessionId: entry.sessionId,
      createdAt: nowIso(),
      lastSeenAt: '',
      platform,
      deviceName,
      helperVersion,
      allowedRoots,
    };
    draft.devices.push(device);
    entry.usedAt = nowIso();
    entry.deviceId = device.id;
    return { bootstrapToken: entry, device };
  });
  return result;
}

export async function getLocalBridgeDeviceByToken(token) {
  const normalized = trimString(token);
  if (!normalized) return null;
  const state = await loadLocalBridgeState();
  return state.devices.find((device) => device.token === normalized) || null;
}

export async function getLocalBridgeDevice(deviceId) {
  const normalized = trimString(deviceId);
  if (!normalized) return null;
  const state = await loadLocalBridgeState();
  return state.devices.find((device) => device.id === normalized) || null;
}

export async function recordLocalBridgeHeartbeat(deviceId, extra = {}) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const platform = trimString(extra?.platform);
  const deviceName = trimString(extra?.deviceName);
  const helperVersion = trimString(extra?.helperVersion);
  const allowedRoots = normalizeAllowedRoots(extra?.allowedRoots);
  const { result } = await mutateState((draft) => {
    const device = draft.devices.find((entry) => entry.id === normalizedDeviceId);
    if (!device) return null;
    device.lastSeenAt = nowIso();
    if (platform) device.platform = platform;
    if (deviceName) device.deviceName = deviceName;
    if (helperVersion) device.helperVersion = helperVersion;
    if (allowedRoots.length > 0) device.allowedRoots = allowedRoots;
    return device;
  });
  return result;
}

export async function enqueueLocalBridgeCommand({ sessionId, deviceId, name, args = {}, stageAssetId = '' }) {
  const normalizedSessionId = trimString(sessionId);
  const normalizedDeviceId = trimString(deviceId);
  const normalizedName = trimString(name);
  if (!normalizedSessionId || !normalizedDeviceId || !normalizedName) {
    throw new Error('sessionId, deviceId, and name are required');
  }
  const command = {
    id: createId('lcmd'),
    sessionId: normalizedSessionId,
    deviceId: normalizedDeviceId,
    name: normalizedName,
    state: 'queued',
    createdAt: nowIso(),
    claimedAt: '',
    completedAt: '',
    stageAssetId: trimString(stageAssetId),
    args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    result: null,
    error: '',
  };
  await mutateState((draft) => {
    draft.commands.push(command);
  });
  return command;
}

export async function claimNextLocalBridgeCommand(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const { result } = await mutateState((draft) => {
    failStaleInProgressCommands(draft, normalizedDeviceId);
    const command = draft.commands.find((entry) => entry.deviceId === normalizedDeviceId && entry.state === 'queued');
    if (!command) return null;
    command.state = 'in_progress';
    command.claimedAt = nowIso();
    return command;
  });
  return result;
}

export async function completeLocalBridgeCommand(deviceId, commandId, payload = {}) {
  const normalizedDeviceId = trimString(deviceId);
  const normalizedCommandId = trimString(commandId);
  if (!normalizedDeviceId || !normalizedCommandId) return null;
  const resultPayload = payload?.result && typeof payload.result === 'object' ? payload.result : null;
  const error = trimString(payload?.error);
  const { result } = await mutateState((draft) => {
    const command = draft.commands.find((entry) => entry.deviceId === normalizedDeviceId && entry.id === normalizedCommandId);
    if (!command) return null;
    if (command.state !== 'in_progress') {
      return command;
    }
    command.state = error ? 'failed' : 'completed';
    command.completedAt = nowIso();
    command.result = resultPayload;
    command.error = error;
    return command;
  });
  return result;
}

export async function getLocalBridgeCommand(commandId) {
  const normalized = trimString(commandId);
  if (!normalized) return null;
  const state = await loadLocalBridgeState();
  return state.commands.find((entry) => entry.id === normalized) || null;
}

export async function getSessionLocalBridgeCommand(sessionId, commandId) {
  const normalizedSessionId = trimString(sessionId);
  const normalizedCommandId = trimString(commandId);
  if (!normalizedSessionId || !normalizedCommandId) return null;
  const state = await loadLocalBridgeState();
  return state.commands.find((entry) => entry.sessionId === normalizedSessionId && entry.id === normalizedCommandId) || null;
}

export async function getSessionLocalBridgeSurface(session) {
  const deviceId = trimString(session?.localBridgeDeviceId);
  if (!deviceId) return null;
  const device = await getLocalBridgeDevice(deviceId);
  if (!device) {
    return {
      deviceId,
      state: 'missing',
      allowedRoots: [],
    };
  }
  const lastSeenAt = trimString(device.lastSeenAt);
  const online = isDeviceOnline(device);
  return {
    deviceId: device.id,
    sessionId: device.sessionId,
    state: online ? 'online' : 'offline',
    lastSeenAt,
    platform: device.platform,
    deviceName: device.deviceName,
    helperVersion: device.helperVersion,
    allowedRoots: device.allowedRoots,
  };
}

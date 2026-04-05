import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { INSTALL_HANDOFFS_FILE } from './config.mjs';

const INSTALL_HANDOFF_PREFIX = 'ih_';
const INSTALL_HANDOFF_HEX_LENGTH = 48;
const INSTALL_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

function normalizePreferredLanguage(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function normalizeInstallHandoffToken(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  return new RegExp(`^${INSTALL_HANDOFF_PREFIX}[a-f0-9]{${INSTALL_HANDOFF_HEX_LENGTH}}$`).test(normalized)
    ? normalized
    : '';
}

function normalizeStoredInstallHandoff(record) {
  if (!record || typeof record !== 'object') return null;
  const expiry = Number(record.expiry);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return {
    expiry,
    preferredLanguage: normalizePreferredLanguage(record.preferredLanguage),
  };
}

function loadInstallHandoffs() {
  try {
    if (!existsSync(INSTALL_HANDOFFS_FILE)) {
      return new Map();
    }
    const raw = JSON.parse(readFileSync(INSTALL_HANDOFFS_FILE, 'utf8'));
    const map = new Map();
    let pruned = false;
    for (const [token, record] of Object.entries(raw || {})) {
      const normalizedToken = normalizeInstallHandoffToken(token);
      const normalizedRecord = normalizeStoredInstallHandoff(record);
      if (!normalizedToken || !normalizedRecord) {
        pruned = true;
        continue;
      }
      map.set(normalizedToken, normalizedRecord);
    }
    if (pruned) {
      const configDir = dirname(INSTALL_HANDOFFS_FILE);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      writeFileSync(INSTALL_HANDOFFS_FILE, JSON.stringify(Object.fromEntries(map), null, 2), 'utf8');
    }
    return map;
  } catch (error) {
    console.error('Failed to load install handoffs:', error.message);
    return new Map();
  }
}

export const installHandoffs = loadInstallHandoffs();

function pruneExpiredInstallHandoffs() {
  let changed = false;
  for (const [token, record] of installHandoffs.entries()) {
    if (!record || Number(record.expiry) <= Date.now()) {
      installHandoffs.delete(token);
      changed = true;
    }
  }
  return changed;
}

export async function saveInstallHandoffsAsync() {
  try {
    const configDir = dirname(INSTALL_HANDOFFS_FILE);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      INSTALL_HANDOFFS_FILE,
      JSON.stringify(Object.fromEntries(installHandoffs), null, 2),
      'utf8',
    );
  } catch (error) {
    console.error('Failed to save install handoffs:', error.message);
  }
}

export async function createInstallHandoff(authSession, { ttlMs = INSTALL_HANDOFF_TTL_MS } = {}) {
  if (!authSession || authSession.role !== 'owner') {
    throw new Error('Install handoff requires an authenticated owner session');
  }

  pruneExpiredInstallHandoffs();
  const token = `${INSTALL_HANDOFF_PREFIX}${randomBytes(INSTALL_HANDOFF_HEX_LENGTH / 2).toString('hex')}`;
  const expiry = Date.now() + Math.max(60 * 1000, Math.floor(ttlMs));
  const record = {
    expiry,
    preferredLanguage: normalizePreferredLanguage(authSession.preferredLanguage),
  };
  installHandoffs.set(token, record);
  await saveInstallHandoffsAsync();
  return {
    token,
    expiry,
    preferredLanguage: record.preferredLanguage,
  };
}

export async function redeemInstallHandoff(token) {
  const normalizedToken = normalizeInstallHandoffToken(token);
  const pruned = pruneExpiredInstallHandoffs();
  if (!normalizedToken) {
    if (pruned) await saveInstallHandoffsAsync();
    return null;
  }
  const record = installHandoffs.get(normalizedToken);
  if (!record || Number(record.expiry) <= Date.now()) {
    installHandoffs.delete(normalizedToken);
    await saveInstallHandoffsAsync();
    return null;
  }
  const preferredLanguage = normalizePreferredLanguage(record.preferredLanguage);
  return preferredLanguage
    ? { role: 'owner', preferredLanguage }
    : { role: 'owner' };
}

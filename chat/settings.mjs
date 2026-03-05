import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CHAT_SETTINGS_FILE } from '../lib/config.mjs';

const DEFAULTS = { progressEnabled: false };

function loadSettings() {
  try {
    if (!existsSync(CHAT_SETTINGS_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CHAT_SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  const dir = dirname(CHAT_SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

export function getSettings() {
  return loadSettings();
}

export function updateSettings(patch) {
  const current = loadSettings();
  const updated = { ...current, ...patch };
  saveSettings(updated);
  return updated;
}

export function isProgressEnabled() {
  return loadSettings().progressEnabled === true;
}

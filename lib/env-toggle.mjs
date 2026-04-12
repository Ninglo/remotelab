const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable', 'none', 'no']);
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled', 'enable', 'yes', 'all']);

export function isEnvToggleEnabled(value, { defaultValue = false } = {}) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
  if (!normalized) return defaultValue;
  if (DISABLED_VALUES.has(normalized)) return false;
  if (ENABLED_VALUES.has(normalized)) return true;
  return defaultValue;
}

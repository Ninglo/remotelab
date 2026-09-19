export const WELCOME_STARTER_PRESET = 'welcome';

export function normalizeSessionStarterPreset(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (normalized === WELCOME_STARTER_PRESET) return WELCOME_STARTER_PRESET;
  return '';
}

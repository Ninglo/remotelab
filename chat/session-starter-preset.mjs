export const WELCOME_STARTER_PRESET = 'welcome';
export const CREATE_AGENT_STARTER_PRESET = 'create_agent';

export function normalizeSessionStarterPreset(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (normalized === WELCOME_STARTER_PRESET) return WELCOME_STARTER_PRESET;
  if (normalized === CREATE_AGENT_STARTER_PRESET) return CREATE_AGENT_STARTER_PRESET;
  return '';
}

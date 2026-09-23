import { DEFAULT_AUTO_QUICK_PROMPT } from './jev-auto-router.mjs';

export const QUICK_SESSION_PROFILE = 'quick';

const trim = value => typeof value === 'string' ? value.trim() : '';

export function normalizeSessionExecutionProfile(value) {
  return trim(value).toLowerCase() === QUICK_SESSION_PROFILE
    ? QUICK_SESSION_PROFILE
    : '';
}

export function isQuickSession(session = {}) {
  return normalizeSessionExecutionProfile(session?.executionProfile) === QUICK_SESSION_PROFILE;
}

export function getQuickSessionRuntimeProfile(env = process.env) {
  return {
    tool: trim(env.REMOTELAB_QUICK_TOOL) || 'codex',
    model: trim(env.REMOTELAB_QUICK_MODEL) || 'gpt-6-sol',
    effort: trim(env.REMOTELAB_QUICK_EFFORT) || 'low',
    thinking: false,
  };
}

export function getQuickSessionDeveloperInstructions(prompt = DEFAULT_AUTO_QUICK_PROMPT) {
  return trim(prompt) || DEFAULT_AUTO_QUICK_PROMPT;
}

export function applyQuickSessionRuntime(session = {}, options = {}) {
  if (!isQuickSession(session)) return { ...options };
  return {
    ...options,
    ...getQuickSessionRuntimeProfile(),
    executionProfile: QUICK_SESSION_PROFILE,
  };
}

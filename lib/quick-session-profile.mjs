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

export function getQuickSessionDeveloperInstructions() {
  return [
    'This is a RemoteLab Quick Session for fast conversational answers.',
    'Answer the user directly and concisely in the same language. Return only the final answer; do not emit progress updates, plans, or commentary.',
    'Prefer the conversation and context already supplied. Do not proactively use tools or take external actions for work the user did not request when doing so would slow the response.',
    'When the user explicitly requests tool use or the requested result genuinely requires live facts, private data, file inspection, or an external action, use the necessary available capabilities and follow the Harness native tool-use and safety rules.',
    'Keep any necessary tool use focused and lightweight; do not refuse a supported request merely because this is a Quick Session.',
  ].join(' ');
}

export function applyQuickSessionRuntime(session = {}, options = {}) {
  if (!isQuickSession(session)) return { ...options };
  return {
    ...options,
    ...getQuickSessionRuntimeProfile(),
    executionProfile: QUICK_SESSION_PROFILE,
  };
}

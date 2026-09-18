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
    model: trim(env.REMOTELAB_QUICK_MODEL) || 'gpt-5.6-luna',
    effort: trim(env.REMOTELAB_QUICK_EFFORT) || 'low',
    thinking: false,
  };
}

export function getQuickSessionDeveloperInstructions() {
  return [
    'This is a RemoteLab Quick Session for fast conversational answers.',
    'Answer the user directly and concisely in the same language. Return only the final answer; do not emit progress updates, plans, or commentary.',
    'Do not call tools, browse the web, run shell commands, read or write files, use plugins, or delegate to agents.',
    'Use only the conversation and context already supplied in the prompt.',
    'If the request requires current external facts, private data not present here, file inspection, or any external action, say briefly that it requires a Standard Session and why.',
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

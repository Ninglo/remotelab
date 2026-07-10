const LEGACY_MICRO_AGENT_TOOL_ID = 'micro-agent';
const PRODUCT_DEFAULT_TOOL_ID = 'codex';
const PRODUCT_DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const PRODUCT_DEFAULT_CODEX_EFFORT = 'medium';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export {
  LEGACY_MICRO_AGENT_TOOL_ID,
  PRODUCT_DEFAULT_TOOL_ID,
  PRODUCT_DEFAULT_CODEX_MODEL,
  PRODUCT_DEFAULT_CODEX_EFFORT,
};

export function isLegacyMicroAgentToolId(value) {
  return trimString(value) === LEGACY_MICRO_AGENT_TOOL_ID;
}

export function normalizeLegacyToolId(value) {
  const normalized = trimString(value);
  return isLegacyMicroAgentToolId(normalized) ? PRODUCT_DEFAULT_TOOL_ID : normalized;
}

export function migrateLegacySessionRuntimeFields(value = {}) {
  if (!isLegacyMicroAgentToolId(value?.tool)) {
    return { ...value };
  }
  return {
    ...value,
    tool: PRODUCT_DEFAULT_TOOL_ID,
    model: PRODUCT_DEFAULT_CODEX_MODEL,
    effort: PRODUCT_DEFAULT_CODEX_EFFORT,
    thinking: false,
  };
}

export function migrateLegacyRuntimeSelection(value = {}) {
  if (!isLegacyMicroAgentToolId(value?.selectedTool)) {
    return { ...value };
  }
  return {
    ...value,
    selectedTool: PRODUCT_DEFAULT_TOOL_ID,
    selectedModel: PRODUCT_DEFAULT_CODEX_MODEL,
    selectedEffort: PRODUCT_DEFAULT_CODEX_EFFORT,
    thinkingEnabled: false,
    reasoningKind: 'enum',
  };
}

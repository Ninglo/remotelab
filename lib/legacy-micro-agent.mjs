const LEGACY_MICRO_AGENT_TOOL_ID = 'micro-agent';
const PRODUCT_DEFAULT_TOOL_ID = 'codex';
const PRODUCT_DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const PRODUCT_DEFAULT_CODEX_EFFORT = 'medium';
const RETIRED_CODEX_MODEL_IDS = new Set([]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseVersionedGptModelId(value) {
  const normalized = trimString(value).toLowerCase();
  const match = normalized.match(/^gpt-(\d+)\.(\d+)(?:-|$)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
  };
}

export {
  LEGACY_MICRO_AGENT_TOOL_ID,
  PRODUCT_DEFAULT_TOOL_ID,
  PRODUCT_DEFAULT_CODEX_MODEL,
  PRODUCT_DEFAULT_CODEX_EFFORT,
};

export function isStaleCodexModelId(value, defaultModel = PRODUCT_DEFAULT_CODEX_MODEL) {
  const normalized = trimString(value);
  if (!normalized || normalized === trimString(defaultModel)) return false;
  if (RETIRED_CODEX_MODEL_IDS.has(normalized)) return true;

  const modelVersion = parseVersionedGptModelId(normalized);
  const defaultVersion = parseVersionedGptModelId(defaultModel);
  if (!modelVersion || !defaultVersion) return false;
  if (modelVersion.major !== defaultVersion.major) {
    return modelVersion.major < defaultVersion.major;
  }
  return modelVersion.minor < defaultVersion.minor;
}

export function normalizeCodexModelId(value, defaultModel = PRODUCT_DEFAULT_CODEX_MODEL) {
  const normalized = trimString(value);
  if (!normalized) return '';
  return isStaleCodexModelId(normalized, defaultModel)
    ? trimString(defaultModel)
    : normalized;
}

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
    const selectedTool = normalizeLegacyToolId(value?.selectedTool);
    return {
      ...value,
      selectedTool,
      selectedModel: selectedTool === PRODUCT_DEFAULT_TOOL_ID
        ? normalizeCodexModelId(value?.selectedModel)
        : trimString(value?.selectedModel),
    };
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

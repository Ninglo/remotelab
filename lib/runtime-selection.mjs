import { migrateLegacyRuntimeSelection } from './legacy-micro-agent.mjs';
import {
  runtimeProfileFromUiSelection,
  runtimeProfileToUiSelection,
} from './runtime-profile.mjs';

export const AUTO_RUNTIME_SELECTION = Object.freeze({
  selectedTool: 'codex',
  selectedModel: 'auto',
  selectedEffort: '',
  reasoningKind: 'none',
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReasoningKind(value) {
  return trimString(value).toLowerCase() === 'enum' ? 'enum' : 'none';
}

export function normalizeUiRuntimeSelection(value = {}) {
  const migrated = migrateLegacyRuntimeSelection({
    ...value,
    selectedTool: trimString(value.selectedTool),
    selectedModel: trimString(value.selectedModel),
    selectedEffort: trimString(value.selectedEffort),
  });
  return {
    ...runtimeProfileToUiSelection(
      runtimeProfileFromUiSelection(migrated),
      normalizeReasoningKind(migrated.reasoningKind),
    ),
    updatedAt: trimString(value.updatedAt) || new Date().toISOString(),
  };
}

export function getAutoRuntimeSelection() {
  return { ...AUTO_RUNTIME_SELECTION };
}

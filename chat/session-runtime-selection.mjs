import { getModelsForTool } from './models.mjs';
import {
  migrateLegacySessionRuntimeFields,
  normalizeCodexModelId,
  normalizeLegacyToolId,
} from '../lib/legacy-micro-agent.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Resolve once at admission; the notice and detached runner share this snapshot.
export async function resolveSessionRuntimeSelection(session = {}, options = {}) {
  const saved = migrateLegacySessionRuntimeFields(session);
  const requested = migrateLegacySessionRuntimeFields(options);
  const tool = normalizeLegacyToolId(trim(requested.tool) || saved.tool || 'codex');
  const sameTool = tool === saved.tool;
  let model = trim(requested.model) || (sameTool ? trim(saved.model) : '');
  if (tool === 'codex') model = normalizeCodexModelId(model);
  const sameModel = sameTool && (!trim(requested.model) || model === trim(saved.model));
  let effort = trim(requested.effort) || (sameModel ? trim(saved.effort) : '');
  if (!model || !effort) {
    const catalog = await getModelsForTool(tool);
    model ||= trim(catalog.defaultModel);
    const descriptor = catalog.models?.find(candidate => candidate.id === model);
    const reasoning = descriptor?.reasoning || catalog.reasoning;
    if (reasoning?.kind === 'enum') effort ||= trim(reasoning.default);
  }
  return {
    tool, model, effort,
    thinking: typeof requested.thinking === 'boolean'
      ? requested.thinking : sameTool && saved.thinking === true,
  };
}

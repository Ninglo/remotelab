import { getModelsForTool } from './models.mjs';
import {
  migrateLegacySessionRuntimeFields,
  normalizeCodexModelId,
  normalizeLegacyToolId,
} from '../lib/legacy-micro-agent.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Resolve once at admission; the notice and detached runner share this snapshot.
export async function resolveSessionRuntimeSelection(session = {}, options = {}) {
  // Runtime preferences belong to the RemoteLab Session, regardless of the
  // connector that delivered the message. Keep the old Feishu field as a
  // migration fallback for sessions created before preferences were generic.
  const saved = migrateLegacySessionRuntimeFields(session.feishuRuntimeSelection || session);
  // Connector delivery carries the connector's admission snapshot for a new
  // Session, but must not silently replace an existing Session snapshot on
  // later messages. Connector commands update the Session explicitly before
  // the next message arrives.
  const connectorRequest = options.sourceContext?.connector || options.sourceDelivery?.connector;
  // Connector workers mark ordinary messages as carrying the shared Default
  // snapshot. An unmarked connector request remains an explicit API override
  // when it is partial (for example, a tool-only switch). Complete unmarked
  // snapshots remain compatible with older connector callers.
  const completeConnectorSnapshot = connectorRequest
    && typeof options.tool === 'string'
    && typeof options.model === 'string'
    && typeof options.effort === 'string';
  const carriesDefaultSnapshot = connectorRequest && (
    options.runtimeSelectionScope === 'default' || session.feishuRuntimeSelection || completeConnectorSnapshot
  );
  const requested = migrateLegacySessionRuntimeFields(carriesDefaultSnapshot ? {} : options);
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

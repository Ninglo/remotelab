import { getModelsForTool } from './models.mjs';
import {
  migrateLegacySessionRuntimeFields,
  normalizeCodexModelId,
  normalizeLegacyToolId,
} from '../lib/legacy-micro-agent.mjs';
import { getQuickSessionRuntimeProfile, isQuickSession } from '../lib/quick-session-profile.mjs';
import {
  completeRuntimeProfile,
  normalizeRuntimeProfile,
  resolveRuntimeProfile,
} from '../lib/runtime-profile.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

// Resolve once at admission; the notice and detached runner share this snapshot.
export async function resolveSessionRuntimeSelection(session = {}, options = {}) {
  if (isQuickSession(session)) return getQuickSessionRuntimeProfile();
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
  const savedProfile = normalizeRuntimeProfile(saved);
  const requestedProfile = normalizeRuntimeProfile(requested);
  requestedProfile.tool = normalizeLegacyToolId(requestedProfile.tool);
  if (savedProfile.tool === 'codex') savedProfile.model = normalizeCodexModelId(savedProfile.model);
  if (requestedProfile.tool === 'codex') requestedProfile.model = normalizeCodexModelId(requestedProfile.model);
  let profile = resolveRuntimeProfile(savedProfile, requestedProfile);
  const sameTool = profile.tool === savedProfile.tool;
  if (!profile.model || !profile.effort) {
    profile = completeRuntimeProfile(profile, await getModelsForTool(profile.tool));
  }
  return {
    ...profile,
    thinking: typeof requested.thinking === 'boolean'
      ? requested.thinking : sameTool && saved.thinking === true,
  };
}

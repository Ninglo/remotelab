import { getModelsForTool } from './models.mjs';
import {
  migrateLegacySessionRuntimeFields,
  normalizeLegacyToolId,
  normalizeRuntimeModelForTool,
} from '../lib/legacy-micro-agent.mjs';
import { getQuickSessionRuntimeProfile, isQuickSession } from '../lib/quick-session-profile.mjs';
import {
  completeRuntimeProfile,
  normalizeRuntimeProfile,
  resolveRuntimeProfile,
} from '../lib/runtime-profile.mjs';
import { getJevTierProfiles, JEV_AUTO_MODEL_ID, resolveJevAutoRoute } from '../lib/jev-auto-router.mjs';
import { applyRuntimeExperiment } from './runtime-experiments.mjs';
import { buildPiModelRouteId } from './pi-models.mjs';
import { clampReasoningEffort } from '../lib/reasoning-effort-policy.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

async function refreshInheritedGroupTier(session, options, profile) {
  const source = options.sourceContext || options.sourceDelivery?.target;
  if (options.internalOperation || options.recordUserMessage === false || session.feishuRuntimeSelection
      || source?.chatType !== 'group' || (source.connector || options.sourceDelivery?.connector) !== 'feishu'
      || !['auto', 'default'].includes(options.runtimeSelectionScope)) return null;

  const receipt = session.autoRouting;
  // Only a matching Auto receipt proves the concrete saved model was a default.
  // Keep explicit selections and experiment assignments on their own policy.
  if (receipt?.provider !== 'typesafe' || receipt.experiment || profile.tool !== 'codex'
      || !['tool', 'model', 'effort'].every(key => receipt.route?.[key] === profile[key])) return null;
  const tier = receipt.status === 'fallback' ? 'quality' : receipt.decision?.tier;
  if (!tier) return null;
  const profiles = await getJevTierProfiles();
  if (!Object.hasOwn(profiles, tier)) return null;
  const current = profiles[tier];
  const route = {
    tool: profile.tool,
    model: normalizeRuntimeModelForTool(profile.tool, current.model),
    effort: clampReasoningEffort(current.effort),
  };
  if (route.model === profile.model && route.effort === profile.effort) return null;
  return { ...route, thinking: session.thinking === true,
    autoRoutingReceipt: { ...receipt, route, profileRefreshedAt: new Date().toISOString() } };
}

// Resolve once at admission; the notice and detached runner share this snapshot.
export async function resolveSessionRuntimeSelection(session = {}, options = {}, activeRuntimeSelection = null) {
  if (isQuickSession(session)) return getQuickSessionRuntimeProfile();
  // Runtime preferences belong to the RemoteLab Session, regardless of the
  // connector that delivered the message. Keep the old Feishu field as a
  // migration fallback for sessions created before preferences were generic.
  const saved = migrateLegacySessionRuntimeFields(session.feishuRuntimeSelection || session);
  // Connector delivery carries the connector's admission snapshot for a new
  // Session, but must not silently replace an existing Session snapshot on
  // later messages. Connector commands update the Session explicitly before
  // the next message arrives.
  const scheduledExecution = options.internalOperation === 'trigger_delivery';
  const connectorRequest = !scheduledExecution && (options.sourceContext?.connector || options.sourceDelivery?.connector);
  // Connector workers mark ordinary messages as carrying the Auto snapshot.
  // An unmarked connector request remains an explicit API override
  // when it is partial (for example, a tool-only switch). Complete unmarked
  // snapshots remain compatible with older connector callers.
  const completeConnectorSnapshot = connectorRequest
    && typeof options.tool === 'string'
    && typeof options.model === 'string'
    && typeof options.effort === 'string';
  const carriesDefaultSnapshot = connectorRequest && (
    ['auto', 'default'].includes(options.runtimeSelectionScope) || session.feishuRuntimeSelection || completeConnectorSnapshot
  );
  const requested = migrateLegacySessionRuntimeFields(carriesDefaultSnapshot ? {} : options);
  // Ordinary input steers the admitted Harness. Session preferences and Auto
  // defaults may have changed since admission; neither can replace that run's
  // frozen snapshot. Explicit switches still resolve below for the busy guard.
  const requestedRuntimeChange = ['tool', 'model', 'effort'].some(key =>
    trim(requested[key]) && requested[key] !== activeRuntimeSelection?.[key])
    || (typeof requested.thinking === 'boolean' && requested.thinking !== activeRuntimeSelection?.thinking);
  if (activeRuntimeSelection && !requestedRuntimeChange && !options.freshThread
      && !options.internalOperation && !options.routingRethink && !options.routingSource) {
    return { ...activeRuntimeSelection };
  }
  const savedProfile = normalizeRuntimeProfile(saved);
  const requestedProfile = normalizeRuntimeProfile(requested);
  requestedProfile.tool = normalizeLegacyToolId(requestedProfile.tool);
  savedProfile.model = normalizeRuntimeModelForTool(savedProfile.tool, savedProfile.model);
  requestedProfile.model = normalizeRuntimeModelForTool(requestedProfile.tool, requestedProfile.model);
  let profile = resolveRuntimeProfile(savedProfile, requestedProfile);
  if (carriesDefaultSnapshot && !activeRuntimeSelection) {
    const refreshed = await refreshInheritedGroupTier(session, options, profile);
    if (refreshed) return refreshed;
  }
  const sameTool = profile.tool === savedProfile.tool;
  if (!profile.model || !profile.effort) {
    profile = completeRuntimeProfile(profile, await getModelsForTool(profile.tool));
  }
  // A Session created by a scheduled Pi Auto task can also be continued
  // manually; its saved Auto sentinel is never sent to the provider.
  const piAuto = profile.tool === 'pi' && (scheduledExecution || savedProfile.model === JEV_AUTO_MODEL_ID);
  if (profile.model === JEV_AUTO_MODEL_ID && (profile.tool === 'codex' || piAuto)) {
    const route = await resolveJevAutoRoute(options.autoRoutingText);
    if (piAuto) {
      const model = buildPiModelRouteId('openai-codex', normalizeRuntimeModelForTool('codex', route.model));
      const effort = route.effort === 'ultra' ? 'max' : clampReasoningEffort(route.effort);
      const catalog = await getModelsForTool('pi');
      const selected = catalog.models?.find(entry => entry.id === model);
      if (!selected || (effort && !selected.reasoning?.levels?.includes(effort))) {
        throw new Error(`Auto route is unavailable in Pi: ${model} / ${effort || 'default'}`);
      }
      const selectedRoute = { tool: 'pi', model, effort };
      return { ...route, ...selectedRoute, autoRoutingReceipt: { ...route.autoRoutingReceipt, route: selectedRoute } };
    }
    return applyRuntimeExperiment({
      ...route,
      model: normalizeRuntimeModelForTool(route.tool, route.model),
      effort: clampReasoningEffort(route.effort),
    }, session, options);
  }
  return {
    ...profile,
    thinking: typeof requested.thinking === 'boolean'
      ? requested.thinking : sameTool && saved.thinking === true,
  };
}

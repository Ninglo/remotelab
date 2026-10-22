import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { executionTrialPrompt } from './work-execution-prompt.mjs';

// Only accepted legacy requests may lack the new snapshot. An explicit false
// always wins; a routing setting cannot opt a new request into parallel work.
export function acceptedParallelWorkPolicy(options = {}) {
  if (options.parallelWorkPolicy) return options.parallelWorkPolicy;
  const legacy = options.messageRoutingPolicy;
  return { ...legacy, version: 1, enabled: legacy?.version === 1 && legacy.mechanism === 'experimental' };
}

export async function buildParallelWorkContext(session, sourceContext, options = {}) {
  const policy = acceptedParallelWorkPolicy(options);
  if (policy.version !== 1 || !policy.enabled || sourceContext?.connector !== 'feishu'
      || ['app', 'bot'].includes(sourceContext.sender?.senderType)) return '';
  const scope = await routingPilotScope(session?.conversation, undefined, policy.personId);
  if (scope?.version !== 2 || policy.trialVersion !== 2 || policy.trialId !== scope.trialId
      || !isPilotInputSinceActivation(scope, sourceContext.createTime || sourceContext.eventTs)) return '';
  const current = await findSessionMeta(session.id) || session;
  return executionTrialPrompt({ trialId: scope.trialId, decisions: current.workAwareness?.inputDecisions,
    plans: current.workAwareness?.executionPlans });
}

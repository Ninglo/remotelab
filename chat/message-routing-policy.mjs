import { resolvePersonMessageReplyPolicy } from './person-message-replies.mjs';
import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';

// Capture the sender's independent parallel setting at admission. The routing
// field remains only for accepted legacy work; new inputs always disable it.
export async function captureMessageRoutingOptions(session, supplied, preserved) {
  const options = { ...supplied };
  for (const key of ['messageRoutingPolicy', 'parallelWorkPolicy', 'routingPilotMainline', 'routingPilotMainlineProtocol']) {
    delete options[key];
    if (preserved && Object.hasOwn(preserved.options || {}, key)) options[key] = preserved.options[key];
  }
  if (preserved) {
    // A handed-off work topic keeps the choice, but is not the source mainline.
    if (preserved.sessionId && preserved.sessionId !== session.id) {
      delete options.routingPilotMainline;
      delete options.routingPilotMainlineProtocol;
    }
    return options; // Retries, routed work and question answers keep their accepted contract.
  }
  const source = options.sourceContext, delivery = options.sourceDelivery;
  const humanGroup = options.feishuConnectorAuthenticated === true && source?.connector === 'feishu'
    && source.chatType === 'group' && source.messageId && source.sender?.openId
    && !['app', 'bot'].includes(source.sender.senderType)
    && !options.internalOperation && !options.automationTitle && !options.routingRethink
    && delivery?.connector === 'feishu' && source.chatId === delivery.target?.chatId
    && source.sourceRouteId === delivery.sourceRouteId;
  let personal = null;
  if (humanGroup) {
    try { personal = await resolvePersonMessageReplyPolicy(options); }
    catch (error) { console.warn(`[message-routing] ${error.message}; routing disabled`); }
  }
  // New inputs never acquire automatic routing. Already accepted inputs above
  // retain their snapshots, including pending confirmations and running plans.
  options.messageRoutingPolicy = { version: 1, mechanism: 'none' };
  const scope = humanGroup ? await routingPilotScope(session.conversation, undefined, personal?.personId) : null;
  const enabled = personal?.parallelWork === true && scope?.version === 2
    && isPilotInputSinceActivation(scope, source.createTime || source.eventTs);
  options.parallelWorkPolicy = { version: 1, enabled: Boolean(enabled),
    ...(personal ? { personId: personal.personId, policyId: personal.policyId } : {}),
    ...(enabled ? { trialId: scope.trialId, trialVersion: 2 } : {}) };
  return options;
}

// Missing snapshots are already accepted legacy requests, not new defaults.
export const allowsMessageRouting = options => !options?.messageRoutingPolicy
  || options.messageRoutingPolicy.version === 1 && options.messageRoutingPolicy.mechanism === 'experimental';

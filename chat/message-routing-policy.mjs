import { resolvePersonMessageReplyPolicy } from './person-message-replies.mjs';
import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';

// Routing belongs to each input's sender, independently of the display policy
// inherited by a native execution. Never let another sender's head opt them in.
export async function captureMessageRoutingOptions(session, supplied, preserved) {
  const options = { ...supplied };
  for (const key of ['messageRoutingPolicy', 'routingPilotMainline', 'routingPilotMainlineProtocol']) {
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
  options.messageRoutingPolicy = { version: 1, mechanism: personal?.routing === 'experimental' ? 'experimental' : 'none',
    ...(personal ? { personId: personal.personId, policyId: personal.policyId } : {}) };
  if (options.messageRoutingPolicy.mechanism === 'experimental'
      && session.conversation?.target?.conversationKind === 'main'
      && isPilotInputSinceActivation(await routingPilotScope(session.conversation), source.createTime || source.eventTs)) {
    options.routingPilotMainline = true;
    options.routingPilotMainlineProtocol = 2;
  }
  return options;
}

// Missing snapshots are already accepted legacy requests, not new defaults.
export const allowsMessageRouting = options => !options?.messageRoutingPolicy
  || options.messageRoutingPolicy.version === 1 && options.messageRoutingPolicy.mechanism === 'experimental';

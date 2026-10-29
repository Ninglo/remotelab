import { createHash } from 'node:crypto';
import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

const source = 'experiments/delivery-self-review/v2.md';
const digest = content => createHash('sha256').update(content).digest('hex');
function groupAddress(context) {
  const source = context.sourceContext, delivery = context.sourceDelivery;
  const tenantKey = source?.tenantKey || source?.sender?.tenantKey;
  if (context.feishuConnectorAuthenticated !== true || context.internalOperation || context.automationTitle
      || source?.connector !== 'feishu' || source.chatType !== 'group' || !source.messageId
      || !source.sender?.openId || ['bot', 'app'].includes(source.sender.senderType)
      || delivery?.connector !== 'feishu' || !source.sourceRouteId || !source.chatId || !tenantKey
      || source.sourceRouteId !== delivery.sourceRouteId || source.chatId !== delivery.target?.chatId
      || tenantKey !== delivery.target?.tenantKey) return null;
  return { sourceRouteId: source.sourceRouteId, tenantKey, chatId: source.chatId };
}
const matches = (policy, context) => policy?.personId === context.personId
  && Boolean(buildPersonMemoryPromptBlock(context))
  && (policy.scope === 'person' || policy.scope === 'group' && policy.group
    && JSON.stringify(policy.group) === JSON.stringify(groupAddress(context)));

// Group configuration arrives only through the authenticated connector's frozen
// source. It never changes anyone's personal preferences or display policy.
export async function captureGroupDeliverySelfReviewPolicy(options, personal, inherited = null) {
  if (inherited) return inherited.options?.groupDeliverySelfReviewPolicy || null;
  if (personal?.selfReview === true) return null; // One check when both are on.
  const group = groupAddress(options), choice = options.sourceContext?.groupSelfReview;
  if (!group || choice?.enabled !== true) return null;
  const policy = { scope: 'group', personId: options.viewPersonId, selfReview: true, group,
    policyId: `group-review:${digest(JSON.stringify([group, choice.revision || 0]))}` };
  const review = await captureDeliverySelfReview(policy, { ...options,
    personId: options.viewPersonId, identityId: options.initiatedByIdentityId });
  return review ? { ...policy, deliverySelfReview: review } : null;
}

// Capture only an explicit personal or authenticated group opt-in. Work keeps this
// procedure across retry, queueing, native steer and future asset revisions.
export async function captureDeliverySelfReview(policy, context = {}, { readAsset = readPromptAsset } = {}) {
  if (policy?.selfReview !== true || !matches(policy, context)) return undefined;
  const provenance = { version: 2, personId: context.personId, policyId: policy.policyId };
  try {
    const content = await readAsset(source);
    if (!content.trim() || content.length > 16000) throw new Error('invalid-review-body');
    return { ...provenance, status: 'captured', source: `chat/prompt-assets/${source}`, sha256: digest(content), content };
  } catch {
    return { ...provenance, status: 'unavailable' };
  }
}

export function deliverySelfReviewPrompt(policy, context = {}) {
  if (policy?.selfReview !== true || !matches(policy, context)) {
    return 'Optional delivery self-review is OFF for this accepted work. Do not inherit another input’s opt-in. Ordinary honesty, task completion and necessary verification still apply.';
  }
  const rule = policy.deliverySelfReview;
  if (rule?.status !== 'captured' || ![1, 2].includes(rule.version) || rule.personId !== policy.personId
      || rule.policyId !== policy.policyId || typeof rule.content !== 'string' || rule.sha256 !== digest(rule.content)) {
    return 'The opted-in delivery self-review snapshot is unavailable. Do not claim that the optional review ran. Continue ordinary Harness execution and necessary verification; report the missing review if relevant to delivery.';
  }
  return [
    'Optional delivery self-review is ON for this verified requester and accepted work only. The current Harness performs it before its final delivery, within this task run.',
    policy.scope === 'group' ? 'Enabled by this Feishu group setting, including its mainline and topics; personal settings are unchanged.'
      : 'Enabled by this requester’s personal setting; other members are not opted in.',
    JSON.stringify({ version: rule.version, personId: rule.personId, source: rule.source, sha256: rule.sha256 }),
    rule.content,
  ].join('\n\n');
}

import { createHash } from 'node:crypto';
import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

const source = 'experiments/delivery-self-review/v1.md';
const digest = content => createHash('sha256').update(content).digest('hex');
const matches = (policy, context) => policy?.scope === 'person'
  && policy.personId === context.personId && Boolean(buildPersonMemoryPromptBlock(context));

// Capture only an explicit personal opt-in. Accepted work keeps this exact
// procedure across retry, queueing, native steer and future asset revisions.
export async function captureDeliverySelfReview(policy, context = {}, { readAsset = readPromptAsset } = {}) {
  if (policy?.selfReview !== true || !matches(policy, context)) return undefined;
  const provenance = { version: 1, personId: context.personId, policyId: policy.policyId };
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
  if (rule?.status !== 'captured' || rule.version !== 1 || rule.personId !== policy.personId
      || rule.policyId !== policy.policyId || typeof rule.content !== 'string' || rule.sha256 !== digest(rule.content)) {
    return 'The opted-in delivery self-review snapshot is unavailable. Do not claim that the optional review ran. Continue ordinary Harness execution and necessary verification; report the missing review if relevant to delivery.';
  }
  return [
    'Optional delivery self-review is ON for this verified requester and accepted work only. The current Harness performs it before its final delivery, within this task run.',
    JSON.stringify({ version: rule.version, personId: rule.personId, source: rule.source, sha256: rule.sha256 }),
    rule.content,
  ].join('\n\n');
}

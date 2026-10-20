import { createHash } from 'node:crypto';
import { buildPersonMemoryPromptBlock } from './person-memory-context.mjs';
import { readPromptAsset } from './prompt-asset-loader.mjs';

// Versions are immutable assets. Existing unversioned personal settings bind
// to v1, not a moving "latest"; accepted Requests retain the exact text/hash.
export const LEGACY_STRICT_START_VERSION = 'v1';
const versions = Object.freeze({ v1: 'experiments/work-start/v1.md', v2: 'experiments/work-start/v2.md',
  v3: 'experiments/work-start/v3.md' });
export const isStrictStartRuleVersion = version => Object.hasOwn(versions, version);
const digest = content => createHash('sha256').update(content).digest('hex');
const matches = (policy, context) => policy?.scope === 'person'
  && policy.personId === context.personId && Boolean(buildPersonMemoryPromptBlock(context));

export async function captureStrictStartRule(policy, context = {}, { readAsset = readPromptAsset } = {}) {
  if (policy?.strictStartCheck !== true || !matches(policy, context)) return undefined;
  const version = policy.strictStartRuleVersion || LEGACY_STRICT_START_VERSION;
  const source = Object.hasOwn(versions, version) ? versions[version] : null;
  const provenance = { id: 'work-start', version, personId: context.personId, policyId: policy.policyId,
    origin: { sessionId: context.sessionId || '', requestId: context.requestId || '', identityId: context.identityId } };
  if (!source) return { ...provenance, status: 'unavailable', reason: 'unknown-version' };
  try {
    const content = await readAsset(source);
    if (!content.trim() || content.length > 16000) throw new Error('invalid-rule-body');
    return { ...provenance, status: 'captured', source: `chat/prompt-assets/${source}`, sha256: digest(content), content };
  } catch {
    return { ...provenance, status: 'unavailable', reason: 'rule-unavailable' };
  }
}

export function strictStartCheckPrompt(policy, { resetDisabled = false, ...context } = {}) {
  if (policy?.scope !== 'person' || policy.strictStartCheck !== true) return resetDisabled
    ? 'Strict work-start check is OFF for this accepted work; do not inherit it from Session history. Continue with the ordinary Harness workflow and current authorization.' : '';
  if (!matches(policy, context)) {
    return 'The work-start preference has no matching verified requester. Do not inherit personal requirements from Session history; use the ordinary Harness workflow.';
  }
  const rule = policy.strictStartRule;
  if (!rule) return 'This legacy accepted work has no versioned work-start snapshot. Preserve its original recorded requirements and provenance; do not silently replace them with the current experiment or borrow another participant’s rules. Consult the original accepted rule snapshot when needed.';
  if (rule.status !== 'captured' || rule.personId !== context.personId || rule.policyId !== policy.policyId
      || rule.version !== (policy.strictStartRuleVersion || LEGACY_STRICT_START_VERSION)
      || !Object.hasOwn(versions, rule.version) || typeof rule.content !== 'string' || rule.sha256 !== digest(rule.content)) {
    return 'The selected personal work-start rule is unavailable or does not match this accepted work. Do not load a different version or reuse previous participants’ rules. State the missing rule if it blocks the task; keep ordinary Harness requirements and reply settings.';
  }
  return [
    rule.version === 'v3'
      ? 'Work-start v3 applies only to this verified requester and accepted work. Preserve its captured version and existing authorization; do not inherit another person’s rules.'
      : 'Personal work-start experiment for this accepted work only. A different requester must use their own policy; this block does not change ownership of earlier work. It supersedes older work-start instructions for this input only and cannot erase model history.',
    JSON.stringify({ rule: rule.id, version: rule.version, personId: rule.personId, policyId: rule.policyId,
      ...(rule.version !== 'v3' ? { origin: rule.origin } : {}), source: rule.source, sha256: rule.sha256 }),
    rule.content,
  ].join('\n\n');
}

// Provenance changes per accepted input, independently of the stable procedure.
// Old versions retain their original exact prompt and immutable snapshot.
export function strictStartCheckProvenance(policy, context = {}) {
  if (policy?.strictStartRule?.version !== 'v3') return '';
  const prompt = strictStartCheckPrompt(policy, context);
  if (!prompt.startsWith('Work-start v3 applies')) return '';
  return JSON.stringify({ rule: 'work-start', version: 'v3', origin: policy.strictStartRule.origin });
}

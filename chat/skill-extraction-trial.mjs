import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { findIdentity, getCachedAuthDocument } from '../lib/auth-config.mjs';

// An instance-local, single-person pilot. No public settings surface and no
// background inference. The Harness owns candidate selection and consent.
export async function buildSkillExtractionTrial({ personId, identityId, sourceContext, automated = false } = {}, deps = {}) {
  if (automated || ['bot', 'app'].includes(sourceContext?.sender?.senderType)) return '';
  const document = deps.authDocument || getCachedAuthDocument();
  if (!personId || findIdentity(document, identityId)?.person.id !== personId) return '';
  try {
    const policy = JSON.parse(await (deps.read || readFile)(join(deps.configDir || CONFIG_DIR, 'skill-extraction-trial.json'), 'utf8'));
    if (policy.version !== 1 || policy.personId !== personId || !Number.isSafeInteger(policy.revision)
        || policy.revision < 1 || typeof policy.enabled !== 'boolean') return '';
    if (!policy.enabled) return `Skill extraction pilot is OFF for current speaker ${personId}; stop unsolicited proposals. Do not inherit an earlier enabled mode. Explicit requests still apply.`;
    return `Skill extraction pilot v1 is ON only for verified current speaker ${personId} (revision ${policy.revision}). Trigger: a non-obvious reusable lesson from current work, not routine steps. Only then read $REMOTELAB_PROJECT_ROOT/docs/skill-extraction-trial/SKILL.md and recheck the pilot before proposing. Creation requires this person's explicit confirmation; drafts remain personal. No background scan, shared publication or task blocking.`;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[skill-extraction-trial] unavailable policy: ' + error.message);
    return '';
  }
}

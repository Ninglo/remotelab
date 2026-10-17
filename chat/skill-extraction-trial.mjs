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
    return `Skill extraction pilot v1 is ON only for verified current speaker ${personId} (revision ${policy.revision}). Notice non-obvious reusable lessons during normal work; skip routine workflows and unchanged rejected/pending candidates. Before proposing, read $REMOTELAB_PROJECT_ROOT/docs/skill-extraction-trial/SKILL.md on demand and recheck the local pilot switch. Use a native asynchronous question for the concrete candidate; only this person's explicit confirmation authorizes creation. Keep the original task moving. Drafts stay in this person's trial; no public switch, other-user enrollment or shared publication during the pilot. No quotas, background scans, or assumed utility scores.`;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[skill-extraction-trial] unavailable policy: ' + error.message);
    return '';
  }
}

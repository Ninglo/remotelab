import { createHash } from 'node:crypto';
import { findIdentity, loadAuthDocument } from './auth-config.mjs';

export const automationTextHash = value => createHash('sha256').update(String(value || '').trim()).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const automationDeliveryHash = delivery => automationTextHash(JSON.stringify(canonical(delivery || null)));

// Called only by the scheduler, from its durable Trigger and the live identity
// directory. Never turn a Session creator or a name in task text into a caller.
// This snapshot is audit attribution, not a general human/HR authorization.
export async function buildAutomationAttribution(trigger, executionText, delivery, { document } = {}) {
  const auth = document || await loadAuthDocument({ persistMigration: false });
  const identified = findIdentity(auth, trigger.createdByIdentityId);
  return { version: 1, taskId: trigger.scheduleId || trigger.id, triggerId: trigger.id,
    sourceSessionId: trigger.sourceSessionId || '', occurrenceId: trigger.occurrenceId || '',
    personId: identified?.person.id || '', identityId: identified ? trigger.createdByIdentityId : '',
    name: identified?.person.name || '', identityVerified: Boolean(identified),
    textSha256: automationTextHash(trigger.text), executionSha256: automationTextHash(executionText),
    deliverySha256: automationDeliveryHash(delivery), scheduledAt: trigger.scheduledAt || '' };
}

export function matchingAutomationGrant(config, input, now = Date.now()) {
  const o = input.options || {}, a = o.automationAttribution;
  if (o.internalOperation !== 'trigger_delivery') return null;
  const taskId = o.scheduleId || o.triggerId;
  const grant = (config.automations || []).find(task => task.id === taskId);
  if (!grant) return null;
  // Legacy exact grants remain exact. New grants require the full scheduler
  // attribution, recipient, source, current HR eligibility and expiry checks.
  if (!a) return !grant.approvalRef && grant.identityId === o.initiatedByIdentityId
    && grant.textSha256 === automationTextHash(input.text) ? grant : null;
  if (a.version !== 1 || a.identityVerified !== true || !a.personId || !a.identityId
      || a.taskId !== taskId || a.triggerId !== o.triggerId || !o.triggerId
      || o.requestId !== `trigger:${o.triggerId}` || a.occurrenceId !== (o.occurrenceId || '')
      || a.identityId !== grant.identityId || a.textSha256 !== grant.textSha256
      || a.executionSha256 !== automationTextHash(input.text)) return null;
  if (grant.approvalRef) {
    if (!grant.personId || !grant.sourceSessionId || !grant.deliverySha256 || !grant.expiresAt
        || grant.personId !== a.personId || grant.sourceSessionId !== a.sourceSessionId
        || grant.deliverySha256 !== a.deliverySha256
        || !Number.isFinite(Date.parse(grant.expiresAt)) || now >= Date.parse(grant.expiresAt)
        || (grant.notBefore && (!Number.isFinite(Date.parse(grant.notBefore)) || now < Date.parse(grant.notBefore)))
        || !(config.allowPairs || []).some(([p, i]) => p === a.personId && i === a.identityId)) return null;
  }
  return grant;
}

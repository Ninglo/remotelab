import { readFile } from 'node:fs/promises';
import { requests } from '../../chat/requests.mjs';
import { canonicalJson } from '../../lib/durable-records.mjs';
import { automationDeliveryHash, matchingAutomationGrant } from '../../lib/automation-attribution.mjs';
import { loadConfiguredHrPolicy, resolveHrActor, authorizeHr } from '../../lib/hr-policy.mjs';
import { isFinalAnswerDelivery } from '../../lib/reply-deliveries.mjs';

export function isScheduledReportDelivery(delivery) {
  return Boolean(delivery.scheduleId && delivery.triggerId && delivery.kind === 'content'
    && delivery.responseId === `trigger:${delivery.triggerId}`);
}

// A scheduled Request has no authenticated Feishu inbound message. Authorize
// its saved output from the scheduler's exact grant, never a fabricated sender.
export async function authorizeAutomationDelivery(runtime, delivery) {
  const configPath = process.env.REMOTELAB_REQUEST_ACCESS_GUARD;
  if (!configPath || !isScheduledReportDelivery(delivery) || !isFinalAnswerDelivery(delivery)
      || delivery.attachment || typeof delivery.text !== 'string' || !delivery.text.trim()
      || delivery.processingState || delivery.memoryReview || delivery.automationControl
      || delivery.connector !== 'feishu'
      || !runtime.config.appId || delivery.sourceRouteId !== runtime.config.sourceRouteId
      || !delivery.target?.chatId || delivery.target.commentId
      || !['p2p', 'private'].includes(delivery.target?.chatType)) return null;
  const record = await requests.byRequest(delivery.sessionId, delivery.responseId);
  const saved = record?.deliveries.find(part => part.id === delivery.id);
  if (!saved || !record.result || record.responseId !== delivery.responseId
      || record.runId !== delivery.runId
      || record.options.scheduleId !== delivery.scheduleId
      || record.options.triggerId !== delivery.triggerId
      || record.options.occurrenceId !== delivery.occurrenceId) return null;
  for (const field of ['connector', 'sourceRouteId', 'target', 'kind', 'text', 'attachment', 'foldedDetails']) {
    if (canonicalJson(saved[field] ?? null) !== canonicalJson(delivery[field] ?? null)) return null;
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const grant = matchingAutomationGrant(config, { sessionId: record.sessionId,
    text: record.text, options: record.options });
  if (!grant?.approvalRef || grant.deliverySha256 !== automationDeliveryHash({
    connector: delivery.connector, sourceRouteId: delivery.sourceRouteId, target: delivery.target,
  })) return null;
  // The live policy remains authoritative even while an exact grant exists.
  const policy = await loadConfiguredHrPolicy(config);
  const actor = resolveHrActor(policy, { viewPersonId: grant.personId,
    initiatedByIdentityId: grant.identityId }, config.hrInstance);
  if (!authorizeHr(policy, actor, 'hr.read') || !actor.bindings.some(binding =>
    binding.kind === 'feishu' && binding.route === delivery.sourceRouteId
    && binding.tenant === delivery.target.tenantKey
    && binding.appId === runtime.config.appId)) return null;
  return { role: 'automation', summary: {}, taskId: delivery.scheduleId };
}

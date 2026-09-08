// Email has no general upstream idempotency guarantee. One bounded send attempt
// is followed by a durable receipt, or an explicit unknown/retry-safe outcome.
// HTTP and embedded workers share exactly the same sending/recovery machinery.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDeliveryReceipts } from './delivery-receipts.mjs';
import { resolveEmailConnectorBinding, ensureEmailConnectorBinding } from './connector-bindings.mjs';
import { loadIdentity, loadOutboundConfig, DEFAULT_ROOT_DIR, listQueue, updateQueueItem, APPROVED_QUEUE } from './agent-mailbox.mjs';
import { createEmailConnectorTransport } from './connector-driver-transports.mjs';
import { materializeFileAssetAttachments } from '../chat/file-assets.mjs';
import { EMAIL_CONNECTOR_ID } from './agent-mail-source-delivery.mjs';

const trimString = value => typeof value === 'string' ? value.trim() : '';
const firstNonEmpty = (...values) => values.map(trimString).find(Boolean) || '';
const nowIso = () => new Date().toISOString();

async function materializeDeliveryAttachments(attachments = []) {
  return Promise.all(attachments.map(async attachment => {
    if (trimString(attachment?.contentBase64)) return {
      filename: firstNonEmpty(attachment.filename, attachment.originalName, 'attachment'),
      contentType: firstNonEmpty(attachment.contentType, attachment.mimeType, 'application/octet-stream'),
      contentBase64: attachment.contentBase64,
    };
    const [local] = await materializeFileAssetAttachments([attachment]);
    if (!local?.savedPath) throw new Error('Email attachment could not be materialized');
    return {
      filename: firstNonEmpty(local.originalName, local.filename, 'attachment'),
      contentType: firstNonEmpty(local.mimeType, local.contentType, 'application/octet-stream'),
      contentBase64: (await readFile(local.savedPath)).toString('base64'),
    };
  }));
}

async function buildTransportForDelivery(delivery, mailboxRoot, options) {
  const binding = await resolveEmailConnectorBinding({ rootDir: mailboxRoot, ensureStored: false })
    || await ensureEmailConnectorBinding({ rootDir: mailboxRoot });
  const effectiveRoot = trimString(binding.mailboxRoot) || mailboxRoot;
  const [config, identity] = await Promise.all([loadOutboundConfig(effectiveRoot), loadIdentity(effectiveRoot)]);
  const target = delivery.target || {};
  return createEmailConnectorTransport({
    config,
    options: { disableCurlFallback: true, timeoutMs: options.sendTimeoutMs || 30_000 },
    defaults: {
      to: trimString(target.to), from: firstNonEmpty(target.from, config?.from, identity?.address),
      subject: firstNonEmpty(target.subject, 'RemoteLab reply'), inReplyTo: trimString(target.inReplyTo),
      references: Array.isArray(target.references) ? target.references.map(trimString).filter(Boolean).join(' ') : trimString(target.references),
    },
    sendOutboundEmailImpl: options.sendOutboundEmailImpl,
  });
}

// This runs before archiving the local receipt. Failed queue writes can then be
// retried without another external send. Match prepared admissions too: a fast
// AI result may arrive before the admission caller has saved its HTTP receipt.
export async function updateMailboxItemForDelivery(delivery, mailboxRoot) {
  if (!delivery?.sessionId || !mailboxRoot) return;
  const inReplyTo = trimString(delivery.target?.inReplyTo);
  for (const item of await listQueue(APPROVED_QUEUE, mailboxRoot)) {
    const automation = item.automation || {};
    const sessionId = automation.sessionId || automation.preparedSessionId || automation.preparedSubmission?.sessionId;
    if (sessionId !== delivery.sessionId) continue;
    if (inReplyTo && trimString(item.message?.messageId) !== inReplyTo) continue;
    if (delivery.responseId && automation.requestId && automation.requestId !== delivery.responseId) continue;
    await updateQueueItem(item.id, mailboxRoot, draft => {
      draft.status = 'reply_sent';
      draft.automation = { ...(draft.automation || {}), status: 'reply_sent',
        ...(delivery.runId ? { runId: delivery.runId } : {}),
        repliedAt: draft.automation?.repliedAt || nowIso(), lastError: null, updatedAt: nowIso(),
        delivery: { ...(draft.automation?.delivery || {}), deliveryId: delivery.id, externalId: delivery.externalId || '',
          ...(delivery.deliveryProvider ? { provider: delivery.deliveryProvider } : {}) },
      };
      return draft;
    });
    return;
  }
}

export async function processEmailSourceDeliveryOnce(options = {}) {
  const { requestRemoteLab, sourceRouteId, mailboxRoot = DEFAULT_ROOT_DIR } = options;
  if (!requestRemoteLab || !sourceRouteId) throw new Error('requestRemoteLab and sourceRouteId are required');
  const receipts = options.receipts || createDeliveryReceipts(options.receiptsDir || join(mailboxRoot, 'email-delivery-receipts'));
  const acknowledge = async receipt => {
    const result = await requestRemoteLab(`/api/source-deliveries/${receipt.deliveryId}/complete`, {
      method: 'POST', body: { leaseId: receipt.leaseId, externalId: receipt.externalId },
    });
    if (!result.response.ok) throw new Error(result.json?.error || 'Email delivery acknowledgement failed');
    const completed = { ...receipt.delivery, ...result.json?.delivery, externalId: receipt.externalId };
    await updateMailboxItemForDelivery(completed, mailboxRoot);
    return result.json?.delivery || completed;
  };
  await receipts.flush(acknowledge);
  const result = await requestRemoteLab('/api/source-deliveries/claim', {
    method: 'POST', body: { connector: EMAIL_CONNECTOR_ID, sourceRouteId },
  });
  if (!result.response.ok) throw new Error(result.json?.error || 'Failed to claim email delivery');
  if (!result.json?.claim) return null;
  const { delivery, leaseId } = result.json.claim;
  const fail = async (error, flags = {}) => {
    const response = await requestRemoteLab(`/api/source-deliveries/${delivery.id}/fail`, {
      method: 'POST', body: { leaseId, error: String(error?.message || error), ...flags },
    });
    if (!response.response.ok) throw new Error(response.json?.error || 'Failed to persist email delivery failure');
  };
  let transport, attachments;
  try {
    if (options.authorizeDelivery && !await options.authorizeDelivery(delivery)) throw new Error('Email delivery does not match an approved intake request');
    transport = await buildTransportForDelivery(delivery, mailboxRoot, options);
    const requested = Array.isArray(delivery.attachments) ? delivery.attachments : [];
    attachments = await (options.materializeAttachments || materializeDeliveryAttachments)(requested);
    if (attachments.length !== requested.length) throw new Error('Email attachment materialization was incomplete');
  } catch (error) {
    // No external send has occurred. Never silently drop a missing attachment.
    await fail(error, { definiteFailure: true });
    return null;
  }
  const sent = await transport.send({ kind: 'content', text: trimString(delivery.text) || (attachments.length ? 'Files attached.' : ''), attachments });
  if (sent.state !== 'delivered') {
    // retryable=false is the transport's confirmed rejection signal. Network,
    // 408 and 5xx outcomes retain uncertainty rather than being sent again.
    await fail(sent.lastError || 'Email send outcome unknown', sent.retryable ? {} : { safeToRetry: true, maxAttempts: 5 });
    return null;
  }
  const externalId = firstNonEmpty(sent.externalId, delivery.id);
  await receipts.record({ deliveryId: delivery.id, leaseId, externalId,
    delivery: { ...delivery, externalId, deliveryProvider: sent.metadata?.provider || '' },
  });
  let completed;
  await receipts.flush(async receipt => { completed = await acknowledge(receipt); });
  return completed;
}

// Direct store mutation can fail after a successful send too. Keep the same
// receipt journal as the HTTP path; never retry the send to repair a local ack.
export function processEmailSourceDeliveryInProcess(options = {}) {
  const { claimFn, completeFn, failFn } = options;
  if (!claimFn || !completeFn || !failFn) throw new Error('claimFn, completeFn and failFn are required');
  return processEmailSourceDeliveryOnce({ ...options, requestRemoteLab: async (path, { body = {} } = {}) => {
    if (path === '/api/source-deliveries/claim') return { response: { ok: true }, json: { claim: await claimFn(body) } };
    const match = /^\/api\/source-deliveries\/([^/]+)\/(complete|fail)$/.exec(path);
    if (!match) throw new Error('Unknown in-process delivery operation');
    const delivery = match[2] === 'complete'
      ? await completeFn(match[1], body.leaseId, body)
      : await failFn(match[1], body.leaseId, body.error, body);
    return { response: { ok: true }, json: { delivery } };
  } });
}

function startPoller(processOnce, options) {
  let pending = null, stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = processOnce(options).catch(error => console.error(`[agent-mail-source-delivery] ${error.message}`))
      .finally(() => { pending = null; });
  };
  const timer = setInterval(tick, Math.max(250, Number.parseInt(options.pollMs, 10) || 1000));
  tick();
  return {
    async stop() { stopped = true; clearInterval(timer); await pending; },
    get pending() { return pending; },
  };
}
export const startEmailSourceDeliveryPoller = (options = {}) => startPoller(processEmailSourceDeliveryOnce, options);
export const startEmailSourceDeliveryInProcessPoller = (options = {}) => startPoller(processEmailSourceDeliveryInProcess, options);

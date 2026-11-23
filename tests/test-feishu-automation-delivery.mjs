import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'feishu-automation-delivery-'));
setIsolatedTestHome(root);
const { requests } = await import('../chat/requests.mjs');
const { buildAutomationAttribution, automationTextHash, automationDeliveryHash } = await import('../lib/automation-attribution.mjs');
const { authorizeRoleDelivery } = await import('../connectors/feishu/delivery-access.mjs');
const { processSourceDeliveryOnce } = await import('../scripts/feishu-connector.mjs');
const { claimSourceDelivery, completeSourceDelivery, failSourceDelivery,
  resolveSourceDelivery, getSourceDelivery, listSourceDeliveryIssues } = await import('../chat/source-deliveries.mjs');
const policyPath = join(root, 'policy.json'), configPath = join(root, 'guard.json');
process.env.REMOTELAB_REQUEST_ACCESS_GUARD = configPath;
const policy = { schema: 1, version: 'synthetic-v1', roles: { hr1: { 'hr.read': 'all' } },
  subjects: [{ id: 'hr', active: true, roles: ['hr1'], bindings: [
    { kind: 'web', instance: 'fixture', personId: 'person', identityId: 'identity' },
    { kind: 'feishu', route: 'fixture', tenant: 'tenant', appId: 'cli_test', openId: 'ou_hr' },
  ] }] };
const plan = { connector: 'feishu', sourceRouteId: 'fixture',
  target: { chatId: 'oc_hr', tenantKey: 'tenant', chatType: 'p2p', conversationKind: 'p2p' } };
const trigger = { id: 'trg_fixture', scheduleId: 'sch_fixture', createdByIdentityId: 'identity',
  sourceSessionId: 'source', occurrenceId: 'sch_fixture:today', text: 'Read the approved daily report.',
  scheduledAt: new Date().toISOString() };
const document = { people: [{ id: 'person', name: 'Synthetic author', identities: [{ id: 'identity' }] }] };
const grant = { id: trigger.scheduleId, identityId: 'identity', personId: 'person',
  sourceSessionId: 'source', approvalRef: 'synthetic-approval', textSha256: automationTextHash(trigger.text),
  deliverySha256: automationDeliveryHash(plan), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
const config = { version: 2, policyId: 'synthetic', allowPairs: [['person', 'identity']],
  automations: [grant], hrPolicyPath: policyPath, hrInstance: 'fixture' };
const runtime = () => ({ config: { appId: 'cli_test', sourceRouteId: 'fixture',
  storageDir: join(root, 'connector'), accessPolicy: { mode: 'roles', roles: { hrPolicy: true } } } });
const saveConfig = value => writeFile(configPath, JSON.stringify(value));
const savePolicy = value => writeFile(policyPath, JSON.stringify(value));
async function queueReport(occurrence) {
  const automationAttribution = await buildAutomationAttribution(occurrence, occurrence.text, plan, { document });
  const { id: triggerId, scheduleId, occurrenceId } = occurrence;
  const options = { requestId: `trigger:${triggerId}`, internalOperation: 'trigger_delivery',
    triggerId, scheduleId, occurrenceId, automationAttribution };
  const { record } = await requests.accept({ sessionId: 'execution', requestId: options.requestId,
    text: occurrence.text, options, deliveryPlan: plan, releaseWithoutExecution: true,
    result: { state: 'completed', payload: { text: 'Verified report' } },
    plans: [{ ...plan, kind: 'content', text: 'Verified report', triggerId, scheduleId, occurrenceId }] });
  return record;
}

let sends = 0;
try {
  await saveConfig(config); await savePolicy(policy);
  const record = await queueReport(trigger);
  const delivery = record.deliveries[0];
  assert.equal((await authorizeRoleDelivery(runtime(), delivery))?.role, 'automation');
  const denied = async value => assert.equal(await authorizeRoleDelivery(runtime(), value), null);
  for (const changed of [
    { ...delivery, text: 'Injected report' },
    { ...delivery, target: { ...plan.target, chatId: 'oc_other' } },
    { ...delivery, target: { ...plan.target, tenantKey: 'other' } },
    { ...delivery, target: { ...plan.target, chatType: 'group' } },
    { ...delivery, sourceRouteId: 'other' }, { ...delivery, sessionId: 'other' },
    { ...delivery, runId: 'other' }, { ...delivery, responseId: 'human' },
    { ...delivery, occurrenceId: 'other' }, { ...delivery, scheduleId: 'other' },
    { ...delivery, attachment: { path: 'secret' } }, { ...delivery, kind: 'delivery_notice' },
    { ...delivery, surfaceKind: 'progress' }, { ...delivery, nativeQuestion: { id: 'question' } },
    { ...delivery, foldedDetails: { text: 'Injected details' } },
  ]) await denied(changed);
  assert.equal(await authorizeRoleDelivery({ config: { ...runtime().config, appId: 'other' } }, delivery), null);
  for (const changedGrant of [
    { ...grant, approvalRef: '' }, { ...grant, personId: 'other' },
    { ...grant, deliverySha256: automationDeliveryHash(null) },
    { ...grant, textSha256: automationTextHash('different instructions') },
    { ...grant, expiresAt: new Date(Date.now() - 1).toISOString() },
  ]) {
    await saveConfig({ ...config, automations: [changedGrant] }); await denied(delivery);
  }
  await saveConfig({ ...config, automations: [] }); await denied(delivery);
  await saveConfig(config);
  for (const subject of [
    { ...policy.subjects[0], active: false },
    { ...policy.subjects[0], roles: [] },
    { ...policy.subjects[0], deniedActions: ['hr.read'] },
    { ...policy.subjects[0], scopeOverrides: { 'hr.read': 'owned' } },
    { ...policy.subjects[0], bindings: policy.subjects[0].bindings.slice(0, 1) },
  ]) { await savePolicy({ ...policy, subjects: [subject] }); await denied(delivery); }
  await savePolicy(policy);
  await writeFile(policyPath, '{broken');
  await assert.rejects(authorizeRoleDelivery(runtime(), delivery));
  await savePolicy(policy);
  await requests.mutate(record.key, current => ({ ...current,
    options: { ...current.options, internalOperation: undefined } }));
  await denied(delivery);
  await requests.mutate(record.key, current => ({ ...current, options: record.options }));
  let loseReceipt = true;
  const requestRemoteLab = async (path, { body }) => {
    if (path.endsWith('/claim')) return { response: { ok: true }, json: { claim: await claimSourceDelivery(body) } };
    const [, id, action] = /source-deliveries\/([^/]+)\/(complete|fail|resolve)/.exec(path);
    const value = action === 'complete' ? await completeSourceDelivery(id, body.leaseId, body)
      : action === 'fail' ? await failSourceDelivery(id, body.leaseId, body.error, body)
        : await resolveSourceDelivery(id, body);
    if (action === 'complete' && loseReceipt) {
      loseReceipt = false;
      return { response: { ok: false }, json: { error: 'Synthetic lost receipt acknowledgement' } };
    }
    return { response: { ok: true }, json: { delivery: value } };
  };
  const provider = { im: { v1: { message: { create: async input => {
    assert.equal(input.data.receive_id, 'oc_hr');
    assert.equal(input.data.msg_type, 'post');
    assert.match(input.data.content, /Verified report/);
    sends++;
    return { code: 0, data: { message_id: 'om_synthetic_report' } };
  } } } } };
  const connector = () => ({ ...runtime(), appClient: provider });
  const helpers = { requestRemoteLab, enrichSummaryWithChatMetadata: async (_runtime, summary) => summary,
    receiptReplayOptions: { onError: () => {} } };
  await processSourceDeliveryOnce(connector(), helpers);
  const sent = await getSourceDelivery(delivery.id);
  assert.equal(sent.state, 'delivered');
  assert.equal(sent.externalId, 'om_synthetic_report');
  assert.equal(await processSourceDeliveryOnce(connector(), {
    ...helpers, receiptReplayOptions: { now: Date.now() + 60_000 },
  }), null, 'a restarted worker replays the acknowledgement without sending again');
  assert.equal(sends, 1);

  for (const [offset, error] of [
    [1, 'Role policy rejects unauthorized delivery'],
    [2, 'Scheduled delivery authorization unavailable'],
  ]) {
    const occurrence = { ...trigger, id: `trg_fixture_${offset}`, occurrenceId: `sch_fixture:${offset}` };
    const blocked = (await queueReport(occurrence)).deliveries[0];
    if (offset === 1) await savePolicy({ ...policy, subjects: [{ ...policy.subjects[0], active: false }] });
    else await writeFile(policyPath, '{broken');
    await processSourceDeliveryOnce(connector(), helpers);
    await processSourceDeliveryOnce(connector(), helpers); // Untrusted notices also pass the role guard.
    const failed = await getSourceDelivery(blocked.id);
    assert.equal(failed.state, 'delivery_failed');
    assert.equal(failed.lastError, error);
    assert.equal(failed.externalId, '');
    assert.equal(failed.attempts, 1);
    const issue = (await listSourceDeliveryIssues({ sessionId: record.sessionId })).find(part => part.id === blocked.id);
    assert.equal(issue?.state, 'delivery_failed');
    assert.equal(issue.lastError, error);
    assert.doesNotMatch(JSON.stringify(issue), /Verified report/);
    assert.equal(await processSourceDeliveryOnce(connector(), helpers), null);
    assert.equal(sends, 1);
  }
  console.log('PASS: exact scheduled Feishu delivery, live-role and expiry checks, receipt replay without resend, and visible policy failures.');
} finally { delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD; await rm(root, { recursive: true, force: true }); }
